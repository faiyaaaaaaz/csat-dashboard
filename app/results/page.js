"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabase";

const INTERCOM_CONVERSATION_URL_PREFIX =
  "https://app.intercom.com/a/inbox/aphmhtyj/inbox/conversation";
const RESULTS_CACHE_PREFIX = "cx-insights-results-cache";
const RESULTS_CACHE_TTL_MS = 0;

const DATE_PRESET_OPTIONS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "past_7_days", label: "Past 7 Days" },
  { key: "past_30_days", label: "Past 30 Days" },
  { key: "this_month", label: "This Month" },
  { key: "past_90_days", label: "Past 90 Days" },
  { key: "custom", label: "Custom" },
];

const RESULT_TYPE_OPTIONS = [
  { value: "all", label: "All Results" },
  { value: "success_only", label: "Successful Only" },
  { value: "Errors_only", label: "Errors Only" },
  { value: "opportunity_cases", label: "Missed Opportunities" },
  { value: "positive_signals", label: "Positive Signals" },
  { value: "negative_risk", label: "Negative Risk" },
];

const REVIEW_SENTIMENT_OPTIONS = [
  "Likely Negative Review",
  "Likely Positive Review",
  "Highly Likely Negative Review",
  "Highly Likely Positive Review",
  "Missed Opportunity",
  "Negative Outcome - No Review Request",
];

const CLIENT_SENTIMENT_OPTIONS = [
  "Very Negative",
  "Negative",
  "Slightly Negative",
  "Neutral",
  "Slightly Positive",
  "Positive",
  "Very Positive",
];

const RESOLUTION_STATUS_OPTIONS = ["Resolved", "Unresolved", "Pending", "Unclear"];

const MAPPING_STATUS_OPTIONS = [
  { value: "all", label: "All Mapping" },
  { value: "mapped", label: "Mapped" },
  { value: "unmapped", label: "Unmapped" },
];

const DUPLICATE_MODE_OPTIONS = [
  {
    value: "skip_existing",
    label: "Skip Existing",
    helper: "Safest Option. Existing Conversation IDs Will Stay Untouched.",
  },
  {
    value: "overwrite_existing",
    label: "Overwrite Existing",
    helper: "Replaces matching conversation IDs with the uploaded workbook data.",
  },
  {
    value: "fail_if_duplicates",
    label: "Stop on Duplicates",
    helper: "Stops the import if any uploaded conversation already exists.",
  },
];


function intercomConversationUrl(conversationId) {
  const id = String(conversationId || "").trim();
  return id ? INTERCOM_CONVERSATION_URL_PREFIX + "/" + id : "#";
}

function normalizePreviewMessages(data) {
  return Array.isArray(data?.messages) ? data.messages : [];
}

function previewText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const joined = value.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ");
      if (joined) return joined;
      continue;
    }
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function previewTags(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const list = value.map((item) => String(item ?? "").trim()).filter(Boolean);
      if (list.length) return Array.from(new Set(list));
    }
    const text = String(value ?? "").trim();
    if (text) return [text];
  }
  return [];
}


function formatPreviewAttributeLabel(label) {
  return String(label || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function previewAttributeValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => previewAttributeValue(item))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") {
    const direct = previewText(value.name, value.label, value.title, value.value, value.text, value.status);
    if (direct) return direct;
    return Object.entries(value)
      .map(([key, item]) => {
        const itemText = previewAttributeValue(item);
        return itemText ? `${formatPreviewAttributeLabel(key)}: ${itemText}` : "";
      })
      .filter(Boolean)
      .join(", ");
  }
  const text = String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/^(null|undefined|nan)$/i.test(text)) return "";
  if (/\.(png|jpe?g|gif|webp|mp4|mov|avi|mkv)(\?|$)/i.test(text)) return "";
  return text;
}

function isPreviewValueFilled(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && text !== "-" && !/^(null|undefined|nan)$/i.test(text));
}

