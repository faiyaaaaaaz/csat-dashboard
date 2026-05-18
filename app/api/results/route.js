import { createClient } from "@supabase/supabase-js";
import {
  PLATFORM_OWNER_EMAIL,
  buildPermissionsForRole,
  filterResultsForActor,
  hasPermission,
  loadSupervisorTeamsForActor,
  normalizeEmail as normalizePermissionEmail,
  readRolePermissionRows,
} from "../../../lib/permissionRules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MASTER_ADMIN_EMAIL = PLATFORM_OWNER_EMAIL;
const PAGE_SIZE = 1000;
const MAX_RESULT_ROWS = 50000;
const MAX_RUN_ROWS = 10000;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
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

  if (email.endsWith("@nextventures.io")) {
    return {
      id: user.id,
      email,
      full_name:
        normalizeText(user.user_metadata?.full_name) ||
        normalizeText(user.user_metadata?.name) ||
        email,
      role: "viewer",
      can_run_tests: false,
      is_active: true,
    };
  }

  return null;
}

function canReadResults(profile) {
  return profile?.is_active === true;
}

function canManageResults(profile, email, permissions = {}) {
  return Boolean(email === MASTER_ADMIN_EMAIL || permissions.results_delete === true);
}

function isSupervisorScoped(profile, email) {
  return false;
}

