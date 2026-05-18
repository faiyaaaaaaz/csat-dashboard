export const PLATFORM_OWNER_EMAIL = "faiyaz@nextventures.io";

export const ROLE_KEYS = ["master_admin", "supervisor_admin", "co_admin", "audit_runner", "viewer"];

export const DEFAULT_ROLE_PERMISSIONS = {
  master_admin: {
    page_dashboard: true,
    page_results: true,
    page_run_audit: true,
    page_admin: true,
    audit_fetch_conversations: true,
    audit_run_ai: true,
    audit_specific_rerun: true,
    audit_bulk_run: true,
    results_view_all: true,
    results_edit_verdict: true,
    results_delete: true,
    results_export: true,
    disputes_submit_any: true,
    admin_disputes: true,
    disputes_review: true,
    admin_snippets: true,
    snippets_create: true,
    snippets_generate: true,
    snippets_activate: true,
    snippets_delete: true,
    admin_prompt: true,
    admin_supervisor_teams: true,
    admin_mappings: true,
    admin_activity_logs: true,
    activity_export: true,
    activity_sessions: true,
    admin_roles: false,
    admin_api_vault: false,
  },
  supervisor_admin: {
    page_dashboard: true,
    page_results: true,
    page_run_audit: false,
    page_admin: false,
    results_view_team: true,
    results_view_own: true,
    disputes_submit_team: true,
    disputes_submit_own: true,
  },
  co_admin: {
    page_dashboard: true,
    page_results: true,
    page_run_audit: false,
    page_admin: true,
    results_view_all: true,
    disputes_submit_any: true,
    admin_prompt: true,
    admin_supervisor_teams: true,
    admin_mappings: true,
    admin_disputes: false,
    admin_snippets: false,
    admin_activity_logs: false,
    admin_roles: false,
    admin_api_vault: false,
  },
  audit_runner: {
    page_dashboard: true,
    page_results: true,
    page_run_audit: true,
    page_admin: false,
    audit_fetch_conversations: true,
    audit_run_ai: true,
    audit_specific_rerun: true,
    audit_bulk_run: true,
    results_view_all: true,
    results_export: true,
    disputes_submit_own: true,
  },
  viewer: {
    page_dashboard: true,
    page_results: true,
    page_run_audit: false,
    page_admin: false,
    results_view_own: true,
    disputes_submit_own: true,
  },
};

export const OWNER_PERMISSIONS = {
  page_dashboard: true,
  page_results: true,
  page_run_audit: true,
  page_admin: true,
  audit_fetch_conversations: true,
  audit_run_ai: true,
  audit_specific_rerun: true,
  audit_bulk_run: true,
  results_view_all: true,
  results_view_team: true,
  results_view_own: true,
  results_edit_verdict: true,
  results_delete: true,
  results_export: true,
  disputes_submit_own: true,
  disputes_submit_team: true,
  disputes_submit_any: true,
  admin_disputes: true,
  disputes_review: true,
  admin_snippets: true,
  snippets_create: true,
  snippets_generate: true,
  snippets_activate: true,
  snippets_delete: true,
  admin_prompt: true,
  admin_supervisor_teams: true,
  admin_mappings: true,
  admin_activity_logs: true,
  activity_export: true,
  activity_sessions: true,
  admin_roles: true,
  admin_api_vault: true,
};

export function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

export function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

export function isPlatformOwnerEmail(email) {
  return normalizeEmail(email) === PLATFORM_OWNER_EMAIL;
}

export async function readRolePermissionRows(adminClient) {
  try {
    const { data, error } = await adminClient
      .from("role_permission_matrix")
      .select("role_key, permissions");

    if (error) return {};

    return Object.fromEntries(
      (Array.isArray(data) ? data : [])
        .filter((row) => row?.role_key)
        .map((row) => [row.role_key, row.permissions || {}])
    );
  } catch (_error) {
    return {};
  }
}

export function buildPermissionsForRole(email, role, permissionRows = {}) {
  if (isPlatformOwnerEmail(email)) return OWNER_PERMISSIONS;

  const roleKey = ROLE_KEYS.includes(normalizeKey(role)) ? normalizeKey(role) : "viewer";
  return {
    ...(DEFAULT_ROLE_PERMISSIONS[roleKey] || DEFAULT_ROLE_PERMISSIONS.viewer),
    ...(permissionRows?.[roleKey] || {}),
  };
}

export function hasPermission(auth, permissionKey) {
  if (isPlatformOwnerEmail(auth?.email)) return true;
  return auth?.permissions?.[permissionKey] === true;
}