function previewAttributes(...values) {
  const rows = [];
  const seen = new Set();

  const pushRow = (label, value) => {
    const cleanLabel = formatPreviewAttributeLabel(label);
    const cleanValue = previewAttributeValue(value);
    if (!cleanLabel || !cleanValue) return;
    const key = `${cleanLabel.toLowerCase()}::${cleanValue.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ label: cleanLabel, value: cleanValue });
  };

  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (!item) return;
        if (typeof item === "object" && !Array.isArray(item)) {
          pushRow(item.label || item.name || item.key || item.title, item.value ?? item.text ?? item.content ?? item.body);
        } else {
          pushRow("Attribute", item);
        }
      });
      continue;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => pushRow(key, item));
    }
  }

  return rows.slice(0, 80);
}

function buildPreviewMetadata(serverMetadata = {}, previewContext = null) {
  const context = previewContext && typeof previewContext === "object" ? previewContext : {};
  return {
    conversationId: previewText(serverMetadata.conversationId, context.conversationId, context.conversation_id, context.id),
    clientEmail: previewText(serverMetadata.clientEmail, context.clientEmail, context.client_email),
    contactName: previewText(serverMetadata.clientName, serverMetadata.contactName, context.clientName, context.client_name),
    assignedAgent: previewText(
      serverMetadata.assignedAdmin,
      context.agentName,
      context.agent_name,
      context.assignedAdmin,
      context.assigned_admin
    ),
    rating: previewText(
      serverMetadata.rating,
      context.conversationRating,
      context.conversation_rating,
      context.csatScore,
      context.csat_score,
      context.rating
    ),
    status: previewText(serverMetadata.state, context.status, context.state),
    createdAt: previewText(serverMetadata.createdAt, context.createdAt, context.created_at),
    updatedAt: previewText(serverMetadata.updatedAt, context.updatedAt, context.updated_at, context.repliedAt, context.replied_at),
    reviewApproach: previewText(context.reviewSentiment, context.review_sentiment, context.reviewApproach, context.review_approach),
    clientSentiment: previewText(context.clientSentiment, context.client_sentiment),
    resolutionStatus: previewText(context.resolutionStatus, context.resolution_status),
    aiVerdict: previewText(context.aiVerdict, context.ai_verdict, context.error),
    teamName: previewText(serverMetadata.teamName, context.teamName, context.team_name),
    inboxName: previewText(serverMetadata.inboxName, context.inboxName, context.inbox_name),
    workflowName: previewText(serverMetadata.workflowName, context.workflowName, context.workflow_name),
    subject: previewText(serverMetadata.subject, context.subject),
    tags: previewTags(serverMetadata.tags, context.tags),
    customAttributes: previewAttributes(serverMetadata.attributes, serverMetadata.customAttributes, context.attributes, context.customAttributes, context.custom_attributes),
  };
}

function isCompactPreviewEvent(message) {
  const type = String(message?.messageType || "").toLowerCase();
  const body = previewText(message?.body).toLowerCase();

  if (message?.authorType === "system") return true;

  const systemTypeHints = [
    "assignment",
    "assign",
    "workflow",
    "sla",
    "attribute",
    "tag",
    "close",
    "open",
    "snooze",
    "custom_action",
    "operator_workflow",
    "language_detection",
    "conversation_rating",
  ];

  if (systemTypeHints.some((hint) => type.includes(hint))) return true;

  return /\b(conversation\s+(sla|attribute|status|rating|tag|assigned|assignment|reopened|closed|snoozed|updated)|sla\s+target\s+missed|operator\s+workflow|default\s+assignment|custom\s+action|message\s+strategy\s+assignment|language\s+detection|fin\s+(guidance|customisation)|queue\s+position|workflow\s+event|attribute\s+updated)\b/i.test(body);
}

function compactPreviewEventText(message) {
  return previewText(message?.body, message?.messageType, "Conversation event.");
}

function ConversationPreviewModal({ conversationId, previewContext = null, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      if (!conversationId) return;
      setLoading(true);
      setError("");
      setData(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) throw new Error("Your session expired. Please refresh and sign in again.");
        const response = await fetch("/api/intercom/conversation-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ conversationId }),
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Preview is not available for this conversation.");
        if (!cancelled) setData(payload);
      } catch (previewError) {
        if (!cancelled) setError(previewError instanceof Error ? previewError.message : "Preview is not available for this conversation.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadPreview();
    return () => { cancelled = true; };
  }, [conversationId]);

  if (!conversationId) return null;
  const messages = normalizePreviewMessages(data);
  const mergedMetadata = useMemo(() => buildPreviewMetadata(data?.metadata || {}, previewContext), [data, previewContext]);
  const auditResultCards = [
    { label: "Review Approach", value: mergedMetadata.reviewApproach || "", tone: "review" },
    { label: "Client Sentiment", value: mergedMetadata.clientSentiment || "", tone: "client" },
    { label: "Resolution", value: mergedMetadata.resolutionStatus || "", tone: "resolution" },
  ].filter((card) => isPreviewValueFilled(card.value));
  const primaryRows = [
    { label: "Assigned Agent", value: mergedMetadata.assignedAgent || "Unassigned" },
    { label: "Rating", value: mergedMetadata.rating || "-" },
    { label: "Status", value: mergedMetadata.status || "-" },
    { label: "Created", value: mergedMetadata.createdAt ? formatDateTime(mergedMetadata.createdAt) : "-" },
    { label: "Updated", value: mergedMetadata.updatedAt ? formatDateTime(mergedMetadata.updatedAt) : "-" },
  ].filter((row) => isPreviewValueFilled(row.value));
  const contextRows = [
    { label: "Contact", value: mergedMetadata.contactName || mergedMetadata.clientEmail || "" },
    { label: "Team", value: mergedMetadata.teamName || "" },
    { label: "Inbox", value: mergedMetadata.inboxName || "" },
    { label: "Workflow", value: mergedMetadata.workflowName || "" },
    { label: "Topic", value: mergedMetadata.subject || "" },
  ].filter((row) => isPreviewValueFilled(row.value));
  const attributeSections = [
    { title: "Conversation Details", subtitle: "Core Intercom fields", rows: primaryRows },
    { title: "Intercom Context", subtitle: "Routing and contact data", rows: contextRows },
    { title: "Intercom Attributes", subtitle: "Additional populated fields", rows: mergedMetadata.customAttributes || [] },
  ].filter((section) => section.rows.length);
  const tags = mergedMetadata.tags || [];

  return createPortal(
    <div className="conversation-preview-backdrop" onClick={onClose}>
      <div className="conversation-preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="conversation-preview-head">
          <div>
            <p>Conversation Preview</p>
            <h2>{conversationId}</h2>
            <span>
              {mergedMetadata.clientEmail || "Client email unavailable"} · {formatNumber(messages.length)} message(s)
            </span>
          </div>
          <div className="conversation-preview-actions">
            <a href={intercomConversationUrl(conversationId)} target="_blank" rel="noreferrer" className="secondary-btn">Open on Intercom</a>
            <button type="button" className="secondary-btn light-action" onClick={onClose}>Close</button>
          </div>
        </div>
        {loading ? (
          <div className="conversation-preview-loading">Loading the full Intercom conversation...</div>
        ) : error ? (
          <div className="conversation-preview-error"><strong>Preview Not Available</strong><span>{error}</span><small>Open on Intercom to see this conversation.</small></div>
        ) : (
          <div className="conversation-preview-loaded">
            {auditResultCards.length ? (
              <div className="conversation-preview-result-strip">
                {auditResultCards.map((card) => (
                  <div key={card.label} className={`conversation-preview-result-card ${card.tone}`}>
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="conversation-preview-body">
              <aside className="conversation-preview-sidebar">
                <div className="conversation-preview-sidebar-title">
                  <span>Case Details</span>
                  <small>Compact audit and Intercom context</small>
                </div>
                {attributeSections.map((section) => (
                  <section key={section.title} className="conversation-preview-compact-section">
                    <div className="conversation-preview-section-head">
                      <span>{section.title}</span>
                      <small>{section.subtitle}</small>
                    </div>
                    <div className="conversation-preview-attribute-list">
                      {section.rows.map((row) => (
                        <div key={`${section.title}-${row.label}`} className="conversation-preview-attr-row">
                          <span>{row.label}</span>
                          <strong>{row.value}</strong>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
                {tags.length ? (
                  <section className="conversation-preview-compact-section">
                    <div className="conversation-preview-section-head">
                      <span>Tags</span>
                      <small>Labels and workflow markers</small>
                    </div>
                    <div className="conversation-preview-tags">
                      {tags.map((tag) => <i key={tag}>{tag}</i>)}
                    </div>
                  </section>
                ) : null}
              </aside>
              <section className="conversation-preview-main">
                {mergedMetadata.aiVerdict ? (
                  <div className="conversation-preview-verdict">
                    <div className="conversation-preview-verdict-head">
                      <span>AI Verdict Snapshot</span>
                      <small>From the stored audit result</small>
                    </div>
                    <pre>{mergedMetadata.aiVerdict}</pre>
                  </div>
                ) : null}
                <div className="conversation-transcript-list">
                  {messages.length ? messages.map((message) => {
                    const isEvent = isCompactPreviewEvent(message);
                    return isEvent ? (
                      <div key={message.id} className="conversation-timeline-event">
                        <span>{formatDateTime(message.createdAt)}</span>
                        <p>{compactPreviewEventText(message)}</p>
                      </div>
                    ) : (
                      <article key={message.id} className={`conversation-message ${message.authorType || "system"}`}>
                        <div className="conversation-message-top"><strong>{message.authorName || "Unknown"}</strong><span>{formatDateTime(message.createdAt)}</span></div>
                        <p>{message.body || "Open on Intercom to see this message."}</p>
                        {!message.isRenderableText ? <small>Open on Intercom to see this message.</small> : null}
                      </article>
                    );
                  }) : <div className="conversation-preview-empty">No renderable text was returned. Open on Intercom to see this conversation.</div>}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ConversationActionButtons({
  conversationId,
  previewContext = null,
  onPreview,
  onToggleVerdict = null,
  verdictVisible = false,
}) {
  const id = String(conversationId || "").trim();
  if (!id) return <span className="preview-unavailable">Preview Not Available</span>;
  return (
    <div className="conversation-action-buttons">
      <button type="button" className="mini-preview-btn" onClick={() => onPreview(id, previewContext)}>Preview Conversation</button>
      <a href={intercomConversationUrl(id)} target="_blank" rel="noreferrer" className="mini-open-link">Open on Intercom</a>
      {typeof onToggleVerdict === "function" ? (
        <button type="button" className={`mini-verdict-btn ${verdictVisible ? "active" : ""}`} onClick={onToggleVerdict}>
          {verdictVisible ? "Hide AI Verdict" : "See AI Verdict"}
        </button>
      ) : null}
    </div>
  );
}


const IMPORT_PROGRESS_STEPS = [
  {
    label: "Preparing upload",
    detail: "Checking file, session, and import settings.",
    percent: 8,
  },
  {
    label: "Reading workbook",
    detail: "Opening the Excel file and scanning workbook structure.",
    percent: 18,
  },
  {
    label: "Detecting date tabs",
    detail: "Looking for sheet tabs named by date.",
    percent: 30,
  },
  {
    label: "Extracting rows",
    detail: "Reading conversations from each valid date tab.",
    percent: 46,
  },
  {
    label: "Normalizing fields",
    detail: "Cleaning dates, sentiments, agents, employees, and verdict fields.",
    percent: 62,
  },
  {
    label: "Checking duplicates",
    detail: "Comparing uploaded conversation IDs with stored Results data.",
    percent: 76,
  },
  {
    label: "Saving to Supabase",
    detail: "Creating the import run and inserting clean audit result rows.",
    percent: 88,
  },
  {
    label: "Refreshing Results",
    detail: "Reloading the archive with the imported data.",
    percent: 96,
  },
];

function getResultsCacheKey(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return `${RESULTS_CACHE_PREFIX}:${normalized || "anonymous"}`;
}

function readClientCache(key) {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function writeClientCache(key, value) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch (_error) {
    // Ignore quota or serialization failures.
  }
}

function normalizeToStartOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateInput(date) {
  const local = normalizeToStartOfDay(date);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return normalizeToStartOfDay(next);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getPresetRange(key) {
  const today = normalizeToStartOfDay(new Date());

  switch (key) {
    case "today":
      return { startDate: formatDateInput(today), endDate: formatDateInput(today) };
    case "yesterday": {
      const yesterday = shiftDays(today, -1);
      return { startDate: formatDateInput(yesterday), endDate: formatDateInput(yesterday) };
    }
    case "past_7_days":
      return { startDate: formatDateInput(shiftDays(today, -6)), endDate: formatDateInput(today) };
    case "past_30_days":
      return { startDate: formatDateInput(shiftDays(today, -29)), endDate: formatDateInput(today) };
    case "this_month":
      return { startDate: formatDateInput(startOfMonth(today)), endDate: formatDateInput(today) };
    case "past_90_days":
      return { startDate: formatDateInput(shiftDays(today, -89)), endDate: formatDateInput(today) };
    default:
      return null;
  }
}

function safeText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function toValidDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInputFromValue(value) {
  const date = toValidDate(value);
  return date ? formatDateInput(date) : "";
}

function formatDateTime(value) {
  const date = toValidDate(value);
  if (!date) return value ? String(value) : "-";

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDate(value) {
  const date = toValidDate(value);
  if (!date) return value ? String(value) : "-";

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function shiftMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return normalizeToStartOfDay(next);
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function sameCalendarDay(a, b) {
  return a && b && formatDateInput(a) === formatDateInput(b);
}

function formatMonthTitle(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function buildCalendarDays(monthDate) {
  const first = monthStart(monthDate);
  const last = monthEnd(monthDate);
  const days = [];
  const startOffset = first.getDay();
  for (let index = 0; index < startOffset; index += 1) {
    const date = new Date(first);
    date.setDate(first.getDate() - (startOffset - index));
    days.push({ date, muted: true });
  }
  for (let day = 1; day <= last.getDate(); day += 1) {
    days.push({ date: new Date(first.getFullYear(), first.getMonth(), day), muted: false });
  }
  while (days.length % 7 !== 0 || days.length < 42) {
    const lastDate = days[days.length - 1].date;
    const date = new Date(lastDate);
    date.setDate(lastDate.getDate() + 1);
    days.push({ date, muted: true });
  }
  return days;
}

function isDateInDraftRange(date, draftStart, draftEnd) {
  if (!draftStart || !draftEnd) return false;
  const value = normalizeToStartOfDay(date).getTime();
  return value >= normalizeToStartOfDay(draftStart).getTime() && value <= normalizeToStartOfDay(draftEnd).getTime();
}

function ResultsCalendarMonth({ monthDate, draftStart, draftEnd, onSelectDate }) {
  const days = buildCalendarDays(monthDate);
  return (
    <div className="results-calendar-month-card">
      <h4>{formatMonthTitle(monthDate)}</h4>
      <div className="results-calendar-weekdays notranslate" translate="no">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="notranslate" translate="no">{day}</span>)}</div>
      <div className="results-calendar-day-grid">
        {days.map(({ date, muted }) => {
          const isStart = draftStart && sameCalendarDay(date, draftStart);
          const isEnd = draftEnd && sameCalendarDay(date, draftEnd);
          const inRange = isDateInDraftRange(date, draftStart, draftEnd);
          return (
            <button key={formatDateInput(date)} type="button" className={["results-calendar-day", muted ? "muted" : "", inRange ? "in-range" : "", isStart ? "range-start" : "", isEnd ? "range-end" : ""].filter(Boolean).join(" ")} onClick={() => onSelectDate(date)}>
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ResultsDateRangePicker({ startDate, endDate, selectedDatePreset, onApplyPreset, onApplyCustom }) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(startDate ? normalizeToStartOfDay(new Date(`${startDate}T00:00:00`)) : null);
  const [draftEnd, setDraftEnd] = useState(endDate ? normalizeToStartOfDay(new Date(`${endDate}T00:00:00`)) : null);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(startDate ? new Date(`${startDate}T00:00:00`) : new Date()));
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    setDraftStart(startDate ? normalizeToStartOfDay(new Date(`${startDate}T00:00:00`)) : null);
    setDraftEnd(endDate ? normalizeToStartOfDay(new Date(`${endDate}T00:00:00`)) : null);
    setVisibleMonth(monthStart(startDate ? new Date(`${startDate}T00:00:00`) : new Date()));
  }, [open, startDate, endDate]);

  useEffect(() => {
    function handleOutside(event) {
      if (!ref.current) return;
      if (!ref.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  function selectDate(date) {
    const normalized = normalizeToStartOfDay(date);
    if (!draftStart || (draftStart && draftEnd)) {
      setDraftStart(normalized);
      setDraftEnd(null);
      return;
    }
    if (normalized < draftStart) {
      setDraftEnd(draftStart);
      setDraftStart(normalized);
      return;
    }
    setDraftEnd(normalized);
  }

  function applyCustomRange() {
    const safeStart = draftStart || draftEnd;
    const safeEnd = draftEnd || draftStart;
    if (!safeStart || !safeEnd) return;
    onApplyCustom(formatDateInput(safeStart), formatDateInput(safeEnd));
    setOpen(false);
  }

  function applyPreset(key) {
    onApplyPreset(key);
    if (key !== "custom") setOpen(false);
  }

  const displayRange = startDate && endDate ? `${startDate} to ${endDate}` : "Select a range";
  const selectedLabel = DATE_PRESET_OPTIONS.find((item) => item.key === selectedDatePreset)?.label || "Custom";
  const secondMonth = shiftMonths(visibleMonth, 1);

  return (
    <div className={open ? "results-date-range-picker open" : "results-date-range-picker"} ref={ref}>
      <label>
        <span>Date Range</span>
        <button type="button" className="results-date-button" onClick={() => setOpen((prev) => !prev)}>
          <strong><CalendarIcon /> {selectedLabel}</strong>
          <small>{displayRange}</small>
          <b>{open ? "Up" : "Down"}</b>
        </button>
      </label>

      {open ? (
        <div className="results-date-popover">
          <div className="results-date-popover-tabs">
            <div><span>From</span><strong>{draftStart ? formatDateInput(draftStart) : "Choose Start"}</strong></div>
            <div className={draftEnd ? "active" : ""}><span>To</span><strong>{draftEnd ? formatDateInput(draftEnd) : "Choose End"}</strong></div>
          </div>
          <div className="results-date-popover-body">
            <aside className="results-date-preset-column">
              {DATE_PRESET_OPTIONS.map((item) => (
                <button key={item.key} type="button" className={item.key === selectedDatePreset ? "active" : ""} onClick={() => applyPreset(item.key)}>{item.label}</button>
              ))}
            </aside>
            <div className="results-date-calendar-zone">
              <div className="results-calendar-nav-row">
                <button type="button" onClick={() => setVisibleMonth((prev) => shiftMonths(prev, -1))}>‹</button>
                <strong>{formatMonthTitle(visibleMonth)} - {formatMonthTitle(secondMonth)}</strong>
                <button type="button" onClick={() => setVisibleMonth((prev) => shiftMonths(prev, 1))}>›</button>
              </div>
              <div className="results-calendar-months-grid">
                <ResultsCalendarMonth monthDate={visibleMonth} draftStart={draftStart} draftEnd={draftEnd} onSelectDate={selectDate} />
                <ResultsCalendarMonth monthDate={secondMonth} draftStart={draftStart} draftEnd={draftEnd} onSelectDate={selectDate} />
              </div>
            </div>
          </div>
          <div className="results-date-popover-actions">
            <button type="button" className="secondary-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={applyCustomRange} disabled={!draftStart && !draftEnd}>Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
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

function canManageResults(profile) {
  const role = String(profile?.role || "").toLowerCase();

  return Boolean(
    profile?.is_active === true &&
      (role === "master_admin" || role === "admin" || role === "co_admin")
  );
}

function getResultType(item) {
  if (item?.error) return "error";

  const reviewSentiment = safeText(item?.review_sentiment, "");

  if (reviewSentiment === "Missed Opportunity") return "opportunity_case";

  if (
    reviewSentiment === "Likely Positive Review" ||
    reviewSentiment === "Highly Likely Positive Review"
  ) {
    return "positive_signal";
  }

  if (
    reviewSentiment === "Likely Negative Review" ||
    reviewSentiment === "Highly Likely Negative Review" ||
    reviewSentiment === "Negative Outcome - No Review Request"
  ) {
    return "negative_risk";
  }

  return "success";
}

function getResultTypeLabel(type) {
  if (type === "error") return "Error";
  if (type === "opportunity_case") return "Opportunity";
  if (type === "positive_signal") return "Positive";
  if (type === "negative_risk") return "Risk";
  return "Stored";
}

function getResultTypeTone(type) {
  if (type === "error") return "danger";
  if (type === "opportunity_case") return "warning";
  if (type === "positive_signal") return "success";
  if (type === "negative_risk") return "danger";
  return "neutral";
}

function getReviewTone(value) {
  const text = safeText(value, "");
  if (text.includes("Positive")) return "success";
  if (text === "Missed Opportunity") return "warning";
  if (text.includes("Negative")) return "danger";
  return "neutral";
}

function getResolutionTone(value) {
  const text = safeText(value, "");
  if (text === "Resolved") return "success";
  if (text === "Pending") return "warning";
  if (text === "Unresolved") return "danger";
  return "neutral";
}

function getClientTone(value) {
  const text = safeText(value, "");
  if (text.includes("Positive")) return "success";
  if (text.includes("Negative")) return "danger";
  if (text === "Neutral") return "neutral";
  return "notice";
}

function getMappingStatus(item) {
  const status = safeText(item?.employee_match_status, "").toLowerCase();
  if (status === "mapped") return "mapped";
  if (status === "unmapped") return "unmapped";
  if (safeText(item?.employee_name, "") || safeText(item?.employee_email, "")) return "mapped";
  return "unmapped";
}

function matchesResultType(item, value) {
  if (value === "all") return true;
  if (value === "success_only") return !item?.error;
  if (value === "Errors_only") return Boolean(item?.error);
  if (value === "opportunity_cases") return getResultType(item) === "opportunity_case";
  if (value === "positive_signals") return getResultType(item) === "positive_signal";
  if (value === "negative_risk") return getResultType(item) === "negative_risk";
  return true;
}

function downloadCsv(filename, rows) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          return `"${value.replace(/"/g, '""')}"`;
        })
        .join(",")
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 2V5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16 2V5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3.5 9H20.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="3.5" y="4.5" width="17" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function buildImportErrorTitle(data, fallback) {
  if (data?.requiresDuplicateDecision) return "Duplicate Conversations Found";
  if (data?.error) return data.error;
  return fallback || "Import Failed";
}