function uniqueValues(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function chunkArray(items, size = 500) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function toTime(value) {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function sortResultsForArchive(rows) {
  return [...(rows || [])].sort((a, b) => {
    const bSavedAt = toTime(b?.created_at);
    const aSavedAt = toTime(a?.created_at);

    if (bSavedAt !== aSavedAt) return bSavedAt - aSavedAt;

    const bReplyAt = toTime(b?.replied_at);
    const aReplyAt = toTime(a?.replied_at);

    return bReplyAt - aReplyAt;
  });
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

function createClients() {
  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    throw new Error("Missing required Supabase environment variables.");
  }

  return {
    authClient: createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    adminClient: createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

async function authenticate(request) {
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

  const { authClient, adminClient } = createClients();

  const {
    data: { user },
    error: userError,
  } = await authClient.auth.getUser(token);

  if (userError || !user) {
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

  const { data: profileById, error: idError } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, can_run_tests, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (idError) {
    throw new Error(idError.message || "Could not load profile.");
  }

  let profile = profileById || null;

  if (!profile) {
    const { data: profileByEmail, error: emailError } = await adminClient
      .from("profiles")
      .select("id, email, full_name, role, can_run_tests, is_active")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();

    if (emailError) {
      throw new Error(emailError.message || "Could not load profile by email.");
    }

    profile = profileByEmail || null;
  }

  profile = profile || buildFallbackProfile(user);

  if (email === MASTER_ADMIN_EMAIL) {
    profile = {
      ...(profile || {}),
      id: user.id,
      email,
      full_name: profile?.full_name || "Faiyaz Muhtasim Ahmed",
      role: "master_admin",
      can_run_tests: true,
      is_active: true,
    };
  }

  if (!canReadResults(profile)) {
    return {
      ok: false,
      response: json(
        { ok: false, error: "This account does not have permission to view stored results." },
        { status: 403 }
      ),
    };
  }

  const permissionRows = await readRolePermissionRows(adminClient);
  const permissions = buildPermissionsForRole(email, profile?.role, permissionRows);

  return { ok: true, user, email, profile, permissions, adminClient };
}

async function writeActivityLog(adminClient, request, auth, payload) {
  try {
    const meta = getRequestMeta(request);
    const profile = auth?.profile || {};
    const user = auth?.user || {};
    const email = normalizeEmail(auth?.email || profile?.email || user?.email);

    await adminClient.from("system_activity_logs").insert({
      actor_user_id: user?.id || profile?.id || null,
      actor_email: email || "unknown",
      actor_name:
        normalizeText(profile?.full_name) ||
        normalizeText(user?.user_metadata?.full_name) ||
        normalizeText(user?.user_metadata?.name) ||
        email ||
        null,
      actor_role: email === MASTER_ADMIN_EMAIL ? "master_admin" : normalizeText(profile?.role) || "viewer",
      action_type: normalizeText(payload.action_type) || "results_action",
      action_label: normalizeText(payload.action_label) || "Results Action",
      area: normalizeText(payload.area) || "Results",
      target_type: normalizeText(payload.target_type) || null,
      target_id: normalizeText(payload.target_id) || null,
      target_label: normalizeText(payload.target_label) || null,
      status: normalizeText(payload.status) || "success",
      description: normalizeText(payload.description) || null,
      is_sensitive: Boolean(payload.is_sensitive),
      safe_before: payload.safe_before || {},
      safe_after: payload.safe_after || {},
      metadata: payload.metadata || {},
      request_path: meta.request_path,
      ip_address: meta.ip_address,
      user_agent: meta.user_agent,
      session_id: payload.session_id || null,
    });
  } catch (error) {
    console.warn("[activity-log] results log failed", error);
  }
}

async function loadSupervisorTeams(adminClient, { scopedProfile = null, scopedEmail = "" } = {}) {
  const { data: teamsData, error: teamsError } = await adminClient
    .from("supervisor_teams")
    .select("id, supervisor_name, supervisor_email, notes, is_active, created_at, updated_at")
    .eq("is_active", true)
    .order("supervisor_name", { ascending: true })
    .limit(1000);

  if (teamsError) {
    throw new Error(teamsError.message || "Could not load Supervisor Teams.");
  }

  const shouldScope = Boolean(scopedProfile && scopedEmail);
  const scopedEmailKey = normalizeEmail(scopedEmail);
  const scopedNameKey = normalizeKey(scopedProfile?.full_name);
  const allTeams = Array.isArray(teamsData) ? teamsData : [];
  const teams = shouldScope
    ? allTeams.filter((team) => {
        const teamEmailKey = normalizeEmail(team?.supervisor_email);
        const teamNameKey = normalizeKey(team?.supervisor_name);

        return Boolean(
          (scopedEmailKey && teamEmailKey === scopedEmailKey) ||
            (scopedNameKey && teamNameKey === scopedNameKey)
        );
      })
    : allTeams;

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

function buildSupervisorScope(teams) {
  const employeeEmails = new Set();
  const employeeNames = new Set();
  const intercomNames = new Set();

  for (const team of teams || []) {
    for (const member of team?.members || []) {
      const email = normalizeEmail(member?.employee_email);
      const name = normalizeKey(member?.employee_name);
      const intercom = normalizeKey(member?.intercom_agent_name);

      if (email) employeeEmails.add(email);
      if (name) employeeNames.add(name);
      if (intercom) intercomNames.add(intercom);
    }
  }

  return { employeeEmails, employeeNames, intercomNames };
}

function rowMatchesSupervisorScope(row, scope) {
  const employeeEmail = normalizeEmail(row?.employee_email);
  const employeeName = normalizeKey(row?.employee_name);
  const agentName = normalizeKey(row?.agent_name);

  return Boolean(
    (employeeEmail && scope.employeeEmails.has(employeeEmail)) ||
      (employeeName && scope.employeeNames.has(employeeName)) ||
      (agentName && scope.intercomNames.has(agentName))
  );
}

function applySupervisorScope(rows, teams) {
  const scope = buildSupervisorScope(teams);
  const hasScope = scope.employeeEmails.size || scope.employeeNames.size || scope.intercomNames.size;

  if (!hasScope) return [];

  return (rows || []).filter((row) => rowMatchesSupervisorScope(row, scope));
}

async function fetchAllAuditResults(adminClient) {
  const allRows = [];
  let from = 0;

  while (from < MAX_RESULT_ROWS) {
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await adminClient
      .from("audit_results")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      throw new Error(error.message || "Could not load audit results.");
    }

    const rows = Array.isArray(data) ? data : [];
    allRows.push(...rows);

    if (rows.length < PAGE_SIZE) break;

    from += PAGE_SIZE;
  }

  return allRows;
}

async function fetchRunsForResults(adminClient, results) {
  const runIds = uniqueValues((results || []).map((row) => row?.run_id));

  if (!runIds.length) return [];

  const allRuns = [];

  for (const chunk of chunkArray(runIds, 500)) {
    const { data, error } = await adminClient
      .from("audit_runs")
      .select("*")
      .in("id", chunk)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message || "Could not load audit runs.");
    }

    allRuns.push(...(Array.isArray(data) ? data : []));
  }

  return allRuns
    .sort((a, b) => toTime(b?.created_at) - toTime(a?.created_at))
    .slice(0, MAX_RUN_ROWS);
}

async function countTableRows(adminClient, tableName) {
  const { count, error } = await adminClient
    .from(tableName)
    .select("id", { count: "exact", head: true });

  if (error) return null;

  return Number.isFinite(count) ? count : null;
}

export async function GET(request) {
  try {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const { adminClient, email, profile, permissions } = auth;

    if (!hasPermission(auth, "page_results")) {
      return json({ ok: false, error: "This account does not have permission to view Results." }, { status: 403 });
    }

    const [allSupervisorTeams, supervisorTeamsForActor, totalResultsCount, rawResults] = await Promise.all([
      loadSupervisorTeams(adminClient),
      loadSupervisorTeamsForActor(adminClient, auth),
      countTableRows(adminClient, "audit_results"),
      fetchAllAuditResults(adminClient),
    ]);

    const scoped = filterResultsForActor(rawResults, auth, supervisorTeamsForActor);
    if (scoped.visibility === "no_results_permission") {
      return json({ ok: false, error: "This account does not have permission to view stored results." }, { status: 403 });
    }

    const results = sortResultsForArchive(scoped.rows);
    const runs = await fetchRunsForResults(adminClient, results);
    const visibleSupervisorTeams = hasPermission(auth, "results_view_all") ? allSupervisorTeams : supervisorTeamsForActor;

    const uniqueConversationCount = uniqueValues(
      results.map((row) => row?.conversation_id)
    ).length;

    return json({
      ok: true,
      runs,
      results,
      supervisorTeams: visibleSupervisorTeams,
      meta: {
        requestedBy: email,
        role: profile?.role || "viewer",
        permissions,
        scopedToSupervisorTeams: scoped.visibility === "team_results",
        supervisorTeamCount: visibleSupervisorTeams.length,
        runsCount: runs.length,
        resultsCount: results.length,
        uniqueConversationCount,
        totalResultsCount,
        resultRowsReturnedCap: MAX_RESULT_ROWS,
        truncated:
          typeof totalResultsCount === "number"
            ? rawResults.length < totalResultsCount
            : rawResults.length >= MAX_RESULT_ROWS,
        visibility: scoped.visibility,
        source: "server_api_results_route_permission_scoped_paginated",
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

export async function DELETE(request) {
  let auth = null;
  let selectedIds = [];

  try {
    auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const { adminClient, email, profile } = auth;

    if (!canManageResults(profile, email, auth.permissions)) {
      await writeActivityLog(adminClient, request, auth, {
        action_type: "results_delete_failed",
        action_label: "Results Delete Failed",
        area: "Results",
        target_type: "audit_results",
        status: "failed",
        description: "Permission denied while deleting stored Results.",
      });

      return json(
        { ok: false, error: "This account does not have permission to delete stored results." },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    selectedIds = Array.isArray(body?.ids)
      ? body.ids.map((id) => normalizeText(id)).filter(Boolean)
      : [];

    if (!selectedIds.length) {
      return json({ ok: false, error: "Select at least one stored result first." }, { status: 400 });
    }

    const { data: selectedRows, error: selectedError } = await adminClient
      .from("audit_results")
      .select("id, run_id, conversation_id, employee_name, employee_email, agent_name")
      .in("id", selectedIds);

    if (selectedError) {
      throw new Error(selectedError.message || "Could not verify Selected results.");
    }

    const targetRunIds = uniqueValues((selectedRows || []).map((item) => item.run_id));
    const sampleConversationIds = (selectedRows || [])
      .map((item) => item.conversation_id)
      .filter(Boolean)
      .slice(0, 25);

    const { error: deleteResultsError } = await adminClient
      .from("audit_results")
      .delete()
      .in("id", selectedIds);

    if (deleteResultsError) {
      throw new Error(deleteResultsError.message || "Could not delete Selected results.");
    }

    let deletedEmptyRuns = 0;

    if (targetRunIds.length) {
      const { data: remainingRows, error: remainingError } = await adminClient
        .from("audit_results")
        .select("run_id")
        .in("run_id", targetRunIds);

      if (remainingError) {
        throw new Error(remainingError.message || "Could not verify remaining run records.");
      }

      const remainingRunSet = new Set((remainingRows || []).map((item) => item.run_id).filter(Boolean));
      const emptyRunIds = targetRunIds.filter((id) => !remainingRunSet.has(id));

      if (emptyRunIds.length) {
        const { error: deleteRunsError } = await adminClient
          .from("audit_runs")
          .delete()
          .in("id", emptyRunIds);

        if (deleteRunsError) {
          throw new Error(deleteRunsError.message || "Could not clean up empty runs.");
        }

        deletedEmptyRuns = emptyRunIds.length;
      }
    }

    await writeActivityLog(adminClient, request, auth, {
      action_type: "results_deleted",
      action_label: "Results Deleted",
      area: "Results",
      target_type: "audit_results",
      target_label: `${selectedIds.length} result(s)`,
      status: "success",
      description: "Stored Results were deleted from the Results archive.",
      safe_before: {
        selected_result_count: selectedIds.length,
        selected_run_count: targetRunIds.length,
        sample_conversation_ids: sampleConversationIds,
      },
      safe_after: {
        deleted_result_count: selectedIds.length,
        deleted_empty_run_count: deletedEmptyRuns,
      },
    });

    return json({
      ok: true,
      message: `${selectedIds.length} stored result(s) deleted.`,
      deletedResults: selectedIds.length,
      deletedEmptyRuns,
    });
  } catch (error) {
    if (auth?.adminClient) {
      await writeActivityLog(auth.adminClient, request, auth, {
        action_type: "results_delete_failed",
        action_label: "Results Delete Failed",
        area: "Results",
        target_type: "audit_results",
        target_label: selectedIds.length ? `${selectedIds.length} result(s)` : null,
        status: "failed",
        description: error instanceof Error ? error.message : "Could not delete Selected results.",
        safe_before: {
          selected_result_count: selectedIds.length,
        },
      });
    }

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Could not delete Selected results.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const { adminClient } = auth;
    const body = await request.json().catch(() => ({}));
    const action = normalizeKey(body?.action);

    if (action !== "export_filtered") {
      return json({ ok: false, error: "Unsupported Results action." }, { status: 400 });
    }

    const exportedCount = Number(body?.exportedCount || 0);
    const filterSummary = body?.filterSummary && typeof body.filterSummary === "object"
      ? body.filterSummary
      : {};

    await writeActivityLog(adminClient, request, auth, {
      action_type: "results_exported",
      action_label: "Results Exported",
      area: "Results",
      target_type: "audit_results_export",
      target_label: `${exportedCount} result(s)`,
      status: "success",
      description: "Filtered Results were exported from the Results archive.",
      safe_after: {
        exported_count: exportedCount,
        filters: filterSummary,
      },
    });

    return json({ ok: true });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Could not log Results action.",
      },
      { status: 500 }
    );
  }
}