function resultMatchesOwn(auth, result) {
  const actorEmail = normalizeEmail(auth?.email || auth?.profile?.email);
  const actorName = normalizeKey(auth?.profile?.full_name || auth?.user?.user_metadata?.full_name || auth?.user?.user_metadata?.name);
  const employeeEmail = normalizeEmail(result?.employee_email);
  const employeeName = normalizeKey(result?.employee_name);
  const agentName = normalizeKey(result?.agent_name);

  return Boolean(
    (actorEmail && employeeEmail && actorEmail === employeeEmail) ||
      (actorName && employeeName && actorName === employeeName) ||
      (actorName && agentName && actorName === agentName)
  );
}

export async function loadSupervisorTeamsForActor(adminClient, auth) {
  const actorEmail = normalizeEmail(auth?.email || auth?.profile?.email);
  const actorName = normalizeKey(auth?.profile?.full_name || auth?.user?.user_metadata?.full_name || auth?.user?.user_metadata?.name);

  const { data: teamsData, error: teamsError } = await adminClient
    .from("supervisor_teams")
    .select("id, supervisor_name, supervisor_email, is_active")
    .eq("is_active", true)
    .limit(1000);

  if (teamsError) throw new Error(teamsError.message || "Could not check Supervisor Team access.");

  const teams = (Array.isArray(teamsData) ? teamsData : []).filter((team) => {
    const supervisorEmail = normalizeEmail(team?.supervisor_email);
    const supervisorName = normalizeKey(team?.supervisor_name);
    return Boolean(
      (actorEmail && supervisorEmail && actorEmail === supervisorEmail) ||
        (actorName && supervisorName && actorName === supervisorName)
    );
  });

  const teamIds = teams.map((team) => team.id).filter(Boolean);
  if (!teamIds.length) return [];

  const { data: membersData, error: membersError } = await adminClient
    .from("supervisor_team_members")
    .select("id, supervisor_team_id, employee_name, employee_email, intercom_agent_name, team_name, is_active")
    .in("supervisor_team_id", teamIds)
    .eq("is_active", true)
    .limit(10000);

  if (membersError) throw new Error(membersError.message || "Could not check Supervisor Team members.");

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

export function resultMatchesSupervisorTeams(result, supervisorTeams) {
  const employeeEmail = normalizeEmail(result?.employee_email);
  const employeeName = normalizeKey(result?.employee_name);
  const agentName = normalizeKey(result?.agent_name);

  return (supervisorTeams || []).some((team) =>
    (team?.members || []).some((member) => {
      const memberEmail = normalizeEmail(member?.employee_email);
      const memberName = normalizeKey(member?.employee_name);
      const memberIntercom = normalizeKey(member?.intercom_agent_name);

      return Boolean(
        (employeeEmail && memberEmail && employeeEmail === memberEmail) ||
          (employeeName && memberName && employeeName === memberName) ||
          (agentName && memberIntercom && agentName === memberIntercom)
      );
    })
  );
}

export async function canActorDisputeResult(adminClient, auth, result) {
  if (hasPermission(auth, "disputes_submit_any")) {
    return { allowed: true, reason: isPlatformOwnerEmail(auth?.email) ? "platform_owner" : "permission_any" };
  }

  if (hasPermission(auth, "disputes_submit_team")) {
    const teams = await loadSupervisorTeamsForActor(adminClient, auth);
    if (resultMatchesSupervisorTeams(result, teams)) {
      return { allowed: true, reason: "permission_team" };
    }
  }

  if (hasPermission(auth, "disputes_submit_own") && resultMatchesOwn(auth, result)) {
    return { allowed: true, reason: "permission_own" };
  }

  return { allowed: false, reason: "permission_denied" };
}

export function filterResultsForActor(rows, auth, supervisorTeamsForActor = []) {
  if (hasPermission(auth, "results_view_all")) {
    return { rows: rows || [], visibility: isPlatformOwnerEmail(auth?.email) ? "owner_all_results" : "all_results" };
  }

  if (hasPermission(auth, "results_view_team")) {
    const scopedRows = (rows || []).filter((row) => resultMatchesSupervisorTeams(row, supervisorTeamsForActor));
    return { rows: scopedRows, visibility: "team_results" };
  }

  if (hasPermission(auth, "results_view_own")) {
    const scopedRows = (rows || []).filter((row) => resultMatchesOwn(auth, row));
    return { rows: scopedRows, visibility: "own_results" };
  }

  return { rows: [], visibility: "no_results_permission" };
}
