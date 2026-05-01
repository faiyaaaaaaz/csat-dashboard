import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INTERCOM_PER_PAGE = 150;
const MAX_FETCH_PAGES_PER_DAY = 50;
const DEFAULT_CONVERSATION_RATINGS = [3, 4, 5];

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

function getKeyFingerprint(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "missing";
  if (cleaned.length <= 8) return cleaned;
  return `${cleaned.slice(0, 6)}...${cleaned.slice(-6)}`;
}

async function loadActiveApiKey({ adminClient, keyType, envName, displayName }) {
  const { data, error } = await adminClient
    .from("api_keys")
    .select("secret_value, masked_value, updated_at")
    .eq("key_type", keyType)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error && error.code !== "42P01") {
    throw new Error(error.message || `Could not load active ${displayName} API key.`);
  }

  const savedSecret = String(data?.[0]?.secret_value || "").trim();

  if (savedSecret) {
    return {
      value: savedSecret,
      source: "admin_api_key_vault",
      fingerprint: data?.[0]?.masked_value || getKeyFingerprint(savedSecret),
    };
  }

  const fallbackSecret = getEnv(envName);

  if (fallbackSecret) {
    return {
      value: fallbackSecret,
      source: "vercel_env_fallback",
      fingerprint: getKeyFingerprint(fallbackSecret),
    };
  }

  throw new Error(
    `No active ${displayName} API key found. Save it in Admin -> API key vault first.`
  );
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeNumberSelections(values, fallback = []) {
  const source = Array.isArray(values) ? values : fallback;
  const result = [];

  for (const value of source || []) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text || text === "all" || text === "any") return [];
    const number = Number(text);
    if (Number.isInteger(number) && number >= 1 && number <= 5 && !result.includes(number)) {
      result.push(number);
    }
  }

  return result.sort((a, b) => a - b);
}

function normalizeTextSelections(values) {
  return Array.from(
    new Set((Array.isArray(values) ? values : []).map((value) => normalizeText(value)).filter(Boolean))
  );
}

function numberMatchesFilter(value, selectedNumbers) {
  if (!Array.isArray(selectedNumbers) || selectedNumbers.length === 0) return true;
  const number = Number(value);
  return Number.isFinite(number) && selectedNumbers.includes(number);
}

