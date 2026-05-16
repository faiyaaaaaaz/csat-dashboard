import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INTERCOM_API_BASE = "https://api.intercom.io";
const INTERCOM_PREVIEW_TIMEOUT_MS = 25000;

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
  return String(value || "").trim().toLowerCase();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeIntercomTimestamp(value) {
  if (!value && value !== 0) return null;

  if (typeof value === "number") {
    if (value > 1000000000000) return new Date(value).toISOString();
    if (value > 1000000000) return new Date(value * 1000).toISOString();
  }

  const text = String(value || "").trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    if (numeric > 1000000000000) return new Date(numeric).toISOString();
    if (numeric > 1000000000) return new Date(numeric * 1000).toISOString();
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}


function formatAttributeLabel(label) {
  return normalizeText(label)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function attributeValueText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => attributeValueText(item)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    const direct = normalizeText(value.name || value.label || value.title || value.value || value.text || value.status);
    if (direct) return direct;
    return Object.entries(value)
      .map(([key, item]) => {
        const text = attributeValueText(item);
        return text ? `${formatAttributeLabel(key)}: ${text}` : "";
      })
      .filter(Boolean)
      .join(", ");
  }
  const text = stripHtml(value).replace(/\s+/g, " ").trim();
  if (!text || /^(null|undefined|nan)$/i.test(text)) return "";
  if (/\.(png|jpe?g|gif|webp|mp4|mov|avi|mkv)(\?|$)/i.test(text)) return "";
  return text;
}

