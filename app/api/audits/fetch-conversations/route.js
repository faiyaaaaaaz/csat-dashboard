import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INTERCOM_PER_PAGE = 150;
const MAX_FETCH_PAGES_PER_DAY = 50;
const DEFAULT_CONVERSATION_RATINGS = [3, 4, 5];
const SOFT_TIMEOUT_MS = 45000;
const MAX_DETAIL_HYDRATIONS_PER_REQUEST = 120;

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
    `No active ${displayName} API key found. Save it in Admin → API key vault first.`
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

function hasUsableNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number);
}

function isClearlyUnassignedAgent(value) {
  const key = normalizeKey(value);
  return !key || key === "unassigned" || key === "unknown" || key === "-";
}

function textMatchesFilter(value, selectedValues) {
  if (!Array.isArray(selectedValues) || selectedValues.length === 0) return true;
  const key = normalizeKey(value);
  if (!key) return false;
  const selected = new Set(selectedValues.map(normalizeKey));
  return selected.has(key);
}

function firstScoreValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text) continue;
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return "";
}

function getCxScoreFromConversation(conversation) {
  const custom = conversation?.custom_attributes || {};
  return firstScoreValue(
    custom?.cx_score_rating,
    custom?.cx_score,
    custom?.CXScoreRating,
    custom?.CXScore,
    custom?.["CX Score Rating"],
    custom?.["CX Score"],
    custom?.customer_experience_score,
    custom?.quality_score,
    conversation?.cx_score_rating,
    conversation?.cx_score
  );
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

function buildFallbackProfile(user) {
  const email = String(user?.email || "").toLowerCase();

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

function canRunAudits(profile) {
  return Boolean(
    profile?.is_active === true &&
      (profile?.role === "master_admin" ||
        profile?.role === "admin" ||
        profile?.role === "audit_runner" ||
        profile?.can_run_tests === true)
  );
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

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function extractConversationPreview(conversation) {
  const parts = Array.isArray(conversation?.conversation_parts?.conversation_parts)
    ? conversation.conversation_parts.conversation_parts
    : [];

  let agentName = firstNonEmpty(
    conversation?.assignee?.name,
    conversation?.admin_assignee?.name,
    conversation?.teammate_assignee?.name,
    conversation?.conversation_rating?.teammate?.name
  );

  if (!agentName && parts.length) {
    const adminParts = parts
      .filter((part) =>
        ["admin", "teammate", "team_member"].includes(part?.author?.type)
      )
      .sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));

    agentName = firstNonEmpty(
      adminParts?.[0]?.author?.name,
      adminParts?.[0]?.author?.email
    );
  }

  return {
    conversationId: String(conversation?.id || "").trim(),
    repliedAt: normalizeIntercomTimestamp(
      conversation?.conversation_rating?.replied_at ||
        conversation?.updated_at ||
        conversation?.created_at ||
        null
    ),
    csatScore:
      conversation?.conversation_rating?.score ??
      conversation?.conversation_rating?.rating ??
      conversation?.conversation_rating?.value ??
      "",
    conversationRating:
      conversation?.conversation_rating?.score ??
      conversation?.conversation_rating?.rating ??
      conversation?.conversation_rating?.value ??
      "",
    cxScoreRating: getCxScoreFromConversation(conversation),
    clientEmail: firstNonEmpty(
      conversation?.contacts?.contacts?.[0]?.email,
      conversation?.source?.author?.email,
      conversation?.author?.email,
      conversation?.user?.email,
      conversation?.customer?.email
    ),
    agentName: agentName || "Unassigned",
  };
}

function buildSearchBody({ sinceTs, untilTs, startingAfter, conversationRatings }) {
  const values = [
    {
      field: "conversation_rating.replied_at",
      operator: ">",
      value: Number(sinceTs),
    },
    {
      field: "conversation_rating.replied_at",
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

  return {
    query: {
      operator: "AND",
      value: values,
    },
    sort: {
      field: "conversation_rating.replied_at",
      order: "ascending",
    },
    pagination: startingAfter
      ? { per_page: INTERCOM_PER_PAGE, starting_after: startingAfter }
      : { per_page: INTERCOM_PER_PAGE },
  };
}

async function fetchIntercomSearchPage({
  intercomApiKey,
  sinceTs,
  untilTs,
  startingAfter,
  conversationRatings,
}) {
  const body = buildSearchBody({
    sinceTs,
    untilTs,
    startingAfter,
    conversationRatings,
  });

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
  const response = await fetch(`https://api.intercom.io/conversations/${conversationId}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Intercom-Version": "2.12",
      Authorization: `Bearer ${intercomApiKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Intercom conversation fetch failed for ${conversationId}: ${response.status} ${text}`
    );
  }

  return response.json();
}

async function hydrateConversationPreview(intercomApiKey, searchConversation) {
  const conversationId = String(searchConversation?.id || "").trim();

  if (!conversationId) {
    return extractConversationPreview(searchConversation);
  }

  try {
    const fullConversation = await fetchFullConversation(intercomApiKey, conversationId);
    return extractConversationPreview(fullConversation);
  } catch {
    return extractConversationPreview(searchConversation);
  }
}

async function fetchConversationsForDay({
  intercomApiKey,
  date,
  limiterEnabled,
  desiredCount,
  seenIds,
  conversationRatings,
  cxScoreRatings,
  selectedIntercomAgentNames,
  requestStartedAt,
  hydrationCounter,
}) {
  const { sinceTs, untilTs } = dhakaDayBounds(date);

  const conversations = [];
  const debugPages = [];

  let startingAfter = null;
  let pageCount = 0;
  let stoppedEarly = false;
  let stopReason = "";

  while (pageCount < MAX_FETCH_PAGES_PER_DAY) {
    if (Date.now() - requestStartedAt > SOFT_TIMEOUT_MS) {
      stoppedEarly = true;
      stopReason = "Stopped early to avoid a Vercel function timeout while scanning Intercom conversations.";
      break;
    }

    const pageResult = await fetchIntercomSearchPage({
      intercomApiKey,
      sinceTs,
      untilTs,
      startingAfter,
      conversationRatings,
    });

    const pageItems = Array.isArray(pageResult?.data?.conversations)
      ? pageResult.data.conversations
      : [];
    const nextCursor = pageResult?.data?.pages?.next?.starting_after ?? null;

    let hydratedOnThisPage = 0;
    let skippedBeforeHydration = 0;

    debugPages.push({
      request: pageResult.requestBody,
      pageIndex: pageCount + 1,
      httpStatus: pageResult.status,
      ok: pageResult.ok,
      contentType: pageResult.contentType,
      returnedCount: pageItems.length,
      nextCursor,
      sampleIds: pageItems
        .map((item) => String(item?.id || "").trim())
        .filter(Boolean)
        .slice(0, 10),
      responseExcerpt: pageResult.responseExcerpt,
    });

    for (const conversation of pageItems) {
      if (Date.now() - requestStartedAt > SOFT_TIMEOUT_MS) {
        stoppedEarly = true;
        stopReason = "Stopped early to avoid a Vercel function timeout while filtering CX Score results.";
        break;
      }

      const id = String(conversation?.id || "").trim();
      if (!id || seenIds.has(id)) continue;

      const preliminaryPreview = extractConversationPreview(conversation);

      if (!numberMatchesFilter(preliminaryPreview?.conversationRating ?? preliminaryPreview?.csatScore, conversationRatings)) {
        continue;
      }

      const hasAgentFilter = Array.isArray(selectedIntercomAgentNames) && selectedIntercomAgentNames.length > 0;
      const hasCxFilter = Array.isArray(cxScoreRatings) && cxScoreRatings.length > 0;
      const preliminaryAgentKnown = !isClearlyUnassignedAgent(preliminaryPreview?.agentName);
      const preliminaryAgentMatches = textMatchesFilter(preliminaryPreview?.agentName, selectedIntercomAgentNames);

      if (hasAgentFilter && preliminaryAgentKnown && !preliminaryAgentMatches) {
        skippedBeforeHydration += 1;
        continue;
      }

      let finalPreview = preliminaryPreview;
      const needsHydrationForAgent = hasAgentFilter && (!preliminaryAgentKnown || !preliminaryAgentMatches);
      const needsHydrationForCx = hasCxFilter && !hasUsableNumber(preliminaryPreview?.cxScoreRating);

      if (needsHydrationForAgent || needsHydrationForCx) {
        if (hydrationCounter.count >= MAX_DETAIL_HYDRATIONS_PER_REQUEST) {
          stoppedEarly = true;
          stopReason = `Stopped after checking ${MAX_DETAIL_HYDRATIONS_PER_REQUEST} detailed Intercom conversations. Narrow the date range, employee, or rating filters and try again.`;
          break;
        }

        hydrationCounter.count += 1;
        hydratedOnThisPage += 1;
        finalPreview = await hydrateConversationPreview(intercomApiKey, conversation);
      }

      if (!numberMatchesFilter(finalPreview?.conversationRating ?? finalPreview?.csatScore, conversationRatings)) {
        continue;
      }

      if (!numberMatchesFilter(finalPreview?.cxScoreRating, cxScoreRatings)) {
        continue;
      }

      if (!textMatchesFilter(finalPreview?.agentName, selectedIntercomAgentNames)) {
        continue;
      }

      seenIds.add(id);
      conversations.push(finalPreview);

      if (limiterEnabled && conversations.length >= desiredCount) {
        const lastDebug = debugPages[debugPages.length - 1];
        if (lastDebug) {
          lastDebug.hydratedOnThisPage = hydratedOnThisPage;
          lastDebug.skippedBeforeHydration = skippedBeforeHydration;
        }

        return {
          sinceTs,
          untilTs,
          conversations,
          debugPages,
          stoppedEarly,
          stopReason,
          hydrationCount: hydrationCounter.count,
        };
      }
    }

    const lastDebug = debugPages[debugPages.length - 1];
    if (lastDebug) {
      lastDebug.hydratedOnThisPage = hydratedOnThisPage;
      lastDebug.skippedBeforeHydration = skippedBeforeHydration;
    }

    if (stoppedEarly || !nextCursor) {
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
    stoppedEarly,
    stopReason,
    hydrationCount: hydrationCounter.count,
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
    const cxScoreRatings = normalizeNumberSelections(body?.cxScoreRatings, []);
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

    const searchedDates = enumerateDateRange(startDate, endDate);
    const desiredCount = limiterEnabled
      ? Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 5, 200))
      : 10000;

    const seenIds = new Set();
    const fetchedConversations = [];
    const dailySummary = [];
    const requestStartedAt = Date.now();
    const hydrationCounter = { count: 0 };
    let stoppedEarly = false;
    let stopReason = "";

    for (const date of searchedDates) {
      const dayResult = await fetchConversationsForDay({
        intercomApiKey,
        date,
        limiterEnabled,
        desiredCount,
        seenIds,
        conversationRatings,
        cxScoreRatings,
        selectedIntercomAgentNames,
        requestStartedAt,
        hydrationCounter,
      });

      fetchedConversations.push(...dayResult.conversations);

      dailySummary.push({
        date,
        sinceTs: dayResult.sinceTs,
        untilTs: dayResult.untilTs,
        fetchedCount: dayResult.conversations.length,
        pages: debug ? dayResult.debugPages : undefined,
        stoppedEarly: dayResult.stoppedEarly || false,
        stopReason: dayResult.stopReason || "",
        hydrationCount: dayResult.hydrationCount || hydrationCounter.count,
      });

      if (dayResult.stoppedEarly) {
        stoppedEarly = true;
        stopReason = dayResult.stopReason || "Stopped early to avoid timeout.";
        break;
      }

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
      description: stoppedEarly
        ? `${email} fetched ${limitedConversations.length} conversation(s) from Intercom for ${startDate} to ${endDate} before the safe timeout limit.`
        : `${email} fetched ${limitedConversations.length} conversation(s) from Intercom for ${startDate} to ${endDate}.`,
      safe_after: {
        start_date: startDate,
        end_date: endDate,
        limiter_enabled: limiterEnabled,
        limit_count: limiterEnabled ? desiredCount : null,
        fetched_count: limitedConversations.length,
        searched_dates: searchedDates,
        conversation_ratings: conversationRatings.length ? conversationRatings : "any",
        cx_score_ratings: cxScoreRatings.length ? cxScoreRatings : "any",
        selected_employee_names: selectedEmployeeNames,
        selected_intercom_agent_names: selectedIntercomAgentNames,
        hydration_count: hydrationCounter.count,
        stopped_early: stoppedEarly,
        stop_reason: stopReason,
        key_source: intercomKey.source,
      },
    });

    return json({
      ok: true,
      message: stoppedEarly
        ? `${limitedConversations.length} conversation(s) matched before the safe timeout limit. Narrow the filters if you expected more.`
        : limitedConversations.length > 0
          ? "Conversations fetched successfully."
          : "No conversations found for the selected date range.",
      warning: stoppedEarly ? stopReason : "",
      meta: {
        startDate,
        endDate,
        limiterEnabled,
        limitCount: limiterEnabled ? desiredCount : null,
        requestedBy: email,
        searchedDates,
        fetchedCount: limitedConversations.length,
        hydrationCount: hydrationCounter.count,
        stoppedEarly,
        stopReason,
        filters: {
          conversationRatings: conversationRatings.length ? conversationRatings : "any",
          cxScoreRatings: cxScoreRatings.length ? cxScoreRatings : "any",
          employeeNames: selectedEmployeeNames,
          intercomAgentNames: selectedIntercomAgentNames,
        },
      },
      conversations: limitedConversations,
      debug: debug
        ? {
            intercomPerPage: INTERCOM_PER_PAGE,
            maxFetchPagesPerDay: MAX_FETCH_PAGES_PER_DAY,
            conversationRatings: conversationRatings.length ? conversationRatings : "any",
            cxScoreRatings: cxScoreRatings.length ? cxScoreRatings : "any",
            auth: {
              tokenSource: intercomKey.source,
              tokenFingerprint: intercomKey.fingerprint,
            },
            dailySummary,
            hydrationCount: hydrationCounter.count,
            stoppedEarly,
            stopReason,
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