function textMatchesFilter(value, selectedValues) {
  if (!Array.isArray(selectedValues) || selectedValues.length === 0) return true;
  const key = normalizeKey(value);
  if (!key) return false;
  const selected = new Set(selectedValues.map(normalizeKey));
  return selected.has(key);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function isClearlyUnassignedAgent(value) {
  const key = normalizeKey(value);
  return !key || key === "unassigned" || key === "unknown" || key === "-";
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

  if (error) {
    console.warn("[activity-log] role grant lookup failed", error);
    return null;
  }

  return data || null;
}

function buildFallbackProfile(user) {
  const email = normalizeEmail(user?.email);

  if (email === "faiyaz@nextventures.io") {
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

  if (email === "faiyaz@nextventures.io") {
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

async function writeActivityLog(adminClient, request, payload) {
  try {
    const meta = getRequestMeta(request);

    await adminClient.from("system_activity_logs").insert({
      actor_user_id: payload.actor_user_id || null,
      actor_email: normalizeEmail(payload.actor_email) || "unknown",
      actor_name: normalizeText(payload.actor_name) || null,
      actor_role: normalizeText(payload.actor_role) || null,
      action_type: normalizeText(payload.action_type) || "system_action",
      action_label: normalizeText(payload.action_label) || "System Action",
      area: normalizeText(payload.area) || "Audit Workflow",
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
    console.warn("[activity-log] audit fetch log failed", error);
  }
}

function parseDateInput(dateStr) {
  const value = String(dateStr || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Dates must be in YYYY-MM-DD format.");
  }

  const [year, month, day] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    throw new Error("Invalid date provided.");
  }

  return { year, month, day };
}

function enumerateDateRange(startDate, endDate) {
  const start = parseDateInput(startDate);
  const end = parseDateInput(endDate);

  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);

  if (startUtc > endUtc) {
    throw new Error("Start date cannot be later than end date.");
  }

  const dates = [];
  let current = new Date(startUtc);

  while (current.getTime() <= endUtc) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, "0");
    const d = String(current.getUTCDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function dhakaDayBounds(dateStr) {
  const { year, month, day } = parseDateInput(dateStr);

  const start = new Date(
    `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+06:00`
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return {
    sinceTs: Math.floor(start.getTime() / 1000),
    untilTs: Math.floor(end.getTime() / 1000),
  };
}

function normalizeIntercomTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1000000000000) return new Date(value).toISOString();
    if (value > 1000000000) return new Date(value * 1000).toISOString();
  }

  const text = String(value).trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1000000000000) return new Date(numeric).toISOString();
    if (numeric > 1000000000) return new Date(numeric * 1000).toISOString();
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function intercomGet({ intercomApiKey, path }) {
  const response = await fetch(`https://api.intercom.io${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Intercom-Version": "2.12",
      Authorization: `Bearer ${intercomApiKey}`,
    },
    cache: "no-store",
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(`Intercom GET ${path} failed with status ${response.status}: ${text.slice(0, 800)}`);
  }

  return data;
}

async function loadIntercomAdmins(intercomApiKey) {
  try {
    const data = await intercomGet({ intercomApiKey, path: "/admins" });
    const admins = Array.isArray(data?.admins)
      ? data.admins
      : Array.isArray(data?.data)
      ? data.data
      : [];

    return admins
      .map((admin) => ({
        id: String(admin?.id || "").trim(),
        name: normalizeText(admin?.name),
        email: normalizeEmail(admin?.email),
      }))
      .filter((admin) => admin.id && (admin.name || admin.email));
  } catch (error) {
    console.warn("[intercom] Could not load admins for assignee filtering", error);
    return [];
  }
}

function buildAdminLookup(admins) {
  const byId = new Map();
  const byName = new Map();
  const byEmail = new Map();

  for (const admin of admins || []) {
    if (admin.id) byId.set(String(admin.id), admin);
    if (admin.name) byName.set(normalizeKey(admin.name), admin);
    if (admin.email) byEmail.set(normalizeEmail(admin.email), admin);
  }

  return { byId, byName, byEmail };
}

function resolveSelectedAdminIds(selectedIntercomAgentNames, adminLookup) {
  const selected = normalizeTextSelections(selectedIntercomAgentNames);
  const ids = [];
  const unresolved = [];

  for (const value of selected) {
    const key = normalizeKey(value);
    const emailKey = normalizeEmail(value);
    const match = adminLookup.byName.get(key) || adminLookup.byEmail.get(emailKey) || adminLookup.byId.get(value);

    if (match?.id && !ids.includes(Number(match.id))) {
      const numberId = Number(match.id);
      ids.push(Number.isFinite(numberId) ? numberId : match.id);
    } else {
      unresolved.push(value);
    }
  }

  return { ids, unresolved };
}

function getAgentNameFromConversation(conversation, adminLookup) {
  const adminId = firstNonEmpty(conversation?.admin_assignee_id, conversation?.assignee?.id);
  const adminFromId = adminId ? adminLookup?.byId?.get(String(adminId)) : null;

  if (adminFromId?.name) return adminFromId.name;

  const parts = Array.isArray(conversation?.conversation_parts?.conversation_parts)
    ? conversation.conversation_parts.conversation_parts
    : [];

  const directName = firstNonEmpty(
    conversation?.assignee?.name,
    conversation?.admin_assignee?.name,
    conversation?.teammate_assignee?.name,
    conversation?.conversation_rating?.teammate?.name
  );

  if (directName) return directName;

  if (parts.length) {
    const adminParts = parts
      .filter((part) => ["admin", "teammate", "team_member"].includes(part?.author?.type))
      .sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));

    return firstNonEmpty(adminParts?.[0]?.author?.name, adminParts?.[0]?.author?.email);
  }

  return "Unassigned";
}

function extractConversationPreview(conversation, adminLookup) {
  const conversationRating =
    conversation?.conversation_rating?.score ??
    conversation?.conversation_rating?.rating ??
    conversation?.conversation_rating?.value ??
    "";

  return {
    conversationId: String(conversation?.id || "").trim(),
    repliedAt: normalizeIntercomTimestamp(
      conversation?.conversation_rating?.replied_at ||
        conversation?.updated_at ||
        conversation?.created_at ||
        null
    ),
    csatScore: conversationRating,
    conversationRating,
    clientEmail: firstNonEmpty(
      conversation?.contacts?.contacts?.[0]?.email,
      conversation?.source?.author?.email,
      conversation?.author?.email,
      conversation?.user?.email,
      conversation?.customer?.email
    ),
    agentName: getAgentNameFromConversation(conversation, adminLookup),
  };
}

function buildSearchBody({
  sinceTs,
  untilTs,
  startingAfter,
  conversationRatings,
  selectedAdminAssigneeIds,
}) {
  const values = [
    {
      field: "created_at",
      operator: ">",
      value: Number(sinceTs),
    },
    {
      field: "created_at",
      operator: "<",
      value: Number(untilTs),
    },
  ];

  if (Array.isArray(conversationRatings) && conversationRatings.length > 0) {
    values.push({
      field: "conversation_rating.score",
      operator: "IN",
      value: conversationRatings,
    });
  }

  if (Array.isArray(selectedAdminAssigneeIds) && selectedAdminAssigneeIds.length > 0) {
    values.push({
      field: "admin_assignee_id",
      operator: "IN",
      value: selectedAdminAssigneeIds,
    });
  }

  return {
    query: {
      operator: "AND",
      value: values,
    },
    sort: {
      field: "created_at",
      order: "ascending",
    },
    pagination: startingAfter
      ? { per_page: INTERCOM_PER_PAGE, starting_after: startingAfter }
      : { per_page: INTERCOM_PER_PAGE },
  };
}

async function postIntercomSearch({ intercomApiKey, body }) {
  const response = await fetch("https://api.intercom.io/conversations/search", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Intercom-Version": "2.12",
      Authorization: `Bearer ${intercomApiKey}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const responseText = await response.text();
  const contentType = response.headers.get("content-type") || "";

  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = null;
  }

  return {
    requestBody: body,
    status: response.status,
    ok: response.ok,
    contentType,
    responseExcerpt: responseText.slice(0, 1200),
    data,
  };
}

async function fetchFullConversation(intercomApiKey, conversationId) {
  const data = await intercomGet({ intercomApiKey, path: `/conversations/${conversationId}` });
  return data;
}

async function hydrateConversationPreview(intercomApiKey, searchConversation, adminLookup) {
  const conversationId = String(searchConversation?.id || "").trim();

  if (!conversationId) {
    return extractConversationPreview(searchConversation, adminLookup);
  }

  try {
    const fullConversation = await fetchFullConversation(intercomApiKey, conversationId);
    return extractConversationPreview(fullConversation, adminLookup);
  } catch {
    return extractConversationPreview(searchConversation, adminLookup);
  }
}

async function fetchConversationsForDay({
  intercomApiKey,
  date,
  limiterEnabled,
  desiredCount,
  seenIds,
  conversationRatings,
  selectedIntercomAgentNames,
  selectedAdminAssigneeIds,
  unresolvedSelectedAgentNames,
  adminLookup,
}) {
  const { sinceTs, untilTs } = dhakaDayBounds(date);

  const conversations = [];
  const debugPages = [];

  let startingAfter = null;
  let pageCount = 0;

  const hasNameFallbackFilter =
    Array.isArray(unresolvedSelectedAgentNames) && unresolvedSelectedAgentNames.length > 0;

  while (pageCount < MAX_FETCH_PAGES_PER_DAY) {
    const searchBody = buildSearchBody({
      sinceTs,
      untilTs,
      startingAfter,
      conversationRatings,
      selectedAdminAssigneeIds,
    });

    const pageResult = await postIntercomSearch({ intercomApiKey, body: searchBody });

    const pageItems = Array.isArray(pageResult?.data?.conversations)
      ? pageResult.data.conversations
      : [];
    const nextCursor = pageResult?.data?.pages?.next?.starting_after ?? null;

    debugPages.push({
      request: pageResult.requestBody,
      pageIndex: pageCount + 1,
      httpStatus: pageResult.status,
      ok: pageResult.ok,
      contentType: pageResult.contentType,
      returnedCount: pageItems.length,
      totalCount: pageResult?.data?.total_count ?? null,
      nextCursor,
      sampleIds: pageItems
        .map((item) => String(item?.id || "").trim())
        .filter(Boolean)
        .slice(0, 10),
      responseExcerpt: pageResult.responseExcerpt,
    });

    if (!pageResult.ok) {
      throw new Error(`Intercom search failed with status ${pageResult.status}: ${pageResult.responseExcerpt}`);
    }

    for (const conversation of pageItems) {
      const id = String(conversation?.id || "").trim();
      if (!id || seenIds.has(id)) continue;

      let preview = extractConversationPreview(conversation, adminLookup);

      if (!numberMatchesFilter(preview?.conversationRating ?? preview?.csatScore, conversationRatings)) {
        continue;
      }

      if (hasNameFallbackFilter) {
        const knownAgent = !isClearlyUnassignedAgent(preview?.agentName);
        const matchesKnownName = textMatchesFilter(preview?.agentName, unresolvedSelectedAgentNames);

        if (!knownAgent || !matchesKnownName) {
          preview = await hydrateConversationPreview(intercomApiKey, conversation, adminLookup);
        }

        if (!textMatchesFilter(preview?.agentName, unresolvedSelectedAgentNames)) {
          continue;
        }
      }

      seenIds.add(id);
      conversations.push(preview);

      if (limiterEnabled && conversations.length >= desiredCount) {
        return {
          sinceTs,
          untilTs,
          conversations,
          debugPages,
        };
      }
    }

    if (!nextCursor) {
      break;
    }

    startingAfter = nextCursor;
    pageCount += 1;
  }

  return {
    sinceTs,
    untilTs,
    conversations,
    debugPages,
  };
}

export async function POST(request) {
  try {
    const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
    const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json(
        {
          ok: false,
          error: "Missing required Supabase environment variables.",
        },
        { status: 500 }
      );
    }

    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";

    if (!token) {
      return json(
        {
          ok: false,
          error: "Missing access token.",
        },
        { status: 401 }
      );
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(token);

    if (userError || !user) {
      return json(
        {
          ok: false,
          error: "Invalid or expired session.",
        },
        { status: 401 }
      );
    }

    const email = normalizeEmail(user.email);
    const domain = email.split("@")[1] || "";

    if (domain !== "nextventures.io") {
      return json(
        {
          ok: false,
          error: "Only nextventures.io accounts are allowed.",
        },
        { status: 403 }
      );
    }

    const { data: profileData } = await adminClient
      .from("profiles")
      .select("id, email, full_name, role, can_run_tests, is_active")
      .eq("id", user.id)
      .maybeSingle();

    const roleGrant = await readActiveRoleGrant(adminClient, email);
    const profile = resolveEffectiveProfile({ user, email, profileData, grant: roleGrant });

    if (!canRunAudits(profile)) {
      return json(
        {
          ok: false,
          error: "This account does not have permission to run tests.",
        },
        { status: 403 }
      );
    }

    const intercomKey = await loadActiveApiKey({
      adminClient,
      keyType: "intercom",
      envName: "INTERCOM_API_KEY",
      displayName: "Intercom",
    });

    const intercomApiKey = intercomKey.value;

    const body = await request.json();
    const startDate = String(body?.startDate || "").trim();
    const endDate = String(body?.endDate || "").trim();
    const limiterEnabled = Boolean(body?.limiterEnabled);
    const requestedLimit = Number(body?.limitCount);
    const debug = Boolean(body?.debug);
    const conversationRatings = normalizeNumberSelections(body?.conversationRatings, DEFAULT_CONVERSATION_RATINGS);
    const selectedEmployeeNames = normalizeTextSelections(body?.employeeNames);
    const selectedIntercomAgentNames = normalizeTextSelections(body?.intercomAgentNames);

    if (!startDate || !endDate) {
      return json(
        {
          ok: false,
          error: "Start date and end date are required.",
        },
        { status: 400 }
      );
    }

    const admins = await loadIntercomAdmins(intercomApiKey);
    const adminLookup = buildAdminLookup(admins);
    const selectedAdminResolution = resolveSelectedAdminIds(selectedIntercomAgentNames, adminLookup);
    const selectedAdminAssigneeIds = selectedAdminResolution.ids;
    const unresolvedSelectedAgentNames = selectedAdminResolution.unresolved;

    const searchedDates = enumerateDateRange(startDate, endDate);
    const desiredCount = limiterEnabled
      ? Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 5, 200))
      : 10000;

    const seenIds = new Set();
    const fetchedConversations = [];
    const dailySummary = [];

    for (const date of searchedDates) {
      const dayResult = await fetchConversationsForDay({
        intercomApiKey,
        date,
        limiterEnabled,
        desiredCount,
        seenIds,
        conversationRatings,
        selectedIntercomAgentNames,
        selectedAdminAssigneeIds,
        unresolvedSelectedAgentNames,
        adminLookup,
      });

      fetchedConversations.push(...dayResult.conversations);

      dailySummary.push({
        date,
        sinceTs: dayResult.sinceTs,
        untilTs: dayResult.untilTs,
        fetchedCount: dayResult.conversations.length,
        pages: debug ? dayResult.debugPages : undefined,
      });

      if (limiterEnabled && fetchedConversations.length >= desiredCount) {
        break;
      }
    }

    const limitedConversations = limiterEnabled
      ? fetchedConversations.slice(0, desiredCount)
      : fetchedConversations;

    await writeActivityLog(adminClient, request, {
      actor_user_id: user.id,
      actor_email: email,
      actor_name: profile?.full_name || email,
      actor_role: profile?.role || "viewer",
      action_type: "audit_conversations_fetched",
      action_label: "Conversations Fetched",
      area: "Run Audit",
      target_type: "Intercom Conversations",
      target_label: `${startDate} to ${endDate}`,
      status: "success",
      description: `${email} fetched ${limitedConversations.length} conversation(s) from Intercom for ${startDate} to ${endDate}.`,
      safe_after: {
        start_date: startDate,
        end_date: endDate,
        limiter_enabled: limiterEnabled,
        limit_count: limiterEnabled ? desiredCount : null,
        fetched_count: limitedConversations.length,
        searched_dates: searchedDates,
        conversation_ratings: conversationRatings.length ? conversationRatings : "any",
        selected_employee_names: selectedEmployeeNames,
        selected_intercom_agent_names: selectedIntercomAgentNames,
        selected_admin_assignee_ids: selectedAdminAssigneeIds,
        unresolved_agent_names: unresolvedSelectedAgentNames,
        key_source: intercomKey.source,
      },
    });

    return json({
      ok: true,
      message:
        limitedConversations.length > 0
          ? "Conversations fetched successfully."
          : "No conversations found for the selected filters.",
      meta: {
        startDate,
        endDate,
        limiterEnabled,
        limitCount: limiterEnabled ? desiredCount : null,
        requestedBy: email,
        searchedDates,
        fetchedCount: limitedConversations.length,
        filters: {
          conversationRatings: conversationRatings.length ? conversationRatings : "any",
          employeeNames: selectedEmployeeNames,
          intercomAgentNames: selectedIntercomAgentNames,
          adminAssigneeIds: selectedAdminAssigneeIds,
          unresolvedAgentNames: unresolvedSelectedAgentNames,
        },
      },
      conversations: limitedConversations,
      debug: debug
        ? {
            intercomPerPage: INTERCOM_PER_PAGE,
            maxFetchPagesPerDay: MAX_FETCH_PAGES_PER_DAY,
            conversationRatings: conversationRatings.length ? conversationRatings : "any",
            auth: {
              tokenSource: intercomKey.source,
              tokenFingerprint: intercomKey.fingerprint,
            },
            selectedAdminAssigneeIds,
            unresolvedSelectedAgentNames,
            dailySummary,
          }
        : undefined,
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
