import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MASTER_ADMIN_EMAIL = "faiyaz@nextventures.io";

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

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
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

function roleLabel(role) {
  return String(role || "viewer")
    .replaceAll("_", " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function mappingLabel(row) {
  return normalizeText(row?.employee_name) || normalizeText(row?.intercom_agent_name) || "Agent Mapping";
}

function safeMapping(row) {
  if (!row) return null;

  return {
    id: row.id || null,
    intercom_agent_name: row.intercom_agent_name || null,
    employee_name: row.employee_name || null,
    employee_email: row.employee_email || null,
    team_name: row.team_name || null,
    notes: row.notes || null,
    is_active: row.is_active !== false,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadActiveSupervisorTeams(adminClient) {
  const { data: teamsData, error: teamsError } = await adminClient
    .from("supervisor_teams")
    .select("id, supervisor_name, supervisor_email, notes, is_active, created_at, updated_at")
    .eq("is_active", true)
    .order("supervisor_name", { ascending: true })
    .limit(1000);

  if (teamsError) {
    throw new Error(teamsError.message || "Could not load Supervisor Teams.");
  }

  const teams = Array.isArray(teamsData) ? teamsData : [];
  const teamIds = teams.map((team) => team.id).filter(Boolean);

  if (!teamIds.length) return [];

  const { data: membersData, error: membersError } = await adminClient
    .from("supervisor_team_members")
    .select("id, supervisor_team_id, employee_name, employee_email, intercom_agent_name, team_name, is_active, created_at, updated_at")
    .in("supervisor_team_id", teamIds)
    .eq("is_active", true)
    .order("employee_name", { ascending: true })
    .limit(10000);

  if (membersError) {
    throw new Error(membersError.message || "Could not load Supervisor Team members.");
  }

  const membersByTeam = new Map();

  for (const member of Array.isArray(membersData) ? membersData : []) {
    const list = membersByTeam.get(member.supervisor_team_id) || [];
    list.push(member);
    membersByTeam.set(member.supervisor_team_id, list);
  }

  return teams.map((team) => ({
    ...team,
    members: membersByTeam.get(team.id) || [],
  }));
}

function validateMappingPayload(input = {}) {
  const intercomAgentName = normalizeText(input.intercom_agent_name);
  const employeeName = normalizeText(input.employee_name) || intercomAgentName;
  const employeeEmail = normalizeEmail(input.employee_email);
  const teamName = normalizeText(input.team_name);
  const notes = normalizeText(input.notes);

  if (!intercomAgentName) {
    throw new Error("Intercom agent name is required.");
  }

  if (!employeeName) {
    throw new Error("Employee name is required.");
  }

  if (employeeEmail && !employeeEmail.endsWith("@nextventures.io")) {
    throw new Error("Employee email must use the nextventures.io domain.");
  }

  return {
    intercom_agent_name: intercomAgentName,
    employee_name: employeeName,
    employee_email: employeeEmail || null,
    team_name: teamName || null,
    notes: notes || null,
    is_active: input.is_active !== false,
    updated_at: new Date().toISOString(),
  };
}

async function getAuthenticatedContext(request) {
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

  const { data: grant } = await adminClient
    .from("user_role_grants")
    .select("email, full_name, role, can_run_tests, is_active")
    .eq("email", email)
    .eq("is_active", true)
    .maybeSingle();

  const { data: profile } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, can_run_tests, is_active")
    .or(`id.eq.${user.id},email.eq.${email}`)
    .maybeSingle();

  const role =
    email === MASTER_ADMIN_EMAIL
      ? "master_admin"
      : grant?.role || profile?.role || "viewer";

  const isActive =
    email === MASTER_ADMIN_EMAIL ? true : grant ? grant.is_active !== false : profile?.is_active !== false;

  const actorName =
    normalizeText(grant?.full_name) ||
    normalizeText(profile?.full_name) ||
    normalizeText(user?.user_metadata?.full_name) ||
    normalizeText(user?.user_metadata?.name) ||
    email;

  const canManage =
    isActive === true &&
    (email === MASTER_ADMIN_EMAIL || role === "master_admin" || role === "co_admin" || role === "admin");

  if (!canManage) {
    return {
      ok: false,
      response: json(
        { ok: false, error: "Only Master Admins and Co-Admins can manage agent mappings." },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true,
    adminClient,
    user,
    actor: {
      id: user.id,
      email,
      name: actorName,
      role,
    },
  };
}

async function writeActivityLog(adminClient, request, actor, payload) {
  const meta = getRequestMeta(request);

  const { error } = await adminClient.from("system_activity_logs").insert({
    actor_user_id: actor.id,
    actor_email: actor.email,
    actor_name: actor.name,
    actor_role: actor.role,
    status: "success",
    area: "Agent Mapping",
    is_sensitive: false,
    request_path: meta.request_path,
    ip_address: meta.ip_address,
    user_agent: meta.user_agent,
    ...payload,
  });

  if (error) {
    console.warn("[activity-log] agent mapping log failed", error);
  }
}

async function findExistingMapping(adminClient, id, intercomAgentName) {
  if (id) {
    const { data, error } = await adminClient
      .from("agent_mappings")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(error.message || "Could not read existing mapping.");
    if (data) return data;
  }

  const { data, error } = await adminClient
    .from("agent_mappings")
    .select("*")
    .limit(10000);

  if (error) throw new Error(error.message || "Could not inspect existing mappings.");

  const key = normalizeKey(intercomAgentName);
  return (data || []).find((row) => normalizeKey(row?.intercom_agent_name) === key) || null;
}


async function getAuthenticatedReadContext(request) {
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

  const { data: grant } = await adminClient
    .from("user_role_grants")
    .select("email, full_name, role, can_run_tests, is_active")
    .eq("email", email)
    .eq("is_active", true)
    .maybeSingle();

  const { data: profile } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, can_run_tests, is_active")
    .or(`id.eq.${user.id},email.eq.${email}`)
    .maybeSingle();

  const role = email === MASTER_ADMIN_EMAIL ? "master_admin" : grant?.role || profile?.role || "viewer";
  const isActive = email === MASTER_ADMIN_EMAIL ? true : grant ? grant.is_active !== false : profile?.is_active !== false;
  const canRunTests = Boolean(grant?.can_run_tests || profile?.can_run_tests);
  const canRead =
    isActive === true &&
    (email === MASTER_ADMIN_EMAIL ||
      role === "master_admin" ||
      role === "co_admin" ||
      role === "admin" ||
      role === "audit_runner" ||
      canRunTests === true);

  if (!canRead) {
    return {
      ok: false,
      response: json({ ok: false, error: "This account cannot read agent mappings." }, { status: 403 }),
    };
  }

  return { ok: true, adminClient, user, email, role };
}

export async function GET(request) {
  const auth = await getAuthenticatedReadContext(request);
  if (!auth.ok) return auth.response;

  try {
    const [{ data, error }, supervisorTeams] = await Promise.all([
      auth.adminClient
        .from("agent_mappings")
        .select("id, intercom_agent_name, employee_name, employee_email, team_name, notes, is_active, created_at, updated_at")
        .eq("is_active", true)
        .order("employee_name", { ascending: true })
        .limit(10000),
      loadActiveSupervisorTeams(auth.adminClient),
    ]);

    if (error) throw new Error(error.message || "Could not load agent mappings.");

    return json({
      ok: true,
      mappings: Array.isArray(data) ? data : [],
      supervisorTeams,
      meta: {
        requestedBy: auth.email,
        role: auth.role,
        count: Array.isArray(data) ? data.length : 0,
        supervisorTeamCount: supervisorTeams.length,
      },
    });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Could not load agent mappings." },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  const auth = await getAuthenticatedContext(request);
  if (!auth.ok) return auth.response;

  const { adminClient, actor } = auth;
  const body = await request.json().catch(() => ({}));
  const action = normalizeKey(body.action || "save");

  try {
    if (action === "seed") {
      const rows = Array.isArray(body.rows) ? body.rows : [];

      if (!rows.length) {
        return json({ ok: false, error: "No detected mappings were provided." }, { status: 400 });
      }

      const now = new Date().toISOString();
      const seen = new Set();
      const sanitizedRows = rows
        .map((row) => validateMappingPayload(row))
        .filter((row) => {
          const key = normalizeKey(row.intercom_agent_name);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((row) => ({
          ...row,
          created_at: now,
          updated_at: now,
        }));

      const { data, error } = await adminClient
        .from("agent_mappings")
        .insert(sanitizedRows)
        .select("*");

      if (error) throw new Error(error.message || "Could not prefill mappings.");

      await writeActivityLog(adminClient, request, actor, {
        action_type: "agent_mappings_prefilled",
        action_label: "Agent Mappings Prefilled",
        target_type: "agent_mappings",
        target_label: `${sanitizedRows.length} mapping(s)`,
        description: `${actor.name} prefilled ${sanitizedRows.length} agent mapping(s).`,
        safe_after: {
          count: sanitizedRows.length,
          agents: sanitizedRows.slice(0, 25).map((row) => row.intercom_agent_name),
        },
        metadata: {
          inserted_count: sanitizedRows.length,
        },
      });

      return json({
        ok: true,
        message: `${sanitizedRows.length} mapping(s) added.`,
        mappings: data || [],
      });
    }

    const input = body.mapping || body;
    const payload = validateMappingPayload(input);
    const requestedId = normalizeText(body.id || input.id);
    const existing = await findExistingMapping(adminClient, requestedId, payload.intercom_agent_name);

    if (existing?.id) {
      const { data, error } = await adminClient
        .from("agent_mappings")
        .update(payload)
        .eq("id", existing.id)
        .select("*")
        .single();

      if (error) throw new Error(error.message || "Could not update the mapping.");

      await writeActivityLog(adminClient, request, actor, {
        action_type: "agent_mapping_updated",
        action_label: "Agent Mapping Updated",
        target_type: "agent_mapping",
        target_id: String(existing.id),
        target_label: mappingLabel(data),
        description: `${actor.name} updated the agent mapping for ${mappingLabel(data)}.`,
        safe_before: safeMapping(existing),
        safe_after: safeMapping(data),
        metadata: {
          intercom_agent_name: data?.intercom_agent_name || payload.intercom_agent_name,
          employee_email: data?.employee_email || null,
          team_name: data?.team_name || null,
        },
      });

      return json({
        ok: true,
        message: "Agent mapping updated successfully.",
        action: "updated",
        mapping: data,
      });
    }

    const { data, error } = await adminClient
      .from("agent_mappings")
      .insert({
        ...payload,
        created_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message || "Could not create the mapping.");

    await writeActivityLog(adminClient, request, actor, {
      action_type: "agent_mapping_created",
      action_label: "Agent Mapping Created",
      target_type: "agent_mapping",
      target_id: String(data.id),
      target_label: mappingLabel(data),
      description: `${actor.name} created the agent mapping for ${mappingLabel(data)}.`,
      safe_after: safeMapping(data),
      metadata: {
        intercom_agent_name: data?.intercom_agent_name || payload.intercom_agent_name,
        employee_email: data?.employee_email || null,
        team_name: data?.team_name || null,
      },
    });

    return json({
      ok: true,
      message: "Agent mapping created successfully.",
      action: "created",
      mapping: data,
    });
  } catch (error) {
    await writeActivityLog(adminClient, request, actor, {
      action_type: action === "seed" ? "agent_mappings_prefill_failed" : "agent_mapping_save_failed",
      action_label: action === "seed" ? "Agent Mappings Prefill Failed" : "Agent Mapping Save Failed",
      status: "failed",
      target_type: "agent_mapping",
      target_label: normalizeText(body?.mapping?.intercom_agent_name || body?.intercom_agent_name) || "Agent Mapping",
      description: error instanceof Error ? error.message : "Could not save agent mapping.",
      safe_after: {
        attempted_intercom_agent_name: normalizeText(body?.mapping?.intercom_agent_name || body?.intercom_agent_name) || null,
        attempted_employee_name: normalizeText(body?.mapping?.employee_name || body?.employee_name) || null,
        attempted_employee_email: normalizeEmail(body?.mapping?.employee_email || body?.employee_email) || null,
      },
    });

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Could not save agent mapping.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request) {
  const auth = await getAuthenticatedContext(request);
  if (!auth.ok) return auth.response;

  const { adminClient, actor } = auth;
  const body = await request.json().catch(() => ({}));
  const id = normalizeText(body.id);
  const nextActive = Boolean(body.isActive);

  if (!id) {
    return json({ ok: false, error: "Mapping ID is required." }, { status: 400 });
  }

  try {
    const { data: before, error: beforeError } = await adminClient
      .from("agent_mappings")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (beforeError) throw new Error(beforeError.message || "Could not read mapping.");
    if (!before) return json({ ok: false, error: "Mapping not found." }, { status: 404 });

    const { data, error } = await adminClient
      .from("agent_mappings")
      .update({
        is_active: nextActive,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw new Error(error.message || "Could not update mapping status.");

    await writeActivityLog(adminClient, request, actor, {
      action_type: nextActive ? "agent_mapping_activated" : "agent_mapping_deactivated",
      action_label: nextActive ? "Agent Mapping Activated" : "Agent Mapping Deactivated",
      target_type: "agent_mapping",
      target_id: String(id),
      target_label: mappingLabel(data),
      description: `${actor.name} ${nextActive ? "activated" : "deactivated"} the agent mapping for ${mappingLabel(data)}.`,
      safe_before: safeMapping(before),
      safe_after: safeMapping(data),
      metadata: {
        intercom_agent_name: data?.intercom_agent_name || null,
        employee_email: data?.employee_email || null,
        team_name: data?.team_name || null,
      },
    });

    return json({
      ok: true,
      message: nextActive ? "Mapping activated." : "Mapping deactivated.",
      mapping: data,
    });
  } catch (error) {
    await writeActivityLog(adminClient, request, actor, {
      action_type: "agent_mapping_status_failed",
      action_label: "Agent Mapping Status Failed",
      status: "failed",
      target_type: "agent_mapping",
      target_id: String(id),
      description: error instanceof Error ? error.message : "Could not update mapping status.",
      safe_after: {
        requested_is_active: nextActive,
      },
    });

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Could not update mapping status.",
      },
      { status: 500 }
    );
  }
}
