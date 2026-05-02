import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MASTER_ADMIN_EMAIL = "faiyaz@nextventures.io";
const MAX_LIMIT = 1000;

const ALLOWED_CLIENT_ACTIONS = new Set([
  "session_heartbeat",
  "session_ended",
  "page_viewed",
]);

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function getEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeSearchTerm(value) {
  return normalizeText(value).replace(/[%,]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function getSupabaseClients() {
  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { authClient, adminClient };
}

function getRequestMeta(request) {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  const ipAddress = forwardedFor.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";
  const userAgent = request.headers.get("user-agent") || "";

  return {
    ip_address: ipAddress || null,
    user_agent: userAgent || null,
    request_path: new URL(request.url).pathname,
  };
}

function safeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function getDurationSeconds(startedAt, endedAt = new Date()) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  return Math.max(0, Math.round((end - start) / 1000));
}

async function getAuthenticatedUser(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!token) {
    return {
      ok: false,
      response: json({ ok: false, error: "Missing access token." }, { status: 401 }),
    };
  }

  const { authClient, adminClient } = getSupabaseClients();

  const {
    data: { user },
    error,
  } = await authClient.auth.getUser(token);

  if (error || !user) {
    return {
      ok: false,
      response: json({ ok: false, error: "Invalid or expired session." }, { status: 401 }),
    };
  }

  const email = normalizeEmail(user.email);

  if (!email.endsWith("@nextventures.io")) {
    return {
      ok: false,
      response: json({ ok: false, error: "Only nextventures.io accounts are allowed." }, { status: 403 }),
    };
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, can_run_tests, is_active")
    .or(`id.eq.${user.id},email.eq.${email}`)
    .maybeSingle();

  if (profileError) {
    return {
      ok: false,
      response: json({ ok: false, error: profileError.message || "Could not read profile." }, { status: 500 }),
    };
  }

  return {
    ok: true,
    user,
    email,
    profile: profile || null,
    adminClient,
  };
}

async function requireMasterAdmin(request) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.ok) return auth;

  const role = auth.email === MASTER_ADMIN_EMAIL ? "master_admin" : auth.profile?.role;

  if (role !== "master_admin") {
    return {
      ok: false,
      response: json(
        {
          ok: false,
          error: "Only Master Admins can view system activity logs.",
        },
        { status: 403 }
      ),
    };
  }

  return auth;
}

async function readActiveRoleGrant(adminClient, email) {
  const normalizedEmail = normalizeEmail(email);

  const { data, error } = await adminClient
    .from("user_role_grants")
    .select("email, full_name, role, can_run_tests, is_active")
    .ilike("email", normalizedEmail)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[activity-log] role grant lookup failed", error);
    return null;
  }

  return data || null;
}

function resolveActorContext(user, email, profile, grant) {
  const actorRole =
    email === MASTER_ADMIN_EMAIL
      ? "master_admin"
      : normalizeText(grant?.role) || normalizeText(profile?.role) || "viewer";

  const actorName =
    normalizeText(grant?.full_name) ||
    normalizeText(profile?.full_name) ||
    normalizeText(user?.user_metadata?.full_name) ||
    normalizeText(user?.user_metadata?.name) ||
    email;

  return {
    actorName,
    actorRole,
  };
}

async function findLatestActiveSession(adminClient, email) {
  const { data, error } = await adminClient
    .from("user_activity_sessions")
    .select("id, started_at, last_seen_at, status")
    .eq("email", email)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Could not read user session.");
  }

  return data || null;
}

async function writeActivityLog(adminClient, payload) {
  const { error } = await adminClient.from("system_activity_logs").insert(payload);

  if (error) {
    throw new Error(error.message || "Could not write activity log.");
  }
}