function getImportSummaryRows(summary) {
  if (!summary) return [];

  return [
    ["File", summary.fileName],
    ["Duplicate Mode", summary.duplicateMode],
    ["Date Range", summary.dateRange?.startDate && summary.dateRange?.endDate ? `${summary.dateRange.startDate} to ${summary.dateRange.endDate}` : ""],
    ["Date Tabs Processed", summary.parsedDateSheetCount],
    ["Parsed Rows", summary.parsedRows],
    ["Unique Workbook Rows", summary.uniqueWorkbookRows],
    ["Inserted Rows", summary.insertedRows],
    ["Skipped Existing Rows", summary.skippedExistingRows],
    ["Duplicate Rows Inside File", summary.duplicateInFileRows],
    ["Deleted Existing Rows", summary.deletedExistingRows],
    ["Workbook Source Mappings", summary.workbookSourceMappings],
    ["Supabase Mappings", summary.supabaseMappings],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
}

function getProblemSheets(summary) {
  if (!summary?.sheets || !Array.isArray(summary.sheets)) return [];

  return summary.sheets.filter(
    (sheet) =>
      sheet?.status &&
      !["parsed", "ignored_non_date_tab"].includes(String(sheet.status))
  );
}


function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function asOptionList(options) {
  return (options || []).map((option) =>
    typeof option === "string"
      ? { value: option, label: option }
      : { value: option.value, label: option.label || option.value }
  );
}

function matchesSelected(Selected, value) {
  if (!Array.isArray(Selected) || Selected.length === 0) return true;
  return Selected.includes(String(value || ""));
}

function buildSupervisorLookup(supervisorTeams) {
  const lookup = new Map();

  for (const team of supervisorTeams || []) {
    const memberNames = new Set();
    const memberEmails = new Set();

    for (const member of team?.members || []) {
      const name = normalizeKey(member?.employee_name);
      const email = normalizeEmail(member?.employee_email);

      if (name) memberNames.add(name);
      if (email) memberEmails.add(email);
    }

    lookup.set(team.id, {
      ...team,
      memberNames,
      memberEmails,
    });
  }

  return lookup;
}

function itemMatchesSupervisorTeams(item, SelectedSupervisorTeamIds, supervisorLookup) {
  if (!Array.isArray(SelectedSupervisorTeamIds) || SelectedSupervisorTeamIds.length === 0) return true;

  const employeeName = normalizeKey(item?.employee_name);
  const employeeEmail = normalizeEmail(item?.employee_email);

  if (!employeeName && !employeeEmail) return false;

  return SelectedSupervisorTeamIds.some((teamId) => {
    const team = supervisorLookup.get(teamId);
    if (!team) return false;

    if (employeeEmail && team.memberEmails.has(employeeEmail)) return true;
    if (employeeName && team.memberNames.has(employeeName)) return true;

    return false;
  });
}

function titleCaseStaticText(text) {
  return String(text || "")
    .split(" ")
    .map((word) => {
      if (!word) return word;
      if (word === "&") return word;
      if (word.toUpperCase() === word && word.length <= 4) return word;
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function MultiSelectFilter({ label, allLabel, options, selected, setSelected, searchPlaceholder }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef(null);
  const optionList = useMemo(() => asOptionList(options), [options]);
  const selectedValues = Array.isArray(selected) ? selected : [];
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);

  const filteredOptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return optionList;

    return optionList.filter((option) =>
      String(option.label || option.value || "").toLowerCase().includes(search)
    );
  }, [optionList, query]);

  useEffect(() => {
    if (!open) return;

    function handleOutsideClick(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  const buttonLabel =
    selectedValues.length === 0
      ? allLabel
      : selectedValues.length === 1
      ? optionList.find((option) => option.value === selectedValues[0])?.label || selectedValues[0]
      : `${selectedValues.length} Selected`;

  function toggleValue(value) {
    setSelected((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      if (current.includes(value)) {
        return current.filter((item) => item !== value);
      }

      return [...current, value];
    });
  }

  return (
    <label className="multi-filter" ref={wrapRef}>
      <span>{label}</span>
      <button type="button" className="multi-button" onClick={() => setOpen((prev) => !prev)}>
        <strong>{buttonLabel}</strong>
        <b>{open ? "Up" : "Down"}</b>
      </button>

      {open ? (
        <div className="multi-menu">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder || `Search ${label.toLowerCase()}`}
          />

          <div className="multi-options">
            <button
              type="button"
              className={selectedValues.length === 0 ? "multi-option active" : "multi-option"}
              onClick={() => setSelected([])}
            >
              <span>{selectedValues.length === 0 ? "Selected" : "Select"}</span>
              <strong>{allLabel}</strong>
            </button>

            {filteredOptions.length ? (
              filteredOptions.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={selectedSet.has(option.value) ? "multi-option active" : "multi-option"}
                  onClick={() => toggleValue(option.value)}
                >
                  <span>{selectedSet.has(option.value) ? "Selected" : "Select"}</span>
                  <strong>{option.label}</strong>
                </button>
              ))
            ) : (
              <div className="multi-empty">No Matching Options.</div>
            )}
          </div>
        </div>
      ) : null}
    </label>
  );
}


export default function ResultsPage() {
  const [previewConversationId, setPreviewConversationId] = useState("");
  const [previewContext, setPreviewContext] = useState(null);
  const initialRange = getPresetRange("past_7_days");

  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMessage, setAuthMessage] = useState("");

  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [pageSuccess, setPageSuccess] = useState("");

  const [runs, setRuns] = useState([]);
  const [results, setResults] = useState([]);
  const [supervisorTeams, setSupervisorTeams] = useState([]);

  const [selectedDatePreset, setSelectedDatePreset] = useState("past_7_days");
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [startDate, setStartDate] = useState(initialRange.startDate);
  const [endDate, setEndDate] = useState(initialRange.endDate);

  const [searchText, setSearchText] = useState("");
  const [agentFilter, setAgentFilter] = useState([]);
  const [employeeFilter, setEmployeeFilter] = useState([]);
  const [supervisorTeamFilter, setSupervisorTeamFilter] = useState([]);
  const [mappingStatusFilter, setMappingStatusFilter] = useState([]);
  const [reviewSentimentFilter, setReviewSentimentFilter] = useState([]);
  const [clientSentimentFilter, setClientSentimentFilter] = useState([]);
  const [resolutionStatusFilter, setResolutionStatusFilter] = useState([]);
  const [resultTypeFilter, setResultTypeFilter] = useState([]);
  const [cexOnly, setCexOnly] = useState(true);

  const [selectedIds, setSelectedIds] = useState([]);
  const [deleting, setDeleting] = useState(false);
  const [expandedRows, setExpandedRows] = useState({});
  const [showAllRows, setShowAllRows] = useState(false);

  const [importFile, setImportFile] = useState(null);
  const [duplicateMode, setDuplicateMode] = useState("skip_existing");
  const [importing, setImporting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showJumpTop, setShowJumpTop] = useState(false);
  const [importProgressIndex, setImportProgressIndex] = useState(0);
  const [importProgressPercent, setImportProgressPercent] = useState(0);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);

  const presetMenuRef = useRef(null);
  const importProgressTimerRef = useRef(null);
  const fileInputRef = useRef(null);

  async function loadProfile(user) {
    const email = user?.email?.toLowerCase() || "";
    const domain = email.split("@")[1] || "";

    if (!user) return { profile: null, message: "" };

    if (domain !== "nextventures.io") {
      await supabase.auth.signOut();
      return { profile: null, message: "Access blocked. Use a nextventures.io Google account." };
    }

    const fallbackProfile = buildFallbackProfile(user);

    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, email, full_name, role, can_run_tests, is_active")
        .eq("id", user.id)
        .maybeSingle();

      if (data) return { profile: data, message: "" };
      if (fallbackProfile) return { profile: fallbackProfile, message: "" };

      return { profile: null, message: "Signed in, but no profile record is available." };
    } catch (_error) {
      if (fallbackProfile) return { profile: fallbackProfile, message: "" };
      return { profile: null, message: "Signed in, but profile loading failed." };
    }
  }


  async function loadSupervisorTeams() {
    const { data: teamsData, error: teamsError } = await supabase
      .from("supervisor_teams")
      .select("id, supervisor_name, supervisor_email, notes, is_active, created_at, updated_at")
      .eq("is_active", true)
      .order("supervisor_name", { ascending: true });

    if (teamsError) {
      throw new Error(teamsError.message || "Could Not Load Supervisor Teams.");
    }

    const teams = Array.isArray(teamsData) ? teamsData : [];
    const teamIds = teams.map((team) => team.id).filter(Boolean);

    if (!teamIds.length) return [];

    const { data: membersData, error: membersError } = await supabase
      .from("supervisor_team_members")
      .select("id, supervisor_team_id, employee_name, employee_email, intercom_agent_name, team_name, is_active, created_at, updated_at")
      .in("supervisor_team_id", teamIds)
      .eq("is_active", true)
      .order("employee_name", { ascending: true });

    if (membersError) {
      throw new Error(membersError.message || "Could Not Load Supervisor Team Members.");
    }

    const membersByTeam = new Map();

    for (const member of Array.isArray(membersData) ? membersData : []) {
      const current = membersByTeam.get(member.supervisor_team_id) || [];
      current.push(member);
      membersByTeam.set(member.supervisor_team_id, current);
    }

    return teams.map((team) => ({
      ...team,
      members: membersByTeam.get(team.id) || [],
    }));
  }

  async function loadStoredResults(activeSession = session, options = {}) {
    const forceRefresh = Boolean(options?.forceRefresh);
    const cacheKey = getResultsCacheKey(activeSession?.user?.email);
    const cached = readClientCache(cacheKey);
    const cacheAge = cached?.savedAt ? Date.now() - cached.savedAt : Number.POSITIVE_INFINITY;
    const hasCachedData = Array.isArray(cached?.results) || Array.isArray(cached?.runs);
    const shouldSkipNetwork = !forceRefresh && hasCachedData && cacheAge <= RESULTS_CACHE_TTL_MS;

    if (hasCachedData) {
      setRuns(Array.isArray(cached?.runs) ? cached.runs : []);
      setResults(Array.isArray(cached?.results) ? cached.results : []);
      setSupervisorTeams(Array.isArray(cached?.supervisorTeams) ? cached.supervisorTeams : []);
      setSelectedIds([]);
      setExpandedRows({});
      setLoading(forceRefresh);
    } else {
      setLoading(true);
    }

    setPageError("");
    setPageSuccess("");

    try {
      if (!activeSession?.access_token) {
        setRuns([]);
        setResults([]);
        setSupervisorTeams([]);
        setSelectedIds([]);
        setLoading(false);
        return;
      }

      if (shouldSkipNetwork) {
        return;
      }

      const response = await fetch("/api/results", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeSession.access_token}`,
        },
        cache: "no-store",
      });

      const data = await response.json();

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not load stored results.");
      }

      const nextRuns = Array.isArray(data?.runs) ? data.runs : [];
      const nextResults = Array.isArray(data?.results) ? data.results : [];
      const loadedSupervisorTeams = Array.isArray(data?.supervisorTeams)
        ? data.supervisorTeams
        : await loadSupervisorTeams();

      setRuns(nextRuns);
      setResults(nextResults);
      setSupervisorTeams(loadedSupervisorTeams);
      setSelectedIds([]);
      setExpandedRows({});
      writeClientCache(cacheKey, {
        savedAt: Date.now(),
        runs: nextRuns,
        results: nextResults,
        supervisorTeams: loadedSupervisorTeams,
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not load stored results.");

      if (!hasCachedData) {
        setRuns([]);
        setResults([]);
        setSupervisorTeams([]);
        setSelectedIds([]);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function init() {
      try {
        const {
          data: { session: currentSession },
        } = await supabase.auth.getSession();

        if (!active) return;

        setSession(currentSession ?? null);

        if (!currentSession?.user) {
          setProfile(null);
          setAuthLoading(false);
          setLoading(false);
          return;
        }

        const profileResult = await loadProfile(currentSession.user);

        if (!active) return;

        setProfile(profileResult.profile);
        setAuthMessage(profileResult.message);
        setAuthLoading(false);

        await loadStoredResults(currentSession);
      } catch (_error) {
        if (!active) return;
        setAuthMessage("Could not complete session check.");
        setAuthLoading(false);
        setLoading(false);
      }
    }

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!active) return;

      const isBackgroundRefresh = event === "TOKEN_REFRESHED" || event === "USER_UPDATED";

      setSession(newSession ?? null);
      setPageError("");
      setPageSuccess("");

      if (!newSession?.user) {
        setProfile(null);
        setAuthMessage("");
        setAuthLoading(false);
        setRuns([]);
        setResults([]);
        setSelectedIds([]);
        setLoading(false);
        return;
      }

      const profileResult = await loadProfile(newSession.user);
      if (!active) return;

      setProfile(profileResult.profile);
      setAuthMessage(profileResult.message);
      setAuthLoading(false);

      if (!isBackgroundRefresh) {
        await loadStoredResults(newSession);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event) {
      if (!presetMenuRef.current) return;
      if (!presetMenuRef.current.contains(event.target)) setShowPresetMenu(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    function handleScroll() {
      setShowJumpTop(window.scrollY > 700);
    }

    handleScroll();
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    return () => {
      if (importProgressTimerRef.current) {
        window.clearInterval(importProgressTimerRef.current);
      }
    };
  }, []);

  function clearImportTimer() {
    if (importProgressTimerRef.current) {
      window.clearInterval(importProgressTimerRef.current);
      importProgressTimerRef.current = null;
    }
  }

  function startImportProgress() {
    clearImportTimer();

    setImportProgressIndex(0);
    setImportProgressPercent(IMPORT_PROGRESS_STEPS[0].percent);

    importProgressTimerRef.current = window.setInterval(() => {
      setImportProgressIndex((current) => {
        const next = Math.min(current + 1, IMPORT_PROGRESS_STEPS.length - 2);
        setImportProgressPercent(IMPORT_PROGRESS_STEPS[next].percent);
        return next;
      });
    }, 1400);
  }

  function finishImportProgress() {
    clearImportTimer();
    setImportProgressIndex(IMPORT_PROGRESS_STEPS.length - 1);
    setImportProgressPercent(100);
  }

  function applyDatePreset(presetKey) {
    setSelectedDatePreset(presetKey);

    if (presetKey === "custom") {
      setShowPresetMenu(false);
      return;
    }

    const range = getPresetRange(presetKey);
    if (!range) {
      setShowPresetMenu(false);
      return;
    }

    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setShowPresetMenu(false);
  }

  function applyCustomDateRange(nextStartDate, nextEndDate) {
    setSelectedDatePreset("custom");
    setStartDate(nextStartDate);
    setEndDate(nextEndDate);
    setShowPresetMenu(false);
  }

  function resetFilters() {
    const range = getPresetRange("past_7_days");
    setSelectedDatePreset("past_7_days");
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    setSearchText("");
    setAgentFilter([]);
    setEmployeeFilter([]);
    setSupervisorTeamFilter([]);
    setMappingStatusFilter([]);
    setReviewSentimentFilter([]);
    setClientSentimentFilter([]);
    setResolutionStatusFilter([]);
    setResultTypeFilter([]);
    setCexOnly(true);
    setSelectedIds([]);
    setShowAllRows(false);
  }

  function closeImportModal() {
    if (importing) return;
    setShowImportModal(false);
  }

  async function handleGoogleLogin() {
    setAuthMessage("");

    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}/results` : undefined;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) setAuthMessage(error.message || "Google sign-in failed.");
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setAuthMessage("");
    setAuthLoading(false);
    setRuns([]);
    setResults([]);
    setSelectedIds([]);
  }

  async function handleHistoricalImport() {
    setPageError("");
    setPageSuccess("");
    setImportError(null);
    setImportResult(null);

    if (!session?.access_token) {
      setImportError({
        title: "Sign In Required",
        message: "Please sign in before importing historical data.",
      });
      setShowImportModal(true);
      return;
    }

    if (!canManageResults(profile)) {
      setImportError({
        title: "Permission Required",
        message: "This account does not have permission to import Results data.",
      });
      setShowImportModal(true);
      return;
    }

    if (!importFile) {
      setImportError({
        title: "No File Selected",
        message: "Choose the historical Excel workbook before starting the import.",
      });
      setShowImportModal(true);
      return;
    }

    if (!importFile.name.toLowerCase().endsWith(".xlsx")) {
      setImportError({
        title: "Unsupported File",
        message: "Only .xlsx Excel files are supported.",
      });
      setShowImportModal(true);
      return;
    }

    setImporting(true);
    setShowImportModal(true);
    startImportProgress();

    try {
      const formData = new FormData();
      formData.append("file", importFile);
      formData.append("duplicateMode", duplicateMode);

      const response = await fetch("/api/results/import", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      let data = null;

      try {
        data = await response.json();
      } catch (_error) {
        data = null;
      }

      if (!response.ok || !data?.ok) {
        const title = buildImportErrorTitle(data, "Import Failed");

        setImportError({
          title,
          message:
            data?.error ||
            "The importer could not complete the upload. Check the file format and try again.",
          status: response.status,
          duplicateSummary: data?.duplicateSummary || null,
          summary: data?.summary || null,
        });

        finishImportProgress();
        setImporting(false);
        return;
      }

      finishImportProgress();

      setImportResult({
        title: "Import Complete",
        message: data?.message || "Historical Results were imported Successfully.",
        runId: data?.runId || null,
        summary: data?.summary || null,
      });

      setPageSuccess(data?.message || "Historical Results imported.");

      if (fileInputRef.current) fileInputRef.current.value = "";
      setImportFile(null);

      await loadStoredResults(session, { forceRefresh: true });
    } catch (error) {
      finishImportProgress();

      setImportError({
        title: "Import Failed",
        message:
          error instanceof Error
            ? error.message
            : "Unknown import error. Please try again.",
      });
    } finally {
      clearImportTimer();
      setImporting(false);
    }
  }

  const runsById = useMemo(() => {
    const map = new Map();
    for (const run of runs) {
      if (run?.id) map.set(run.id, run);
    }
    return map;
  }, [runs]);

  const decoratedResults = useMemo(() => {
    return results.map((item) => ({
      ...item,
      runMeta: item?.run_id ? runsById.get(item.run_id) || null : null,
    }));
  }, [results, runsById]);

  const agentOptions = useMemo(() => {
    return Array.from(
      new Set(decoratedResults.map((item) => safeText(item.agent_name, "Unassigned")).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
  }, [decoratedResults]);

  const employeeOptions = useMemo(() => {
    return Array.from(
      new Set(
        decoratedResults
          .map((item) =>
            safeText(
              item.employee_name,
              getMappingStatus(item) === "mapped" ? "Mapped Employee" : "Unmapped"
            )
          )
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
  }, [decoratedResults]);

  const supervisorTeamOptions = useMemo(() => {
    return (supervisorTeams || [])
      .map((team) => ({ value: team.id, label: team.supervisor_name || team.supervisor_email || "Unnamed Supervisor" }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [supervisorTeams]);

  const supervisorLookup = useMemo(() => buildSupervisorLookup(supervisorTeams), [supervisorTeams]);

  const filteredResults = useMemo(() => {
    return decoratedResults.filter((item) => {
      const sourceDateOnly = toDateInputFromValue(item?.replied_at || item?.created_at);

      if (startDate && sourceDateOnly && sourceDateOnly < startDate) return false;
      if (endDate && sourceDateOnly && sourceDateOnly > endDate) return false;

      if (cexOnly && safeText(item.team_name, "No Team") !== "CEx") return false;

      if (!itemMatchesSupervisorTeams(item, supervisorTeamFilter, supervisorLookup)) return false;

      if (!matchesSelected(agentFilter, safeText(item.agent_name, "Unassigned"))) return false;

      const employeeName = safeText(
        item.employee_name,
        getMappingStatus(item) === "mapped" ? "Mapped Employee" : "Unmapped"
      );
      if (!matchesSelected(employeeFilter, employeeName)) return false;

      if (!matchesSelected(mappingStatusFilter, getMappingStatus(item))) return false;

      if (!matchesSelected(reviewSentimentFilter, safeText(item.review_sentiment, ""))) {
        return false;
      }

      if (!matchesSelected(clientSentimentFilter, safeText(item.client_sentiment, ""))) {
        return false;
      }

      if (!matchesSelected(resolutionStatusFilter, safeText(item.resolution_status, ""))) {
        return false;
      }

      if (Array.isArray(resultTypeFilter) && resultTypeFilter.length > 0 && !resultTypeFilter.some((value) => matchesResultType(item, value))) {
        return false;
      }

      const haystack = [
        item?.conversation_id,
        item?.agent_name,
        item?.employee_name,
        item?.employee_email,
        item?.team_name,
        item?.client_email,
        item?.review_sentiment,
        item?.client_sentiment,
        item?.resolution_status,
        item?.ai_verdict,
        item?.error,
        item?.employee_match_status,
        item?.runMeta?.requested_by_email,
      ]
        .map((value) => String(value ?? "").toLowerCase())
        .join(" ");

      if (searchText.trim() && !haystack.includes(searchText.trim().toLowerCase())) return false;

      return true;
    });
  }, [
    decoratedResults,
    startDate,
    endDate,
    agentFilter,
    employeeFilter,
    supervisorTeamFilter,
    supervisorLookup,
    mappingStatusFilter,
    reviewSentimentFilter,
    clientSentimentFilter,
    resolutionStatusFilter,
    resultTypeFilter,
    cexOnly,
    searchText,
  ]);

  const visibleResults = showAllRows ? filteredResults : filteredResults.slice(0, 25);
  const allVisibleIds = visibleResults.map((item) => item.id).filter(Boolean);
  const allFilteredIds = filteredResults.map((item) => item.id).filter(Boolean);
  const SelectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const totalStoredRuns = useMemo(() => {
    return new Set(filteredResults.map((item) => item.run_id).filter(Boolean)).size;
  }, [filteredResults]);

  const uniqueConversations = useMemo(() => {
    return new Set(filteredResults.map((item) => item.conversation_id).filter(Boolean)).size;
  }, [filteredResults]);

  const totalErrors = filteredResults.filter((item) => item?.error).length;
  const totalSuccess = filteredResults.length - totalErrors;
  const totalMissedOpportunities = filteredResults.filter(
    (item) => safeText(item.review_sentiment, "") === "Missed Opportunity"
  ).length;
  const totalNegativeRisk = filteredResults.filter((item) => getResultType(item) === "negative_risk").length;
  const mappedRowsCount = filteredResults.filter((item) => getMappingStatus(item) === "mapped").length;

  const resolutionRate = useMemo(() => {
    if (!filteredResults.length) return 0;
    const resolvedCount = filteredResults.filter(
      (item) => safeText(item.resolution_status, "") === "Resolved"
    ).length;
    return (resolvedCount / filteredResults.length) * 100;
  }, [filteredResults]);

  const latestStoredAt = useMemo(() => {
    const latest = decoratedResults[0]?.created_at || decoratedResults[0]?.replied_at;
    return latest ? formatDateTime(latest) : "No stored results";
  }, [decoratedResults]);

  const currentImportStep = IMPORT_PROGRESS_STEPS[importProgressIndex] || IMPORT_PROGRESS_STEPS[0];
  const importSummaryRows = getImportSummaryRows(importResult?.summary || importError?.summary);
  const problemSheets = getProblemSheets(importError?.summary);

  function toggleSingle(id) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  function selectAllVisible() {
    setSelectedIds((prev) => Array.from(new Set([...prev, ...allVisibleIds])));
  }

  function selectAllFiltered() {
    setSelectedIds(Array.from(new Set(allFilteredIds)));
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  function openConversationPreview(conversationId, context = null) {
    setPreviewConversationId(String(conversationId || "").trim());
    setPreviewContext(context || null);
  }

  function closeConversationPreview() {
    setPreviewConversationId("");
    setPreviewContext(null);
  }

  function toggleRowExpanded(id) {
    setExpandedRows((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function handleDeleteSelected() {
    if (!selectedIds.length) {
      setPageError("Select at least one stored result first.");
      setPageSuccess("");
      return;
    }

    if (!session?.access_token) {
      setPageError("Please sign in before deleting stored results.");
      setPageSuccess("");
      return;
    }

    if (!canManageResults(profile)) {
      setPageError("This account does not have permission to delete stored results.");
      setPageSuccess("");
      return;
    }

    const confirmed = window.confirm(
      `Delete ${selectedIds.length} Selected stored result(s)? This cannot be undone.`
    );

    if (!confirmed) return;

    setDeleting(true);
    setPageError("");
    setPageSuccess("");

    try {
      const response = await fetch("/api/results", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ ids: selectedIds }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not delete Selected results.");
      }

      setSelectedIds([]);
      setPageSuccess(data.message || `${selectedIds.length} stored result(s) deleted.`);
      await loadStoredResults(session, { forceRefresh: true });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not delete Selected results.");
    } finally {
      setDeleting(false);
    }
  }

  function handleExportFiltered() {
    if (!filteredResults.length) {
      setPageError("There are no filtered results to export.");
      setPageSuccess("");
      return;
    }

    const rows = [
      [
        "Result ID",
        "Run ID",
        "Conversation ID",
        "Intercom Link",
        "Replied At",
        "Agent Name",
        "Employee Name",
        "Employee Email",
        "Team Name",
        "Mapping Status",
        "Client Email",
        "CSAT Score",
        "Review Sentiment",
        "Client Sentiment",
        "Resolution Status",
        "AI Verdict",
        "Error",
        "Requested By",
        "Run Created At",
      ],
      ...filteredResults.map((item) => [
        item.id,
        item.run_id,
        item.conversation_id,
        item.conversation_id ? `${INTERCOM_CONVERSATION_URL_PREFIX}/${item.conversation_id}` : "",
        item.replied_at || item.created_at || "",
        item.agent_name || "",
        item.employee_name || "",
        item.employee_email || "",
        item.team_name || "",
        item.employee_match_status || getMappingStatus(item),
        item.client_email || "",
        item.csat_score || "",
        item.review_sentiment || "",
        item.client_sentiment || "",
        item.resolution_status || "",
        item.ai_verdict || "",
        item.error || "",
        item.runMeta?.requested_by_email || "",
        item.runMeta?.created_at || "",
      ]),
    ];

    downloadCsv(`stored-results-${startDate || "start"}-to-${endDate || "end"}.csv`, rows);

    if (session?.access_token) {
      fetch("/api/results", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          action: "export_filtered",
          exportedCount: filteredResults.length,
          filterSummary: {
            startDate: startDate || null,
            endDate: endDate || null,
            agentFilter,
            employeeFilter,
            supervisorTeamFilter,
            mappingStatusFilter,
            reviewSentimentFilter,
            clientSentimentFilter,
            resolutionStatusFilter,
            resultTypeFilter,
            cexOnly,
            searchText: searchText || "",
          },
        }),
        keepalive: true,
      }).catch(() => {});
    }

    setPageSuccess("Filtered results exported.");
    setPageError("");
  }

  const stats = [
    { label: "Stored Results", value: formatNumber(filteredResults.length), tone: "violet" },
    { label: "Conversations", value: formatNumber(uniqueConversations), tone: "cyan" },
    { label: "Missed Opportunities", value: formatNumber(totalMissedOpportunities), tone: "amber" },
    { label: "Resolution Rate", value: `${resolutionRate.toFixed(1)}%`, tone: "emerald" },
    { label: "Mapped Rows", value: formatNumber(mappedRowsCount), tone: "blue" },
    { label: "Negative Risk", value: formatNumber(totalNegativeRisk), tone: "rose" },
  ];

  if (authLoading) {
    return (
      <main className="results-page results-loading-page">
        <style>{resultsStyles}</style>
        <section className="results-loading-shell" aria-live="polite" aria-busy="true">
          <div className="results-loading-card">
            <div className="results-loader-visual" aria-hidden="true">
              <span className="results-loader-glow" />
              <span className="results-loader-ring ring-one" />
              <span className="results-loader-ring ring-two" />
              <span className="results-loader-gear gear-one">⚙</span>
              <span className="results-loader-gear gear-two">⚙</span>
              <span className="results-loader-gear gear-three">⚙</span>
              <span className="results-loader-dot dot-one" />
              <span className="results-loader-dot dot-two" />
            </div>

            <div className="results-loading-copy">
              <span>Results Archive</span>
              <h1>Loading Results...</h1>
              <p>Preparing saved audit records, filters, verdicts, and conversation previews.</p>
            </div>

            <div className="results-loading-steps" aria-hidden="true">
              <i>Syncing Archive</i>
              <i>Mapping Teams</i>
              <i>Preparing Filters</i>
            </div>

            <div className="results-loading-bar" aria-hidden="true">
              <b />
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="results-page">
      <style>{resultsStyles}</style>

      <section className="hero">
        <div>
          <div className="hero-badge">Results Archive</div>
          <h1>Stored Results Command Center</h1>
          <p>Search Saved Audit Records, Import Historical Excel Workbooks, Export Filtered Data, And Manage The Archive From One Polished Workspace.</p>
        </div>

        <div className="hero-panel">
          <span>Latest Save</span>
          <strong>{latestStoredAt}</strong>
          <small>{formatNumber(results.length)} Total Stored Row(s)</small>
        </div>
      </section>

      <section className="action-strip">
        <div className="action-row">
          <Link href="/run" className="primary-btn">Run New Audit</Link>
          <button type="button" className="secondary-btn" onClick={handleExportFiltered}>Export CSV</button>
          <button type="button" className="secondary-btn" onClick={() => loadStoredResults(session, { forceRefresh: true })}>Reload</button>
          {!session?.user ? (
            <button type="button" className="secondary-btn" onClick={handleGoogleLogin}>Sign In</button>
          ) : null}
        </div>
        <div className="mini-status">
          <span>{formatNumber(totalSuccess)} Successful</span>
          <span>{formatNumber(totalErrors)} Errors</span>
          <span>{formatNumber(totalStoredRuns)} run(s)</span>
          <span>{formatNumber(selectedIds.length)} Selected</span>
        </div>
      </section>

      {canManageResults(profile) ? (
        <section className="import-panel">
          <div className="import-head">
            <div>
              <p className="eyebrow">Manual Import</p>
              <h2>Historical Excel Import</h2>
            </div>
            <span className="import-pill">Master Admin & Co-Admin Only</span>
          </div>

          <div className="import-grid">
            <label className="file-box">
              <span>Excel Workbook</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                onChange={(event) => setImportFile(event.target.files?.[0] || null)}
              />
              <small>{importFile ? importFile.name : "Choose The Historical .xlsx File"}</small>
            </label>

            <label>
              <span>Duplicate Handling</span>
              <select value={duplicateMode} onChange={(event) => setDuplicateMode(event.target.value)}>
                {DUPLICATE_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <div className="duplicate-help">
              {DUPLICATE_MODE_OPTIONS.find((option) => option.value === duplicateMode)?.helper}
            </div>

            <button
              type="button"
              className="primary-btn import-btn"
              onClick={handleHistoricalImport}
              disabled={importing || !session?.user}
            >
              {importing ? "Importing..." : "Import to Results"}
            </button>
          </div>
        </section>
      ) : (
        <section className="import-panel locked-import-panel">
          <div className="import-head">
            <div>
              <p className="eyebrow">View-Only Access</p>
              <h2>Historical Excel Import Locked</h2>
            </div>
            <span className="import-pill">Master Admin & Co-Admin Only</span>
          </div>
          <p className="locked-import-copy">
            You can view and export the Results archive, but importing new historical data is limited to Master Admin and Co-Admin users.
          </p>
        </section>
      )}

      {(authMessage || pageError || pageSuccess) ? (
        <section className="message-stack">
          {authMessage ? <div className="message error">{authMessage}</div> : null}
          {pageError ? <div className="message error">{pageError}</div> : null}
          {pageSuccess ? <div className="message success">{pageSuccess}</div> : null}
        </section>
      ) : null}

      <section className="stats-grid">
        {stats.map((stat) => (
          <article key={stat.label} className={`stat-card ${stat.tone}`}>
            <p>{stat.label}</p>
            <strong>{stat.value}</strong>
          </article>
        ))}
      </section>

      <section className="filters-panel">
        <div className="filters-top">
          <ResultsDateRangePicker
            startDate={startDate}
            endDate={endDate}
            selectedDatePreset={selectedDatePreset}
            onApplyPreset={applyDatePreset}
            onApplyCustom={applyCustomDateRange}
          />

          <label className="search-field">
            <span>Search</span>
            <input
              type="text"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Conversation, agent, employee, client, verdict"
            />
          </label>
        </div>

        <div className="filters-grid">
          <MultiSelectFilter
            label="Agent"
            allLabel="All Agents"
            options={agentOptions}
            selected={agentFilter}
            setSelected={setAgentFilter}
          />

          <MultiSelectFilter
            label="Employee"
            allLabel="All Employees"
            options={employeeOptions}
            selected={employeeFilter}
            setSelected={setEmployeeFilter}
          />

          <MultiSelectFilter
            label="Supervisor Team"
            allLabel="All Supervisors"
            options={supervisorTeamOptions}
            selected={supervisorTeamFilter}
            setSelected={setSupervisorTeamFilter}
          />

          <label className="cex-check">
            <input
              type="checkbox"
              checked={cexOnly}
              onChange={(event) => setCexOnly(event.target.checked)}
            />
            <span>CEx Only</span>
          </label>

          <MultiSelectFilter
            label="Mapping"
            allLabel="All Mapping"
            options={MAPPING_STATUS_OPTIONS}
            selected={mappingStatusFilter}
            setSelected={setMappingStatusFilter}
          />

          <MultiSelectFilter
            label="Result Type"
            allLabel="All Results"
            options={RESULT_TYPE_OPTIONS}
            selected={resultTypeFilter}
            setSelected={setResultTypeFilter}
          />

          <MultiSelectFilter
            label="Review"
            allLabel="All Review Sentiments"
            options={REVIEW_SENTIMENT_OPTIONS}
            selected={reviewSentimentFilter}
            setSelected={setReviewSentimentFilter}
          />

          <MultiSelectFilter
            label="Client"
            allLabel="All Client Sentiments"
            options={CLIENT_SENTIMENT_OPTIONS}
            selected={clientSentimentFilter}
            setSelected={setClientSentimentFilter}
          />

          <MultiSelectFilter
            label="Resolution"
            allLabel="All Resolution Statuses"
            options={RESOLUTION_STATUS_OPTIONS}
            selected={resolutionStatusFilter}
            setSelected={setResolutionStatusFilter}
          />
        </div>

        <div className="selection-row">
          <div className="action-row">
            <button type="button" className="secondary-btn" onClick={selectAllVisible}>Select Visible</button>
            <button type="button" className="secondary-btn" onClick={selectAllFiltered}>Select All Filtered</button>
            <button type="button" className="secondary-btn" onClick={clearSelection}>Clear Selection</button>
            <button type="button" className="secondary-btn" onClick={resetFilters}>Reset Filters</button>
            <button
              type="button"
              className="danger-btn"
              onClick={handleDeleteSelected}
              disabled={!selectedIds.length || deleting}
            >
              {deleting ? "Deleting..." : `Delete (${selectedIds.length})`}
            </button>
          </div>
          <span>Showing {formatNumber(visibleResults.length)} of {formatNumber(filteredResults.length)}</span>
        </div>
      </section>

      <section className="table-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Archive Table</p>
            <h2>Audit Results</h2>
          </div>
          <div className="table-summary">
            <span>{formatNumber(totalSuccess)} Successful</span>
            <span>{formatNumber(totalErrors)} Errors</span>
            <span>{formatNumber(selectedIds.length)} Selected</span>
          </div>
        </div>

        {loading || authLoading ? (
          <div className="empty-box">Loading stored audit results...</div>
        ) : !session?.user ? (
          <div className="empty-box">Sign In to view stored results.</div>
        ) : !filteredResults.length ? (
          <div className="empty-box">No stored results match the current filters.</div>
        ) : (
          <>
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={allVisibleIds.length > 0 && allVisibleIds.every((id) => SelectedIdSet.has(id))}
                        onChange={(event) => {
                          if (event.target.checked) {
                            selectAllVisible();
                          } else {
                            setSelectedIds((prev) => prev.filter((id) => !allVisibleIds.includes(id)));
                          }
                        }}
                      />
                    </th>
                    <th>Conversation</th>
                    <th>Agent</th>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>Review</th>
                    <th>Client</th>
                    <th>Resolution</th>
                    <th>Date</th>
                    <th>Requester</th>
                    <th>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {visibleResults.map((item) => {
                    const resultType = getResultType(item);
                    const isExpanded = Boolean(expandedRows[item.id]);
                    const conversationUrl = item.conversation_id
                      ? intercomConversationUrl(item.conversation_id)
                      : "";
                    const mappingStatus = getMappingStatus(item);

                    return (
                      <Fragment key={item.id || item.conversation_id}>
                        <tr>
                          <td>
                            <input
                              type="checkbox"
                              checked={SelectedIdSet.has(item.id)}
                              onChange={() => toggleSingle(item.id)}
                            />
                          </td>
                          <td>
                            <strong>{safeText(item.conversation_id, "Unknown")}</strong>
                            <small>{safeText(item.client_email)}</small>
                          </td>
                          <td>
                            <strong>{safeText(item.agent_name, "Unassigned")}</strong>
                            <small>CSAT {safeText(item.csat_score)}</small>
                          </td>
                          <td>
                            <strong>{safeText(item.employee_name, mappingStatus === "mapped" ? "Mapped" : "Unmapped")}</strong>
                            <small>{safeText(item.employee_email, mappingStatus)}</small>
                            <span className="team-chip">{safeText(item.team_name, "No Team")}</span>
                          </td>
                          <td><span className={`pill ${getResultTypeTone(resultType)}`}>{getResultTypeLabel(resultType)}</span></td>
                          <td><span className={`pill ${getReviewTone(item.review_sentiment)}`}>{safeText(item.review_sentiment)}</span></td>
                          <td><span className={`pill ${getClientTone(item.client_sentiment)}`}>{safeText(item.client_sentiment)}</span></td>
                          <td><span className={`pill ${getResolutionTone(item.resolution_status)}`}>{safeText(item.resolution_status)}</span></td>
                          <td>
                            <strong>{formatDateTime(item.replied_at || item.created_at)}</strong>
                            <small>{formatShortDate(item.replied_at || item.created_at)}</small>
                          </td>
                          <td>
                            <strong>{safeText(item.runMeta?.requested_by_email)}</strong>
                            <small>{safeText(item.runMeta?.audit_mode, "live_gpt")}</small>
                          </td>
                          <td>
                            {conversationUrl ? (
                              <ConversationActionButtons
                                conversationId={item.conversation_id}
                                previewContext={item}
                                onPreview={openConversationPreview}
                                onToggleVerdict={() => toggleRowExpanded(item.id)}
                                verdictVisible={isExpanded}
                              />
                            ) : (
                              <button type="button" className={`mini-verdict-btn ${isExpanded ? "active" : ""}`} onClick={() => toggleRowExpanded(item.id)}>
                                {isExpanded ? "Hide AI Verdict" : "See AI Verdict"}
                              </button>
                            )}
                          </td>
                        </tr>

                        {isExpanded ? (
                          <tr className="expanded-row">
                            <td colSpan={11}>
                              <div className={item.error ? "verdict-box error" : "verdict-box"}>
                                <div className="verdict-head">
                                  <span>{item.error ? "Error Details" : "AI Verdict"}</span>
                                  <small>Run {safeText(item.run_id)}</small>
                                </div>
                                <pre>{safeText(item.error || item.ai_verdict, item.error ? "No error details available." : "No AI verdict available.")}</pre>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {filteredResults.length > 25 ? (
              <div className="show-more-row">
                <button type="button" className="secondary-btn" onClick={() => setShowAllRows((prev) => !prev)}>
                  {showAllRows ? "Show Less" : `Show More (${formatNumber(filteredResults.length - visibleResults.length)} more)`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {showJumpTop ? (
        <button
          type="button"
          className="jump-top"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          Jump to top
        </button>
      ) : null}

      {previewConversationId ? (
        <ConversationPreviewModal
          conversationId={previewConversationId}
          previewContext={previewContext}
          onClose={closeConversationPreview}
        />
      ) : null}

      {showImportModal ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="import-modal">
            {importing ? (
              <>
                <div className="modal-head">
                  <div>
                    <p className="eyebrow">Import Running</p>
                    <h2>{currentImportStep.label}</h2>
                  </div>
                  <span className="import-percent">{Math.round(importProgressPercent)}%</span>
                </div>

                <p className="modal-copy">{currentImportStep.detail}</p>

                <div className="progress-shell">
                  <div className="progress-bar" style={{ width: `${importProgressPercent}%` }} />
                </div>

                <div className="progress-steps">
                  {IMPORT_PROGRESS_STEPS.map((step, index) => (
                    <div
                      key={step.label}
                      className={
                        index < importProgressIndex
                          ? "progress-step done"
                          : index === importProgressIndex
                          ? "progress-step active"
                          : "progress-step"
                      }
                    >
                      <span>{index < importProgressIndex ? "✓" : index + 1}</span>
                      <strong>{step.label}</strong>
                    </div>
                  ))}
                </div>

                <div className="modal-note">
                  Large Excel files can take a little time. Keep this page open while the import finishes.
                </div>
              </>
            ) : importResult ? (
              <>
                <div className="modal-head">
                  <div>
                    <p className="eyebrow success-text">Import Complete</p>
                    <h2>{importResult.title}</h2>
                  </div>
                  <span className="modal-status success">Done</span>
                </div>

                <p className="modal-copy">{importResult.message}</p>

                {importResult.runId ? (
                  <div className="run-id-box">
                    <span>Import Run ID</span>
                    <strong>{importResult.runId}</strong>
                  </div>
                ) : null}

                {importSummaryRows.length ? (
                  <div className="summary-grid">
                    {importSummaryRows.map(([label, value]) => (
                      <div key={label}>
                        <span>{label}</span>
                        <strong>{formatNumber(value) === "NaN" ? String(value) : typeof value === "number" ? formatNumber(value) : String(value)}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="modal-actions">
                  <button type="button" className="primary-btn" onClick={closeImportModal}>Close</button>
                </div>
              </>
            ) : importError ? (
              <>
                <div className="modal-head">
                  <div>
                    <p className="eyebrow danger-text">Import Error</p>
                    <h2>{importError.title}</h2>
                  </div>
                  <span className="modal-status error">Error</span>
                </div>

                <p className="modal-copy">{importError.message}</p>

                {importError.duplicateSummary ? (
                  <div className="error-detail-box">
                    <strong>{formatNumber(importError.duplicateSummary.duplicateCount)} duplicate conversation(s) found.</strong>
                    <small>
                      Sample: {(importError.duplicateSummary.sampleConversationIds || []).join(", ") || "No sample available"}
                    </small>
                  </div>
                ) : null}

                {problemSheets.length ? (
                  <div className="error-detail-box">
                    <strong>Problem sheet(s)</strong>
                    {problemSheets.slice(0, 8).map((sheet) => (
                      <small key={sheet.sheetName}>
                        {sheet.sheetName}: {sheet.status}
                      </small>
                    ))}
                  </div>
                ) : null}

                {importSummaryRows.length ? (
                  <div className="summary-grid compact">
                    {importSummaryRows.map(([label, value]) => (
                      <div key={label}>
                        <span>{label}</span>
                        <strong>{typeof value === "number" ? formatNumber(value) : String(value)}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="modal-actions">
                  <button type="button" className="secondary-btn" onClick={closeImportModal}>Close</button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}

const resultsStyles = `
  .results-page {
    min-height: 100vh;
    padding: 22px 18px 76px;
    color: #f5f7ff;
    background:
      radial-gradient(circle at 10% 0%, rgba(59, 130, 246, 0.14), transparent 24%),
      radial-gradient(circle at 88% 2%, rgba(139, 92, 246, 0.15), transparent 26%),
      radial-gradient(circle at 52% 100%, rgba(6, 182, 212, 0.08), transparent 24%),
      linear-gradient(180deg, #040714 0%, #050918 46%, #04060d 100%);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .results-loading-page {
    display: grid;
    place-items: center;
    padding: 32px;
  }

  .results-loading-shell {
    width: min(1040px, 94vw);
    min-height: min(620px, 80vh);
    display: grid;
    place-items: center;
  }

  .results-loading-card {
    position: relative;
    overflow: hidden;
    width: min(860px, 100%);
    min-height: 360px;
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    align-items: center;
    gap: 34px;
    padding: 48px;
    border-radius: 38px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background:
      radial-gradient(circle at 18% 12%, rgba(34, 211, 238, 0.15), transparent 34%),
      radial-gradient(circle at 88% 16%, rgba(168, 85, 247, 0.22), transparent 36%),
      linear-gradient(145deg, rgba(13, 20, 43, 0.96), rgba(7, 10, 24, 0.98));
    box-shadow:
      0 36px 120px rgba(0, 0, 0, 0.58),
      0 0 0 1px rgba(96, 165, 250, 0.08),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  .results-loading-card::before,
  .results-loading-card::after {
    content: "";
    position: absolute;
    border-radius: 999px;
    pointer-events: none;
    filter: blur(72px);
  }

  .results-loading-card::before {
    left: -160px;
    top: -150px;
    width: 360px;
    height: 360px;
    background: rgba(34, 211, 238, 0.14);
  }

  .results-loading-card::after {
    right: -180px;
    bottom: -170px;
    width: 420px;
    height: 420px;
    background: rgba(236, 72, 153, 0.14);
  }

  .results-loader-visual,
  .results-loading-copy,
  .results-loading-steps,
  .results-loading-bar {
    position: relative;
    z-index: 1;
  }

  .results-loader-visual {
    width: 190px;
    height: 190px;
    border-radius: 44px;
    border: 1px solid rgba(147, 197, 253, 0.2);
    background:
      radial-gradient(circle at 30% 24%, rgba(255, 255, 255, 0.2), transparent 20%),
      linear-gradient(145deg, rgba(5, 12, 31, 0.98), rgba(15, 23, 42, 0.94));
    box-shadow:
      0 28px 74px rgba(15, 23, 42, 0.6),
      0 0 46px rgba(34, 211, 238, 0.14),
      inset 0 1px 0 rgba(255, 255, 255, 0.12);
  }

  .results-loader-glow,
  .results-loader-ring,
  .results-loader-gear,
  .results-loader-dot {
    position: absolute;
    pointer-events: none;
  }

  .results-loader-glow {
    inset: 20px;
    border-radius: 34px;
    background: radial-gradient(circle, rgba(34, 211, 238, 0.14), rgba(139, 92, 246, 0.12), transparent 70%);
    filter: blur(10px);
    animation: resultsGlowPulse 2.4s ease-in-out infinite;
  }

  .results-loader-ring {
    border-radius: 999px;
    border: 1px solid rgba(125, 211, 252, 0.18);
  }

  .results-loader-ring.ring-one {
    inset: 28px 26px 30px 20px;
    animation: resultsOrbitTilt 5.8s ease-in-out infinite;
  }

  .results-loader-ring.ring-two {
    inset: 45px 18px 38px 42px;
    border-color: rgba(244, 114, 182, 0.18);
    animation: resultsOrbitTiltReverse 4.8s ease-in-out infinite;
  }

  .results-loader-gear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
    line-height: 1;
    text-shadow: 0 14px 30px rgba(0, 0, 0, 0.5);
  }

  .results-loader-gear.gear-one {
    left: 34px;
    top: 60px;
    color: #8b5cf6;
    font-size: 86px;
    filter: drop-shadow(0 0 18px rgba(139, 92, 246, 0.34));
    animation: resultsGearSpin 5s linear infinite;
  }

  .results-loader-gear.gear-two {
    left: 90px;
    top: 30px;
    color: #38bdf8;
    font-size: 76px;
    filter: drop-shadow(0 0 18px rgba(56, 189, 248, 0.32));
    animation: resultsGearSpinReverse 4.2s linear infinite;
  }

  .results-loader-gear.gear-three {
    left: 104px;
    top: 104px;
    color: #ec4899;
    font-size: 54px;
    filter: drop-shadow(0 0 18px rgba(236, 72, 153, 0.3));
    animation: resultsGearSpin 3.3s linear infinite;
  }

  .results-loader-dot {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: currentColor;
    box-shadow: 0 0 18px currentColor;
    animation: resultsDotBlink 1.8s ease-in-out infinite;
  }

  .results-loader-dot.dot-one {
    left: 54px;
    top: 46px;
    color: #93c5fd;
  }

  .results-loader-dot.dot-two {
    right: 38px;
    bottom: 46px;
    color: #f9a8d4;
    animation-delay: 0.4s;
  }

  .results-loading-copy span {
    display: inline-flex;
    margin-bottom: 14px;
    color: #93b4ff;
    font-size: 13px;
    font-weight: 950;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .results-loading-copy h1 {
    max-width: 520px;
    margin: 0;
    color: #ffffff;
    font-size: clamp(46px, 6vw, 78px);
    line-height: 0.95;
    letter-spacing: -0.075em;
  }

  .results-loading-copy p {
    max-width: 560px;
    margin: 18px 0 0;
    color: #aebbe1;
    font-size: 18px;
    line-height: 1.65;
  }

  .results-loading-steps {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 6px;
  }

  .results-loading-steps i {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    padding: 0 14px;
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.16);
    background: rgba(255, 255, 255, 0.045);
    color: #c7d2fe;
    font-size: 13px;
    font-style: normal;
    font-weight: 850;
  }

  .results-loading-bar {
    grid-column: 1 / -1;
    height: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
  }

  .results-loading-bar b {
    display: block;
    width: 38%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #22d3ee, #8b5cf6, #ec4899);
    box-shadow: 0 0 20px rgba(139, 92, 246, 0.32);
    animation: resultsLoadingBar 1.35s ease-in-out infinite;
  }

  @keyframes resultsGearSpin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  @keyframes resultsGearSpinReverse {
    from { transform: rotate(360deg); }
    to { transform: rotate(0deg); }
  }

  @keyframes resultsGlowPulse {
    0%, 100% { opacity: 0.64; transform: scale(0.96); }
    50% { opacity: 1; transform: scale(1.04); }
  }

  @keyframes resultsOrbitTilt {
    0%, 100% { transform: rotate(0deg) scale(1); opacity: 0.72; }
    50% { transform: rotate(8deg) scale(1.02); opacity: 1; }
  }

  @keyframes resultsOrbitTiltReverse {
    0%, 100% { transform: rotate(0deg) scale(1); opacity: 0.58; }
    50% { transform: rotate(-8deg) scale(0.98); opacity: 0.9; }
  }

  @keyframes resultsDotBlink {
    0%, 100% { opacity: 0.42; transform: scale(0.82); }
    50% { opacity: 1; transform: scale(1.18); }
  }

  @keyframes resultsLoadingBar {
    0% { transform: translateX(-105%); }
    50% { transform: translateX(82%); }
    100% { transform: translateX(265%); }
  }

  .hero,
  .action-strip,
  .import-panel,
  .message-stack,
  .stats-grid,
  .filters-panel,
  .table-panel {
    max-width: 1440px;
    margin-left: auto;
    margin-right: auto;
  }

  .hero,
  .action-strip,
  .import-panel,
  .filters-panel,
  .table-panel,
  .stat-card,
  .import-modal {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background:
      linear-gradient(180deg, rgba(14, 20, 40, 0.92), rgba(7, 10, 24, 0.96));
    box-shadow:
      0 24px 80px rgba(0, 0, 0, 0.38),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .eyebrow,
  label span,
  .preset-wrap label,
  .hero-panel span,
  .hero-panel small,
  .stat-card p,
  .verdict-head span,
  .verdict-head small,
  .run-id-box span,
  .summary-grid span {
    margin: 0 0 8px;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .hero {
    position: relative;
    overflow: hidden;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    align-items: stretch;
    gap: 18px;
    padding: 30px;
    margin-bottom: 18px;
    border-radius: 30px;
  }

  .hero::before {
    content: "";
    position: absolute;
    inset: auto -120px -150px auto;
    width: 420px;
    height: 420px;
    border-radius: 999px;
    background: rgba(124, 58, 237, 0.18);
    filter: blur(56px);
    pointer-events: none;
  }

  .hero::after {
    content: "";
    position: absolute;
    inset: -170px auto auto -120px;
    width: 360px;
    height: 360px;
    border-radius: 999px;
    background: rgba(37, 99, 235, 0.12);
    filter: blur(60px);
    pointer-events: none;
  }

  .hero.compact {
    max-width: 900px;
    margin-top: 80px;
  }

  .hero > div {
    position: relative;
    z-index: 1;
  }

  .hero-badge,
  .primary-btn,
  .secondary-btn,
  .danger-btn,
  .pill,
  .team-chip,
  .import-pill,
  .modal-status,
  .access-pill,
  .count-pill,
  .mini-status span,
  .table-summary span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: fit-content;
    border-radius: 999px;
    text-decoration: none;
    white-space: nowrap;
  }

  .hero-badge {
    min-height: 34px;
    padding: 0 12px;
    margin-bottom: 16px;
    color: #e7ecff;
    border: 1px solid rgba(129, 140, 248, 0.24);
    background: rgba(99, 102, 241, 0.16);
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h1,
  h2,
  p {
    position: relative;
    margin-top: 0;
  }

  h1 {
    margin: 0 0 12px;
    max-width: 880px;
    font-size: clamp(42px, 5vw, 72px);
    line-height: 0.98;
    letter-spacing: -0.07em;
  }

  h2 {
    margin: 0;
    font-size: 30px;
    letter-spacing: -0.04em;
  }

  .hero p {
    margin: 0;
    max-width: 740px;
    color: #a9b4d0;
    font-size: 20px;
    line-height: 1.65;
  }

  .hero-panel {
    position: relative;
    z-index: 1;
    min-width: 0;
    align-self: stretch;
    display: grid;
    align-content: center;
    padding: 20px;
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background:
      radial-gradient(circle at top right, rgba(139, 92, 246, 0.16), transparent 42%),
      rgba(255, 255, 255, 0.04);
  }

  .hero-panel strong,
  .hero-panel small {
    display: block;
  }

  .hero-panel strong {
    margin: 8px 0;
    color: #f5f7ff;
    font-size: 20px;
    line-height: 1.45;
  }

  .hero-panel small {
    color: #a9b4d0;
  }

  .nav-actions,
  .action-row,
  .mini-status,
  .selection-row,
  .table-summary,
  .modal-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .action-strip {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    padding: 16px;
    margin-bottom: 18px;
    border-radius: 24px;
    background:
      linear-gradient(180deg, rgba(9, 13, 29, 0.74), rgba(7, 10, 24, 0.84));
    backdrop-filter: blur(18px);
  }

  .primary-btn,
  .secondary-btn,
  .danger-btn {
    min-height: 44px;
    padding: 0 16px;
    border-radius: 14px;
    font-size: 16px;
    font-weight: 900;
    cursor: pointer;
    transition: transform 0.18s ease, opacity 0.18s ease, border-color 0.18s ease, background 0.18s ease;
  }

  .primary-btn:hover,
  .secondary-btn:hover,
  .danger-btn:hover,
  .date-preset-btn:hover,
  .jump-top:hover {
    transform: translateY(-1px);
  }

  .primary-btn {
    color: #fff;
    border: 0;
    background: linear-gradient(135deg, #2563eb 0%, #7c3aed 52%, #db2777 100%);
    box-shadow: 0 16px 34px rgba(91, 33, 182, 0.34);
  }

  .secondary-btn {
    color: #e5ebff;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
  }

  .secondary-btn.small {
    min-height: 36px;
    padding: 0 12px;
    font-size: 14px;
  }

  .danger-btn {
    color: #ffe4e6;
    border: 1px solid rgba(251, 113, 133, 0.2);
    background: rgba(244, 63, 94, 0.1);
  }

  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none !important;
  }

  .mini-status span,
  .table-summary span {
    min-height: 32px;
    padding: 0 10px;
    color: #a9b4d0;
    font-size: 14px;
    font-weight: 900;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  .import-panel {
    position: relative;
    overflow: hidden;
    padding: 24px;
    margin-bottom: 18px;
    border-radius: 28px;
    background:
      radial-gradient(circle at top left, rgba(34, 211, 238, 0.12), transparent 26%),
      linear-gradient(180deg, rgba(15, 22, 43, 0.9), rgba(7, 10, 24, 0.96));
  }

  .import-panel::after {
    content: "";
    position: absolute;
    inset: auto -100px -130px auto;
    width: 300px;
    height: 300px;
    border-radius: 999px;
    background: rgba(6, 182, 212, 0.1);
    filter: blur(48px);
    pointer-events: none;
  }

  .import-head {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 18px;
  }

  .import-pill {
    min-height: 34px;
    padding: 0 12px;
    color: #cffafe;
    border: 1px solid rgba(34, 211, 238, 0.22);
    background: rgba(34, 211, 238, 0.1);
    font-size: 14px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .import-grid {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: minmax(260px, 1.2fr) 240px minmax(240px, 1fr) auto;
    gap: 14px;
    align-items: end;
  }

  .file-box input {
    padding-top: 13px;
  }

  .file-box small {
    display: block;
    margin-top: 8px;
    color: #a9b4d0;
    font-size: 14px;
    line-height: 1.5;
  }

  .duplicate-help {
    min-height: 50px;
    display: flex;
    align-items: center;
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.5;
    padding: 0 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.035);
  }

  .import-btn {
    min-width: 160px;
    height: 50px;
  }

  .message-stack {
    display: grid;
    gap: 10px;
    margin-bottom: 18px;
  }

  .message {
    padding: 14px 16px;
    border-radius: 16px;
    font-size: 16px;
    line-height: 1.6;
  }

  .message.error {
    color: #fecdd3;
    border: 1px solid rgba(244, 63, 94, 0.23);
    background: rgba(244, 63, 94, 0.08);
  }

  .message.success {
    color: #bbf7d0;
    border: 1px solid rgba(16, 185, 129, 0.23);
    background: rgba(16, 185, 129, 0.08);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 18px;
  }

  .stat-card {
    position: relative;
    overflow: hidden;
    padding: 20px;
    border-radius: 24px;
  }

  .stat-card::before {
    content: "";
    position: absolute;
    left: -54px;
    top: -54px;
    width: 140px;
    height: 140px;
    border-radius: 50%;
    filter: blur(32px);
    background: rgba(59, 130, 246, 0.16);
  }

  .stat-card.violet::before { background: rgba(139, 92, 246, 0.18); }
  .stat-card.cyan::before { background: rgba(34, 211, 238, 0.16); }
  .stat-card.amber::before { background: rgba(245, 158, 11, 0.16); }
  .stat-card.emerald::before { background: rgba(16, 185, 129, 0.16); }
  .stat-card.blue::before { background: rgba(59, 130, 246, 0.16); }
  .stat-card.rose::before { background: rgba(244, 63, 94, 0.16); }

  .stat-card p,
  .stat-card strong {
    position: relative;
    z-index: 1;
  }

  .stat-card p {
    margin: 0 0 10px;
  }

  .stat-card strong {
    display: block;
    color: #f5f7ff;
    font-size: 32px;
    letter-spacing: -0.05em;
  }

  .filters-panel,
  .table-panel {
    padding: 24px;
    margin-bottom: 18px;
    border-radius: 28px;
  }

  .filters-top,
  .filters-grid {
    display: grid;
    gap: 14px;
  }

  .filters-top {
    grid-template-columns: 340px 180px 180px minmax(260px, 1fr);
    margin-bottom: 14px;
  }

  .filters-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 16px;
  }

  label {
    display: block;
  }

  input,
  select,
  button {
    font: inherit;
  }

  input,
  select,
  .date-preset-btn {
    width: 100%;
    min-height: 50px;
    box-sizing: border-box;
    color: #e7ecff;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 16px;
    outline: none;
    background: rgba(5, 8, 18, 0.9);
  }

  input,
  select {
    padding: 0 14px;
    color-scheme: dark;
  }

  input:focus,
  select:focus,
  .date-preset-btn:focus {
    border-color: rgba(96, 165, 250, 0.38);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
  }

  .preset-wrap {
    position: relative;
  }

  .date-preset-btn {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    cursor: pointer;
    transition: transform 0.18s ease, border-color 0.18s ease;
  }

  .date-preset-btn span {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-weight: 900;
  }

  .date-preset-btn small {
    color: #8ea0d6;
    font-size: 14px;
  }

  .date-preset-btn b {
    color: #8ea0d6;
    font-size: 13px;
  }

  .preset-menu {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    right: 0;
    z-index: 40;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    background: rgba(7, 10, 24, 0.98);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
  }

  .preset-menu button {
    width: 100%;
    padding: 13px 16px;
    color: #dbe7ff;
    border: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    background: transparent;
    text-align: left;
    font-size: 16px;
    font-weight: 800;
    cursor: pointer;
  }

  .preset-menu button.active,
  .preset-menu button:hover {
    color: #f5f3ff;
    background: rgba(139, 92, 246, 0.16);
  }


  .multi-filter {
    position: relative;
  }

  .multi-button {
    width: 100%;
    min-height: 50px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 0 14px;
    color: #e7ecff;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 16px;
    outline: none;
    background: rgba(5, 8, 18, 0.92);
    cursor: pointer;
    text-align: left;
  }

  .multi-button strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .multi-button b {
    color: #8ea0d6;
    font-size: 13px;
  }

  .multi-button:focus,
  .multi-button:hover {
    border-color: rgba(96, 165, 250, 0.38);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
  }

  .multi-menu {
    position: absolute;
    left: 0;
    top: calc(100% + 10px);
    z-index: 5000;
    width: min(360px, 86vw);
    padding: 10px;
    border-radius: 20px;
    border: 1px solid rgba(147, 197, 253, 0.22);
    background:
      radial-gradient(circle at top right, rgba(124, 58, 237, 0.16), transparent 34%),
      #0b1122;
    box-shadow:
      0 28px 90px rgba(0, 0, 0, 0.72),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }

  .multi-menu input {
    margin-bottom: 8px;
  }

  .multi-options {
    display: grid;
    gap: 6px;
    max-height: 280px;
    overflow: auto;
  }

  .multi-option {
    width: 100%;
    min-height: 38px;
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    border: 1px solid transparent;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.015);
    color: #e5ebff;
    padding: 0 10px;
    text-align: left;
    cursor: pointer;
  }

  .multi-option:hover,
  .multi-option.active {
    border-color: rgba(96, 165, 250, 0.22);
    background: rgba(59, 130, 246, 0.16);
  }

  .multi-option span {
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
  }

  .multi-option.active span {
    color: #34d399;
  }

  .multi-option strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .multi-empty {
    padding: 12px;
    color: #a9b4d0;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.025);
    font-size: 15px;
  }

  .cex-check {
    min-height: 50px;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    color: #dbe7ff;
    font-size: 16px;
    font-weight: 900;
  }

  .cex-check input {
    width: auto;
    min-height: auto;
  }

  .cex-check span {
    margin: 0;
    color: #dbe7ff;
    letter-spacing: 0;
    font-size: 16px;
    text-transform: none;
  }


  .selection-row {
    justify-content: space-between;
    padding-top: 4px;
  }

  .selection-row > span {
    color: #a9b4d0;
    font-size: 15px;
    font-weight: 800;
  }

  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 18px;
    margin-bottom: 18px;
  }

  .empty-box {
    padding: 36px 20px;
    color: #a9b4d0;
    text-align: center;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.025);
    line-height: 1.7;
  }

  .table-shell {
    overflow: auto;
    max-height: 920px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 24px;
    background: rgba(4, 8, 20, 0.72);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  table {
    width: 100%;
    min-width: 1640px;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 15px 14px;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 2;
    color: #8ea0d6;
    background: rgba(10, 18, 34, 0.98);
    backdrop-filter: blur(18px);
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  tr:nth-child(even) td {
    background: rgba(255, 255, 255, 0.018);
  }

  tr:hover td {
    background: rgba(59, 130, 246, 0.035);
  }

  td strong,
  td small,
  td em {
    display: block;
  }

  td strong {
    color: #f5f7ff;
    margin-bottom: 5px;
    font-size: 16px;
    line-height: 1.35;
  }

  td small {
    color: #a9b4d0;
    line-height: 1.5;
    font-size: 14px;
  }

  .mini-link {
    display: inline-flex;
    margin-top: 8px;
    color: #93c5fd;
    font-size: 14px;
    font-weight: 900;
    text-decoration: none;
  }

  .team-chip {
    margin-top: 8px;
    padding: 6px 10px;
    color: #dbe7ff;
    border: 1px solid rgba(96, 165, 250, 0.2);
    background: rgba(59, 130, 246, 0.1);
    font-size: 14px;
    font-weight: 900;
  }

  .pill {
    padding: 7px 11px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.05);
    color: #dbe7ff;
    font-size: 14px;
    font-weight: 900;
    line-height: 1.25;
  }

  .pill.success {
    color: #bbf7d0;
    border-color: rgba(16, 185, 129, 0.22);
    background: rgba(16, 185, 129, 0.1);
  }

  .pill.warning {
    color: #fde68a;
    border-color: rgba(245, 158, 11, 0.24);
    background: rgba(245, 158, 11, 0.1);
  }

  .pill.danger {
    color: #fecdd3;
    border-color: rgba(244, 63, 94, 0.24);
    background: rgba(244, 63, 94, 0.1);
  }

  .pill.notice,
  .pill.neutral {
    color: #bfdbfe;
    border-color: rgba(96, 165, 250, 0.24);
    background: rgba(59, 130, 246, 0.1);
  }

  .expanded-row td {
    padding-top: 0;
    background: rgba(255, 255, 255, 0.02) !important;
  }

  .verdict-box {
    margin: 0 0 8px;
    padding: 18px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .verdict-box.error {
    border-color: rgba(251, 113, 133, 0.18);
    background: rgba(244, 63, 94, 0.08);
  }

  .verdict-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }

  pre {
    margin: 0;
    white-space: pre-wrap;
    color: #dbe7ff;
    font-family: inherit;
    font-size: 16px;
    line-height: 1.8;
  }

  .show-more-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 22px;
    background: rgba(1, 4, 12, 0.78);
    backdrop-filter: blur(18px);
  }

  .import-modal {
    width: min(760px, 100%);
    max-height: min(86vh, 860px);
    overflow: auto;
    border-radius: 30px;
    padding: 26px;
    background:
      radial-gradient(circle at top left, rgba(59, 130, 246, 0.14), transparent 28%),
      radial-gradient(circle at bottom right, rgba(168, 85, 247, 0.14), transparent 26%),
      linear-gradient(180deg, rgba(15, 22, 43, 0.98), rgba(5, 8, 18, 0.98));
  }

  .modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }

  .modal-copy {
    margin: 0 0 18px;
    color: #a9b4d0;
    line-height: 1.7;
    font-size: 17px;
  }

  .success-text {
    color: #86efac;
  }

  .danger-text {
    color: #fda4af;
  }

  .import-percent {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 72px;
    height: 44px;
    border-radius: 999px;
    color: #cffafe;
    border: 1px solid rgba(34, 211, 238, 0.22);
    background: rgba(34, 211, 238, 0.1);
    font-weight: 900;
  }

  .progress-shell {
    height: 12px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 18px;
  }

  .progress-bar {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(135deg, #2563eb, #7c3aed, #db2777);
    transition: width 500ms ease;
    box-shadow: 0 0 30px rgba(139, 92, 246, 0.42);
  }

  .progress-steps {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }

  .progress-step {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 42px;
    padding: 10px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.03);
    color: #8ea0d6;
    font-size: 15px;
    font-weight: 800;
  }

  .progress-step span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    color: #dbe7ff;
    font-size: 14px;
  }

  .progress-step.active {
    color: #f5f7ff;
    border-color: rgba(96, 165, 250, 0.22);
    background: rgba(59, 130, 246, 0.12);
  }

  .progress-step.done {
    color: #bbf7d0;
    border-color: rgba(16, 185, 129, 0.2);
    background: rgba(16, 185, 129, 0.08);
  }

  .modal-note,
  .run-id-box,
  .error-detail-box,
  .summary-grid div {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
    border-radius: 16px;
  }

  .modal-note {
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.6;
    padding: 12px 14px;
  }

  .modal-status {
    padding: 9px 13px;
    font-size: 14px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .modal-status.success {
    color: #bbf7d0;
    border: 1px solid rgba(16, 185, 129, 0.23);
    background: rgba(16, 185, 129, 0.08);
  }

  .modal-status.error {
    color: #fecdd3;
    border: 1px solid rgba(244, 63, 94, 0.23);
    background: rgba(244, 63, 94, 0.08);
  }

  .run-id-box,
  .error-detail-box {
    padding: 14px;
    margin-bottom: 14px;
  }

  .run-id-box span,
  .run-id-box strong,
  .error-detail-box strong,
  .error-detail-box small {
    display: block;
  }

  .run-id-box strong {
    color: #f5f7ff;
    font-size: 15px;
    word-break: break-all;
  }

  .error-detail-box {
    border-color: rgba(244, 63, 94, 0.18);
    background: rgba(244, 63, 94, 0.07);
  }

  .error-detail-box strong {
    color: #ffe4e6;
    margin-bottom: 8px;
  }

  .error-detail-box small {
    color: #fecdd3;
    line-height: 1.6;
    word-break: break-word;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }

  .summary-grid.compact {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .summary-grid div {
    padding: 13px;
  }

  .summary-grid span,
  .summary-grid strong {
    display: block;
  }

  .summary-grid strong {
    color: #f5f7ff;
    font-size: 17px;
    line-height: 1.4;
    word-break: break-word;
  }

  .modal-actions {
    justify-content: flex-end;
  }

  .jump-top {
    position: fixed;
    right: 22px;
    bottom: 22px;
    z-index: 50;
    min-height: 46px;
    padding: 0 16px;
    border-radius: 999px;
    border: 1px solid rgba(59, 130, 246, 0.22);
    background: rgba(8, 13, 28, 0.92);
    color: #dbeafe;
    font: inherit;
    font-size: 15px;
    font-weight: 900;
    cursor: pointer;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.34);
  }

  @media (max-width: 1280px) {
    .stats-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .filters-top,
    .filters-grid,
    .import-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .duplicate-help,
    .import-btn {
      grid-column: span 2;
    }

    .hero {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 820px) {
    .results-page {
      padding-left: 12px;
      padding-right: 12px;
    }

    .hero,
    .action-strip,
    .section-head,
    .import-head,
    .modal-head {
      grid-template-columns: 1fr;
      flex-direction: column;
      align-items: stretch;
    }

    .hero-panel {
      min-width: 0;
    }

    .stats-grid,
    .filters-top,
    .filters-grid,
    .import-grid,
    .progress-steps,
    .summary-grid,
    .summary-grid.compact {
      grid-template-columns: 1fr;
    }

    .duplicate-help,
    .import-btn {
      grid-column: auto;
    }

    .primary-btn,
    .secondary-btn,
    .danger-btn {
      width: 100%;
    }

    h1 {
      font-size: 42px;
    }
  }

  .conversation-action-buttons { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .mini-preview-btn, .mini-open-link, .mini-verdict-btn { min-height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.22); color: #eef4ff; font-size: 13px; font-weight: 900; text-decoration: none; cursor: pointer; white-space: nowrap; transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, background .18s ease; }
  .mini-preview-btn:hover, .mini-open-link:hover, .mini-verdict-btn:hover { transform: translateY(-1px); }
  .mini-preview-btn { border-color: rgba(56, 189, 248, 0.36); background: linear-gradient(135deg, rgba(8, 47, 73, 0.95), rgba(14, 116, 144, 0.92)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 10px 26px rgba(8, 47, 73, 0.28); }
  .mini-preview-btn:hover { border-color: rgba(103, 232, 249, 0.55); background: linear-gradient(135deg, rgba(14, 116, 144, 0.96), rgba(34, 211, 238, 0.28)); }
  .mini-open-link { border-color: rgba(167, 139, 250, 0.32); background: linear-gradient(135deg, rgba(49, 46, 129, 0.95), rgba(91, 33, 182, 0.92)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 10px 26px rgba(76, 29, 149, 0.22); }
  .mini-open-link:hover { border-color: rgba(196, 181, 253, 0.5); background: linear-gradient(135deg, rgba(76, 29, 149, 0.96), rgba(147, 51, 234, 0.3)); }
  .mini-verdict-btn { border-color: rgba(244, 114, 182, 0.3); background: linear-gradient(135deg, rgba(80, 7, 36, 0.95), rgba(157, 23, 77, 0.92)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 10px 26px rgba(131, 24, 67, 0.22); }
  .mini-verdict-btn:hover, .mini-verdict-btn.active { border-color: rgba(251, 207, 232, 0.55); background: linear-gradient(135deg, rgba(157, 23, 77, 0.96), rgba(236, 72, 153, 0.32)); }
  .preview-unavailable { color: #8ea0d6; font-size: 13px; font-weight: 800; }
  .conversation-preview-backdrop {
    position: fixed;
    inset: 0;
    z-index: 999999;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
    padding: 14px;
    background:
      radial-gradient(circle at 14% 18%, rgba(34, 211, 238, 0.08), transparent 24%),
      radial-gradient(circle at 88% 12%, rgba(168, 85, 247, 0.12), transparent 26%),
      rgba(2, 6, 23, 0.84);
    backdrop-filter: blur(18px);
  }
  .conversation-preview-modal {
    width: min(1900px, calc(100vw - 28px));
    height: min(1120px, calc(100dvh - 28px));
    max-height: calc(100dvh - 28px);
    margin: auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(148, 163, 184, 0.24);
    border-radius: 34px;
    background:
      radial-gradient(circle at 12% 0%, rgba(34, 211, 238, 0.08), transparent 28%),
      radial-gradient(circle at 86% 0%, rgba(139, 92, 246, 0.12), transparent 30%),
      linear-gradient(180deg, rgba(16, 23, 43, 0.99) 0%, rgba(5, 9, 23, 0.99) 100%);
    box-shadow:
      0 42px 150px rgba(0, 0, 0, 0.82),
      0 0 0 1px rgba(96, 165, 250, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  .conversation-preview-head {
    flex: 0 0 auto;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 22px;
    padding: 26px 30px 22px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.14);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.82), rgba(15, 23, 42, 0.35));
  }
  .conversation-preview-head p { margin: 0 0 6px; color: #9fb5ff; font-size: 13px; font-weight: 950; letter-spacing: 0.16em; text-transform: uppercase; }
  .conversation-preview-head h2 { margin: 0 0 7px; color: #ffffff; font-size: clamp(28px, 1.9vw, 40px); line-height: 1; letter-spacing: -0.05em; }
  .conversation-preview-head span { color: #b7c4e5; font-size: 15.5px; font-weight: 800; }
  .conversation-preview-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  .conversation-preview-body {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(320px, 390px) minmax(0, 1fr);
    overflow: hidden;
  }
  .conversation-preview-sidebar {
    min-height: 0;
    overflow: auto;
    padding: 20px 18px 24px;
    border-right: 1px solid rgba(148, 163, 184, 0.14);
    background:
      radial-gradient(circle at 0% 0%, rgba(34, 211, 238, 0.08), transparent 32%),
      linear-gradient(180deg, rgba(15, 23, 42, 0.74), rgba(8, 13, 28, 0.92));
  }
  .conversation-preview-sidebar-title {
    margin-bottom: 14px;
    padding: 14px 14px 12px;
    border-radius: 18px;
    border: 1px solid rgba(96, 165, 250, 0.18);
    background: rgba(59, 130, 246, 0.08);
  }
  .conversation-preview-sidebar-title span,
  .conversation-preview-sidebar-title small { display: block; }
  .conversation-preview-sidebar-title span { color: #f8fbff; font-size: 17px; font-weight: 950; letter-spacing: -0.02em; }
  .conversation-preview-sidebar-title small { margin-top: 4px; color: #9fb5ff; font-size: 12px; font-weight: 850; letter-spacing: 0.08em; text-transform: uppercase; }
  .conversation-preview-main {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background:
      radial-gradient(circle at 50% 0%, rgba(96, 165, 250, 0.06), transparent 34%),
      rgba(3, 7, 18, 0.2);
  }
  .conversation-preview-meta {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    padding: 0;
    border-bottom: 0;
  }
  .conversation-preview-meta div,
  .conversation-preview-attributes .attribute-card {
    min-height: 76px;
    padding: 15px 16px;
    border-radius: 18px;
    border: 1px solid rgba(148, 163, 184, 0.14);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.058), rgba(255, 255, 255, 0.026));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    overflow: hidden;
  }
  .conversation-preview-meta span,
  .conversation-preview-meta strong,
  .conversation-preview-attributes span,
  .conversation-preview-attributes strong { display: block; }
  .conversation-preview-meta span,
  .conversation-preview-attributes span { margin-bottom: 7px; color: #9fb5ff; font-size: 12px; font-weight: 950; letter-spacing: 0.13em; text-transform: uppercase; }
  .conversation-preview-meta strong,
  .conversation-preview-attributes strong { color: #f8fbff; font-size: 15.5px; line-height: 1.45; overflow-wrap: anywhere; }
  .conversation-preview-attributes {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    padding: 14px 0 0;
    border-bottom: 0;
  }
  .conversation-preview-attributes .tags-card { grid-column: auto; }
  .conversation-preview-tags { display: flex; flex-wrap: wrap; gap: 8px; }
  .conversation-preview-tags i { padding: 7px 10px; border-radius: 999px; border: 1px solid rgba(96, 165, 250, 0.22); background: rgba(59, 130, 246, 0.14); color: #dbeafe; font-style: normal; font-size: 12px; font-weight: 850; }
  .conversation-preview-loaded {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .conversation-preview-result-strip {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.14);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.56), rgba(8, 13, 28, 0.36));
  }
  .conversation-preview-result-card {
    min-width: 0;
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    background: rgba(15, 23, 42, 0.76);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
  }
  .conversation-preview-result-card.review { border-color: rgba(251, 191, 36, 0.3); background: linear-gradient(180deg, rgba(251, 191, 36, 0.12), rgba(15, 23, 42, 0.72)); }
  .conversation-preview-result-card.client { border-color: rgba(45, 212, 191, 0.3); background: linear-gradient(180deg, rgba(45, 212, 191, 0.12), rgba(15, 23, 42, 0.72)); }
  .conversation-preview-result-card.resolution { border-color: rgba(168, 85, 247, 0.3); background: linear-gradient(180deg, rgba(168, 85, 247, 0.13), rgba(15, 23, 42, 0.72)); }
  .conversation-preview-result-card span,
  .conversation-preview-result-card strong { display: block; min-width: 0; }
  .conversation-preview-result-card span {
    color: #9fb5ff;
    font-size: 11px;
    font-weight: 950;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 5px;
  }
  .conversation-preview-result-card strong {
    color: #ffffff;
    font-size: 15px;
    font-weight: 950;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }
  .conversation-preview-compact-section {
    margin-bottom: 12px;
    border: 1px solid rgba(148, 163, 184, 0.13);
    border-radius: 16px;
    overflow: hidden;
    background: rgba(15, 23, 42, 0.42);
  }
  .conversation-preview-section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    background: rgba(96, 165, 250, 0.055);
  }
  .conversation-preview-section-head span {
    color: #f8fbff;
    font-size: 13px;
    font-weight: 950;
    letter-spacing: -0.01em;
  }
  .conversation-preview-section-head small {
    color: #91a6d8;
    font-size: 10px;
    font-weight: 850;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-align: right;
  }
  .conversation-preview-attribute-list { display: grid; grid-template-columns: 1fr; }
  .conversation-preview-attr-row {
    display: grid;
    grid-template-columns: minmax(92px, 42%) minmax(0, 1fr);
    align-items: start;
    gap: 12px;
    min-height: 34px;
    padding: 9px 12px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.075);
  }
  .conversation-preview-attr-row:last-child { border-bottom: 0; }
  .conversation-preview-attr-row span {
    color: #91a6d8;
    font-size: 11px;
    font-weight: 950;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    line-height: 1.35;
  }
  .conversation-preview-attr-row strong {
    min-width: 0;
    color: #f8fbff;
    font-size: 13px;
    font-weight: 850;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .conversation-preview-compact-section .conversation-preview-tags {
    padding: 12px;
    gap: 7px;
  }
  .conversation-preview-compact-section .conversation-preview-tags i {
    padding: 5px 8px;
    font-size: 11px;
  }

  .conversation-preview-verdict {
    flex: 0 0 auto;
    margin: 22px 26px 14px;
    max-height: 190px;
    overflow: auto;
    padding: 18px 20px;
    border-radius: 22px;
    border: 1px solid rgba(244, 114, 182, 0.24);
    background:
      radial-gradient(circle at top left, rgba(236, 72, 153, 0.16), transparent 36%),
      linear-gradient(180deg, rgba(76, 29, 149, 0.2), rgba(91, 33, 182, 0.09));
    box-shadow: 0 18px 50px rgba(76, 29, 149, 0.18), inset 0 1px 0 rgba(255,255,255,0.05);
  }
  .conversation-preview-verdict-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 11px; }
  .conversation-preview-verdict-head span { color: #f5d0fe; font-size: 15px; font-weight: 950; }
  .conversation-preview-verdict-head small { color: #fbcfe8; font-size: 12px; font-weight: 900; }
  .conversation-preview-verdict pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    color: #fff7ff;
    font-family: inherit;
    font-size: 15px;
    line-height: 1.7;
  }
  .conversation-transcript-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 8px 30px 32px;
    display: grid;
    align-content: start;
    gap: 18px;
  }

  .conversation-timeline-event {
    justify-self: center;
    display: inline-grid;
    grid-template-columns: auto auto;
    align-items: center;
    gap: 8px;
    max-width: min(760px, 82%);
    margin: 2px auto;
    padding: 5px 10px;
    border: 1px solid rgba(148, 163, 184, 0.16);
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.46);
    color: rgba(203, 213, 225, 0.86);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18);
  }
  .conversation-timeline-event::before {
    content: "◷";
    color: rgba(203, 213, 225, 0.72);
    font-size: 11px;
    line-height: 1;
  }
  .conversation-timeline-event span {
    color: rgba(148, 163, 184, 0.82);
    font-size: 11px;
    font-weight: 850;
    letter-spacing: 0.01em;
  }
  .conversation-timeline-event p {
    grid-column: 2;
    margin: 0;
    color: rgba(226, 232, 240, 0.92);
    font-size: 12px;
    font-weight: 800;
    line-height: 1.25;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .conversation-message {
    max-width: min(980px, 78%);
    padding: 18px 20px;
    border-radius: 22px;
    border: 1px solid rgba(148, 163, 184, 0.14);
    background: rgba(15, 23, 42, 0.86);
    box-shadow: 0 16px 44px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255,255,255,0.035);
  }
  .conversation-message.client { justify-self: start; border-color: rgba(59, 130, 246, 0.28); background: linear-gradient(180deg, rgba(30, 64, 175, 0.33), rgba(30, 41, 59, 0.72)); }
  .conversation-message.agent { justify-self: end; border-color: rgba(16, 185, 129, 0.22); background: linear-gradient(180deg, rgba(6, 95, 70, 0.3), rgba(15, 23, 42, 0.76)); }
  .conversation-message.system { justify-self: center; max-width: min(760px, 70%); background: rgba(255, 255, 255, 0.052); }
  .conversation-message-top { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 10px; }
  .conversation-message-top strong { color: #f8fbff; font-size: 16px; font-weight: 950; }
  .conversation-message-top span,
  .conversation-message small { color: #9fb5ff; font-size: 13px; font-weight: 850; }
  .conversation-message p { margin: 0; color: #e7efff; white-space: pre-wrap; line-height: 1.75; font-size: 16px; overflow-wrap: anywhere; }
  .conversation-message.system,
  .conversation-message.compact-event {
    max-width: min(620px, 62%);
    padding: 11px 14px;
    border-radius: 16px;
    border-color: rgba(148, 163, 184, 0.12);
    background: rgba(255, 255, 255, 0.048);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
  }
  .conversation-message.compact-event .conversation-message-top { margin-bottom: 5px; gap: 10px; }
  .conversation-message.compact-event .conversation-message-top strong,
  .conversation-message.compact-event .conversation-message-top span { font-size: 11.5px; }
  .conversation-message.compact-event p { font-size: 12.5px; line-height: 1.45; color: #d8e3fb; }

  .conversation-preview-loading,
  .conversation-preview-empty,
  .conversation-preview-error { margin: 24px 28px; padding: 24px; border-radius: 20px; border: 1px dashed rgba(148, 163, 184, 0.22); color: #dbe7ff; background: rgba(15, 23, 42, 0.7); }
  .conversation-preview-error strong,
  .conversation-preview-error span,
  .conversation-preview-error small { display: block; }
  .conversation-preview-error strong { color: #fecaca; margin-bottom: 8px; }
  .conversation-preview-error span { color: #f8fbff; margin-bottom: 6px; }
  @media (max-width: 1080px) {
    .conversation-preview-modal { width: calc(100vw - 20px); height: calc(100dvh - 20px); max-height: calc(100dvh - 20px); border-radius: 28px; }
    .conversation-preview-body { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); }
    .conversation-message { max-width: 90%; }
  }
  @media (max-width: 780px) {
    .conversation-preview-backdrop { padding: 8px; }
    .conversation-preview-modal { width: calc(100vw - 16px); height: calc(100dvh - 16px); max-height: calc(100dvh - 16px); border-radius: 24px; }
    .conversation-preview-head,
    .conversation-preview-actions { flex-direction: column; align-items: stretch; }
    .conversation-preview-body { grid-template-columns: 1fr; overflow: auto; }
    .conversation-preview-sidebar { max-height: none; border-right: 0; border-bottom: 1px solid rgba(148, 163, 184, 0.14); }
    .conversation-preview-main { min-height: 70dvh; overflow: visible; }
    .conversation-preview-verdict { margin: 16px; }
    .conversation-transcript-list { padding: 8px 16px 24px; overflow: visible; }
    .conversation-message,
    .conversation-message.system { max-width: 100%; }
    .conversation-preview-verdict-head { align-items: flex-start; flex-direction: column; }
  }

  .results-date-range-picker { position: relative; z-index: 35; }
  .results-date-range-picker.open { z-index: 9999; }
  .results-date-button { width: 100%; min-height: 50px; display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; padding: 0 14px; cursor: pointer; color: #e7ecff; border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; outline: none; background: rgba(5,8,18,0.94); }
  .results-date-button strong { display: inline-flex; align-items: center; gap: 9px; font-weight: 900; }
  .results-date-button small { color: #8ea0d6; font-size: 14px; }
  .results-date-button b { color: #8ea0d6; font-size: 13px; }
  .results-date-popover { position: absolute; top: calc(100% + 10px); left: 0; width: min(740px, 92vw); z-index: 99999; overflow: hidden; border-radius: 22px; background: #f8fafc; color: #0f172a; border: 1px solid rgba(15,23,42,0.14); box-shadow: 0 34px 100px rgba(0,0,0,0.72), 0 0 0 1px rgba(255,255,255,0.9); }
  .results-date-popover-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 18px 20px 10px; border-bottom: 1px solid rgba(15,23,42,0.1); }
  .results-date-popover-tabs div { padding: 10px 12px; border-radius: 14px; background: #fff; border: 1px solid rgba(15,23,42,0.08); }
  .results-date-popover-tabs div.active { border-bottom-color: #15803d; box-shadow: inset 0 -2px 0 #15803d; }
  .results-date-popover-tabs span { display: block; color: #64748b; font-size: 13px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 4px; }
  .results-date-popover-tabs strong, .results-calendar-nav-row strong, .results-calendar-month-card h4 { color: #0f172a; }
  .results-date-popover-body { display: grid; grid-template-columns: 160px minmax(0,1fr); gap: 16px; padding: 16px 20px; }
  .results-date-preset-column { display: grid; align-content: start; gap: 8px; }
  .results-date-preset-column button, .results-calendar-nav-row button { min-height: 38px; border-radius: 12px; border: 1px solid rgba(15,23,42,0.1); background: #fff; color: #0f172a; font-weight: 850; cursor: pointer; }
  .results-date-preset-column button.active, .results-date-preset-column button:hover, .results-calendar-nav-row button:hover { background: #dcfce7; color: #14532d; border-color: rgba(22,163,74,.28); }
  .results-calendar-nav-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .results-calendar-months-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .results-calendar-month-card h4 { margin: 0 0 10px; text-align: center; font-size: 17px; }
  .results-calendar-weekdays, .results-calendar-day-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .results-calendar-weekdays span { color: #94a3b8; text-align: center; font-size: 13px; font-weight: 900; letter-spacing: 0.01em; text-transform: none; }
  .results-calendar-day { min-height: 34px; border: 0; border-radius: 10px; color: #0f172a; background: transparent; cursor: pointer; font-weight: 800; }
  .results-calendar-day.muted { color: #cbd5e1; }
  .results-calendar-day.in-range { background: #e8f5ec; }
  .results-calendar-day.range-start, .results-calendar-day.range-end { color: #fff; border-radius: 999px; background: #15803d; }
  .results-date-popover-actions { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px 18px; border-top: 1px solid rgba(15,23,42,.08); }
  .results-date-popover-actions .secondary-btn { background: #fff; color: #0f172a; border: 1px solid rgba(15,23,42,.1); }
  .results-date-popover-actions .primary-btn { background: #15803d; color: #fff; }
  @media (max-width: 780px) { .results-date-popover { width: min(94vw, 520px); } .results-date-popover-body, .results-calendar-months-grid { grid-template-columns: 1fr; } }

  @media (max-width: 760px) {
    .results-loading-page {
      padding: 20px;
    }

    .results-loading-shell {
      min-height: 76vh;
    }

    .results-loading-card {
      grid-template-columns: 1fr;
      justify-items: center;
      text-align: center;
      gap: 24px;
      padding: 34px 22px;
      border-radius: 30px;
    }

    .results-loader-visual {
      width: 164px;
      height: 164px;
    }

    .results-loader-gear.gear-one {
      left: 26px;
      top: 54px;
      font-size: 76px;
    }

    .results-loader-gear.gear-two {
      left: 78px;
      top: 28px;
      font-size: 66px;
    }

    .results-loader-gear.gear-three {
      left: 88px;
      top: 94px;
      font-size: 48px;
    }

    .results-loading-steps {
      justify-content: center;
    }
  }

`;
