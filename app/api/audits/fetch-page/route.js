import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INTERCOM_PER_PAGE = 150;
const MAX_PAGES_PER_CALL = 2;
const MAX_PAGES_PER_DATE = 80;
const DEFAULT_CONVERSATION_RATINGS = [3, 4, 5];
const MASTER_ADMIN_EMAIL = "faiyaz@nextventures.io";

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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return "";
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

function normalizeConversationIdSelections(value) {
  const source = Array.isArray(value) ? value.join(",") : String(value || "");
  return Array.from(
    new Set(
      source
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter((item) => /^\d{5,}$/.test(item))
    )
  ).slice(0, 50);
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

function isClearlyUnassignedAgent(value) {
  const key = normalizeKey(value);
  return !key || key === "unassigned" || key === "unknown" || key === "-";
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

  throw new Error(`No active ${displayName} API key found. Save it in Admin -> API key vault first.`);
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
    const allAdmins = [];
    let startingAfter = "";
    let safety = 0;

    while (safety < 25) {
      safety += 1;

      const query = new URLSearchParams();
      query.set("per_page", "150");
      if (startingAfter) query.set("starting_after", startingAfter);

      const data = await intercomGet({ intercomApiKey, path: `/admins?${query.toString()}` });
      const admins = Array.isArray(data?.admins) ? data.admins : Array.isArray(data?.data) ? data.data : [];

      allAdmins.push(...admins);

      const nextCursor =
        data?.pages?.next?.starting_after ||
        data?.pages?.next?.startingAfter ||
        data?.pagination?.next?.starting_after ||
        data?.pagination?.next?.startingAfter ||
        "";

      if (!nextCursor || !admins.length) break;
      startingAfter = String(nextCursor);
    }

    const byId = new Map();

    for (const admin of allAdmins) {
      const id = String(admin?.id || "").trim();
      const name = normalizeText(admin?.name);
      const email = normalizeEmail(admin?.email);

      if (!id || (!name && !email)) continue;
      if (!byId.has(id)) byId.set(id, { id, name, email });
    }

    return Array.from(byId.values());
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

  return firstNonEmpty(
    conversation?.assignee?.name,
    conversation?.admin_assignee?.name,
    conversation?.teammate_assignee?.name,
    conversation?.conversation_rating?.teammate?.name,
    "Unassigned"
  );
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
      conversation?.conversation_rating?.replied_at || conversation?.updated_at || conversation?.created_at || null
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

async function fetchSpecificConversationPreviews({ intercomApiKey, conversationIds, adminLookup }) {
  const conversations = [];
  const failed = [];

  for (const conversationId of conversationIds) {
    try {
      const params = new URLSearchParams({ display_as: "plaintext" });
      const fullConversation = await intercomGet({ intercomApiKey, path: `/conversations/${conversationId}?${params.toString()}` });
      const preview = extractConversationPreview(fullConversation, adminLookup);
      conversations.push({ ...preview, conversationId: preview.conversationId || conversationId });
    } catch (error) {
      failed.push({
        conversationId,
        error: error instanceof Error ? error.message : "Could not fetch this conversation.",
      });
    }
  }

  return { conversations, failed };
}

function buildSearchBody({ sinceTs, untilTs, startingAfter, conversationRatings, selectedAdminAssigneeIds }) {
  const values = [
    { field: "created_at", operator: ">", value: Number(sinceTs) },
    { field: "created_at", operator: "<", value: Number(untilTs) },
  ];

  if (Array.isArray(conversationRatings) && conversationRatings.length > 0) {
    values.push({ field: "conversation_rating.score", operator: "IN", value: conversationRatings });
  }

  if (Array.isArray(selectedAdminAssigneeIds) && selectedAdminAssigneeIds.length > 0) {
    values.push({ field: "admin_assignee_id", operator: "IN", value: selectedAdminAssigneeIds });
  }

  return {
    query: { operator: "AND", value: values },
    sort: { field: "created_at", order: "ascending" },
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
    contentType: response.headers.get("content-type") || "",
    responseExcerpt: responseText.slice(0, 1200),
    data,
  };
}

function makeInitialFetchState(startDate, endDate) {
  return {
    dates: enumerateDateRange(startDate, endDate),
    dateIndex: 0,
    cursor: null,
    pageIndexForDate: 0,
    processedPages: 0,
  };
}

function normalizeFetchState(inputState, startDate, endDate) {
  const initial = makeInitialFetchState(startDate, endDate);
  const input = inputState && typeof inputState === "object" ? inputState : {};
  const dates = Array.isArray(input.dates) && input.dates.length ? input.dates : initial.dates;

  return {
    dates,
    dateIndex: Math.max(0, Math.min(Number(input.dateIndex || 0), dates.length)),
    cursor: input.cursor || null,
    pageIndexForDate: Math.max(0, Number(input.pageIndexForDate || 0)),
    processedPages: Math.max(0, Number(input.processedPages || 0)),
  };
}

async function fetchChunk({
  intercomApiKey,
  startDate,
  endDate,
  fetchState,
  alreadyFetchedCount,
  limiterEnabled,
  desiredCount,
  conversationRatings,
  selectedAdminAssigneeIds,
  unresolvedSelectedAgentNames,
  adminLookup,
}) {
  const state = normalizeFetchState(fetchState, startDate, endDate);
  const conversations = [];
  const debugPages = [];
  let done = false;
  let pagesProcessedThisCall = 0;
  let totalIntercomReturned = 0;

  while (pagesProcessedThisCall < MAX_PAGES_PER_CALL && state.dateIndex < state.dates.length) {
    if (limiterEnabled && alreadyFetchedCount + conversations.length >= desiredCount) {
      done = true;
      break;
    }

    const currentDate = state.dates[state.dateIndex];

    if (state.pageIndexForDate >= MAX_PAGES_PER_DATE) {
      state.dateIndex += 1;
      state.cursor = null;
      state.pageIndexForDate = 0;
      continue;
    }

    const { sinceTs, untilTs } = dhakaDayBounds(currentDate);
    const searchBody = buildSearchBody({
      sinceTs,
      untilTs,
      startingAfter: state.cursor,
      conversationRatings,
      selectedAdminAssigneeIds,
    });

    const pageResult = await postIntercomSearch({ intercomApiKey, body: searchBody });
    const pageItems = Array.isArray(pageResult?.data?.conversations) ? pageResult.data.conversations : [];
    const nextCursor = pageResult?.data?.pages?.next?.starting_after ?? null;
    const hasNameFallbackFilter = Array.isArray(unresolvedSelectedAgentNames) && unresolvedSelectedAgentNames.length > 0;

    pagesProcessedThisCall += 1;
    state.processedPages += 1;
    state.pageIndexForDate += 1;
    totalIntercomReturned += pageItems.length;

    debugPages.push({
      date: currentDate,
      pageIndexForDate: state.pageIndexForDate,
      httpStatus: pageResult.status,
      ok: pageResult.ok,
      returnedCount: pageItems.length,
      acceptedCountBeforeLimit: conversations.length,
      totalCount: pageResult?.data?.total_count ?? null,
      nextCursor,
      sampleIds: pageItems.map((item) => String(item?.id || "").trim()).filter(Boolean).slice(0, 8),
      responseExcerpt: pageResult.ok ? undefined : pageResult.responseExcerpt,
    });

    if (!pageResult.ok) {
      throw new Error(`Intercom search failed with status ${pageResult.status}: ${pageResult.responseExcerpt}`);
    }

    for (const conversation of pageItems) {
      if (limiterEnabled && alreadyFetchedCount + conversations.length >= desiredCount) {
        done = true;
        break;
      }

      const id = String(conversation?.id || "").trim();
      if (!id) continue;

      const preview = extractConversationPreview(conversation, adminLookup);

      if (!numberMatchesFilter(preview?.conversationRating ?? preview?.csatScore, conversationRatings)) {
        continue;
      }

      if (hasNameFallbackFilter) {
        const knownAgent = !isClearlyUnassignedAgent(preview?.agentName);
        const matchesKnownName = textMatchesFilter(preview?.agentName, unresolvedSelectedAgentNames);
        if (!knownAgent || !matchesKnownName) continue;
      }

      conversations.push(preview);
    }

    if (done) break;

    if (nextCursor) {
      state.cursor = nextCursor;
    } else {
      state.dateIndex += 1;
      state.cursor = null;
      state.pageIndexForDate = 0;
    }
  }

  if (state.dateIndex >= state.dates.length) {
    done = true;
  }

  return {
    conversations,
    done,
    fetchState: state,
    meta: {
      processedPagesThisCall: pagesProcessedThisCall,
      processedPagesTotal: state.processedPages,
      totalIntercomReturned,
      activeDate: state.dates[state.dateIndex] || null,
      remainingDates: Math.max(0, state.dates.length - state.dateIndex),
      maxPagesPerCall: MAX_PAGES_PER_CALL,
      maxPagesPerDate: MAX_PAGES_PER_DATE,
      debugPages,
    },
  };
}

export async function POST(request) {
  try {
    const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
    const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json({ ok: false, error: "Missing required Supabase environment variables." }, { status: 500 });
    }

    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

    if (!token) {
      return json({ ok: false, error: "Missing access token." }, { status: 401 });
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
      return json({ ok: false, error: "Invalid or expired session." }, { status: 401 });
    }

    const email = normalizeEmail(user.email);
    const domain = email.split("@")[1] || "";

    if (domain !== "nextventures.io") {
      return json({ ok: false, error: "Only nextventures.io accounts are allowed." }, { status: 403 });
    }

    const { data: profileData } = await adminClient
      .from("profiles")
      .select("id, email, full_name, role, can_run_tests, is_active")
      .eq("id", user.id)
      .maybeSingle();

    const roleGrant = await readActiveRoleGrant(adminClient, email);
    const profile = resolveEffectiveProfile({ user, email, profileData, grant: roleGrant });

    if (!canRunAudits(profile)) {
      return json({ ok: false, error: "This account does not have permission to run tests." }, { status: 403 });
    }

    const intercomKey = await loadActiveApiKey({
      adminClient,
      keyType: "intercom",
      envName: "INTERCOM_API_KEY",
      displayName: "Intercom",
    });

    const body = await request.json().catch(() => ({}));
    const startDate = normalizeText(body?.startDate);
    const endDate = normalizeText(body?.endDate);
    const limiterEnabled = Boolean(body?.limiterEnabled);
    const requestedLimit = Number(body?.limitCount);
    const alreadyFetchedCount = Math.max(0, Number(body?.alreadyFetchedCount || 0));
    const conversationRatings = normalizeNumberSelections(body?.conversationRatings, DEFAULT_CONVERSATION_RATINGS);
    const selectedIntercomAgentNames = normalizeTextSelections(body?.intercomAgentNames);
    const specificConversationIds = normalizeConversationIdSelections(body?.conversationIds || body?.specificConversationIds);

    const admins = await loadIntercomAdmins(intercomKey.value);
    const adminLookup = buildAdminLookup(admins);

    if (specificConversationIds.length > 0) {
      const directResult = await fetchSpecificConversationPreviews({
        intercomApiKey: intercomKey.value,
        conversationIds: specificConversationIds,
        adminLookup,
      });

      return json({
        ok: true,
        done: true,
        conversations: directResult.conversations,
        fetchState: {
          mode: "specific_conversation_ids",
          requestedIds: specificConversationIds,
          done: true,
        },
        message: directResult.conversations.length
          ? "Specific conversation(s) fetched successfully."
          : "No matching conversations were returned for the entered conversation ID(s).",
        meta: {
          startDate: startDate || null,
          endDate: endDate || null,
          limiterEnabled: false,
          limitCount: null,
          alreadyFetchedCount,
          fetchedCount: directResult.conversations.length,
          pageFetchedCount: directResult.conversations.length,
          fetchMode: "specific_conversation_ids",
          requestedConversationIds: specificConversationIds,
          failedConversationIds: directResult.failed,
          filters: {
            conversationIds: specificConversationIds,
            otherFiltersIgnored: true,
          },
          auth: {
            tokenSource: intercomKey.source,
            tokenFingerprint: intercomKey.fingerprint,
          },
        },
      });
    }

    if (!startDate || !endDate) {
      return json({ ok: false, error: "Start date and end date are required unless specific conversation IDs are provided." }, { status: 400 });
    }

    const desiredCount = limiterEnabled
      ? Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 5, 20000))
      : 20000;

    const selectedAdminResolution = resolveSelectedAdminIds(selectedIntercomAgentNames, adminLookup);

    const hasSelectedAgentFilter = selectedIntercomAgentNames.length > 0;
    const hasUnresolvedAgentNames = selectedAdminResolution.unresolved.length > 0;
    const useAdminAssigneeSearch = hasSelectedAgentFilter && !hasUnresolvedAgentNames && selectedAdminResolution.ids.length > 0;

    const chunk = await fetchChunk({
      intercomApiKey: intercomKey.value,
      startDate,
      endDate,
      fetchState: body?.fetchState,
      alreadyFetchedCount,
      limiterEnabled,
      desiredCount,
      conversationRatings,
      selectedAdminAssigneeIds: useAdminAssigneeSearch ? selectedAdminResolution.ids : [],
      unresolvedSelectedAgentNames: hasSelectedAgentFilter && !useAdminAssigneeSearch ? selectedIntercomAgentNames : [],
      adminLookup,
    });

    const fetchedCount = alreadyFetchedCount + chunk.conversations.length;
    const done = Boolean(chunk.done || (limiterEnabled && fetchedCount >= desiredCount));

    return json({
      ok: true,
      done,
      conversations: chunk.conversations,
      fetchState: chunk.fetchState,
      message: done ? "Fetch page completed. No more pages remain." : "Fetch page completed. More pages remain.",
      meta: {
        startDate,
        endDate,
        limiterEnabled,
        limitCount: limiterEnabled ? desiredCount : null,
        alreadyFetchedCount,
        fetchedCount,
        pageFetchedCount: chunk.conversations.length,
        filters: {
          conversationRatings: conversationRatings.length ? conversationRatings : "any",
          intercomAgentNames: selectedIntercomAgentNames,
          adminAssigneeIds: selectedAdminResolution.ids,
          unresolvedAgentNames: selectedAdminResolution.unresolved,
          agentFilterMode: useAdminAssigneeSearch ? "admin_assignee_id" : hasSelectedAgentFilter ? "agent_name_fallback" : "none",
          loadedIntercomAdminCount: admins.length,
        },
        auth: {
          tokenSource: intercomKey.source,
          tokenFingerprint: intercomKey.fingerprint,
        },
        ...chunk.meta,
      },
    });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown paginated fetch error." },
      { status: 500 }
    );
  }
}
