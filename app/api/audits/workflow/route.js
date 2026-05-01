import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MASTER_ADMIN_EMAIL = "faiyaz@nextventures.io";
const DEFAULT_BATCH_SIZE = 8;
const ACTIVE_STATUSES = new Set([
  "draft",
  "fetching",
  "fetched",
  "duplicate_checking",
  "paused_duplicate_decision",
  "auditing",
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

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
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

  if (error) return null;

  return data || null;
}

function buildFallbackProfile(user) {
  const email = normalizeEmail(user?.email);

  if (email === MASTER_ADMIN_EMAIL) {
    return {
      id: user.id,
      email,
      full_name: user.user_metadata?.full_name || "Faiyaz Muhtasim Ahmed",
      role: "master_admin",
      can_run_tests: true,
      is_active: true,
    };
  }

  return null;
}

function resolveEffectiveProfile({ user, email, profileData, grant }) {
  const fallbackProfile = buildFallbackProfile(user);
  const baseProfile = profileData || fallbackProfile;

  if (email === MASTER_ADMIN_EMAIL) {
    return {
      ...(baseProfile || {}),
      id: user.id,
      email,
      full_name: "Faiyaz Muhtasim Ahmed",
      role: "master_admin",
      can_run_tests: true,
      is_active: true,
    };
  }

  if (grant && grant.is_active !== false) {
    return {
      ...(baseProfile || {}),
      id: baseProfile?.id || user.id,
      email,
      full_name:
        normalizeText(grant.full_name) ||
        normalizeText(baseProfile?.full_name) ||
        normalizeText(user?.user_metadata?.full_name) ||
        normalizeText(user?.user_metadata?.name) ||
        email,
      role: normalizeText(grant.role) || "viewer",
      can_run_tests: Boolean(grant.can_run_tests),
      is_active: true,
    };
  }

  return baseProfile;
}

function canRunAudits(profile) {
  return Boolean(
    profile?.is_active === true &&
      (profile?.role === "master_admin" ||
        profile?.role === "admin" ||
        profile?.role === "audit_runner" ||
        profile?.can_run_tests === true)
  );
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

  const { data: profileData, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, can_run_tests, is_active")
    .or(`id.eq.${user.id},email.ilike.${email}`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (profileError) {
    return {
      ok: false,
      response: json({ ok: false, error: profileError.message || "Could not read profile." }, { status: 500 }),
    };
  }

  const grant = await readActiveRoleGrant(adminClient, email);
  const profile = resolveEffectiveProfile({ user, email, profileData, grant });

  if (!canRunAudits(profile)) {
    return {
      ok: false,
      response: json({ ok: false, error: "This account cannot run audits." }, { status: 403 }),
    };
  }

  return {
    ok: true,
    user,
    email,
    profile,
    adminClient,
  };
}

async function writeWorkflowEvent(adminClient, runId, event) {
  if (!runId) return;

  const { error } = await adminClient.from("audit_workflow_events").insert({
    run_id: runId,
    event_type: normalizeText(event.event_type) || "workflow_event",
    event_label: normalizeText(event.event_label) || "Workflow Event",
    status: normalizeText(event.status) || "info",
    actor_email: normalizeEmail(event.actor_email) || null,
    actor_name: normalizeText(event.actor_name) || null,
    actor_role: normalizeText(event.actor_role) || null,
    stage: normalizeText(event.stage) || null,
    target_type: normalizeText(event.target_type) || null,
    target_label: normalizeText(event.target_label) || null,
    details: normalizeText(event.details) || null,
    metadata: event.metadata || {},
  });

  if (error) {
    console.warn("[audit-workflow] event write failed", error);
  }
}

async function writeSystemLog(adminClient, request, actor, payload) {
  try {
    const meta = getRequestMeta(request);

    await adminClient.from("system_activity_logs").insert({
      actor_user_id: actor.user?.id || null,
      actor_email: actor.email || "unknown",
      actor_name: actor.profile?.full_name || actor.email,
      actor_role: actor.profile?.role || null,
      action_type: normalizeText(payload.action_type) || "audit_workflow_event",
      action_label: normalizeText(payload.action_label) || "Audit Workflow Event",
      area: "Run Audit",
      target_type: "Audit Workflow",
      target_id: payload.target_id || null,
      target_label: payload.target_label || null,
      status: normalizeText(payload.status) || "info",
      description: normalizeText(payload.description) || null,
      is_sensitive: false,
      safe_before: {},
      safe_after: payload.safe_after || {},
      metadata: payload.metadata || {},
      request_path: meta.request_path,
      ip_address: meta.ip_address,
      user_agent: meta.user_agent,
      session_id: null,
    });
  } catch (error) {
    console.warn("[audit-workflow] system log failed", error);
  }
}

function makeQueueRows(runId, conversations, batchSize = DEFAULT_BATCH_SIZE, startIndex = 0) {
  const list = Array.isArray(conversations) ? conversations : [];

  return list
    .map((item, index) => {
      const conversationId = normalizeText(item?.conversationId || item?.conversation_id || item?.id);
      if (!conversationId) return null;

      return {
        run_id: runId,
        sequence_no: startIndex + index + 1,
        batch_index: Math.floor((startIndex + index) / batchSize) + 1,
        conversation_id: conversationId,
        agent_name: normalizeText(item?.agentName || item?.agent_name) || null,
        client_email: normalizeText(item?.clientEmail || item?.client_email) || null,
        csat_score: normalizeText(item?.csatScore || item?.csat_score) || null,
        replied_at: item?.repliedAt || item?.replied_at || null,
        status: "queued",
      };
    })
    .filter(Boolean);
}

function getConversationIds(conversations) {
  return (Array.isArray(conversations) ? conversations : [])
    .map((item) => normalizeText(item?.conversationId || item?.conversation_id || item?.id))
    .filter(Boolean);
}
function mergeConversationsById(existing, incoming) {
  const map = new Map();

  for (const item of Array.isArray(existing) ? existing : []) {
    const id = normalizeText(item?.conversationId || item?.conversation_id || item?.id);
    if (id && !map.has(id)) map.set(id, item);
  }

  for (const item of Array.isArray(incoming) ? incoming : []) {
    const id = normalizeText(item?.conversationId || item?.conversation_id || item?.id);
    if (id && !map.has(id)) map.set(id, item);
  }

  return Array.from(map.values());
}


async function loadRunBundle(adminClient, runId) {
  if (!runId) return { run: null, queue: [], events: [] };

  const { data: run, error: runError } = await adminClient
    .from("audit_workflow_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();

  if (runError) throw new Error(runError.message || "Could not load workflow run.");

  const [{ data: queue, error: queueError }, { data: events, error: eventsError }] = await Promise.all([
    adminClient
      .from("audit_workflow_queue")
      .select("*")
      .eq("run_id", runId)
      .order("sequence_no", { ascending: true }),
    adminClient
      .from("audit_workflow_events")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: false })
      .limit(80),
  ]);

  if (queueError) throw new Error(queueError.message || "Could not load workflow queue.");
  if (eventsError) throw new Error(eventsError.message || "Could not load workflow events.");

  return {
    run: run || null,
    queue: Array.isArray(queue) ? queue : [],
    events: Array.isArray(events) ? events : [],
  };
}

async function updateRun(adminClient, runId, patch) {
  const { error } = await adminClient
    .from("audit_workflow_runs")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) throw new Error(error.message || "Could not update workflow run.");
}

export async function GET(request) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const runId = normalizeText(url.searchParams.get("run_id"));

    if (runId) {
      const bundle = await loadRunBundle(auth.adminClient, runId);
      return json({ ok: true, ...bundle });
    }

    const { data: run, error } = await auth.adminClient
      .from("audit_workflow_runs")
      .select("*")
      .eq("requested_by_email", auth.email)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message || "Could not load latest workflow run.");

    if (!run) return json({ ok: true, run: null, queue: [], events: [] });

    const bundle = await loadRunBundle(auth.adminClient, run.id);
    return json({ ok: true, ...bundle });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown workflow error." },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => ({}));
    const action = normalizeText(body.action);
    const now = new Date().toISOString();
    const actor = {
      user: auth.user,
      email: auth.email,
      profile: auth.profile,
    };

    if (action === "start_workflow") {
      const startDate = normalizeText(body.startDate);
      const endDate = normalizeText(body.endDate);
      const limiterEnabled = Boolean(body.limiterEnabled);
      const limitCount = body.limitCount === null || body.limitCount === undefined ? null : toInt(body.limitCount, null);
      const autoRunEnabled = Boolean(body.autoRunAfterFetch);
      const batchSize = toInt(body.batchSize, DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE;
      const filters = body.filters && typeof body.filters === "object" ? body.filters : {};

      const { data: run, error } = await auth.adminClient
        .from("audit_workflow_runs")
        .insert({
          requested_by_user_id: auth.user.id,
          requested_by_email: auth.email,
          requested_by_name: auth.profile?.full_name || auth.email,
          requested_by_role: auth.profile?.role || null,
          status: "fetching",
          stage: "fetch",
          status_message: `Fetching conversations for ${startDate} to ${endDate}.`,
          start_date: startDate || null,
          end_date: endDate || null,
          limiter_enabled: limiterEnabled,
          limit_count: limitCount,
          auto_run_enabled: autoRunEnabled,
          batch_size: batchSize,
          safe_payload: {
            datePreset: body.selectedDatePreset || null,
            filters,
            createdFrom: "run_audit_page",
          },
          last_heartbeat_at: now,
        })
        .select("*")
        .single();

      if (error) throw new Error(error.message || "Could not create workflow run.");

      await writeWorkflowEvent(auth.adminClient, run.id, {
        event_type: "workflow_started",
        event_label: "Workflow Started",
        status: "info",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "fetch",
        target_label: `${startDate} to ${endDate}`,
        details: `Fetch started for ${startDate} to ${endDate}.`,
        metadata: { limiterEnabled, limitCount, autoRunEnabled, batchSize, filters },
      });

      await writeSystemLog(auth.adminClient, request, actor, {
        action_type: "audit_workflow_started",
        action_label: "Audit Workflow Started",
        status: "info",
        target_id: run.id,
        target_label: `${startDate} to ${endDate}`,
        description: `${auth.profile?.full_name || auth.email} started a database-backed Run Audit workflow.`,
        safe_after: { startDate, endDate, limiterEnabled, limitCount, autoRunEnabled, filters },
      });

      return json({ ok: true, run });
    }

    const runId = normalizeText(body.run_id || body.runId);
    if (!runId) {
      return json({ ok: false, error: "Missing workflow run id." }, { status: 400 });
    }

    const { data: existingRun, error: runError } = await auth.adminClient
      .from("audit_workflow_runs")
      .select("*")
      .eq("id", runId)
      .maybeSingle();

    if (runError) throw new Error(runError.message || "Could not read workflow run.");
    if (!existingRun) return json({ ok: false, error: "Workflow run not found." }, { status: 404 });

    if (action === "fetch_completed") {
      const conversations = Array.isArray(body.conversations) ? body.conversations : [];
      const batchSize = toInt(existingRun.batch_size, DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE;
      const queueRows = makeQueueRows(runId, conversations, batchSize);
      const fetchedCount = toInt(body.fetchedCount ?? body.meta?.fetchedCount, conversations.length);
      const queuedCount = queueRows.length;
      const totalBatches = queuedCount ? Math.ceil(queuedCount / batchSize) : 0;
      const nextStatus = queuedCount > 0 ? "fetched" : "completed";

      await auth.adminClient.from("audit_workflow_queue").delete().eq("run_id", runId);

      if (queueRows.length) {
        const { error: insertError } = await auth.adminClient.from("audit_workflow_queue").insert(queueRows);
        if (insertError) throw new Error(insertError.message || "Could not save workflow queue.");
      }

      await updateRun(auth.adminClient, runId, {
        status: nextStatus,
        stage: nextStatus === "completed" ? "completed" : "fetch_completed",
        status_message: queuedCount
          ? `${queuedCount} conversation(s) fetched and queued.`
          : "Fetch completed with no conversations found.",
        fetched_count: fetchedCount,
        queued_count: queuedCount,
        total_batches: totalBatches,
        fetched_conversations: conversations,
        progress_percent: queuedCount ? 20 : 100,
        completed_at: queuedCount ? null : now,
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "fetch_completed",
        event_label: "Fetch Completed",
        status: queuedCount ? "success" : "info",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "fetch_completed",
        target_label: `${queuedCount} queued conversation(s)`,
        details: `${fetchedCount} conversation(s) returned. ${queuedCount} queued for audit.`,
        metadata: { fetchedCount, queuedCount, totalBatches, meta: body.meta || {} },
      });

      const bundle = await loadRunBundle(auth.adminClient, runId);
      return json({ ok: true, ...bundle });
    }

    if (action === "fetch_page_saved") {
      const conversations = Array.isArray(body.conversations) ? body.conversations : [];
      const batchSize = toInt(existingRun.batch_size, DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE;
      const incomingIds = getConversationIds(conversations);
      const done = Boolean(body.done);
      const fetchState = body.fetchState && typeof body.fetchState === "object" ? body.fetchState : null;
      const pageMeta = body.meta && typeof body.meta === "object" ? body.meta : {};

      const { data: existingQueue, error: existingQueueError } = await auth.adminClient
        .from("audit_workflow_queue")
        .select("conversation_id")
        .eq("run_id", runId)
        .order("sequence_no", { ascending: true });

      if (existingQueueError) throw new Error(existingQueueError.message || "Could not read workflow queue.");

      const existingQueueIds = new Set(
        (Array.isArray(existingQueue) ? existingQueue : [])
          .map((item) => normalizeText(item.conversation_id))
          .filter(Boolean)
      );

      const newConversations = conversations.filter((item) => {
        const id = normalizeText(item?.conversationId || item?.conversation_id || item?.id);
        return id && !existingQueueIds.has(id);
      });

      const startIndex = existingQueueIds.size;
      const queueRows = makeQueueRows(runId, newConversations, batchSize, startIndex);

      if (queueRows.length) {
        const { error: insertError } = await auth.adminClient.from("audit_workflow_queue").insert(queueRows);
        if (insertError) throw new Error(insertError.message || "Could not append workflow queue page.");
      }

      const existingConversations = Array.isArray(existingRun.fetched_conversations)
        ? existingRun.fetched_conversations
        : [];
      const mergedConversations = mergeConversationsById(existingConversations, newConversations);
      const fetchedCount = toInt(body.fetchedCount ?? pageMeta.fetchedCount, mergedConversations.length);
      const queuedCount = mergedConversations.length;
      const totalBatches = queuedCount ? Math.ceil(queuedCount / batchSize) : 0;
      const nextStatus = done ? (queuedCount > 0 ? "fetched" : "completed") : "fetching";
      const previousPayload = existingRun.safe_payload && typeof existingRun.safe_payload === "object"
        ? existingRun.safe_payload
        : {};

      await updateRun(auth.adminClient, runId, {
        status: nextStatus,
        stage: done ? (queuedCount > 0 ? "fetch_completed" : "completed") : "fetching_page",
        status_message: done
          ? queuedCount
            ? `${queuedCount} conversation(s) fetched and queued.`
            : "Fetch completed with no conversations found."
          : `${queuedCount} conversation(s) fetched so far. Fetch is still paging through Intercom.`,
        fetched_count: fetchedCount,
        queued_count: queuedCount,
        total_batches: totalBatches,
        fetched_conversations: mergedConversations,
        safe_payload: {
          ...previousPayload,
          fetch_pagination: {
            done,
            fetchState,
            lastMeta: pageMeta,
            updatedAt: now,
          },
        },
        progress_percent: done ? (queuedCount ? 20 : 100) : Math.max(Number(existingRun.progress_percent || 5), 10),
        completed_at: done && !queuedCount ? now : null,
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: done ? "fetch_completed" : "fetch_page_saved",
        event_label: done ? "Fetch Completed" : "Fetch Page Saved",
        status: done ? (queuedCount ? "success" : "info") : "info",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: done ? "fetch_completed" : "fetching",
        target_label: `${queuedCount} queued conversation(s)`,
        details: done
          ? `${queuedCount} total conversation(s) are ready in the audit queue.`
          : `${queueRows.length} new conversation(s) added. ${queuedCount} total conversation(s) fetched so far.`,
        metadata: {
          incomingIds,
          newCount: queueRows.length,
          queuedCount,
          fetchedCount,
          done,
          fetchState,
          pageMeta,
        },
      });

      const bundle = await loadRunBundle(auth.adminClient, runId);
      return json({ ok: true, ...bundle });
    }

    if (action === "update_queue") {
      const conversations = Array.isArray(body.conversations) ? body.conversations : [];
      const batchSize = toInt(existingRun.batch_size, DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE;
      const queueRows = makeQueueRows(runId, conversations, batchSize);
      const fetchedCount = toInt(body.fetchedCount, conversations.length);
      const queuedCount = queueRows.length;
      const totalBatches = queuedCount ? Math.ceil(queuedCount / batchSize) : 0;
      const reason = normalizeText(body.reason || "Queue updated from Run Audit page.");

      await auth.adminClient.from("audit_workflow_queue").delete().eq("run_id", runId);

      if (queueRows.length) {
        const { error: insertError } = await auth.adminClient.from("audit_workflow_queue").insert(queueRows);
        if (insertError) throw new Error(insertError.message || "Could not update workflow queue.");
      }

      await updateRun(auth.adminClient, runId, {
        status: queuedCount > 0 ? "fetched" : "completed",
        stage: queuedCount > 0 ? "queue_updated" : "queue_cleared",
        status_message: queuedCount > 0 ? `${queuedCount} conversation(s) currently queued.` : "Queue cleared.",
        fetched_count: fetchedCount,
        queued_count: queuedCount,
        total_batches: totalBatches,
        fetched_conversations: conversations,
        progress_percent: queuedCount ? Math.max(Number(existingRun.progress_percent || 20), 20) : 100,
        completed_at: queuedCount ? null : now,
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "queue_updated",
        event_label: "Queue Updated",
        status: queuedCount ? "info" : "warning",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "queue",
        target_label: `${queuedCount} queued conversation(s)`,
        details: reason,
        metadata: { fetchedCount, queuedCount, totalBatches },
      });

      const bundle = await loadRunBundle(auth.adminClient, runId);
      return json({ ok: true, ...bundle });
    }

    if (action === "duplicate_check_completed") {
      const duplicateSummary = body.duplicateSummary || body.duplicate_summary || null;
      const duplicateCount = toInt(duplicateSummary?.duplicateCount || body.duplicateCount, 0);
      const paused = Boolean(body.paused);

      await updateRun(auth.adminClient, runId, {
        status: paused ? "paused_duplicate_decision" : "duplicate_checking",
        stage: paused ? "duplicate_decision" : "duplicate_check_completed",
        status_message: paused
          ? `${duplicateCount} duplicate conversation(s) need a decision.`
          : `Duplicate check completed. ${duplicateCount} duplicate(s) found.`,
        duplicate_count: duplicateCount,
        duplicate_summary: duplicateSummary,
        progress_percent: paused ? 25 : Math.max(Number(existingRun.progress_percent || 0), 25),
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "duplicate_check_completed",
        event_label: "Duplicate Check Completed",
        status: paused ? "warning" : "info",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "duplicate_check",
        target_label: `${duplicateCount} duplicate(s)`,
        details: paused
          ? `${duplicateCount} duplicate conversation(s) need a decision.`
          : `Duplicate check completed with ${duplicateCount} duplicate(s).`,
        metadata: { duplicateSummary, paused },
      });

      return json({ ok: true, ...(await loadRunBundle(auth.adminClient, runId)) });
    }

    if (action === "audit_started") {
      const queuedCount = toInt(body.queuedCount, existingRun.queued_count || 0);
      const totalBatches = toInt(body.totalBatches, existingRun.total_batches || 0);
      const duplicateMode = normalizeText(body.duplicateMode || existingRun.duplicate_mode || "none");

      await updateRun(auth.adminClient, runId, {
        status: "auditing",
        stage: "audit_started",
        status_message: `Audit started for ${queuedCount} conversation(s).`,
        queued_count: queuedCount,
        total_batches: totalBatches,
        duplicate_mode: duplicateMode,
        progress_percent: Math.max(Number(existingRun.progress_percent || 0), 30),
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "audit_started",
        event_label: "Audit Started",
        status: "info",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "audit",
        target_label: `${queuedCount} conversation(s)`,
        details: `Audit started with duplicate mode ${duplicateMode}.`,
        metadata: { queuedCount, totalBatches, duplicateMode },
      });

      return json({ ok: true, ...(await loadRunBundle(auth.adminClient, runId)) });
    }

    if (action === "batch_started") {
      const batchIndex = toInt(body.batchIndex, 0);
      const totalBatches = toInt(body.totalBatches, existingRun.total_batches || 0);
      const batchConversationIds = getConversationIds(body.batchConversations || body.batch);

      if (batchConversationIds.length) {
        await auth.adminClient
          .from("audit_workflow_queue")
          .update({ status: "processing", updated_at: now })
          .eq("run_id", runId)
          .in("conversation_id", batchConversationIds);
      }

      await updateRun(auth.adminClient, runId, {
        status: "auditing",
        stage: "batch_started",
        current_batch_index: batchIndex,
        total_batches: totalBatches,
        status_message: `Batch ${batchIndex} of ${totalBatches} started.`,
        progress_percent: Math.max(Number(existingRun.progress_percent || 0), 30),
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "batch_started",
        event_label: "Batch Started",
        status: "info",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "audit_batch",
        target_label: `Batch ${batchIndex} of ${totalBatches}`,
        details: `Batch ${batchIndex} started with ${batchConversationIds.length} conversation(s).`,
        metadata: { batchIndex, totalBatches, conversationIds: batchConversationIds },
      });

      return json({ ok: true });
    }

    if (action === "batch_completed") {
      const batchIndex = toInt(body.batchIndex, existingRun.current_batch_index || 0);
      const totalBatches = toInt(body.totalBatches, existingRun.total_batches || 0);
      const handled = toInt(body.handled, existingRun.handled_count || 0);
      const savedRows = toInt(body.savedRows, existingRun.saved_count || 0);
      const skippedRows = toInt(body.skippedRows, existingRun.skipped_count || 0);
      const failedRows = toInt(body.failedRows, existingRun.error_count || 0);
      const mappedCount = toInt(body.mappedCount, existingRun.mapped_count || 0);
      const unmappedCount = toInt(body.unmappedCount, existingRun.unmapped_count || 0);
      const storedRunIds = Array.isArray(body.storedRunIds) ? body.storedRunIds : [];
      const batchConversationIds = getConversationIds(body.batchConversations || body.batch);
      const progress = existingRun.queued_count
        ? Math.min(99, Math.round((handled / Number(existingRun.queued_count || handled || 1)) * 100))
        : Math.min(99, Math.round((batchIndex / Math.max(totalBatches, 1)) * 100));

      if (batchConversationIds.length) {
        await auth.adminClient
          .from("audit_workflow_queue")
          .update({ status: "completed", updated_at: now })
          .eq("run_id", runId)
          .in("conversation_id", batchConversationIds);
      }

      await updateRun(auth.adminClient, runId, {
        status: "auditing",
        stage: "batch_completed",
        current_batch_index: batchIndex,
        total_batches: totalBatches,
        handled_count: handled,
        saved_count: savedRows,
        skipped_count: skippedRows,
        error_count: failedRows,
        mapped_count: mappedCount,
        unmapped_count: unmappedCount,
        latest_audit_run_ids: storedRunIds,
        progress_percent: progress,
        status_message: `Batch ${batchIndex} of ${totalBatches} completed.`,
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "batch_completed",
        event_label: "Batch Completed",
        status: "success",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "audit_batch",
        target_label: `Batch ${batchIndex} of ${totalBatches}`,
        details: `Batch ${batchIndex} completed. ${handled} total conversation(s) handled so far.`,
        metadata: {
          batchIndex,
          totalBatches,
          handled,
          savedRows,
          skippedRows,
          failedRows,
          mappedCount,
          unmappedCount,
          storedRunIds,
        },
      });

      return json({ ok: true });
    }

    if (action === "audit_completed") {
      const meta = body.meta || {};
      const handledCount = toInt(meta.handledCount ?? body.handledCount, existingRun.handled_count || 0);
      const savedCount = toInt(meta.auditedCount ?? body.savedCount, existingRun.saved_count || 0);
      const skippedCount = toInt(meta.skippedCount ?? body.skippedCount, existingRun.skipped_count || 0);
      const errorCount = toInt(meta.errorCount ?? body.errorCount, existingRun.error_count || 0);
      const mappedCount = toInt(meta.mappedCount ?? body.mappedCount, existingRun.mapped_count || 0);
      const unmappedCount = toInt(meta.unmappedCount ?? body.unmappedCount, existingRun.unmapped_count || 0);
      const storedRunIds = Array.isArray(meta.storedRunIds) ? meta.storedRunIds : [];

      await auth.adminClient
        .from("audit_workflow_queue")
        .update({ status: "completed", updated_at: now })
        .eq("run_id", runId)
        .in("status", ["queued", "processing"]);

      await updateRun(auth.adminClient, runId, {
        status: "completed",
        stage: "completed",
        status_message: `Audit completed. ${savedCount} result row(s) returned.`,
        handled_count: handledCount,
        saved_count: savedCount,
        skipped_count: skippedCount,
        error_count: errorCount,
        mapped_count: mappedCount,
        unmapped_count: unmappedCount,
        latest_audit_run_ids: storedRunIds,
        progress_percent: 100,
        completed_at: now,
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "audit_completed",
        event_label: "Audit Completed",
        status: errorCount ? "warning" : "success",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "completed",
        target_label: `${savedCount} result row(s)`,
        details: `Audit completed with ${savedCount} result row(s), ${skippedCount} skipped, and ${errorCount} error(s).`,
        metadata: meta,
      });

      await writeSystemLog(auth.adminClient, request, actor, {
        action_type: "audit_workflow_completed",
        action_label: "Audit Workflow Completed",
        status: errorCount ? "warning" : "success",
        target_id: runId,
        target_label: `${savedCount} result row(s)`,
        description: `${auth.profile?.full_name || auth.email} completed a database-backed Run Audit workflow.`,
        safe_after: { handledCount, savedCount, skippedCount, errorCount, mappedCount, unmappedCount },
      });

      return json({ ok: true, ...(await loadRunBundle(auth.adminClient, runId)) });
    }

    if (action === "workflow_failed") {
      const message = normalizeText(body.error || body.message || "Workflow failed.");

      await updateRun(auth.adminClient, runId, {
        status: "failed",
        stage: "failed",
        status_message: message,
        error_message: message,
        failed_at: now,
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "workflow_failed",
        event_label: "Workflow Failed",
        status: "failed",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "failed",
        target_label: "Run Audit",
        details: message,
        metadata: body.metadata || {},
      });

      return json({ ok: true, ...(await loadRunBundle(auth.adminClient, runId)) });
    }

    if (action === "workflow_cancelled") {
      const message = normalizeText(body.message || "Workflow cancelled by user.");

      await updateRun(auth.adminClient, runId, {
        status: "cancelled",
        stage: "cancelled",
        status_message: message,
        cancelled_at: now,
      });

      await writeWorkflowEvent(auth.adminClient, runId, {
        event_type: "workflow_cancelled",
        event_label: "Workflow Cancelled",
        status: "cancelled",
        actor_email: auth.email,
        actor_name: auth.profile?.full_name,
        actor_role: auth.profile?.role,
        stage: "cancelled",
        target_label: "Run Audit",
        details: message,
        metadata: body.metadata || {},
      });

      return json({ ok: true, ...(await loadRunBundle(auth.adminClient, runId)) });
    }

    if (action === "heartbeat") {
      await updateRun(auth.adminClient, runId, {
        last_heartbeat_at: now,
      });

      return json({ ok: true });
    }

    return json({ ok: false, error: "Unsupported workflow action." }, { status: 400 });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown workflow error." },
      { status: 500 }
    );
  }
}
