import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OPENAI_MODEL = "gpt-4.1-mini";
const PROMPT_KEY = "audit_review_prompt";
const CONVERSATION_CONCURRENCY = 3;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 700;

const FALLBACK_AUDIT_PROMPT = `You are auditing FundedNext support conversations.

You will receive ONE conversation at a time.
The input includes:
- ConversationId
- HasHumanAgent
- Transcript with timestamps, roles, and message text

Role legend:
- [USER] = client/customer
- [BOT] = automation
- [HUMAN_AGENT] = human support agent
- [SYSTEM] = system event

Your job is to analyze the conversation and return exactly one JSON object.

--------------------------------------------------
TASK 1: REVIEW SENTIMENT
--------------------------------------------------

Before choosing reviewSentiment, first determine whether the agent actually sent a review request link.
If no review request link was sent, you must not use:
- Likely Negative Review
- Likely Positive Review
- Highly Likely Negative Review
- Highly Likely Positive Review
Use only:
- Missed Opportunity
- Negative Outcome - No Review Request

Classify the likely review outcome using exactly one of these 6 values:

1. Likely Negative Review
Use this when:
- the client’s issue was not resolved, not resolved properly, or still pending, and the agent sent a review request link
- the client may be dissatisfied, disappointed, unconvinced, or still waiting, and the agent sent a review request link
- the client was negative, but not strongly negative, and the agent sent a review request link

2. Likely Positive Review
Use this when:
- the client’s issue or query was resolved, and the agent sent a review request link
- the conversation ended in the client’s favor, and the agent sent a review request link
- the client was positive, but not strongly positive, and the agent sent a review request link

3. Highly Likely Negative Review
Use this when:
- the client showed strong frustration, anger, repeated dissatisfaction, or clearly negative emotion, and the agent sent a review request link
- the issue was unresolved, poorly handled, or still causing negative feeling, and the agent sent a review request link
- the client’s emotional tone was strongly negative and the agent still sent a review request link

4. Highly Likely Positive Review
Use this when:
- the client showed clear genuine satisfaction, strong appreciation, happiness, praise, or explicitly positive intent, and the agent sent a review request link
- examples include:
  - “Awesome, thank you so much”
  - “Perfect, that solved it”
  - “Great support”
  - “Sure, I will leave a review”
  - “You were very helpful”

5. Missed Opportunity
Use this when:
- the client showed genuine satisfaction or clearly positive sentiment, and the agent did NOT send a review request link
- the conversation ended very favorably with positive emotions from the client, and the agent did NOT send a review request link
- this was a clear chance to ask for a review, and the agent did NOT send a review request link

6. Negative Outcome - No Review Request
Use this when:
- the client’s issue was unresolved, still pending, escalated, or poorly handled, and the agent did NOT send a review request link
- the client ended frustrated, disappointed, confused, or negative, and the agent did NOT send a review request link
- the conversation did not end favorably, and the agent did NOT send a review request link

--------------------------------------------------
REVIEW REQUEST DETECTION RULES
--------------------------------------------------

A review request is present if the agent:
- shares one of these links:
  1) https://www.trustpilot.com/review/fundednext.com
  2) https://www.sitejabber.com/requested-review?biz_id=62357d8fdf98d
  3) https://propfirmmatch.com/reviews
- or clearly asks for a public review using phrases such as:
  - "Please leave us a review"
  - "Rate us on Trustpilot"
  - "Share your feedback publicly"
  - "Kindly leave a review"
  - "Please review us on Trustpilot / Sitejabber / Propfirmmatch"

Important distinction:
- If the agent sent a review request link, do NOT use Missed Opportunity or Negative Outcome - No Review Request.
- If the agent did NOT send a review request link, do NOT use Likely Positive Review, Likely Negative Review, Highly Likely Positive Review, or Highly Likely Negative Review.
- If the agent did NOT send a review request link and the outcome was favorable with genuine positive client sentiment, use Missed Opportunity.
- If the agent did NOT send a review request link and the outcome was unresolved, pending, escalated, unclear, or negative, use Negative Outcome - No Review Request.
- If the agent sent a review request link too early, while the client was still waiting, frustrated, unresolved, confused, upset, disappointed, or not clearly satisfied, use Likely Negative Review or Highly Likely Negative Review depending on intensity.
- If the issue may have been handled but the client did not clearly confirm successful resolution in their own words, and no review request link was sent, use Negative Outcome - No Review Request.

--------------------------------------------------
TASK 2: CLIENT SENTIMENT
--------------------------------------------------

Classify the client’s overall sentiment using exactly one of these 7 values:

- Very Negative
- Negative
- Slightly Negative
- Neutral
- Slightly Positive
- Positive
- Very Positive

How to choose:
- focus on the client’s overall emotional tone, especially near the end
- if the client starts negative but ends genuinely satisfied, lean positive
- if the client stays unhappy, disappointed, angry, or frustrated, lean negative
- if the client shows little emotion and is mostly factual, use Neutral
- use Very Positive only for strong, clear satisfaction, praise, warmth, or gratitude
- use Very Negative only for strong frustration, anger, repeated complaints, or sharp dissatisfaction

--------------------------------------------------
IMPORTANT INTERPRETATION RULES
--------------------------------------------------

1. Genuine satisfaction matters
Treat these as strong positive signals when the context supports full resolution:
- “Awesome”
- “Perfect”
- “Great”
- “That worked”
- “It’s solved now”
- “Thank you so much”
- “Really appreciate it”
- “You helped a lot”
- “Sure, I’ll leave a review”

2. Weak closing words are NOT enough on their own
Do NOT treat these alone as proof of satisfaction:
- “ok”
- “okay”
- “thanks”
- “fine”
- “alright”
- “noted”

These can be neutral, polite, or even reluctant.

3. Resolved in client’s favor
This usually means:
- the issue was fixed
- the requested information was successfully provided
- the problem was addressed clearly and completely
- the client acknowledged the successful outcome

4. Unresolved / pending situations
These include:
- client still waiting
- escalation pending
- callback promised
- another team will handle it later
- verification/payment/problem still not completed
- vague promise without actual resolution

5. No human handling cases
If the conversation was assigned but the human agent did not actually contribute meaningful support:
- reviewSentiment should reflect whether a review request was sent and whether the outcome was favorable or not
- clientSentiment should still reflect the client’s emotion.

--------------------------------------------------
TASK 3: RESOLUTION STATUS
--------------------------------------------------

Classify the conversation using exactly one of these 4 values:

- Resolved
- Unresolved
- Pending
- Unclear

Definitions:

Resolved:
The client's question or concern was addressed, even if they did not like the answer.

Unresolved:
The client's question or concern was not addressed.
If the client asked multiple questions and even one was left unaddressed, use Unresolved.

Pending:
The client's concern or issue was pending.
The client was told to wait, or the matter was still in progress.

Unclear:
The client went silent and did not confirm whether the issue was solved.
Use this when the final outcome cannot be confirmed from the conversation.

--------------------------------------------------
OUTPUT RULES
--------------------------------------------------

Return ONLY valid JSON.
Do not add markdown.
Do not add explanation outside JSON.

aiVerdict rules:
- MUST be exactly one single line
- maximum 35 words
- MUST include all 3 parts in this exact structure:

"<review verdict>; Client Sentiment: <sentiment>; Resolution Status: <resolution> because <reason>"

Return exactly this structure:

{
  "conversationId": "...",
  "aiVerdict": "...",
  "reviewSentiment": "Likely Negative Review|Likely Positive Review|Highly Likely Negative Review|Highly Likely Positive Review|Missed Opportunity|Negative Outcome - No Review Request",
  "clientSentiment": "Very Negative|Negative|Slightly Negative|Neutral|Slightly Positive|Positive|Very Positive",
  "resolutionStatus": "Resolved|Unresolved|Pending|Unclear"
}`;

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
      fingerprint: data?.[0]?.masked_value || "saved",
    };
  }

  const fallbackSecret = getEnv(envName);

  if (fallbackSecret) {
    return {
      value: fallbackSecret,
      source: "vercel_env_fallback",
      fingerprint: "env",
    };
  }

  throw new Error(
    `No active ${displayName} API key found. Save it in Admin → API key vault first.`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function stripHtml(input) {
  return String(input || "")
    .replace(/<\/(p|div|br|li|h\d)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+\n/g, "\n\n")
    .trim();
}

function isoFromUnix(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toISOString();
}

function roleLabel(authorType) {
  if (authorType === "user") return "USER";
  if (["admin", "teammate", "team_member"].includes(authorType)) return "HUMAN_AGENT";
  return authorType === "bot" ? "BOT" : "SYSTEM";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim();
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
      action_type: normalizeText(payload.action_type) || "audit_action",
      action_label: normalizeText(payload.action_label) || "Audit Action",
      area: normalizeText(payload.area) || "Run Audit",
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
    console.warn("[activity-log] audit run log failed", error);
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

function normalizeConversation(item) {
  const conversationId = String(item?.conversationId || item?.id || "").trim();

  return {
    conversationId,
    repliedAt: item?.repliedAt || null,
    csatScore: item?.csatScore ?? "",
    clientEmail: item?.clientEmail || "",
    agentName: item?.agentName || "Unassigned",
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function chunkArray(items, size = 500) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function normalizeDuplicateMode(value) {
  const mode = String(value || "").trim().toLowerCase();

  if (mode === "skip_existing") return "skip_existing";
  if (mode === "overwrite_existing") return "overwrite_existing";
  if (mode === "cancel") return "cancel";

  return "";
}

function normalizeBatchPayload(body) {
  return {
    batchMode: Boolean(body?.batchMode),
    batchIndex: Number.isFinite(Number(body?.batchIndex)) ? Number(body.batchIndex) : 0,
    totalBatches: Number.isFinite(Number(body?.totalBatches)) ? Number(body.totalBatches) : 0,
    batchSize: Number.isFinite(Number(body?.batchSize)) ? Number(body.batchSize) : 0,
    totalCount: Number.isFinite(Number(body?.totalCount)) ? Number(body.totalCount) : 0,
    batchLabel: String(body?.batchLabel || "").trim(),
  };
}

function normalizeTimestampForDb(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1000000000000) return new Date(value).toISOString();
    if (value > 1000000000) return new Date(value * 1000).toISOString();
  }

  const numeric = Number(String(value).trim());
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1000000000000) return new Date(numeric).toISOString();
    if (numeric > 1000000000) return new Date(numeric * 1000).toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();

  return null;
}

function extractConversationMeta(conversation, fallbackConversation = {}) {
  const parts = Array.isArray(conversation?.conversation_parts?.conversation_parts)
    ? conversation.conversation_parts.conversation_parts
    : [];

  const clientEmail = firstNonEmpty(
    conversation?.contacts?.contacts?.[0]?.email,
    conversation?.source?.author?.email,
    conversation?.author?.email,
    conversation?.user?.email,
    conversation?.customer?.email,
    fallbackConversation?.clientEmail
  );

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

  if (!agentName) {
    const fallbackAgentName = String(fallbackConversation?.agentName || "").trim();
    if (fallbackAgentName && fallbackAgentName !== "Unassigned") {
      agentName = fallbackAgentName;
    }
  }

  return {
    conversationId: firstNonEmpty(conversation?.id, fallbackConversation?.conversationId),
    clientEmail,
    agentName: agentName || "Unassigned",
    csatScore:
      conversation?.conversation_rating?.score ??
      conversation?.conversation_rating?.rating ??
      conversation?.conversation_rating?.value ??
      fallbackConversation?.csatScore ??
      "",
    repliedAt:
      fallbackConversation?.repliedAt ||
      conversation?.conversation_rating?.replied_at ||
      conversation?.updated_at ||
      conversation?.created_at ||
      null,
  };
}

function buildTranscript(conversation) {
  const sourceMessage = conversation?.source?.body
    ? [
        {
          when: isoFromUnix(conversation?.created_at),
          role: roleLabel(conversation?.source?.author?.type),
          name: String(
            conversation?.source?.author?.name ||
              conversation?.source?.author?.email ||
              "unknown"
          ).trim(),
          text: stripHtml(conversation?.source?.body),
        },
      ]
    : [];

  const parts = Array.isArray(conversation?.conversation_parts?.conversation_parts)
    ? conversation.conversation_parts.conversation_parts
    : [];

  const partMessages = parts
    .filter((part) => String(part?.body || "").trim())
    .sort((a, b) => (a?.created_at || 0) - (b?.created_at || 0))
    .map((part) => ({
      when: isoFromUnix(part?.created_at),
      role: roleLabel(part?.author?.type),
      name: String(part?.author?.name || part?.author?.email || "unknown").trim(),
      text: stripHtml(part?.body),
    }));

  const messages = [...sourceMessage, ...partMessages];

  return messages
    .map(
      (message) =>
        `[${message.when}] [${message.role}] (${message.name}): ${message.text}`
    )
    .join("\n\n");
}

async function fetchWithRetry(url, options, label) {
  let lastText = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, options);

    if (response.ok) return response;

    lastText = await response.text();

    if (!shouldRetryStatus(response.status) || attempt === MAX_RETRIES) {
      throw new Error(`${label} failed: ${response.status} ${lastText}`);
    }

    await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
  }

  throw new Error(`${label} failed. ${lastText}`);
}