export async function GET(request) {
  try {
    const auth = await requireMasterAdmin(request);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), MAX_LIMIT);
    const email = normalizeEmail(url.searchParams.get("email"));
    const actionType = normalizeText(url.searchParams.get("action_type"));
    const status = normalizeText(url.searchParams.get("status"));
    const area = normalizeText(url.searchParams.get("area"));
    const search = normalizeSearchTerm(url.searchParams.get("search"));
    const startDate = normalizeText(url.searchParams.get("start_date"));
    const endDate = normalizeText(url.searchParams.get("end_date"));

    let logsQuery = auth.adminClient
      .from("system_activity_logs")
      .select(`
        id,
        created_at,
        actor_user_id,
        actor_email,
        actor_name,
        actor_role,
        action_type,
        action_label,
        area,
        target_type,
        target_id,
        target_label,
        status,
        description,
        is_sensitive,
        safe_before,
        safe_after,
        metadata,
        request_path,
        ip_address,
        user_agent,
        session_id
      `)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (email) logsQuery = logsQuery.eq("actor_email", email);
    if (actionType) logsQuery = logsQuery.eq("action_type", actionType);
    if (status) logsQuery = logsQuery.eq("status", status);
    if (area) logsQuery = logsQuery.eq("area", area);
    if (startDate) logsQuery = logsQuery.gte("created_at", `${startDate}T00:00:00.000Z`);
    if (endDate) logsQuery = logsQuery.lte("created_at", `${endDate}T23:59:59.999Z`);
    if (search) {
      const pattern = `%${search}%`;
      logsQuery = logsQuery.or([
        `actor_email.ilike.${pattern}`,
        `actor_name.ilike.${pattern}`,
        `actor_role.ilike.${pattern}`,
        `action_type.ilike.${pattern}`,
        `action_label.ilike.${pattern}`,
        `area.ilike.${pattern}`,
        `target_type.ilike.${pattern}`,
        `target_label.ilike.${pattern}`,
        `status.ilike.${pattern}`,
        `description.ilike.${pattern}`,
        `request_path.ilike.${pattern}`
      ].join(","));
    }

    const { data: rawLogs, error: logsError } = await logsQuery;

    if (logsError) {
      throw new Error(logsError.message || "Could not load activity logs.");
    }

    let logs = Array.isArray(rawLogs) ? rawLogs : [];

    if (search) {
      logs = logs.filter((row) => {
        const haystack = [
          row.actor_email,
          row.actor_name,
          row.actor_role,
          row.action_type,
          row.action_label,
          row.area,
          row.target_type,
          row.target_label,
          row.status,
          row.description,
          row.request_path,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(search);
      });
    }

    let sessionsQuery = auth.adminClient
      .from("user_activity_sessions")
      .select(`
        id,
        user_id,
        email,
        full_name,
        role,
        started_at,
        last_seen_at,
        ended_at,
        duration_seconds,
        status,
        ip_address,
        user_agent,
        created_at,
        updated_at
      `)
      .order("last_seen_at", { ascending: false })
      .limit(80);

    if (email) sessionsQuery = sessionsQuery.eq("email", email);
    if (startDate) sessionsQuery = sessionsQuery.gte("started_at", `${startDate}T00:00:00.000Z`);
    if (endDate) sessionsQuery = sessionsQuery.lte("started_at", `${endDate}T23:59:59.999Z`);
    if (search) {
      const pattern = `%${search}%`;
      sessionsQuery = sessionsQuery.or([
        `email.ilike.${pattern}`,
        `full_name.ilike.${pattern}`,
        `role.ilike.${pattern}`,
        `status.ilike.${pattern}`
      ].join(","));
    }

    const { data: rawSessions, error: sessionsError } = await sessionsQuery;

    if (sessionsError) {
      throw new Error(sessionsError.message || "Could not load activity sessions.");
    }

    let sessions = Array.isArray(rawSessions) ? rawSessions : [];

    if (search) {
      sessions = sessions.filter((row) => {
        const haystack = [row.email, row.full_name, row.role, row.status]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(search);
      });
    }

    return json({
      ok: true,
      logs,
      sessions,
      count: logs.length,
      session_count: sessions.length,
      filters: {
        limit,
        email,
        action_type: actionType,
        status,
        area,
        search,
        start_date: startDate,
        end_date: endDate,
      },
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown server error.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => ({}));
    const actionType = normalizeText(body.action_type || "session_heartbeat");

    if (!ALLOWED_CLIENT_ACTIONS.has(actionType)) {
      return json(
        {
          ok: false,
          error: "Unsupported client activity action.",
        },
        { status: 400 }
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const meta = getRequestMeta(request);
    const profile = auth.profile || {};
    const grant = await readActiveRoleGrant(auth.adminClient, auth.email);
    const { actorName, actorRole } = resolveActorContext(auth.user, auth.email, profile, grant);
    const latestSession = await findLatestActiveSession(auth.adminClient, auth.email);

    let sessionId = latestSession?.id || null;

    if (!latestSession) {
      const { data: newSession, error: sessionError } = await auth.adminClient
        .from("user_activity_sessions")
        .insert({
          user_id: auth.user.id,
          email: auth.email,
          full_name: actorName,
          role: actorRole,
          last_seen_at: nowIso,
          status: actionType === "session_ended" ? "ended" : "active",
          ended_at: actionType === "session_ended" ? nowIso : null,
          duration_seconds: actionType === "session_ended" ? 0 : null,
          ip_address: meta.ip_address,
          user_agent: meta.user_agent,
        })
        .select("id, started_at")
        .single();

      if (sessionError) {
        throw new Error(sessionError.message || "Could not create activity session.");
      }

      sessionId = newSession.id;
    } else if (actionType === "session_ended") {
      const durationSeconds = getDurationSeconds(latestSession.started_at, now);

      const { error: updateError } = await auth.adminClient
        .from("user_activity_sessions")
        .update({
          last_seen_at: nowIso,
          ended_at: nowIso,
          duration_seconds: durationSeconds,
          status: "ended",
          updated_at: nowIso,
        })
        .eq("id", latestSession.id);

      if (updateError) {
        throw new Error(updateError.message || "Could not end activity session.");
      }
    } else {
      const { error: updateError } = await auth.adminClient
        .from("user_activity_sessions")
        .update({
          user_id: auth.user.id,
          full_name: actorName,
          role: actorRole,
          last_seen_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", latestSession.id);

      if (updateError) {
        throw new Error(updateError.message || "Could not update activity session.");
      }
    }

    if (actionType !== "session_heartbeat") {
      const label = actionType === "session_ended" ? "User Signed Out" : "Page Viewed";
      const description =
        actionType === "session_ended"
          ? `${actorName} signed out.`
          : `${actorName} viewed ${normalizeText(body.page || "a page")}.`;

      await writeActivityLog(auth.adminClient, {
        actor_user_id: auth.user.id,
        actor_email: auth.email,
        actor_name: actorName,
        actor_role: actorRole,
        action_type: actionType,
        action_label: label,
        area: actionType === "session_ended" ? "Authentication" : "Navigation",
        status: "info",
        description,
        metadata: safeJsonObject(body.metadata),
        request_path: meta.request_path,
        ip_address: meta.ip_address,
        user_agent: meta.user_agent,
        session_id: sessionId,
      });
    }

    return json({
      ok: true,
      session_id: sessionId,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown server error.",
      },
      { status: 500 }
    );
  }
}