function collectAttributeRows(...sources) {
  const rows = [];
  const seen = new Set();

  const push = (label, value) => {
    const cleanLabel = formatAttributeLabel(label);
    const cleanValue = attributeValueText(value);
    if (!cleanLabel || !cleanValue) return;
    const key = `${cleanLabel.toLowerCase()}::${cleanValue.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ label: cleanLabel, value: cleanValue });
  };

  sources.forEach((source) => {
    if (!source) return;
    if (Array.isArray(source)) {
      source.forEach((item) => {
        if (!item) return;
        if (typeof item === "object" && !Array.isArray(item)) {
          push(item.label || item.name || item.key || item.title, item.value ?? item.text ?? item.content ?? item.body);
        } else {
          push("Attribute", item);
        }
      });
      return;
    }
    if (typeof source === "object") {
      Object.entries(source).forEach(([key, value]) => push(key, value));
    }
  });

  return rows.slice(0, 80);
}

function collectNames(values) {
  const list = Array.isArray(values) ? values : [];
  return Array.from(
    new Set(
      list
        .map((item) => normalizeText(item?.name || item?.label || item))
        .filter(Boolean)
    )
  );
}

function detectPrimaryAgentName(conversation) {
  const direct = normalizeText(
    conversation?.assignee?.name ||
    conversation?.admin_assignee?.name ||
    conversation?.teammate_assignee?.name
  );

  if (direct) return direct;

  const sourceAuthor = conversation?.source?.author;
  if (authorRole(sourceAuthor) === "agent") return authorLabel(sourceAuthor);

  const parts = Array.isArray(conversation?.conversation_parts?.conversation_parts)
    ? conversation.conversation_parts.conversation_parts
    : [];

  for (const part of parts) {
    if (authorRole(part?.author) === "agent") return authorLabel(part.author);
  }

  return "";
}

function attachmentPreviewText(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return "";

  const names = list
    .map((item) => normalizeText(item?.name || item?.file_name || item?.content_type))
    .filter(Boolean);

  const hasVisual = list.some((item) => {
    const type = normalizeText(item?.content_type).toLowerCase();
    return type.startsWith("image/") || type.startsWith("video/");
  });

  const prefix = hasVisual ? "Image or video omitted in preview." : "Attachment omitted in preview.";
  return names.length ? `${prefix} ${names.join(", ")}` : prefix;
}

function buildPartFallbackBody(part) {
  const attachmentText = attachmentPreviewText(part?.attachments);
  if (attachmentText) return attachmentText;

  const summary = stripHtml(part?.summary || part?.description || part?.redacted || part?.event_description);
  if (summary) return summary;

  const label = normalizeText(part?.part_type || part?.type || "update").replace(/_/g, " ");
  const assignee = normalizeText(part?.assigned_to?.name || part?.admin_assignee?.name || part?.teammate_assignee?.name);

  if (label && assignee) return `${label.charAt(0).toUpperCase() + label.slice(1)}: ${assignee}`;
  if (label) return `${label.charAt(0).toUpperCase() + label.slice(1)}.`;

  return "Open on Intercom to see this message.";
}

function buildSourceFallbackBody(source) {
  const attachmentText = attachmentPreviewText(source?.attachments);
  if (attachmentText) return attachmentText;
  return "Open on Intercom to see this message.";
}

function authorLabel(author) {
  const type = normalizeText(author?.type).toLowerCase();
  const name = normalizeText(author?.name || author?.email || author?.id);

  if (name) return name;
  if (type === "admin" || type === "team_member" || type === "teammate") return "Agent";
  if (type === "user" || type === "lead" || type === "contact") return "Client";
  return "Unknown";
}

function authorRole(author) {
  const type = normalizeText(author?.type).toLowerCase();
  if (type === "admin" || type === "team_member" || type === "teammate") return "agent";
  if (type === "user" || type === "lead" || type === "contact") return "client";
  if (type === "bot" || type === "workflow") return "system";
  return "system";
}

function buildMessage({ id, author, body, createdAt, messageType, sourceType, fallbackBody }) {
  const cleaned = stripHtml(body);
  const fallback = normalizeText(fallbackBody);
  const finalBody = cleaned || fallback || "Open on Intercom to see this message.";
  const hasRenderableText = Boolean(cleaned || fallback);

  return {
    id: normalizeText(id) || crypto.randomUUID(),
    authorName: authorLabel(author),
    authorType: authorRole(author),
    authorEmail: normalizeEmail(author?.email) || null,
    createdAt: normalizeIntercomTimestamp(createdAt),
    messageType: normalizeText(messageType || sourceType || "message") || "message",
    body: finalBody,
    isRenderableText: hasRenderableText,
  };
}

function buildTranscript(conversation) {
  const messages = [];

  if (conversation?.source) {
    messages.push(
      buildMessage({
        id: conversation.source.id || "source",
        author: conversation.source.author || conversation.author,
        body: conversation.source.body || conversation.source.delivered_as,
        createdAt: conversation.created_at,
        messageType: conversation.source.type || "conversation_start",
        sourceType: "conversation_start",
        fallbackBody: buildSourceFallbackBody(conversation.source),
      })
    );
  }

  const parts = Array.isArray(conversation?.conversation_parts?.conversation_parts)
    ? conversation.conversation_parts.conversation_parts
    : [];

  for (const part of parts) {
    messages.push(
      buildMessage({
        id: part?.id,
        author: part?.author,
        body: part?.body,
        createdAt: part?.created_at,
        messageType: part?.part_type || part?.type || "conversation_part",
        fallbackBody: buildPartFallbackBody(part),
      })
    );
  }

  return messages
    .filter((message) => message.body || message.createdAt)
    .sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });
}

function buildMetadata(conversation) {
  return {
    conversationId: normalizeText(conversation?.id),
    createdAt: normalizeIntercomTimestamp(conversation?.created_at),
    updatedAt: normalizeIntercomTimestamp(conversation?.updated_at),
    state: normalizeText(conversation?.state || conversation?.status),
    clientName:
      normalizeText(conversation?.contacts?.contacts?.[0]?.name) ||
      normalizeText(conversation?.source?.author?.name) ||
      normalizeText(conversation?.author?.name) ||
      "",
    clientEmail:
      normalizeEmail(conversation?.contacts?.contacts?.[0]?.email) ||
      normalizeEmail(conversation?.source?.author?.email) ||
      normalizeEmail(conversation?.author?.email) ||
      "",
    assignedAdmin: detectPrimaryAgentName(conversation) || "Unassigned",
    rating:
      conversation?.conversation_rating?.score ??
      conversation?.conversation_rating?.rating ??
      conversation?.conversation_rating?.value ??
      null,
    subject: normalizeText(conversation?.source?.subject || conversation?.source?.title || conversation?.title),
    teamName: normalizeText(conversation?.team_assignee?.name || conversation?.team?.name),
    inboxName: normalizeText(conversation?.inbox?.name || conversation?.source?.name),
    workflowName: normalizeText(conversation?.conversation_message?.subject || conversation?.source?.delivered_as),
    tags: collectNames(conversation?.tags?.tags),
    attributes: collectAttributeRows(
      conversation?.custom_attributes,
      conversation?.conversation_attributes,
      conversation?.source?.custom_attributes,
      conversation?.source?.author?.custom_attributes,
      conversation?.contacts?.contacts?.[0]?.custom_attributes,
      conversation?.contacts?.contacts?.[0]?.social_profiles,
    ),
  };
}


async function fetchIntercomConversationWithTimeout(url, options = {}, timeoutMs = INTERCOM_PREVIEW_TIMEOUT_MS) {
  const controller = new AbortController();
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("Intercom preview request timed out. Please try again or open the conversation on Intercom."));
    }, timeoutMs);
  });

  const requestPromise = (async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  })();

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Intercom preview request timed out. Please try again or open the conversation on Intercom.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function loadActiveApiKey(adminClient) {
  const { data, error } = await adminClient
    .from("api_keys")
    .select("secret_value")
    .eq("key_type", "intercom")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error && error.code !== "42P01") {
    throw new Error(error.message || "Could not load Intercom API key.");
  }

  const savedSecret = normalizeText(data?.[0]?.secret_value);
  const envSecret = getEnv("INTERCOM_API_KEY") || getEnv("INTERCOM_TOKEN");
  const secret = savedSecret || envSecret;

  if (!secret) {
    throw new Error("No active Intercom API key found. Save it in Admin -> API key vault first.");
  }

  return secret;
}

async function authenticate(request) {
  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return { ok: false, response: json({ ok: false, error: "Missing Supabase environment variables." }, { status: 500 }) };
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

  if (!token) {
    return { ok: false, response: json({ ok: false, error: "Missing access token." }, { status: 401 }) };
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  const user = authData?.user;

  if (authError || !user?.id) {
    return { ok: false, response: json({ ok: false, error: "Invalid or expired session." }, { status: 401 }) };
  }

  const email = normalizeEmail(user.email);
  if (!email.endsWith("@nextventures.io")) {
    return { ok: false, response: json({ ok: false, error: "Access blocked. Only nextventures.io accounts are allowed." }, { status: 403 }) };
  }

  return { ok: true, adminClient, user, email };
}

export async function POST(request) {
  try {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => ({}));
    const conversationId = normalizeText(body?.conversationId || body?.conversation_id || body?.id);

    if (!conversationId) {
      return json({ ok: false, error: "Conversation ID is required." }, { status: 400 });
    }

    const intercomApiKey = await loadActiveApiKey(auth.adminClient);
    const { response, text } = await fetchIntercomConversationWithTimeout(`${INTERCOM_API_BASE}/conversations/${encodeURIComponent(conversationId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Intercom-Version": "2.12",
        Authorization: `Bearer ${intercomApiKey}`,
      },
      cache: "no-store",
    });
    let conversation = null;
    try {
      conversation = text ? JSON.parse(text) : null;
    } catch {
      conversation = null;
    }

    if (!response.ok || !conversation) {
      return json(
        {
          ok: false,
          error: `Could not load conversation preview from Intercom. Status ${response.status}.`,
          hint: "Open on Intercom to see this conversation.",
        },
        { status: response.status || 502 }
      );
    }

    const messages = buildTranscript(conversation);

    return json({
      ok: true,
      conversationId,
      metadata: buildMetadata(conversation),
      messages,
      messageCount: messages.length,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Could not load conversation preview.",
        hint: "Open on Intercom to see this conversation.",
      },
      { status: 500 }
    );
  }
}