async function fetchFullConversation(intercomApiKey, conversationId) {
  const response = await fetchWithRetry(
    `https://api.intercom.io/conversations/${conversationId}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": "2.12",
        Authorization: `Bearer ${intercomApiKey}`,
      },
      cache: "no-store",
    },
    `Intercom conversation fetch for ${conversationId}`
  );

  return response.json();
}

async function loadLiveAuditPrompt(adminClient) {
  const { data, error } = await adminClient
    .from("admin_prompt_configs")
    .select("live_prompt")
    .eq("prompt_key", PROMPT_KEY)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01") return FALLBACK_AUDIT_PROMPT;
    throw new Error(error.message || "Could not load live audit prompt.");
  }

  const livePrompt = String(data?.live_prompt || "").trim();
  return livePrompt || FALLBACK_AUDIT_PROMPT;
}

async function loadActiveCalibrationSnippets(adminClient) {
  const { data, error } = await adminClient
    .from("ai_calibration_snippets")
    .select("id, title, applies_to, wrong_verdict, correct_verdict, rule_text, applies_when, does_not_apply_when, example_context, updated_at")
    .eq("is_active", true)
    .eq("applies_to", "review_status")
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    // Do not break audits if the snippet table has not been created yet.
    if (error.code === "42P01") return [];
    throw new Error(error.message || "Could not load calibration snippets.");
  }

  return Array.isArray(data) ? data : [];
}

function formatCalibrationSnippets(snippets) {
  const rows = Array.isArray(snippets) ? snippets : [];
  if (!rows.length) return "";

  const body = rows
    .map((snippet, index) => {
      const title = String(snippet?.title || `Calibration Snippet ${index + 1}`).trim();
      const wrong = String(snippet?.wrong_verdict || "").trim();
      const correct = String(snippet?.correct_verdict || "").trim();
      const rule = String(snippet?.rule_text || "").trim();
      const appliesWhen = String(snippet?.applies_when || "").trim();
      const doesNotApplyWhen = String(snippet?.does_not_apply_when || "").trim();
      const example = String(snippet?.example_context || "").trim();

      return [
        `${index + 1}. ${title}`,
        wrong ? `Wrong Review Status to avoid: ${wrong}` : "Wrong Review Status to avoid: Not specified",
        correct ? `Correct Review Status guidance: ${correct}` : "Correct Review Status guidance: Not specified",
        rule ? `Rule: ${rule}` : "Rule: Not specified",
        appliesWhen ? `Applies when: ${appliesWhen}` : "",
        doesNotApplyWhen ? `Does not apply when: ${doesNotApplyWhen}` : "",
        example ? `Example pattern: ${example}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return `\n\n===== APPROVED REVIEW STATUS CALIBRATION SNIPPETS =====\nThese snippets are approved calibration rules from Master Admin-reviewed disputes. They do not replace the main audit prompt. They clarify Review Status classification and must be checked before finalizing reviewSentiment. Apply a snippet only when the conversation pattern truly matches it. Do not apply snippets to unrelated cases. Client Sentiment and Resolution Status must still follow the main prompt.\n\n${body}\n===== END APPROVED REVIEW STATUS CALIBRATION SNIPPETS =====`;
}

function buildAuditPromptWithCalibration(livePrompt, snippets) {
  return `${livePrompt}${formatCalibrationSnippets(snippets)}`;
}

async function runOpenAIAudit({
  openAiApiKey,
  transcript,
  conversationId,
  auditPrompt,
}) {
  const response = await fetchWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${auditPrompt}\n\nReturn valid JSON only.` },
          {
            role: "user",
            content: `Return your answer as JSON.\n\nConversation ID: ${conversationId}\n\nTranscript:\n${transcript || "(no transcript found)"}`,
          },
        ],
        temperature: 0.1,
      }),
      cache: "no-store",
    },
    `OpenAI audit for ${conversationId}`
  );

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenAI returned an empty response.");
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }

  return {
    aiVerdict: String(parsed?.aiVerdict || "").trim(),
    reviewSentiment: String(parsed?.reviewSentiment || "").trim(),
    clientSentiment: String(parsed?.clientSentiment || "").trim(),
    resolutionStatus: String(parsed?.resolutionStatus || "").trim(),
  };
}

async function fetchExistingStoredResults(adminClient, conversationIds) {
  const ids = Array.from(new Set((conversationIds || []).filter(Boolean)));
  const rows = [];

  for (const chunk of chunkArray(ids, 500)) {
    const { data, error } = await adminClient
      .from("audit_results")
      .select("id, run_id, conversation_id, agent_name, client_email, created_at")
      .in("conversation_id", chunk);

    if (error) {
      throw new Error(error.message || "Could not check existing stored results.");
    }

    rows.push(...(Array.isArray(data) ? data : []));
  }

  return rows;
}

async function removeStoredDuplicates(adminClient, conversationIds) {
  const ids = Array.from(new Set((conversationIds || []).filter(Boolean)));

  if (!ids.length) {
    return { deletedResults: 0, deletedRuns: 0 };
  }

  const rows = [];

  for (const chunk of chunkArray(ids, 500)) {
    const { data, error } = await adminClient
      .from("audit_results")
      .select("id, run_id")
      .in("conversation_id", chunk);

    if (error) {
      throw new Error(error.message || "Could not inspect stored duplicates.");
    }

    rows.push(...(Array.isArray(data) ? data : []));
  }

  if (!rows.length) {
    return { deletedResults: 0, deletedRuns: 0 };
  }

  const runIds = Array.from(new Set(rows.map((item) => item.run_id).filter(Boolean)));
  const resultIds = rows.map((item) => item.id).filter(Boolean);

  for (const chunk of chunkArray(resultIds, 500)) {
    const { error } = await adminClient.from("audit_results").delete().in("id", chunk);

    if (error) {
      throw new Error(error.message || "Could not delete existing stored duplicates.");
    }
  }

  let deletedRuns = 0;

  if (runIds.length) {
    const remainingRows = [];

    for (const chunk of chunkArray(runIds, 500)) {
      const { data, error } = await adminClient
        .from("audit_results")
        .select("run_id")
        .in("run_id", chunk);

      if (error) {
        throw new Error(error.message || "Could not verify remaining run rows.");
      }

      remainingRows.push(...(Array.isArray(data) ? data : []));
    }

    const stillUsedRunIds = new Set(
      remainingRows.map((item) => item.run_id).filter(Boolean)
    );

    const emptyRunIds = runIds.filter((id) => !stillUsedRunIds.has(id));

    for (const chunk of chunkArray(emptyRunIds, 500)) {
      const { error } = await adminClient.from("audit_runs").delete().in("id", chunk);

      if (error) {
        throw new Error(error.message || "Could not clean up duplicate audit runs.");
      }

      deletedRuns += chunk.length;
    }
  }

  return {
    deletedResults: resultIds.length,
    deletedRuns,
  };
}

async function loadAgentMappings(adminClient, agentNames) {
  const normalizedNames = Array.from(
    new Set(
      (agentNames || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );

  const mappingByName = new Map();

  for (const chunk of chunkArray(normalizedNames, 500)) {
    const { data, error } = await adminClient
      .from("agent_mappings")
      .select("intercom_agent_name, employee_name, employee_email, team_name, is_active")
      .in("intercom_agent_name", chunk);

    if (error) {
      throw new Error(error.message || "Could not load agent mappings.");
    }

    for (const row of data || []) {
      if (row?.is_active === false) continue;
      mappingByName.set(normalizeKey(row.intercom_agent_name), row);
    }
  }

  return mappingByName;
}

function attachEmployeeMapping(result, mappingByName) {
  const key = normalizeKey(result?.agentName);
  const mapped = mappingByName.get(key);

  if (!mapped) {
    return {
      ...result,
      employeeName: null,
      employeeEmail: null,
      teamName: null,
      employeeMatchStatus: "unmapped",
    };
  }

  return {
    ...result,
    employeeName: String(mapped.employee_name || "").trim() || null,
    employeeEmail: String(mapped.employee_email || "").trim() || null,
    teamName: String(mapped.team_name || "").trim() || null,
    employeeMatchStatus: "mapped",
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => runWorker());

  await Promise.all(workers);

  return results;
}

async function auditSingleConversation({
  conversation,
  intercomApiKey,
  openAiApiKey,
  auditPrompt,
}) {
  try {
    const fullConversation = await fetchFullConversation(
      intercomApiKey,
      conversation.conversationId
    );

    const transcript = buildTranscript(fullConversation);
    const meta = extractConversationMeta(fullConversation, conversation);

    const audit = await runOpenAIAudit({
      openAiApiKey,
      transcript,
      conversationId: meta.conversationId,
      auditPrompt,
    });

    return {
      conversationId: meta.conversationId,
      repliedAt: meta.repliedAt,
      csatScore: meta.csatScore,
      clientEmail: meta.clientEmail,
      agentName: meta.agentName,
      aiVerdict: audit.aiVerdict,
      reviewSentiment: audit.reviewSentiment,
      clientSentiment: audit.clientSentiment,
      resolutionStatus: audit.resolutionStatus,
    };
  } catch (error) {
    return {
      conversationId: conversation.conversationId,
      repliedAt: conversation.repliedAt,
      csatScore: conversation.csatScore,
      clientEmail: conversation.clientEmail,
      agentName: conversation.agentName,
      error: error instanceof Error ? error.message : "Unknown processing error.",
    };
  }
}

async function auditConversations({
  conversationsToAudit,
  intercomApiKey,
  openAiApiKey,
  auditPrompt,
}) {
  return mapWithConcurrency(
    conversationsToAudit,
    CONVERSATION_CONCURRENCY,
    async (conversation) =>
      auditSingleConversation({
        conversation,
        intercomApiKey,
        openAiApiKey,
        auditPrompt,
      })
  );
}

function buildResultRows(runId, results) {
  return results.map((item) => ({
    run_id: runId,
    conversation_id: item.conversationId || null,
    replied_at: normalizeTimestampForDb(item.repliedAt),
    csat_score:
      item.csatScore === null || item.csatScore === undefined
        ? null
        : String(item.csatScore),
    client_email: item.clientEmail || null,
    agent_name: item.agentName || null,
    employee_name: item.employeeName || null,
    employee_email: item.employeeEmail || null,
    team_name: item.teamName || null,
    employee_match_status: item.employeeMatchStatus || "unmapped",
    ai_verdict: item.aiVerdict || null,
    review_sentiment: item.reviewSentiment || null,
    client_sentiment: item.clientSentiment || null,
    resolution_status: item.resolutionStatus || null,
    error: item.error || null,
  }));
}

async function persistAuditRunAndResults({
  adminClient,
  user,
  email,
  startDate,
  endDate,
  limiterEnabled,
  limitCount,
  receivedCount,
  auditedCount,
  successCount,
  errorCount,
  promptSource,
  results,
  batchInfo,
}) {
  const runId = crypto.randomUUID();

  const batchPromptSuffix = batchInfo?.batchMode
    ? ` | batch ${batchInfo.batchIndex || 1}/${batchInfo.totalBatches || "?"}`
    : "";

  const runPayload = {
    id: runId,
    requested_by_user_id: user.id,
    requested_by_email: email,
    start_date: startDate || null,
    end_date: endDate || null,
    limiter_enabled: limiterEnabled,
    limit_count: limitCount,
    received_count: receivedCount,
    audited_count: auditedCount,
    success_count: successCount,
    error_count: errorCount,
    audit_mode: batchInfo?.batchMode ? "live_gpt_batch" : "live_gpt",
    prompt_source: `${promptSource}${batchPromptSuffix}`,
  };

  const { error: runInsertError } = await adminClient
    .from("audit_runs")
    .insert(runPayload);

  if (runInsertError) {
    throw new Error(runInsertError.message || "Could not save audit run.");
  }

  const { data: runCheck, error: runCheckError } = await adminClient
    .from("audit_runs")
    .select("id")
    .eq("id", runId)
    .maybeSingle();

  if (runCheckError || !runCheck?.id) {
    throw new Error(runCheckError?.message || "Audit run row was not confirmed after insert.");
  }

  const resultRows = buildResultRows(runId, results);

  if (resultRows.length) {
    for (const chunk of chunkArray(resultRows, 500)) {
      const { error: resultsInsertError } = await adminClient
        .from("audit_results")
        .insert(chunk);

      if (resultsInsertError) {
        await adminClient.from("audit_results").delete().eq("run_id", runId);
        await adminClient.from("audit_runs").delete().eq("id", runId);
        throw new Error(resultsInsertError.message || "Could not save audit results.");
      }
    }
  }

  return runId;
}

async function authenticateRequest(request) {
  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return {
      response: json(
        { ok: false, error: "Missing required Supabase environment variables." },
        { status: 500 }
      ),
    };
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!token) {
    return {
      response: json({ ok: false, error: "Missing access token." }, { status: 401 }),
    };
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
    return {
      response: json({ ok: false, error: "Invalid or expired session." }, { status: 401 }),
    };
  }

  const email = normalizeEmail(user.email);
  const domain = email.split("@")[1] || "";

  if (domain !== "nextventures.io") {
    return {
      response: json(
        { ok: false, error: "Only nextventures.io accounts are allowed." },
        { status: 403 }
      ),
    };
  }

  const { data: profileData } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, can_run_tests, is_active")
    .eq("id", user.id)
    .maybeSingle();

  const roleGrant = await readActiveRoleGrant(adminClient, email);
  const profile = resolveEffectiveProfile({ user, email, profileData, grant: roleGrant });

  if (!canRunAudits(profile)) {
    return {
      response: json(
        { ok: false, error: "This account does not have permission to run tests." },
        { status: 403 }
      ),
    };
  }

  const intercomKey = await loadActiveApiKey({
    adminClient,
    keyType: "intercom",
    envName: "INTERCOM_API_KEY",
    displayName: "Intercom",
  });

  const openAiKey = await loadActiveApiKey({
    adminClient,
    keyType: "openai",
    envName: "OPENAI_API_KEY",
    displayName: "OpenAI / GPT",
  });

  return {
    user,
    email,
    profile,
    adminClient,
    intercomApiKey: intercomKey.value,
    openAiApiKey: openAiKey.value,
    apiKeySources: {
      intercom: intercomKey.source,
      openai: openAiKey.source,
    },
  };
}

function applyLimiterIfNeeded(normalizedConversations, limiterEnabled, limitCount, batchInfo) {
  if (batchInfo?.batchMode) return normalizedConversations;
  if (!limiterEnabled) return normalizedConversations;

  const parsedLimit = Number(limitCount);

  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    throw new Error("Limiter is enabled but limitCount is invalid.");
  }

  return normalizedConversations.slice(0, parsedLimit);
}

export async function POST(request) {
  try {
    const auth = await authenticateRequest(request);

    if (auth.response) return auth.response;

    const { user, email, profile, adminClient, intercomApiKey, openAiApiKey, apiKeySources } = auth;
    const body = await request.json();

    const rawConversations = Array.isArray(body?.conversations) ? body.conversations : [];
    const limiterEnabled = Boolean(body?.limiterEnabled);
    const limitCount = body?.limitCount ?? null;
    const startDate = String(body?.startDate || "").trim() || null;
    const endDate = String(body?.endDate || "").trim() || null;
    const duplicateMode = normalizeDuplicateMode(body?.duplicateMode);
    const checkOnly = Boolean(body?.checkOnly);
    const batchInfo = normalizeBatchPayload(body);

    if (!rawConversations.length) {
      return json(
        { ok: false, error: "No fetched conversations were provided for audit." },
        { status: 400 }
      );
    }

    const normalizedConversations = rawConversations
      .map(normalizeConversation)
      .filter((item) => item.conversationId);

    if (!normalizedConversations.length) {
      return json(
        { ok: false, error: "No valid conversation IDs were found in the audit payload." },
        { status: 400 }
      );
    }

    const conversationsToAuditInitial = applyLimiterIfNeeded(
      normalizedConversations,
      limiterEnabled,
      limitCount,
      batchInfo
    );

    const conversationIdsToCheck = Array.from(
      new Set(
        conversationsToAuditInitial
          .map((item) => item.conversationId)
          .filter(Boolean)
      )
    );

    const existingStoredRows = await fetchExistingStoredResults(
      adminClient,
      conversationIdsToCheck
    );

    const duplicateConversationIds = Array.from(
      new Set(
        existingStoredRows
          .map((item) => String(item.conversation_id || "").trim())
          .filter(Boolean)
      )
    );

    const duplicateSummary = {
      duplicateCount: duplicateConversationIds.length,
      sampleConversationIds: duplicateConversationIds.slice(0, 25),
      duplicateConversationIds,
      batchMode: batchInfo.batchMode,
      batchIndex: batchInfo.batchIndex || null,
      totalBatches: batchInfo.totalBatches || null,
    };

    if (checkOnly) {
      await writeActivityLog(adminClient, request, {
        actor_user_id: user.id,
        actor_email: email,
        actor_name: profile?.full_name || email,
        actor_role: profile?.role || "viewer",
        action_type: "audit_duplicate_check",
        action_label: "Duplicate Check Completed",
        area: "Run Audit",
        target_type: "Audit Payload",
        target_label: `${conversationsToAuditInitial.length} conversation(s)`,
        status: "info",
        description: `${email} checked ${conversationsToAuditInitial.length} conversation(s) for duplicates before audit.`,
        safe_after: {
          received_count: normalizedConversations.length,
          checked_count: conversationsToAuditInitial.length,
          duplicate_count: duplicateConversationIds.length,
          batch_mode: batchInfo.batchMode,
          batch_index: batchInfo.batchIndex || null,
          total_batches: batchInfo.totalBatches || null,
        },
      });

      return json({
        ok: true,
        checkOnly: true,
        requiresDuplicateDecision: duplicateConversationIds.length > 0 && !duplicateMode,
        duplicateSummary,
        meta: {
          requestedBy: email,
          receivedCount: normalizedConversations.length,
          checkedCount: conversationsToAuditInitial.length,
          duplicateCount: duplicateConversationIds.length,
          batchMode: batchInfo.batchMode,
          batchIndex: batchInfo.batchIndex || null,
          totalBatches: batchInfo.totalBatches || null,
          apiKeySources,
        },
      });
    }

    if (duplicateConversationIds.length && !duplicateMode) {
      return json(
        {
          ok: false,
          requiresDuplicateDecision: true,
          error: "Some selected conversations already exist in Results.",
          duplicateSummary,
        },
        { status: 409 }
      );
    }

    if (duplicateMode === "cancel") {
      return json(
        {
          ok: false,
          cancelledByUser: true,
          error: "Audit run was cancelled by the user.",
        },
        { status: 400 }
      );
    }

    let conversationsToAudit = conversationsToAuditInitial;

    let duplicateActionMeta = {
      duplicateModeApplied: duplicateMode || "none",
      duplicateCount: duplicateConversationIds.length,
      skippedCount: 0,
      overwrittenCount: 0,
      deletedStoredResults: 0,
      deletedStoredRuns: 0,
    };

    if (duplicateConversationIds.length && duplicateMode === "skip_existing") {
      const duplicateSet = new Set(duplicateConversationIds);

      conversationsToAudit = conversationsToAuditInitial.filter(
        (item) => !duplicateSet.has(item.conversationId)
      );

      duplicateActionMeta = {
        ...duplicateActionMeta,
        duplicateModeApplied: "skip_existing",
        skippedCount: duplicateConversationIds.length,
      };
    }

    if (duplicateConversationIds.length && duplicateMode === "overwrite_existing") {
      const removalSummary = await removeStoredDuplicates(
        adminClient,
        duplicateConversationIds
      );

      duplicateActionMeta = {
        ...duplicateActionMeta,
        duplicateModeApplied: "overwrite_existing",
        overwrittenCount: duplicateConversationIds.length,
        deletedStoredResults: removalSummary.deletedResults,
        deletedStoredRuns: removalSummary.deletedRuns,
      };
    }

    if (!conversationsToAudit.length) {
      await writeActivityLog(adminClient, request, {
        actor_user_id: user.id,
        actor_email: email,
        actor_name: profile?.full_name || email,
        actor_role: profile?.role || "viewer",
        action_type: "audit_run_skipped_duplicates",
        action_label: "Audit Run Skipped Existing",
        area: "Run Audit",
        target_type: "Audit Run",
        target_label: `${normalizedConversations.length} conversation(s)`,
        status: "info",
        description: `${email} skipped audit because all selected conversations already existed in Results.`,
        safe_after: {
          received_count: normalizedConversations.length,
          duplicate_count: duplicateConversationIds.length,
          skipped_count: duplicateActionMeta.skippedCount,
          duplicate_mode: duplicateActionMeta.duplicateModeApplied,
        },
      });

      return json({
        ok: true,
        message: "All selected conversations already exist in Results, so nothing new was audited.",
        meta: {
          requestedBy: email,
          receivedCount: normalizedConversations.length,
          batchReceivedCount: conversationsToAuditInitial.length,
          auditedCount: 0,
          limiterEnabled,
          limitCount,
          auditMode: batchInfo.batchMode ? "live_gpt_batch" : "live_gpt",
          promptSource: "not_needed",
          storageStatus: "no_new_results_saved",
          mappedCount: 0,
          unmappedCount: 0,
          batchMode: batchInfo.batchMode,
          batchIndex: batchInfo.batchIndex || null,
          totalBatches: batchInfo.totalBatches || null,
          batchSize: batchInfo.batchSize || conversationsToAuditInitial.length,
          totalCount: batchInfo.totalCount || normalizedConversations.length,
          concurrency: CONVERSATION_CONCURRENCY,
          apiKeySources,
          ...duplicateActionMeta,
        },
        results: [],
      });
    }

    const liveAuditPrompt = await loadLiveAuditPrompt(adminClient);
    const activeCalibrationSnippets = await loadActiveCalibrationSnippets(adminClient);
    const auditPrompt = buildAuditPromptWithCalibration(liveAuditPrompt, activeCalibrationSnippets);

    const results = await auditConversations({
      conversationsToAudit,
      intercomApiKey,
      openAiApiKey,
      auditPrompt,
    });

    const mappingByName = await loadAgentMappings(
      adminClient,
      results.map((item) => item.agentName)
    );

    const mappedResults = results.map((item) =>
      attachEmployeeMapping(item, mappingByName)
    );

    const mappedCount = mappedResults.filter(
      (item) => item.employeeMatchStatus === "mapped"
    ).length;

    const unmappedCount = mappedResults.length - mappedCount;

    const promptSourceBase =
      liveAuditPrompt === FALLBACK_AUDIT_PROMPT
        ? "fallback_code_prompt"
        : "admin_live_prompt";
    const promptSource = activeCalibrationSnippets.length
      ? `${promptSourceBase}+calibration_snippets:${activeCalibrationSnippets.length}`
      : promptSourceBase;

    const successCount = mappedResults.filter((item) => !item.error).length;
    const errorCount = mappedResults.filter((item) => Boolean(item.error)).length;

    const storedRunId = await persistAuditRunAndResults({
      adminClient,
      user,
      email,
      startDate,
      endDate,
      limiterEnabled,
      limitCount,
      receivedCount: batchInfo.batchMode
        ? conversationsToAuditInitial.length
        : normalizedConversations.length,
      auditedCount: mappedResults.length,
      successCount,
      errorCount,
      promptSource,
      results: mappedResults,
      batchInfo,
    });

    await writeActivityLog(adminClient, request, {
      actor_user_id: user.id,
      actor_email: email,
      actor_name: profile?.full_name || email,
      actor_role: profile?.role || "viewer",
      action_type: "audit_run_completed",
      action_label: "Audit Run Completed",
      area: "Run Audit",
      target_type: "Audit Run",
      target_id: storedRunId,
      target_label: `${mappedResults.length} audited conversation(s)`,
      status: errorCount > 0 ? "warning" : "success",
      description: `${email} completed an audit run with ${mappedResults.length} conversation(s), ${successCount} saved result(s), and ${errorCount} error(s).`,
      safe_after: {
        run_id: storedRunId,
        start_date: startDate,
        end_date: endDate,
        received_count: normalizedConversations.length,
        batch_received_count: conversationsToAuditInitial.length,
        audited_count: mappedResults.length,
        success_count: successCount,
        error_count: errorCount,
        mapped_count: mappedCount,
        unmapped_count: unmappedCount,
        prompt_source: promptSource,
        limiter_enabled: limiterEnabled,
        limit_count: limitCount,
        batch_mode: batchInfo.batchMode,
        batch_index: batchInfo.batchIndex || null,
        total_batches: batchInfo.totalBatches || null,
        duplicate_action: duplicateActionMeta,
        api_key_sources: apiKeySources,
      },
    });

    return json({
      ok: true,
      message:
        mappedResults.length > 0
          ? "Audit completed successfully."
          : "No conversations were available for audit.",
      meta: {
        requestedBy: email,
        receivedCount: normalizedConversations.length,
        batchReceivedCount: conversationsToAuditInitial.length,
        auditedCount: mappedResults.length,
        limiterEnabled,
        limitCount,
        auditMode: batchInfo.batchMode ? "live_gpt_batch" : "live_gpt",
        promptSource,
        storedRunId,
        storageStatus: "saved_to_supabase",
        mappedCount,
        unmappedCount,
        batchMode: batchInfo.batchMode,
        batchIndex: batchInfo.batchIndex || null,
        totalBatches: batchInfo.totalBatches || null,
        batchSize: batchInfo.batchSize || conversationsToAuditInitial.length,
        totalCount: batchInfo.totalCount || normalizedConversations.length,
        batchLabel: batchInfo.batchLabel || null,
        concurrency: CONVERSATION_CONCURRENCY,
        ...duplicateActionMeta,
      },
      results: mappedResults,
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
