"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabase";

const AUTO_DUPLICATE_OVERWRITE_LIMIT = 20;
const AUDIT_BATCH_SIZE = 8;
const LARGE_FETCH_LIMIT_THRESHOLD = 250;
const LARGE_FETCH_RANGE_DAYS = 7;
const LARGE_QUEUE_CONFIRM_THRESHOLD = 100;
const CANCEL_FETCH_CONFIRM_THRESHOLD = 50;
const SESSION_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const RUN_PAGE_CACHE_KEY = "ai-auditor-run-page-state-v2";
const RUN_PAGE_CACHE_VERSION = 2;
const ACTIVE_WORKFLOW_STATUSES = new Set([
  "fetching",
  "fetched",
  "duplicate_checking",
  "paused_duplicate_decision",
  "auditing",
]);

const DATE_PRESET_OPTIONS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "past_week", label: "Past Week" },
  { key: "month_to_date", label: "Month to Date" },
  { key: "past_4_weeks", label: "Past 4 Weeks" },
  { key: "past_12_weeks", label: "Past 12 Weeks" },
  { key: "year_to_date", label: "Year to Date" },
  { key: "past_6_months", label: "Past 6 Months" },
  { key: "past_12_months", label: "Past 12 Months" },
  { key: "custom", label: "Custom" },
];

const SCORE_FILTER_OPTIONS = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5" },
];

const DEFAULT_CONVERSATION_RATINGS = ["3", "4", "5"];

const FETCH_STEPS = [
  "Preparing request",
  "Checking access",
  "Connecting to Intercom",
  "Finding filtered conversations",
  "Hydrating conversation details",
  "Preparing audit queue",
];

function CalendarIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 2V5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16 2V5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3.5 9H20.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="3.5" y="4.5" width="17" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 4V10H14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20V14H10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 10C18.37 8.22 17.18 6.69 15.61 5.64C14.03 4.58 12.15 4.05 10.25 4.11C8.36 4.16 6.51 4.8 5 5.95C3.49 7.11 2.41 8.72 1.93 10.55" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 14C5.63 15.78 6.82 17.31 8.39 18.36C9.97 19.42 11.85 19.95 13.75 19.89C15.64 19.84 17.49 19.2 19 18.05C20.51 16.89 21.59 15.28 22.07 13.45" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6" y="4" width="4" height="16" rx="1.4" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" rx="1.4" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function normalizeRunText(value) {
  return String(value ?? "").trim();
}

function normalizeRunKey(value) {
  return normalizeRunText(value).toLowerCase();
}

function uniqueSortedText(values) {
  return Array.from(new Set((values || []).map(normalizeRunText).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
}

function toOptionList(values) {
  return uniqueSortedText(values).map((value) => ({ value, label: value }));
}

function sameCalendarDay(a, b) {
  return a && b && formatDateInput(a) === formatDateInput(b);
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function formatMonthTitle(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function buildCalendarDays(monthDate) {
  const first = monthStart(monthDate);
  const last = monthEnd(monthDate);
  const startOffset = first.getDay();
  const days = [];

  for (let index = 0; index < startOffset; index += 1) {
    const date = new Date(first);
    date.setDate(first.getDate() - (startOffset - index));
    days.push({ date, muted: true });
  }

  for (let day = 1; day <= last.getDate(); day += 1) {
    days.push({ date: new Date(first.getFullYear(), first.getMonth(), day), muted: false });
  }

  while (days.length % 7 !== 0) {
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

function describeSelection(values, fallback = "Any") {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  return values.join(", ");
}

function MultiSelectFilter({ label, options, selected, onChange, placeholder = "Any", helper = "" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  const normalizedOptions = useMemo(() => {
    return (options || [])
      .map((option) =>
        typeof option === "string"
          ? { value: option, label: option, helper: "" }
          : { value: option.value, label: option.label || option.value, helper: option.helper || "" }
      )
      .filter((option) => normalizeRunText(option.value));
  }, [options]);

  const filteredOptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return normalizedOptions;
    return normalizedOptions.filter((option) => `${option.label || ""} ${option.helper || ""}`.toLowerCase().includes(search));
  }, [normalizedOptions, query]);

  useEffect(() => {
    function handleOutside(event) {
      if (!ref.current) return;
      if (!ref.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const selectedList = Array.isArray(selected) ? selected : [];
  const selectedSet = new Set(selectedList);
  const allSelected = selectedList.length === 0;
  const buttonLabel = allSelected
    ? placeholder
    : selectedList.length === 1
    ? normalizedOptions.find((option) => option.value === selectedList[0])?.label || selectedList[0]
    : `${selectedList.length} Selected`;

  function toggleValue(value) {
    const next = new Set(selectedList);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  }

  return (
    <div ref={ref} className={open ? "run-multi-filter open" : "run-multi-filter"}>
      <label>
        <span>{label}</span>
        <button type="button" className="run-multi-button" onClick={() => setOpen((prev) => !prev)}>
          <strong>{buttonLabel}</strong>
          <b>{open ? "Up" : "Down"}</b>
        </button>
        {helper ? <small>{helper}</small> : null}
      </label>

      {open ? (
        <div className="run-multi-menu">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} />
          <button type="button" className={allSelected ? "run-multi-option active" : "run-multi-option"} onClick={() => onChange([])}>
            <span>{allSelected ? "Selected" : "Select"}</span>
            <strong>{placeholder}</strong>
          </button>
          <div className="run-multi-options">
            {filteredOptions.map((option) => (
              <button key={option.value} type="button" className={selectedSet.has(option.value) ? "run-multi-option active" : "run-multi-option"} onClick={() => toggleValue(option.value)}>
                <span>{selectedSet.has(option.value) ? "Selected" : "Select"}</span>
                <strong>{option.label}</strong>
                {option.helper ? <em>{option.helper}</em> : null}
              </button>
            ))}
            {!filteredOptions.length ? <div className="run-multi-empty">No Matching Options.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CalendarMonth({ monthDate, draftStart, draftEnd, onSelectDate }) {
  const days = buildCalendarDays(monthDate);
  return (
    <div className="calendar-month-card">
      <h4>{formatMonthTitle(monthDate)}</h4>
      <div className="calendar-weekdays">{["SU", "MO", "TU", "WE", "TH", "FR", "SA"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="calendar-day-grid">
        {days.map(({ date, muted }) => {
          const isStart = draftStart && sameCalendarDay(date, draftStart);
          const isEnd = draftEnd && sameCalendarDay(date, draftEnd);
          const inRange = isDateInDraftRange(date, draftStart, draftEnd);
          return (
            <button key={formatDateInput(date)} type="button" className={["calendar-day", muted ? "muted" : "", inRange ? "in-range" : "", isStart ? "range-start" : "", isEnd ? "range-end" : ""].filter(Boolean).join(" ")} onClick={() => onSelectDate(date)}>
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RunDateRangePicker({ startDate, endDate, selectedDatePreset, selectedPresetLabel, onApplyPreset, onApplyCustom }) {
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
  const secondMonth = shiftMonths(visibleMonth, 1);

  return (
    <div className={open ? "run-date-range-picker open" : "run-date-range-picker"} ref={ref}>
      <label>
        <span>Date Range</span>
        <button type="button" className="run-date-button" onClick={() => setOpen((prev) => !prev)}>
          <strong><CalendarIcon /> {selectedPresetLabel}</strong>
          <small>{displayRange}</small>
          <b>{open ? "Up" : "Down"}</b>
        </button>
      </label>

      {open ? (
        <div className="run-date-popover">
          <div className="date-popover-tabs">
            <div><span>From</span><strong>{draftStart ? formatDateInput(draftStart) : "Choose Start"}</strong></div>
            <div className={draftEnd ? "active" : ""}><span>To</span><strong>{draftEnd ? formatDateInput(draftEnd) : "Choose End"}</strong></div>
          </div>
          <div className="date-popover-body">
            <aside className="date-preset-column">
              {DATE_PRESET_OPTIONS.map((item) => (
                <button key={item.key} type="button" className={item.key === selectedDatePreset ? "active" : ""} onClick={() => applyPreset(item.key)}>{item.label}</button>
              ))}
            </aside>
            <div className="date-calendar-zone">
              <div className="calendar-nav-row">
                <button type="button" onClick={() => setVisibleMonth((prev) => shiftMonths(prev, -1))}>‹</button>
                <strong>{formatMonthTitle(visibleMonth)} - {formatMonthTitle(secondMonth)}</strong>
                <button type="button" onClick={() => setVisibleMonth((prev) => shiftMonths(prev, 1))}>›</button>
              </div>
              <div className="calendar-months-grid">
                <CalendarMonth monthDate={visibleMonth} draftStart={draftStart} draftEnd={draftEnd} onSelectDate={selectDate} />
                <CalendarMonth monthDate={secondMonth} draftStart={draftStart} draftEnd={draftEnd} onSelectDate={selectDate} />
              </div>
            </div>
          </div>
          <div className="date-popover-actions">
            <button type="button" className="ghost-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn light" onClick={applyCustomRange} disabled={!draftStart && !draftEnd}>Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildFallbackProfile(user) {
  const email = user?.email?.toLowerCase() || "";

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
        profile?.can_run_tests === true)
  );
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

function shiftMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return normalizeToStartOfDay(next);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
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
    case "past_week":
      return { startDate: formatDateInput(shiftDays(today, -6)), endDate: formatDateInput(today) };
    case "month_to_date":
      return { startDate: formatDateInput(startOfMonth(today)), endDate: formatDateInput(today) };
    case "past_4_weeks":
      return { startDate: formatDateInput(shiftDays(today, -27)), endDate: formatDateInput(today) };
    case "past_12_weeks":
      return { startDate: formatDateInput(shiftDays(today, -83)), endDate: formatDateInput(today) };
    case "year_to_date":
      return { startDate: formatDateInput(startOfYear(today)), endDate: formatDateInput(today) };
    case "past_6_months":
      return { startDate: formatDateInput(shiftMonths(today, -6)), endDate: formatDateInput(today) };
    case "past_12_months":
      return { startDate: formatDateInput(shiftMonths(today, -12)), endDate: formatDateInput(today) };
    default:
      return null;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function normalizeTimestampForDisplay(value) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1000000000000) return new Date(value);
    if (value > 1000000000) return new Date(value * 1000);
  }

  const text = String(value).trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1000000000000) return new Date(numeric);
    if (numeric > 1000000000) return new Date(numeric * 1000);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatClock(value) {
  const date = normalizeTimestampForDisplay(value);
  if (!date) return value ? String(value) : "-";

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}
const INTERCOM_CONVERSATION_URL_PREFIX = "https://app.intercom.com/a/inbox/aphmhtyj/inbox/conversation";

function intercomConversationUrl(conversationId) {
  const id = String(conversationId || "").trim();
  return id ? `${INTERCOM_CONVERSATION_URL_PREFIX}/${id}` : "#";
}

function conversationIdOf(item) {
  return String(item?.conversationId || item?.conversation_id || item?.id || "").trim();
}

function normalizePreviewMessages(data) {
  return Array.isArray(data?.messages) ? data.messages : [];
}

function ConversationPreviewModal({ conversationId, onClose }) {
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
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
  const metadata = data?.metadata || {};

  return createPortal(
    <div className="conversation-preview-backdrop" onClick={onClose}>
      <div className="conversation-preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="conversation-preview-head">
          <div>
            <p>Conversation Preview</p>
            <h2>{conversationId}</h2>
            <span>{metadata.clientEmail || "Client email unavailable"} · {formatNumber(messages.length)} message(s)</span>
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
          <>
            <div className="conversation-preview-meta">
              <div><span>Assigned Agent</span><strong>{metadata.assignedAdmin || "Unassigned"}</strong></div>
              <div><span>Rating</span><strong>{metadata.rating || "-"}</strong></div>
              <div><span>Status</span><strong>{metadata.state || "-"}</strong></div>
              <div><span>Created</span><strong>{formatClock(metadata.createdAt)}</strong></div>
            </div>
            <div className="conversation-transcript-list">
              {messages.length ? messages.map((message) => (
                <article key={message.id} className={`conversation-message ${message.authorType || "system"}`}>
                  <div className="conversation-message-top"><strong>{message.authorName || "Unknown"}</strong><span>{formatClock(message.createdAt)}</span></div>
                  <p>{message.body || "Open on Intercom to see this message."}</p>
                  {!message.isRenderableText ? <small>Open on Intercom to see this message.</small> : null}
                </article>
              )) : <div className="conversation-preview-empty">No renderable text was returned. Open on Intercom to see this conversation.</div>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

function formatElapsed(startedAt) {
  if (!startedAt) return "0s";

  const diff = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(diff / 60);
  const seconds = diff % 60;

  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function splitIntoBatches(items, size) {
  const batches = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}

async function readJsonSafely(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_error) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    throw new Error(
      `Server returned a non-JSON response. Status ${response.status}. ${trimmed.slice(0, 260)}`
    );
  }
}

function mapWorkflowStatusToOperation(status) {
  if (status === "fetching") return "fetching";
  if (status === "fetched") return "fetched";
  if (status === "duplicate_checking") return "auditing";
  if (status === "paused_duplicate_decision") return "paused";
  if (status === "auditing") return "paused";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";

  return "idle";
}

function workflowEventToLog(item) {
  const createdAt = item?.created_at ? new Date(item.created_at) : new Date();
  const time = createdAt.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const toneMap = {
    success: "success",
    warning: "warning",
    failed: "danger",
    cancelled: "warning",
    info: "notice",
  };

  return {
    id: item?.id || `${Date.now()}-${Math.random()}`,
    time,
    message: item?.details || item?.event_label || "Workflow event recorded.",
    tone: toneMap[item?.status] || "notice",
  };
}

function rebuildConversationsFromWorkflow(run, queue = []) {
  const savedConversations = Array.isArray(run?.fetched_conversations)
    ? run.fetched_conversations
    : [];
  const completedIds = new Set(
    (Array.isArray(queue) ? queue : [])
      .filter((item) => item.status === "completed" || item.status === "skipped")
      .map((item) => String(item.conversation_id || ""))
      .filter(Boolean)
  );

  if (!savedConversations.length) return [];

  if (run?.status === "auditing" || run?.status === "failed" || run?.status === "cancelled") {
    return savedConversations.filter(
      (item) => !completedIds.has(String(item?.conversationId || item?.conversation_id || item?.id || ""))
    );
  }

  return savedConversations;
}

function readRunPageCache() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(RUN_PAGE_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== RUN_PAGE_CACHE_VERSION) return null;

    return parsed;
  } catch (_error) {
    return null;
  }
}

function writeRunPageCache(payload) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      RUN_PAGE_CACHE_KEY,
      JSON.stringify({
        version: RUN_PAGE_CACHE_VERSION,
        savedAt: new Date().toISOString(),
        ...payload,
      })
    );
  } catch (_error) {
    // Ignore browser storage failures. The live run must not depend on this cache.
  }
}

function clearRunPageCache() {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(RUN_PAGE_CACHE_KEY);
  } catch (_error) {
    // Ignore browser storage failures.
  }
}

function getResultStatusLabel(item) {
  if (item?.error) return "Error";
  if (item?.resolutionStatus) return item.resolutionStatus;
  return "Completed";
}

function getStatusTone(value) {
  if (value === "Resolved" || value === "Completed") return "success";
  if (value === "Pending") return "notice";
  if (value === "Unresolved" || value === "Error") return "danger";
  return "neutral";
}

function getResultSummary(item) {
  if (item?.error) return item.error;
  if (item?.aiVerdict) return item.aiVerdict;
  if (item?.summary) return item.summary;
  return "Audit completed.";
}

function getFindingsList(item) {
  const findings = [];

  if (item?.reviewSentiment) findings.push(`Review Sentiment: ${item.reviewSentiment}`);
  if (item?.clientSentiment) findings.push(`Client Sentiment: ${item.clientSentiment}`);
  if (item?.resolutionStatus) findings.push(`Resolution Status: ${item.resolutionStatus}`);

  if (Array.isArray(item?.findings) && item.findings.length > 0) {
    findings.push(...item.findings);
  }

  return findings;
}

function getOperationTone(status) {
  if (status === "completed" || status === "fetched") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "paused") return "warning";
  if (status === "fetching" || status === "auditing") return "notice";
  return "neutral";
}

function getOperationLabel(status, fetchLoading, runLoading, duplicateOpen) {
  if (fetchLoading) return "Fetching";
  if (runLoading) return "Auditing";
  if (duplicateOpen) return "Paused";
  if (status === "completed") return "Completed";
  if (status === "fetched") return "Fetched";
  if (status === "failed") return "Attention";
  if (status === "cancelled") return "Cancelled";
  return "Ready";
}

function getDateRangeDayCount(startDate, endDate) {
  if (!startDate || !endDate) return 0;

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;

  const diffDays = Math.round((normalizeToStartOfDay(end).getTime() - normalizeToStartOfDay(start).getTime()) / 86400000) + 1;
  return Math.max(1, diffDays);
}

function SafetyConfirmationModal({ confirmation, onCancel, onConfirm }) {
  if (!confirmation) return null;

  const details = Array.isArray(confirmation.details) ? confirmation.details : [];
  const tone = confirmation.tone || "warning";
  const confirmClassName = tone === "danger" ? "danger-btn" : "primary-btn";

  return (
    <div className="modal-backdrop safety-backdrop" onClick={onCancel}>
      <div className="duplicate-modal safety-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-shell-top">
          <div className={`modal-badge ${tone}`}>{confirmation.badge || "Confirmation Required"}</div>
          {confirmation.countLabel ? <div className={`modal-count ${tone}`}>{confirmation.countLabel}</div> : null}
        </div>

        <h2>{confirmation.title || "Confirm This Action"}</h2>
        <p className="modal-copy">{confirmation.message || "Please confirm before continuing."}</p>

        {details.length ? (
          <div className="safety-detail-grid">
            {details.map((item) => (
              <div className="modal-note-card safety-detail-card" key={`${item.label}-${item.value}`}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                {item.helper ? <small>{item.helper}</small> : null}
              </div>
            ))}
          </div>
        ) : null}

        {confirmation.note ? (
          <div className="modal-hint safety-hint">
            <SparklesIcon />
            <span>{confirmation.note}</span>
          </div>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onCancel}>
            {confirmation.cancelText || "Go Back"}
          </button>
          <button type="button" className={confirmClassName} onClick={onConfirm}>
            {confirmation.confirmText || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DuplicateWarningModal({
  open,
  duplicateSummary,
  processing,
  onCancel,
  onSkip,
  onOverwrite,
}) {
  if (!open) return null;

  const sampleIds = Array.isArray(duplicateSummary?.sampleConversationIds)
    ? duplicateSummary.sampleConversationIds
    : [];

  const duplicateCount = Number(duplicateSummary?.duplicateCount || 0);
  const willAutoOverwrite = duplicateCount < AUTO_DUPLICATE_OVERWRITE_LIMIT;

  return (
    <div className="modal-backdrop">
      <div className="duplicate-modal">
        <div className="modal-shell-top">
          <div className="modal-badge warning">Duplicate check required</div>
          <div className="modal-count">{formatNumber(duplicateCount)}</div>
        </div>

        <h2>Existing Result Rows Were Found</h2>
        <p className="modal-copy">
          {formatNumber(duplicateCount)} conversation audit(s) in this run already exist in Results.
          Choose what should happen before the audit continues.
        </p>

        <div className="modal-note-grid">
          <div className="modal-note-card">
            <span>Skip Existing</span>
            <strong>Preserves old rows</strong>
            <small>New rows are created only for conversations that are not already stored.</small>
          </div>

          <div className="modal-note-card">
            <span>Overwrite Existing</span>
            <strong>Refreshes stored rows</strong>
            <small>Existing matching rows are replaced with the new audit result.</small>
          </div>
        </div>

        <div className="duplicate-sample-box">
          <span>Sample conversation IDs</span>
          {sampleIds.length ? (
            <div className="duplicate-list">
              {sampleIds.map((id) => (
                <strong key={id}>{id}</strong>
              ))}
            </div>
          ) : (
            <small>No sample conversation IDs were returned.</small>
          )}
        </div>

        <div className="modal-hint">
          <SparklesIcon />
          <span>
            Auto-Run uses <strong>{willAutoOverwrite ? "Overwrite Existing" : "Skip Existing"}</strong>{" "}
            when duplicates appear automatically.
          </span>
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onCancel} disabled={processing}>
            Cancel
          </button>
          <button type="button" className="secondary-btn" onClick={onSkip} disabled={processing}>
            Skip Existing
          </button>
          <button type="button" className="primary-btn" onClick={onOverwrite} disabled={processing}>
            Overwrite Existing
          </button>
        </div>
      </div>
    </div>
  );
}

function ProgressPanel({
  type,
  label,
  detail,
  percent,
  elapsed,
  handled,
  total,
  batchIndex,
  totalBatches,
  savedRows,
  skippedRows,
  failedRows,
  onCancel,
}) {
  const normalizedPercent = Math.max(0, Math.min(100, percent));

  return (
    <div className="progress-panel enhanced">
      <div className="progress-panel-head">
        <div>
          <span className="mini-label">{type}</span>
          <h3>{label}</h3>
          <p>{detail}</p>
        </div>
        <div className="progress-percent-chip">{Math.round(normalizedPercent)}%</div>
      </div>

      <div className={type.toLowerCase().includes("fetch") ? "progress-visual fetch-visual" : "progress-visual audit-visual"} aria-hidden="true">
        {type.toLowerCase().includes("fetch") ? (
          <>
            <span className="fetch-node source" />
            <span className="fetch-stream"><i /><i /><i /></span>
            <span className="fetch-node queue" />
            <span className="fetch-scan-line" />
          </>
        ) : (
          <>
            <span className="mechanic-gear gear-large" />
            <span className="mechanic-gear gear-small" />
            <span className="mechanic-gear gear-mid" />
            <span className="audit-spark" />
          </>
        )}
      </div>

      <div className="progress-meter-shell">
        <div className="progress-meter-fill" style={{ width: `${normalizedPercent}%` }} />
      </div>

      <div className="progress-metrics-grid">
        <div>
          <span>Handled</span>
          <strong>{total ? `${formatNumber(handled)} / ${formatNumber(total)}` : "Preparing"}</strong>
        </div>
        <div>
          <span>Batch</span>
          <strong>{totalBatches ? `${formatNumber(batchIndex)} / ${formatNumber(totalBatches)}` : "-"}</strong>
        </div>
        <div>
          <span>Saved</span>
          <strong>{formatNumber(savedRows || 0)}</strong>
        </div>
        <div>
          <span>Skipped</span>
          <strong>{formatNumber(skippedRows || 0)}</strong>
        </div>
        <div>
          <span>Failed</span>
          <strong>{formatNumber(failedRows || 0)}</strong>
        </div>
        <div>
          <span>Elapsed</span>
          <strong>{elapsed}</strong>
        </div>
      </div>

      <div className="progress-bottom-row">
        <div className="progress-tip">
          <RefreshIcon />
          <small>Progress updates as each step or batch finishes.</small>
        </div>

        <button type="button" className="danger-btn compact" onClick={onCancel}>
          <PauseIcon />
          Cancel
        </button>
      </div>
    </div>
  );
}

function WorkflowStep({ number, title, body, status }) {
  return (
    <div className={`workflow-step ${status}`}>
      <div className="workflow-dot">{status === "done" ? <CheckIcon /> : number}</div>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

export default function RunPage() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedDatePreset, setSelectedDatePreset] = useState("custom");
  const [showPresetMenu, setShowPresetMenu] = useState(false);

  const [limiterEnabled, setLimiterEnabled] = useState(true);
  const [limitCount, setLimitCount] = useState("10");
  const [autoRunAfterFetch, setAutoRunAfterFetch] = useState(false);

  const [conversationRatings, setConversationRatings] = useState(DEFAULT_CONVERSATION_RATINGS);
  const [selectedSupervisorTeamIds, setSelectedSupervisorTeamIds] = useState([]);
  const [selectedEmployeeNames, setSelectedEmployeeNames] = useState([]);
  const [selectedIntercomAgentNames, setSelectedIntercomAgentNames] = useState([]);
  const [agentMappings, setAgentMappings] = useState([]);
  const [supervisorTeams, setSupervisorTeams] = useState([]);
  const [mappingFilterError, setMappingFilterError] = useState("");
  const [mappingFilterLoading, setMappingFilterLoading] = useState(false);

  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMessage, setAuthMessage] = useState("");

  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchStepIndex, setFetchStepIndex] = useState(0);
  const [fetchStartedAt, setFetchStartedAt] = useState(null);
  const [fetchError, setFetchError] = useState("");
  const [fetchSuccess, setFetchSuccess] = useState("");
  const [fetchData, setFetchData] = useState(null);

  const [runLoading, setRunLoading] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState(null);
  const [runError, setRunError] = useState("");
  const [runSuccess, setRunSuccess] = useState("");
  const [runData, setRunData] = useState(null);

  const [operationStatus, setOperationStatus] = useState("idle");
  const [executionLog, setExecutionLog] = useState([]);
  const [showAllResults, setShowAllResults] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [queueSearchText, setQueueSearchText] = useState("");
  const [selectedQueueIds, setSelectedQueueIds] = useState([]);
  const [previewConversationId, setPreviewConversationId] = useState("");
  const [showJumpTop, setShowJumpTop] = useState(false);
  const [_elapsedTick, setElapsedTick] = useState(0);

  const [duplicateWarningOpen, setDuplicateWarningOpen] = useState(false);
  const [duplicateSummary, setDuplicateSummary] = useState(null);
  const [duplicateDecisionLoading, setDuplicateDecisionLoading] = useState(false);
  const [pendingDuplicateConversations, setPendingDuplicateConversations] = useState([]);
  const [safetyConfirmation, setSafetyConfirmation] = useState(null);

  const [workflowRunId, setWorkflowRunId] = useState("");
  const [workflowRun, setWorkflowRun] = useState(null);
  const [workflowLoaded, setWorkflowLoaded] = useState(false);

  const [auditProgress, setAuditProgress] = useState({
    handled: 0,
    total: 0,
    batchIndex: 0,
    totalBatches: 0,
    percent: 0,
    savedRows: 0,
    skippedRows: 0,
    failedRows: 0,
    label: "Ready",
    detail: "Audit has not started.",
  });

  const startDateRef = useRef(null);
  const endDateRef = useRef(null);
  const presetMenuRef = useRef(null);
  const fetchAbortRef = useRef(null);
  const runAbortRef = useRef(null);
  const cancelRequestedRef = useRef(false);
  const cacheHydratedRef = useRef(false);

  const canRunTests = canRunAudits(profile);
  const isBusy = fetchLoading || runLoading || duplicateDecisionLoading;

  const fetchedConversations = Array.isArray(fetchData?.conversations)
    ? fetchData.conversations
    : [];

  const dailySummary = Array.isArray(fetchData?.debug?.dailySummary)
    ? fetchData.debug.dailySummary
    : [];

  const filteredFetchedQueue = useMemo(() => {
    const search = queueSearchText.trim().toLowerCase();
    if (!search) return fetchedConversations;
    return fetchedConversations.filter((item) => {
      const haystack = [conversationIdOf(item), item?.agentName, item?.clientEmail, item?.conversationRating, item?.csatScore, item?.repliedAt].join(" ").toLowerCase();
      return haystack.includes(search);
    });
  }, [fetchedConversations, queueSearchText]);

  const visibleFetchedQueue = queueExpanded ? filteredFetchedQueue : filteredFetchedQueue.slice(0, 8);
  const selectedQueueSet = useMemo(() => new Set(selectedQueueIds), [selectedQueueIds]);
  const allVisibleQueueSelected = visibleFetchedQueue.length > 0 && visibleFetchedQueue.every((item) => selectedQueueSet.has(conversationIdOf(item)));

  const results = Array.isArray(runData?.results) ? runData.results : [];
  const successCount = results.filter((item) => !item?.error).length;
  const errorCount = results.filter((item) => item?.error).length;
  const visibleResults = showAllResults ? results : results.slice(0, 8);
  const selectedPresetLabel =
    DATE_PRESET_OPTIONS.find((item) => item.key === selectedDatePreset)?.label || "Custom";
  const activeAgentMappings = useMemo(
    () =>
      (Array.isArray(agentMappings) ? agentMappings : [])
        .filter((item) => item?.is_active !== false)
        .map((item) => ({
          id: item.id || `${item.intercom_agent_name}-${item.employee_name}`,
          intercom_agent_name: normalizeRunText(item.intercom_agent_name),
          employee_name: normalizeRunText(item.employee_name || item.intercom_agent_name),
          employee_email: normalizeRunText(item.employee_email),
          team_name: normalizeRunText(item.team_name),
        }))
        .filter((item) => item.intercom_agent_name || item.employee_name),
    [agentMappings]
  );

  const activeSupervisorTeams = useMemo(
    () =>
      (Array.isArray(supervisorTeams) ? supervisorTeams : [])
        .filter((team) => team?.is_active !== false)
        .map((team) => ({
          id: normalizeRunText(team.id),
          supervisor_name: normalizeRunText(team.supervisor_name || team.supervisor_email || "Unnamed Supervisor"),
          supervisor_email: normalizeRunText(team.supervisor_email),
          members: Array.isArray(team.members)
            ? team.members
                .filter((member) => member?.is_active !== false)
                .map((member) => ({
                  employee_name: normalizeRunText(member.employee_name),
                  employee_email: normalizeRunText(member.employee_email),
                  intercom_agent_name: normalizeRunText(member.intercom_agent_name),
                  team_name: normalizeRunText(member.team_name),
                }))
            : [],
        }))
        .filter((team) => team.id && team.supervisor_name),
    [supervisorTeams]
  );

  const supervisorTeamFilterOptions = useMemo(
    () =>
      activeSupervisorTeams.map((team) => ({
        value: team.id,
        label: team.supervisor_name,
        helper: `${team.members.length} Team Member(s)`,
      })),
    [activeSupervisorTeams]
  );

  const employeeFilterOptions = useMemo(
    () =>
      toOptionList(activeAgentMappings.map((item) => item.employee_name)).map((option) => {
        const mappedAgents = activeAgentMappings
          .filter((item) => normalizeRunKey(item.employee_name) === normalizeRunKey(option.value))
          .map((item) => item.intercom_agent_name)
          .filter(Boolean);
        return { ...option, helper: mappedAgents.length ? `${mappedAgents.length} Intercom Agent(s)` : "No Intercom Agent" };
      }),
    [activeAgentMappings]
  );

  const intercomAgentFilterOptions = useMemo(
    () =>
      toOptionList(activeAgentMappings.map((item) => item.intercom_agent_name)).map((option) => {
        const mapping = activeAgentMappings.find((item) => normalizeRunKey(item.intercom_agent_name) === normalizeRunKey(option.value));
        return { ...option, helper: mapping?.employee_name ? `Employee: ${mapping.employee_name}` : "Unmapped" };
      }),
    [activeAgentMappings]
  );

  const selectedFilterSummary = useMemo(
    () => ({
      conversationRatings: describeSelection(conversationRatings, "Any Rating"),
      supervisorTeams: selectedSupervisorTeamIds.length
        ? `${selectedSupervisorTeamIds.length} Supervisor Team(s)`
        : "All Supervisor Teams",
      employees: selectedEmployeeNames.length ? `${selectedEmployeeNames.length} Employee(s)` : "All Employees",
      agents: selectedIntercomAgentNames.length ? `${selectedIntercomAgentNames.length} Intercom Agent(s)` : "All Intercom Agents",
    }),
    [conversationRatings, selectedSupervisorTeamIds, selectedEmployeeNames, selectedIntercomAgentNames]
  );
  const queuedConversationCount = useMemo(
    () => getQueuedConversations(fetchedConversations).length,
    [fetchedConversations, limiterEnabled, limitCount]
  );

  function addLog(message, tone = "info") {
    const now = new Date();
    const time = now.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    setExecutionLog((prev) =>
      [{ time, message, tone, id: `${Date.now()}-${Math.random()}` }, ...prev].slice(0, 60)
    );
  }

  async function getFreshAccessToken() {
    const { data, error } = await supabase.auth.getSession();

    if (error) {
      throw new Error(error.message || "Could not check the current login session.");
    }

    let activeSession = data?.session || session;

    if (!activeSession?.access_token) {
      throw new Error("Your login session is missing. Please sign in again.");
    }

    const expiresAtMs = activeSession?.expires_at ? activeSession.expires_at * 1000 : 0;
    const shouldRefresh = expiresAtMs && expiresAtMs - Date.now() < SESSION_REFRESH_BUFFER_MS;

    if (shouldRefresh) {
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();

      if (refreshError || !refreshData?.session?.access_token) {
        throw new Error(
          "Your login session expired during the audit. Please sign in again before continuing."
        );
      }

      activeSession = refreshData.session;
      setSession(activeSession);
      addLog("Session refreshed before the next batch.", "notice");
    } else {
      setSession(activeSession);
    }

    return activeSession.access_token;
  }

  async function postWorkflowAction(action, payload = {}, options = {}) {
    const quiet = Boolean(options.quiet);

    try {
      const accessToken = await getFreshAccessToken();

      const response = await fetch("/api/audits/workflow", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action, ...payload }),
        cache: "no-store",
      });

      const data = await readJsonSafely(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not update workflow state.");
      }

      if (data.run) {
        setWorkflowRun(data.run);
        setWorkflowRunId(data.run.id || payload.run_id || payload.runId || workflowRunId);
      }

      return data;
    } catch (error) {
      if (!quiet) {
        addLog(
          `Workflow state save failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          "warning"
        );
      }

      return null;
    }
  }

  function applyWorkflowSnapshot(snapshot, options = {}) {
    const run = snapshot?.run;
    if (!run?.id) return;

    const queue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const restoredConversations = rebuildConversationsFromWorkflow(run, queue);
    const operation = mapWorkflowStatusToOperation(run.status);
    const fetchedCount = Number(run.fetched_count || restoredConversations.length || 0);
    const handledCount = Number(run.handled_count || 0);
    const savedCount = Number(run.saved_count || 0);
    const skippedCount = Number(run.skipped_count || 0);
    const errorCount = Number(run.error_count || 0);
    const totalBatches = Number(run.total_batches || 0);
    const currentBatchIndex = Number(run.current_batch_index || 0);

    setWorkflowRun(run);
    setWorkflowRunId(run.id);
    setOperationStatus(operation);

    if (run.start_date) setStartDate(run.start_date);
    if (run.end_date) setEndDate(run.end_date);
    if (typeof run.limiter_enabled === "boolean") setLimiterEnabled(run.limiter_enabled);
    if (run.limit_count !== null && run.limit_count !== undefined) setLimitCount(String(run.limit_count));
    if (typeof run.auto_run_enabled === "boolean") setAutoRunAfterFetch(run.auto_run_enabled);

    if (restoredConversations.length) {
      setFetchData({
        ok: true,
        message: "Restored from database-backed Run Audit workflow.",
        meta: {
          fetchedCount,
          restoredCount: restoredConversations.length,
          workflowRunId: run.id,
          workflowStatus: run.status,
        },
        conversations: restoredConversations,
      });

      if (run.status !== "completed") {
        setFetchSuccess(
          `${formatNumber(restoredConversations.length)} remaining conversation(s) restored from the database workflow.`
        );
      }
    }

    if (run.status === "completed") {
      setRunData({
        ok: true,
        message: run.status_message || "Database-backed workflow completed.",
        meta: {
          requestedBy: run.requested_by_email || "",
          receivedCount: Number(run.queued_count || 0),
          handledCount,
          auditedCount: savedCount,
          successCount: Math.max(0, savedCount - errorCount),
          errorCount,
          skippedCount,
          mappedCount: Number(run.mapped_count || 0),
          unmappedCount: Number(run.unmapped_count || 0),
          duplicateModeApplied: run.duplicate_mode || "none",
          storedRunIds: Array.isArray(run.latest_audit_run_ids) ? run.latest_audit_run_ids : [],
          totalBatches,
          workflowRunId: run.id,
          auditMode: "database_backed_workflow_restore",
          storageStatus: "restored_from_supabase_workflow",
        },
        results: [],
      });
      setRunSuccess(run.status_message || "Database-backed workflow completed.");
    } else if (ACTIVE_WORKFLOW_STATUSES.has(run.status)) {
      setRunError("");
      setRunSuccess(
        "Workflow restored safely. Only the remaining queued conversations are loaded, so you can resume from where the audit stopped."
      );
    }

    setAuditProgress((prev) => ({
      ...prev,
      handled: handledCount,
      total: Number(run.queued_count || restoredConversations.length || prev.total || 0),
      batchIndex: currentBatchIndex,
      totalBatches,
      percent: Math.min(100, Math.max(0, Math.round(Number(run.progress_percent || 0)))),
      savedRows: savedCount,
      skippedRows: skippedCount,
      failedRows: errorCount,
      label:
        run.status === "completed"
          ? "Workflow Completed"
          : ACTIVE_WORKFLOW_STATUSES.has(run.status)
            ? "Workflow Restored"
            : run.status === "failed"
              ? "Workflow Failed"
              : run.status === "cancelled"
                ? "Workflow Cancelled"
                : prev.label,
      detail: run.status_message || prev.detail,
    }));

    if (events.length && options.withEvents !== false) {
      setExecutionLog((prev) => {
        const restoredLogs = events.map(workflowEventToLog);
        const existingIds = new Set(prev.map((item) => item.id));
        const merged = [
          ...restoredLogs.filter((item) => !existingIds.has(item.id)),
          ...prev,
        ];
        return merged.slice(0, 60);
      });
    }
  }

  async function loadLatestWorkflowSnapshot(activeSession = session) {
    if (!activeSession?.access_token) return;

    try {
      const response = await fetch("/api/audits/workflow", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${activeSession.access_token}`,
        },
        cache: "no-store",
      });

      const data = await readJsonSafely(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not load latest workflow state.");
      }

      if (data.run?.id) {
        applyWorkflowSnapshot(data);
        addLog("Latest database-backed Run Audit workflow restored.", "notice");
      }
    } catch (error) {
      addLog(
        `Could not restore database workflow state: ${error instanceof Error ? error.message : "Unknown error"}`,
        "warning"
      );
    } finally {
      setWorkflowLoaded(true);
    }
  }

  function resetRunStateForInputChange() {
    setFetchData(null);
    setFetchError("");
    setFetchSuccess("");
    setRunData(null);
    setRunError("");
    setRunSuccess("");
    setShowAllResults(false);
    setDuplicateWarningOpen(false);
    setDuplicateSummary(null);
    setDuplicateDecisionLoading(false);
    setPendingDuplicateConversations([]);
    setOperationStatus("idle");
    setWorkflowRunId("");
    setWorkflowRun(null);
    setAuditProgress({
      handled: 0,
      total: 0,
      batchIndex: 0,
      totalBatches: 0,
      percent: 0,
      savedRows: 0,
      skippedRows: 0,
      failedRows: 0,
      label: "Ready",
      detail: "Audit has not started.",
    });
    clearRunPageCache();
  }

  function openPicker(inputRef) {
    const el = inputRef.current;
    if (!el) return;

    if (typeof el.showPicker === "function") {
      el.showPicker();
      return;
    }

    el.focus();
    el.click();
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
    resetRunStateForInputChange();
    setShowPresetMenu(false);
  }

  async function loadProfile(user) {
    const email = user?.email?.toLowerCase() || "";
    const domain = email.split("@")[1] || "";

    if (!user) return { profile: null, message: "" };

    if (domain !== "nextventures.io") {
      await supabase.auth.signOut();
      return {
        profile: null,
        message: "Access blocked. Only nextventures.io Google accounts are allowed.",
      };
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

      return {
        profile: null,
        message: "Signed in, but no profile record is available yet.",
      };
    } catch (_error) {
      if (fallbackProfile) return { profile: fallbackProfile, message: "" };
      return { profile: null, message: "Signed in, but profile loading failed." };
    }
  }

  async function loadAgentMappingsForFilters(activeSession = session) {
    if (!activeSession?.access_token) {
      setAgentMappings([]);
      return;
    }

    setMappingFilterLoading(true);
    setMappingFilterError("");

    try {
      const response = await fetch("/api/admin/agent-mappings", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeSession.access_token}`,
        },
        cache: "no-store",
      });

      const data = await readJsonSafely(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not load agent mappings.");
      setAgentMappings(Array.isArray(data.mappings) ? data.mappings : []);
      setSupervisorTeams(Array.isArray(data.supervisorTeams) ? data.supervisorTeams : []);
    } catch (error) {
      setMappingFilterError(error instanceof Error ? error.message : "Could not load employee mappings.");
      setAgentMappings([]);
      setSupervisorTeams([]);
    } finally {
      setMappingFilterLoading(false);
    }
  }

  function getEmployeesAndAgentsForSupervisorTeams(nextTeamIds) {
    const selectedTeamIds = new Set(uniqueSortedText(nextTeamIds));
    const employeeNames = [];
    const intercomAgentNames = [];

    for (const team of activeSupervisorTeams) {
      if (!selectedTeamIds.has(team.id)) continue;

      for (const member of team.members || []) {
        if (member.employee_name) employeeNames.push(member.employee_name);
        if (member.intercom_agent_name) intercomAgentNames.push(member.intercom_agent_name);
      }
    }

    const employeeKeys = new Set(employeeNames.map(normalizeRunKey));

    for (const mapping of activeAgentMappings) {
      if (!employeeKeys.has(normalizeRunKey(mapping.employee_name))) continue;
      if (mapping.intercom_agent_name) intercomAgentNames.push(mapping.intercom_agent_name);
    }

    return {
      employeeNames: uniqueSortedText(employeeNames),
      intercomAgentNames: uniqueSortedText(intercomAgentNames),
    };
  }

  function applySupervisorTeamFilterSelection(nextTeamIds) {
    const normalizedTeamIds = uniqueSortedText(nextTeamIds);
    setSelectedSupervisorTeamIds(normalizedTeamIds);

    if (!normalizedTeamIds.length) {
      setSelectedEmployeeNames([]);
      setSelectedIntercomAgentNames([]);
      resetRunStateForInputChange();
      return;
    }

    const linkedSelection = getEmployeesAndAgentsForSupervisorTeams(normalizedTeamIds);
    setSelectedEmployeeNames(linkedSelection.employeeNames);
    setSelectedIntercomAgentNames(linkedSelection.intercomAgentNames);
    resetRunStateForInputChange();
  }

  function applyEmployeeFilterSelection(nextEmployees) {
    const normalizedEmployees = uniqueSortedText(nextEmployees);
    setSelectedSupervisorTeamIds([]);
    setSelectedEmployeeNames(normalizedEmployees);

    if (!normalizedEmployees.length) {
      setSelectedIntercomAgentNames([]);
      resetRunStateForInputChange();
      return;
    }

    const selectedEmployeeKeys = new Set(normalizedEmployees.map(normalizeRunKey));
    const matchingAgents = activeAgentMappings
      .filter((item) => selectedEmployeeKeys.has(normalizeRunKey(item.employee_name)))
      .map((item) => item.intercom_agent_name)
      .filter(Boolean);

    setSelectedIntercomAgentNames(uniqueSortedText(matchingAgents));
    resetRunStateForInputChange();
  }

  function applyIntercomAgentFilterSelection(nextAgents) {
    const normalizedAgents = uniqueSortedText(nextAgents);
    setSelectedSupervisorTeamIds([]);
    setSelectedIntercomAgentNames(normalizedAgents);

    if (!normalizedAgents.length) {
      setSelectedEmployeeNames([]);
      resetRunStateForInputChange();
      return;
    }

    const selectedAgentKeys = new Set(normalizedAgents.map(normalizeRunKey));
    const matchingEmployees = activeAgentMappings
      .filter((item) => selectedAgentKeys.has(normalizeRunKey(item.intercom_agent_name)))
      .map((item) => item.employee_name)
      .filter(Boolean);

    setSelectedEmployeeNames(uniqueSortedText(matchingEmployees));
    resetRunStateForInputChange();
  }

  function applyCustomDateRange(nextStartDate, nextEndDate) {
    setStartDate(nextStartDate);
    setEndDate(nextEndDate);
    setSelectedDatePreset("custom");
    resetRunStateForInputChange();
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
          setAuthMessage("");
          setAuthLoading(false);
          return;
        }

        const result = await loadProfile(currentSession.user);

        if (!active) return;

        setProfile(result.profile);
        setAuthMessage(result.message);
        setAuthLoading(false);

        if (currentSession?.access_token && result.profile?.can_run_tests) {
          loadLatestWorkflowSnapshot(currentSession);
        }
      } catch (_error) {
        if (!active) return;
        setAuthMessage("Could not complete session check.");
        setAuthLoading(false);
      }
    }

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!active) return;

      const isBackgroundRefresh = event === "TOKEN_REFRESHED" || event === "USER_UPDATED";

      setSession(newSession ?? null);

      if (!newSession?.user) {
        setProfile(null);
        setAuthMessage("");
        setAuthLoading(false);
        return;
      }

      loadProfile(newSession.user)
        .then((result) => {
          if (!active) return;
          setProfile(result.profile);
          setAuthMessage(result.message);
          setAuthLoading(false);

          if (!isBackgroundRefresh && newSession?.access_token && result.profile?.can_run_tests) {
            loadLatestWorkflowSnapshot(newSession);
          }
        })
        .catch(() => {
          if (!active) return;
          setAuthMessage("Could not complete profile check.");
          setAuthLoading(false);
        });
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.access_token) {
      setAgentMappings([]);
      setSupervisorTeams([]);
      setSelectedSupervisorTeamIds([]);
      return;
    }

    loadAgentMappingsForFilters(session);
  }, [session?.access_token]);

  useEffect(() => {
    if (cacheHydratedRef.current) return;

    const cached = readRunPageCache();
    cacheHydratedRef.current = true;

    if (!cached) return;

    if (cached.startDate) setStartDate(cached.startDate);
    if (cached.endDate) setEndDate(cached.endDate);
    if (cached.selectedDatePreset) setSelectedDatePreset(cached.selectedDatePreset);
    if (typeof cached.limiterEnabled === "boolean") setLimiterEnabled(cached.limiterEnabled);
    if (cached.limitCount) setLimitCount(cached.limitCount);
    if (typeof cached.autoRunAfterFetch === "boolean") setAutoRunAfterFetch(cached.autoRunAfterFetch);
    if (Array.isArray(cached.conversationRatings)) setConversationRatings(cached.conversationRatings);
    if (Array.isArray(cached.selectedSupervisorTeamIds)) setSelectedSupervisorTeamIds(cached.selectedSupervisorTeamIds);
    if (Array.isArray(cached.selectedEmployeeNames)) setSelectedEmployeeNames(cached.selectedEmployeeNames);
    if (Array.isArray(cached.selectedIntercomAgentNames)) setSelectedIntercomAgentNames(cached.selectedIntercomAgentNames);
    if (cached.workflowRunId) setWorkflowRunId(cached.workflowRunId);
    if (cached.workflowRun) setWorkflowRun(cached.workflowRun);

    if (cached.fetchData) setFetchData(cached.fetchData);
    if (cached.runData) setRunData(cached.runData);
    if (cached.fetchSuccess) setFetchSuccess(cached.fetchSuccess);
    if (cached.runSuccess) setRunSuccess(cached.runSuccess);
    if (cached.operationStatus && cached.operationStatus !== "fetching" && cached.operationStatus !== "auditing") {
      setOperationStatus(cached.operationStatus);
    }

    if (Array.isArray(cached.executionLog) && cached.executionLog.length > 0) {
      setExecutionLog(cached.executionLog.slice(0, 60));
    }

    if (cached.auditProgress && typeof cached.auditProgress === "object") {
      setAuditProgress((prev) => ({
        ...prev,
        ...cached.auditProgress,
        label:
          cached.operationStatus === "fetching" || cached.operationStatus === "auditing"
            ? "Previous Run State Restored"
            : cached.auditProgress.label || prev.label,
        detail:
          cached.operationStatus === "fetching" || cached.operationStatus === "auditing"
            ? "This page restored the last saved UI state. Check Results and System Activity Logs before rerunning."
            : cached.auditProgress.detail || prev.detail,
      }));
    }

    if (cached.operationStatus === "fetching" || cached.operationStatus === "auditing") {
      setOperationStatus("failed");
      setFetchLoading(false);
      setRunLoading(false);
      setFetchError(
        "The page was refreshed during an active workflow. Check Results and System Activity Logs before rerunning the same range."
      );
      addLog(
        "Previous active workflow state was restored after refresh. Verify Results before rerunning.",
        "warning"
      );
    } else if (cached.savedAt) {
      addLog("Previous Run Audit page state restored from this browser session.", "notice");
    }
  }, []);

  useEffect(() => {
    if (!cacheHydratedRef.current) return;

    writeRunPageCache({
      startDate,
      endDate,
      selectedDatePreset,
      limiterEnabled,
      limitCount,
      autoRunAfterFetch,
      conversationRatings,
      selectedSupervisorTeamIds,
      selectedEmployeeNames,
      selectedIntercomAgentNames,
      workflowRunId,
      workflowRun,
      fetchData,
      runData,
      fetchSuccess,
      runSuccess,
      operationStatus,
      executionLog: executionLog.slice(0, 20),
      auditProgress,
    });
  }, [
    startDate,
    endDate,
    selectedDatePreset,
    limiterEnabled,
    limitCount,
    autoRunAfterFetch,
    conversationRatings,
    selectedSupervisorTeamIds,
    selectedEmployeeNames,
    selectedIntercomAgentNames,
    workflowRunId,
    workflowRun,
    fetchData,
    runData,
    fetchSuccess,
    runSuccess,
    operationStatus,
    executionLog,
    auditProgress,
  ]);

  useEffect(() => {
    if (!fetchLoading) return undefined;

    const interval = setInterval(() => {
      setFetchStepIndex((prev) => (prev >= FETCH_STEPS.length - 1 ? prev : prev + 1));
    }, 1300);

    return () => clearInterval(interval);
  }, [fetchLoading]);

  useEffect(() => {
    if (!fetchLoading && !runLoading) return undefined;

    const interval = setInterval(() => {
      setElapsedTick((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [fetchLoading, runLoading]);

  useEffect(() => {
    function handleBeforeUnload(event) {
      if (!isBusy) return;

      event.preventDefault();
      event.returnValue =
        "A fetch or audit is still running. Leaving now can interrupt the live workflow.";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isBusy]);

  useEffect(() => {
    function handleScroll() {
      setShowJumpTop(window.scrollY > 700);
    }

    handleScroll();
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    function handleClickOutside(event) {
      if (!presetMenuRef.current) return;
      if (!presetMenuRef.current.contains(event.target)) {
        setShowPresetMenu(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      // Do not auto-abort in-flight requests on unmount.
      // The explicit Cancel buttons are the only place that should abort a fetch or audit.
      // This gives server routes the best chance to finish if the browser refreshes unexpectedly.
    };
  }, []);

  function toggleAutoRun() {
    setAutoRunAfterFetch((prev) => {
      const next = !prev;
      addLog(`Auto-Run ${next ? "enabled" : "disabled"}.`, next ? "success" : "neutral");
      return next;
    });
  }

  function performCancelFetch() {
    cancelRequestedRef.current = true;

    if (fetchAbortRef.current) fetchAbortRef.current.abort();

    setFetchLoading(false);
    setFetchError("Fetch cancelled.");
    setOperationStatus("cancelled");
    addLog("Fetch cancelled by user.", "warning");

    if (workflowRunId) {
      postWorkflowAction(
        "workflow_cancelled",
        { run_id: workflowRunId, message: "Fetch cancelled by user." },
        { quiet: true }
      );
    }
  }

  function performCancelAudit() {
    cancelRequestedRef.current = true;

    if (runAbortRef.current) runAbortRef.current.abort();

    setRunLoading(false);
    setDuplicateDecisionLoading(false);
    setDuplicateWarningOpen(false);
    setRunError("Audit cancelled. Already completed batches may still be saved in Results.");
    setOperationStatus("cancelled");
    addLog("Audit cancelled. Check Results before rerunning the same batch.", "warning");

    if (workflowRunId) {
      postWorkflowAction(
        "workflow_cancelled",
        { run_id: workflowRunId, message: "Audit cancelled by user." },
        { quiet: true }
      );
    }
  }

  function handleCancelFetch() {
    const fetchedCount = fetchedConversations.length || Number(fetchData?.meta?.fetchedCount || 0);

    if (fetchLoading && fetchedCount >= CANCEL_FETCH_CONFIRM_THRESHOLD) {
      openSafetyConfirmation({
        action: "cancel_fetch",
        tone: "danger",
        badge: "Cancel Fetch?",
        title: "Cancel The Active Fetch?",
        countLabel: formatNumber(fetchedCount),
        message:
          "This fetch has already pulled conversations into the audit queue. Cancelling now stops the live fetch, but the rows already fetched may remain available in the current workflow.",
        details: [
          { label: "Fetched So Far", value: `${formatNumber(fetchedCount)} conversation(s)`, helper: "These may remain in the queue after cancellation." },
          { label: "Workflow State", value: workflowRunId ? "Database-backed" : "Local only", helper: workflowRunId ? "The workflow cancellation will be logged." : "No workflow id is currently attached." },
        ],
        note: "Before rerunning this same range, check the queue and Results to avoid duplicate operational work.",
        confirmText: "Cancel Fetch",
        cancelText: "Keep Fetching",
      });
      return;
    }

    performCancelFetch();
  }

  function handleCancelAudit() {
    const totalCount = auditProgress.total || queuedConversationCount || fetchedConversations.length;

    if (runLoading) {
      openSafetyConfirmation({
        action: "cancel_audit",
        tone: "danger",
        badge: "Cancel Audit?",
        title: "Cancel The Running Audit?",
        countLabel: totalCount ? formatNumber(totalCount) : "Live",
        message:
          "Completed batches may already be saved in Results. Cancelling now stops the remaining batches but does not undo rows that were already stored.",
        details: [
          { label: "Handled", value: `${formatNumber(auditProgress.handled || 0)} of ${formatNumber(totalCount || 0)}`, helper: "Already completed batches may be saved." },
          { label: "Saved Rows", value: formatNumber(auditProgress.savedRows || 0), helper: "Check Results before rerunning the same queue." },
          { label: "Current Batch", value: auditProgress.totalBatches ? `${formatNumber(auditProgress.batchIndex)} of ${formatNumber(auditProgress.totalBatches)}` : "Preparing", helper: "Cancellation happens between active requests where possible." },
        ],
        note: "Use this only when you intentionally want to stop the current audit run.",
        confirmText: "Cancel Audit",
        cancelText: "Keep Auditing",
      });
      return;
    }

    performCancelAudit();
  }

  function getQueuedConversations(conversations) {
    const list = Array.isArray(conversations) ? conversations : [];

    if (!limiterEnabled) return list;

    const parsedLimit = Number(limitCount);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) return list;

    return list.slice(0, parsedLimit);
  }

  async function checkDuplicates(conversations) {
    const accessToken = await getFreshAccessToken();
    const controller = new AbortController();
    runAbortRef.current = controller;

    const response = await fetch("/api/audits/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        conversations,
        limiterEnabled: false,
        limitCount: null,
        startDate,
        endDate,
        duplicateMode: "",
        checkOnly: true,
        batchMode: false,
      }),
      signal: controller.signal,
    });

    const data = await readJsonSafely(response);

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "Duplicate check failed.");
    }

    return data;
  }

  async function runSingleBatch({
    batch,
    batchIndex,
    totalBatches,
    totalCount,
    duplicateMode,
  }) {
    const accessToken = await getFreshAccessToken();
    const controller = new AbortController();
    runAbortRef.current = controller;

    const response = await fetch("/api/audits/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        conversations: batch,
        limiterEnabled: false,
        limitCount: null,
        startDate,
        endDate,
        duplicateMode,
        batchMode: true,
        batchIndex,
        totalBatches,
        batchSize: batch.length,
        totalCount,
        batchLabel: `Batch ${batchIndex} of ${totalBatches}`,
      }),
      signal: controller.signal,
    });

    const data = await readJsonSafely(response);

    if (response.status === 409 && data?.requiresDuplicateDecision) {
      throw new Error(
        "A duplicate appeared during a batch after the duplicate check. Please retry with Skip Existing or Overwrite Existing."
      );
    }

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Batch ${batchIndex} failed.`);
    }

    return data;
  }

  function buildPartialRunData({
    queuedConversations,
    batches,
    allResults,
    storedRunIds,
    modeToUse,
    totalSkipped,
    totalOverwritten,
    totalMapped,
    totalUnmapped,
    handled,
    failedCount,
    partialReason,
  }) {
    const safeBatches = Array.isArray(batches) ? batches : [];

    return {
      ok: false,
      partial: true,
      message: "Partial batch audit saved before the run stopped.",
      meta: {
        requestedBy: session?.user?.email || "",
        receivedCount: queuedConversations.length,
        handledCount: handled,
        auditedCount: allResults.length,
        successCount: allResults.filter((item) => !item?.error).length,
        errorCount: allResults.filter((item) => item?.error).length + failedCount,
        duplicateModeApplied: modeToUse || "none",
        skippedCount: totalSkipped,
        overwrittenCount: totalOverwritten,
        mappedCount: totalMapped,
        unmappedCount: totalUnmapped,
        auditMode: "live_gpt_batch_client_partial",
        storageStatus: "partial_save_to_supabase",
        storedRunIds,
        batchSize: AUDIT_BATCH_SIZE,
        totalBatches: safeBatches.length,
        partialReason,
      },
      results: allResults,
    };
  }

  async function startBatchAudit({
    conversationsOverride = null,
    duplicateMode = "",
    autoTriggered = false,
    workflowRunIdOverride = "",
  } = {}) {
    setRunError("");
    setRunSuccess("");
    setRunData(null);
    setShowAllResults(false);
    setDuplicateWarningOpen(false);
    setDuplicateSummary(null);
    setDuplicateDecisionLoading(false);

    const sourceConversations = Array.isArray(conversationsOverride)
      ? conversationsOverride
      : fetchedConversations;

    const queuedConversations = getQueuedConversations(sourceConversations);
    const activeWorkflowRunId = workflowRunIdOverride || workflowRunId || "";

    if (!queuedConversations.length) {
      setRunError("Please fetch conversations first.");
      return;
    }

    if (!session?.access_token) {
      setRunError("Your login session is missing. Please sign in again.");
      return;
    }

    cancelRequestedRef.current = false;
    setRunLoading(true);
    setRunStartedAt(Date.now());
    setOperationStatus("auditing");

    setAuditProgress({
      handled: 0,
      total: queuedConversations.length,
      batchIndex: 0,
      totalBatches: 0,
      percent: 3,
      savedRows: 0,
      skippedRows: 0,
      failedRows: 0,
      label: "Checking Duplicates",
      detail: "Checking stored Results before starting the batch audit.",
    });

    addLog(
      `Audit started for ${formatNumber(queuedConversations.length)} conversation(s). Mode: ${
        duplicateMode || "duplicate check"
      }.`,
      "info"
    );

    let modeToUse = duplicateMode;
    let batches = [];
    const allResults = [];
    const storedRunIds = [];

    let handled = 0;
    let totalSkipped = 0;
    let totalOverwritten = 0;
    let totalMapped = 0;
    let totalUnmapped = 0;
    let totalFailedRows = 0;

    try {
      if (!modeToUse) {
        const duplicateCheck = await checkDuplicates(queuedConversations);
        const duplicateCount = Number(duplicateCheck?.duplicateSummary?.duplicateCount || 0);

        if (activeWorkflowRunId) {
          await postWorkflowAction(
            "duplicate_check_completed",
            {
              run_id: activeWorkflowRunId,
              duplicateSummary: duplicateCheck.duplicateSummary || null,
              duplicateCount,
              paused: duplicateCount > 0 && !autoTriggered,
            },
            { quiet: true }
          );
        }

        if (duplicateCount > 0) {
          if (autoTriggered) {
            modeToUse =
              duplicateCount < AUTO_DUPLICATE_OVERWRITE_LIMIT
                ? "overwrite_existing"
                : "skip_existing";

            addLog(
              `${formatNumber(duplicateCount)} duplicate(s) found. Auto-${
                modeToUse === "overwrite_existing" ? "overwrite" : "skip"
              } applied.`,
              modeToUse === "overwrite_existing" ? "warning" : "notice"
            );
          } else {
            setPendingDuplicateConversations(queuedConversations);
            setDuplicateSummary(duplicateCheck.duplicateSummary || null);
            setDuplicateWarningOpen(true);
            setRunLoading(false);
            setOperationStatus("paused");
            setRunError("Audit paused. Duplicate decision required.");
            addLog(
              `${formatNumber(duplicateCount)} duplicate conversation(s) need a decision.`,
              "warning"
            );
            return;
          }
        }
      }

      batches = splitIntoBatches(queuedConversations, AUDIT_BATCH_SIZE);

      if (activeWorkflowRunId) {
        await postWorkflowAction(
          "audit_started",
          {
            run_id: activeWorkflowRunId,
            queuedCount: queuedConversations.length,
            totalBatches: batches.length,
            duplicateMode: modeToUse || "none",
          },
          { quiet: true }
        );
      }

      setAuditProgress({
        handled: 0,
        total: queuedConversations.length,
        batchIndex: 1,
        totalBatches: batches.length,
        percent: 5,
        savedRows: 0,
        skippedRows: 0,
        failedRows: 0,
        label: "Starting Batch Audit",
        detail: `${formatNumber(batches.length)} batch(es) created. ${formatNumber(
          AUDIT_BATCH_SIZE
        )} conversation(s) per batch.`,
      });

      for (let index = 0; index < batches.length; index += 1) {
        if (cancelRequestedRef.current) {
          throw new Error("Audit cancelled by user.");
        }

        const batchNumber = index + 1;
        const batch = batches[index];

        setAuditProgress({
          handled,
          total: queuedConversations.length,
          batchIndex: batchNumber,
          totalBatches: batches.length,
          percent: Math.max(6, Math.round((handled / queuedConversations.length) * 100)),
          savedRows: allResults.length,
          skippedRows: totalSkipped,
          failedRows: totalFailedRows,
          label: `Running Batch ${batchNumber} of ${batches.length}`,
          detail: `Auditing ${formatNumber(batch.length)} conversation(s) in this batch.`,
        });

        addLog(
          `Batch ${batchNumber}/${batches.length} started with ${formatNumber(batch.length)} conversation(s).`,
          "info"
        );

        if (activeWorkflowRunId) {
          await postWorkflowAction(
            "batch_started",
            {
              run_id: activeWorkflowRunId,
              batchIndex: batchNumber,
              totalBatches: batches.length,
              batchConversations: batch,
            },
            { quiet: true }
          );
        }

        const batchData = await runSingleBatch({
          batch,
          batchIndex: batchNumber,
          totalBatches: batches.length,
          totalCount: queuedConversations.length,
          duplicateMode: modeToUse,
        });

        const batchResults = Array.isArray(batchData?.results) ? batchData.results : [];
        allResults.push(...batchResults);

        if (batchData?.meta?.storedRunId) storedRunIds.push(batchData.meta.storedRunId);

        const skippedThisBatch = Number(batchData?.meta?.skippedCount || 0);
        const overwrittenThisBatch = Number(batchData?.meta?.overwrittenCount || 0);
        const mappedThisBatch = Number(batchData?.meta?.mappedCount || 0);
        const unmappedThisBatch = Number(batchData?.meta?.unmappedCount || 0);
        const batchErrorRows = batchResults.filter((item) => item?.error).length;

        totalSkipped += skippedThisBatch;
        totalOverwritten += overwrittenThisBatch;
        totalMapped += mappedThisBatch;
        totalUnmapped += unmappedThisBatch;
        totalFailedRows += batchErrorRows;

        handled += batch.length;

        setAuditProgress({
          handled: Math.min(handled, queuedConversations.length),
          total: queuedConversations.length,
          batchIndex: batchNumber,
          totalBatches: batches.length,
          percent: Math.min(100, Math.round((handled / queuedConversations.length) * 100)),
          savedRows: allResults.length,
          skippedRows: totalSkipped,
          failedRows: totalFailedRows,
          label: `Batch ${batchNumber} Saved`,
          detail: `${formatNumber(handled)} of ${formatNumber(
            queuedConversations.length
          )} conversation(s) handled. ${formatNumber(allResults.length)} result row(s) returned.`,
        });

        const skippedText = skippedThisBatch ? ` ${formatNumber(skippedThisBatch)} skipped.` : "";

        addLog(
          `Batch ${batchNumber}/${batches.length} saved. Handled ${formatNumber(handled)}/${formatNumber(
            queuedConversations.length
          )}.${skippedText}`,
          "success"
        );

        if (activeWorkflowRunId) {
          await postWorkflowAction(
            "batch_completed",
            {
              run_id: activeWorkflowRunId,
              batchIndex: batchNumber,
              totalBatches: batches.length,
              batchConversations: batch,
              handled,
              savedRows: allResults.length,
              skippedRows: totalSkipped,
              failedRows: totalFailedRows,
              mappedCount: totalMapped,
              unmappedCount: totalUnmapped,
              storedRunIds,
            },
            { quiet: true }
          );
        }
      }

      const finalData = {
        ok: true,
        message: "Batch audit completed successfully.",
        meta: {
          requestedBy: session?.user?.email || "",
          receivedCount: queuedConversations.length,
          handledCount: handled,
          auditedCount: allResults.length,
          successCount: allResults.filter((item) => !item?.error).length,
          errorCount: allResults.filter((item) => item?.error).length,
          duplicateModeApplied: modeToUse || "none",
          skippedCount: totalSkipped,
          overwrittenCount: totalOverwritten,
          mappedCount: totalMapped,
          unmappedCount: totalUnmapped,
          auditMode: "live_gpt_batch_client",
          storageStatus: "saved_to_supabase_in_batches",
          storedRunIds,
          batchSize: AUDIT_BATCH_SIZE,
          totalBatches: batches.length,
        },
        results: allResults,
      };

      setRunData(finalData);
      setRunSuccess(
        `Audit completed in ${formatNumber(batches.length)} batch(es). ${formatNumber(
          allResults.length
        )} result row(s) returned. ${formatNumber(totalSkipped)} skipped.`
      );
      setOperationStatus("completed");
      setAuditProgress({
        handled: queuedConversations.length,
        total: queuedConversations.length,
        batchIndex: batches.length,
        totalBatches: batches.length,
        percent: 100,
        savedRows: allResults.length,
        skippedRows: totalSkipped,
        failedRows: finalData.meta.errorCount,
        label: "Audit Completed",
        detail: "All batches finished. Completed batch results were saved to Results.",
      });

      if (activeWorkflowRunId) {
        await postWorkflowAction(
          "audit_completed",
          {
            run_id: activeWorkflowRunId,
            meta: finalData.meta,
          },
          { quiet: true }
        );
      }

      addLog("Batch audit completed successfully.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Audit run failed.";

      if (allResults.length || handled > 0) {
        const partialData = buildPartialRunData({
          queuedConversations,
          batches,
          allResults,
          storedRunIds,
          modeToUse,
          totalSkipped,
          totalOverwritten,
          totalMapped,
          totalUnmapped,
          handled,
          failedCount: totalFailedRows,
          partialReason: message,
        });

        setRunData(partialData);
        setRunSuccess(
          `Partial save available: ${formatNumber(allResults.length)} result row(s) returned before the run stopped.`
        );
      }

      if (error?.name === "AbortError") {
        setRunError("Audit cancelled. Completed batches may already be saved in Results.");
        setOperationStatus("cancelled");
        addLog("Audit request was aborted.", "warning");
      } else {
        setRunError(message);
        setOperationStatus(message.toLowerCase().includes("cancelled") ? "cancelled" : "failed");
        addLog(message, "danger");
      }

      if (activeWorkflowRunId) {
        await postWorkflowAction(
          message.toLowerCase().includes("cancelled") || error?.name === "AbortError"
            ? "workflow_cancelled"
            : "workflow_failed",
          {
            run_id: activeWorkflowRunId,
            message,
            error: message,
            metadata: {
              handled,
              savedRows: allResults.length,
              skippedRows: totalSkipped,
              failedRows: totalFailedRows,
            },
          },
          { quiet: true }
        );
      }

      setAuditProgress((prev) => ({
        ...prev,
        handled,
        total: queuedConversations.length,
        savedRows: allResults.length,
        skippedRows: totalSkipped,
        failedRows: totalFailedRows,
        label: message.toLowerCase().includes("cancelled") ? "Audit Cancelled" : "Audit Stopped",
        detail:
          allResults.length || handled
            ? `Stopped after handling ${formatNumber(handled)} of ${formatNumber(
                queuedConversations.length
              )} conversation(s). Completed batch results may already be saved.`
            : message,
      }));
    } finally {
      setRunLoading(false);
      setDuplicateDecisionLoading(false);
      runAbortRef.current = null;
    }
  }

  async function syncWorkflowQueue(nextConversations, reason = "Queue updated.") {
    if (!workflowRunId) return;
    try {
      await postWorkflowAction(
        "update_queue",
        {
          run_id: workflowRunId,
          conversations: nextConversations,
          fetchedCount: nextConversations.length,
          reason,
        },
        { quiet: true }
      );
    } catch (error) {
      addLog("Queue updated locally, but database queue sync failed. Refresh may restore older queue.", "warning");
    }
  }

  function applyQueueUpdate(nextConversations, message) {
    const safeList = Array.isArray(nextConversations) ? nextConversations : [];
    setFetchData((prev) => ({
      ...(prev || {}),
      ok: true,
      conversations: safeList,
      meta: {
        ...(prev?.meta || {}),
        fetchedCount: safeList.length,
      },
    }));
    setSelectedQueueIds([]);
    addLog(message, "notice");
    syncWorkflowQueue(safeList, message);
  }

  function toggleQueueSelection(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return;
    setSelectedQueueIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  }

  function toggleAllVisibleQueueSelection() {
    const visibleIds = visibleFetchedQueue.map(conversationIdOf).filter(Boolean);
    if (!visibleIds.length) return;
    if (allVisibleQueueSelected) {
      setSelectedQueueIds((prev) => prev.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelectedQueueIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
  }

  function performRemoveSelectedFromQueue() {
    if (!selectedQueueIds.length) return;
    const selected = new Set(selectedQueueIds);
    const nextConversations = fetchedConversations.filter((item) => !selected.has(conversationIdOf(item)));
    applyQueueUpdate(nextConversations, formatNumber(selectedQueueIds.length) + " selected conversation(s) removed from the audit queue.");
  }

  function performClearFetchedQueue() {
    if (!fetchedConversations.length) return;
    applyQueueUpdate([], "Fetched Queue cleared. Fetch again to rebuild the audit queue.");
  }

  function removeSelectedFromQueue() {
    if (!selectedQueueIds.length) return;

    openSafetyConfirmation({
      action: "remove_selected",
      tone: "warning",
      badge: "Remove Selected?",
      title: "Remove Selected Conversations?",
      countLabel: formatNumber(selectedQueueIds.length),
      message:
        "These conversations will be removed from the current audit queue before the audit runs. This does not delete Intercom conversations or stored Results rows.",
      details: [
        { label: "Selected", value: `${formatNumber(selectedQueueIds.length)} conversation(s)`, helper: "Only selected queue rows will be removed." },
        { label: "Queue After Removal", value: `${formatNumber(Math.max(0, fetchedConversations.length - selectedQueueIds.length))} conversation(s)`, helper: workflowRunId ? "The database-backed queue will be synced." : "This update will apply locally." },
      ],
      note: "Use this when you want to skip specific fetched conversations from the next audit.",
      confirmText: "Remove Selected",
      cancelText: "Keep Queue",
    });
  }

  function clearFetchedQueue() {
    if (!fetchedConversations.length) return;

    openSafetyConfirmation({
      action: "clear_queue",
      tone: "danger",
      badge: "Clear Queue?",
      title: "Clear The Fetched Queue?",
      countLabel: formatNumber(fetchedConversations.length),
      message:
        "This will remove every fetched conversation currently shown in the Run Audit Queue. You will need to fetch again to rebuild the queue.",
      details: [
        { label: "Fetched Queue", value: `${formatNumber(fetchedConversations.length)} conversation(s)`, helper: "All queued rows will be removed from this workflow view." },
        { label: "Audit Queue", value: `${formatNumber(queuedConversationCount)} conversation(s)`, helper: "No Intercom data or existing Results rows are deleted." },
      ],
      note: "This is useful before changing filters, but avoid clearing if you still need this queue for the next audit.",
      confirmText: "Clear Queue",
      cancelText: "Keep Queue",
    });
  }

  async function handleFetchConversations() {
    const canResumeExistingFetch = Boolean(
      workflowRun?.id &&
        workflowRun?.status === "fetching" &&
        workflowRun?.safe_payload?.fetch_pagination?.fetchState
    );

    if (!canResumeExistingFetch) {
      const confirmation = buildLargeFetchConfirmation();
      if (confirmation) {
        openSafetyConfirmation(confirmation);
        return;
      }
    }

    await executeFetchConversations();
  }

  async function executeFetchConversations() {
    const restoreCandidateFetchData = fetchData;
    const restoreCandidateWorkflowRun = workflowRun;
    const restoreCandidateWorkflowRunId = workflowRunId;
    const canResumeExistingFetch = Boolean(
      restoreCandidateWorkflowRun?.id &&
        restoreCandidateWorkflowRun?.status === "fetching" &&
        restoreCandidateWorkflowRun?.safe_payload?.fetch_pagination?.fetchState
    );

    setFetchError("");
    setFetchSuccess("");
    setFetchData(canResumeExistingFetch ? restoreCandidateFetchData : null);
    setRunData(null);
    setRunError("");
    setRunSuccess("");
    setShowAllResults(false);
    setDuplicateWarningOpen(false);
    setDuplicateSummary(null);
    setDuplicateDecisionLoading(false);
    setPendingDuplicateConversations([]);

    if (!startDate || !endDate) {
      setFetchError("Please choose both a start date and an end date.");
      return;
    }

    if (limiterEnabled) {
      const parsedLimit = Number(limitCount);
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
        setFetchError("Please enter a valid limiter number greater than 0.");
        return;
      }
    }

    let accessToken = "";

    try {
      accessToken = await getFreshAccessToken();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Your login session is missing. Please sign in again.";
      setFetchError(message);
      setAuthMessage(message);
      addLog(message, "danger");
      return;
    }

    const controller = new AbortController();
    fetchAbortRef.current = controller;
    cancelRequestedRef.current = false;

    setFetchLoading(true);
    setFetchStartedAt(Date.now());
    setFetchStepIndex(0);
    setOperationStatus("fetching");

    addLog(
      canResumeExistingFetch
        ? `Resuming paginated fetch for ${startDate} to ${endDate}.`
        : `Paginated fetch started for ${startDate} to ${endDate}.`,
      "info"
    );

    let activeWorkflowRunId = "";
    let fetchState = canResumeExistingFetch
      ? restoreCandidateWorkflowRun?.safe_payload?.fetch_pagination?.fetchState || null
      : null;
    let accumulatedConversations = canResumeExistingFetch && Array.isArray(restoreCandidateFetchData?.conversations)
      ? [...restoreCandidateFetchData.conversations]
      : [];
    let pageRound = 0;

    try {
      if (canResumeExistingFetch) {
        activeWorkflowRunId = restoreCandidateWorkflowRunId || restoreCandidateWorkflowRun?.id || "";
        setWorkflowRunId(activeWorkflowRunId);
      } else {
        const workflowStart = await postWorkflowAction(
          "start_workflow",
          {
            startDate,
            endDate,
            limiterEnabled,
            limitCount: limiterEnabled ? limitCount : null,
            autoRunAfterFetch,
            batchSize: AUDIT_BATCH_SIZE,
            selectedDatePreset,
            filters: {
              conversationRatings,
              supervisorTeamIds: selectedSupervisorTeamIds,
              employeeNames: selectedEmployeeNames,
              intercomAgentNames: selectedIntercomAgentNames,
              fetchMode: "paginated",
            },
          },
          { quiet: false }
        );

        activeWorkflowRunId = workflowStart?.run?.id || "";
        if (activeWorkflowRunId) {
          setWorkflowRunId(activeWorkflowRunId);
          addLog("Database-backed paginated workflow record created.", "success");
        }
      }

      let done = false;
      const maxClientPages = 400;

      while (!done) {
        if (cancelRequestedRef.current) {
          const abortError = new Error("Fetch cancelled.");
          abortError.name = "AbortError";
          throw abortError;
        }

        pageRound += 1;
        if (pageRound > maxClientPages) {
          throw new Error("Paginated fetch stopped for safety after too many pages. Narrow the date range or filters and try again.");
        }

        const response = await fetch("/api/audits/fetch-page", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            startDate,
            endDate,
            limiterEnabled,
            limitCount,
            conversationRatings,
            supervisorTeamIds: selectedSupervisorTeamIds,
            employeeNames: selectedEmployeeNames,
            intercomAgentNames: selectedIntercomAgentNames,
            fetchState,
            alreadyFetchedCount: accumulatedConversations.length,
          }),
          signal: controller.signal,
          cache: "no-store",
        });

        const pageData = await readJsonSafely(response);

        if (!response.ok || !pageData?.ok) {
          throw new Error(pageData?.error || "Paginated conversation fetch failed.");
        }

        const pageConversations = Array.isArray(pageData.conversations) ? pageData.conversations : [];
        const knownIds = new Set(accumulatedConversations.map((item) => conversationIdOf(item)).filter(Boolean));
        const newConversations = pageConversations.filter((item) => {
          const id = conversationIdOf(item);
          if (!id || knownIds.has(id)) return false;
          knownIds.add(id);
          return true;
        });

        accumulatedConversations = [...accumulatedConversations, ...newConversations];
        fetchState = pageData.fetchState || fetchState;
        done = Boolean(pageData.done);

        const fetchedCount = accumulatedConversations.length;
        const mergedFetchData = {
          ok: true,
          message: done
            ? fetchedCount
              ? "Paginated fetch completed."
              : "Fetch completed with no conversations found."
            : "Paginated fetch is still running.",
          meta: {
            ...(pageData.meta || {}),
            startDate,
            endDate,
            fetchedCount,
            paginated: true,
            done,
            pageRound,
          },
          conversations: accumulatedConversations,
          debug: pageData.debug,
        };

        setFetchData(mergedFetchData);
        setSelectedQueueIds([]);
        setQueueSearchText("");
        setFetchStepIndex(done ? FETCH_STEPS.length - 1 : Math.min(FETCH_STEPS.length - 2, 1));
        setFetchSuccess(
          done
            ? `${formatNumber(fetchedCount)} filtered conversation(s) fetched.`
            : `${formatNumber(fetchedCount)} conversation(s) fetched so far. Still paging through Intercom...`
        );

        if (activeWorkflowRunId) {
          await postWorkflowAction(
            "fetch_page_saved",
            {
              run_id: activeWorkflowRunId,
              conversations: newConversations,
              fetchedCount,
              done,
              fetchState,
              meta: mergedFetchData.meta,
            },
            { quiet: true }
          );
        }

        const pageCount = Number(pageData?.meta?.processedPagesTotal || pageRound || 0);
        if (newConversations.length || done || pageRound % 5 === 0) {
          addLog(
            done
              ? `Paginated fetch completed with ${formatNumber(fetchedCount)} conversation(s).`
              : `Fetch page ${formatNumber(pageCount)} saved. ${formatNumber(fetchedCount)} conversation(s) found so far.`,
            newConversations.length ? "success" : "notice"
          );
        }

        if (limiterEnabled && fetchedCount >= Number(limitCount || 0)) {
          done = true;
        }

        if (!done) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }

      const fetchedCount = accumulatedConversations.length;

      if (fetchedCount > 0) {
        setFetchSuccess(`${formatNumber(fetchedCount)} filtered conversation(s) fetched.`);
        setOperationStatus("fetched");
        addLog(`${formatNumber(fetchedCount)} conversation(s) fetched and saved to the audit queue.`, "success");
      } else {
        setFetchSuccess("Fetch completed with no conversations found.");
        setOperationStatus("completed");
        addLog("Fetch completed with no conversations found.", "neutral");
      }

      setFetchLoading(false);
      fetchAbortRef.current = null;

      if (autoRunAfterFetch && fetchedCount > 0) {
        addLog("Auto-Run enabled. Starting batch audit automatically after paginated fetch.", "success");
        await startBatchAudit({
          conversationsOverride: accumulatedConversations,
          duplicateMode: "",
          autoTriggered: true,
          workflowRunIdOverride: activeWorkflowRunId,
        });
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        setFetchError("Fetch cancelled.");
        addLog("Fetch request was aborted.", "warning");
        setOperationStatus("cancelled");
      } else {
        const message = error instanceof Error ? error.message : "Paginated conversation fetch failed.";
        setFetchError(message);
        addLog(message, "danger");
        setOperationStatus("failed");
      }

      if (activeWorkflowRunId) {
        await postWorkflowAction(
          error?.name === "AbortError" ? "workflow_cancelled" : "workflow_failed",
          {
            run_id: activeWorkflowRunId,
            message: error?.name === "AbortError" ? "Fetch cancelled." : error instanceof Error ? error.message : "Paginated conversation fetch failed.",
            error: error instanceof Error ? error.message : "Paginated conversation fetch failed.",
            metadata: { stage: "paginated_fetch", fetchState },
          },
          { quiet: true }
        );
      }
    } finally {
      setFetchLoading(false);
      fetchAbortRef.current = null;
    }
  }


  async function handleRunAudit() {
    const queueCount = queuedConversationCount || getQueuedConversations(fetchedConversations).length;

    if (queueCount >= LARGE_QUEUE_CONFIRM_THRESHOLD) {
      openSafetyConfirmation({
        action: "run_large_audit",
        tone: "warning",
        badge: "Large Audit Queue",
        title: "Run Audit on a Large Queue?",
        countLabel: formatNumber(queueCount),
        message:
          "This audit will process a large queue in batches. It may take several minutes, and completed batches may be saved to Results even if the run is later cancelled.",
        details: [
          { label: "Audit Queue", value: `${formatNumber(queueCount)} conversation(s)`, helper: `${formatNumber(AUDIT_BATCH_SIZE)} conversation(s) per batch.` },
          { label: "Estimated Batches", value: formatNumber(Math.ceil(queueCount / AUDIT_BATCH_SIZE)), helper: "Progress updates after each batch finishes." },
          { label: "Duplicate Handling", value: "Checked Before Audit", helper: "Manual runs pause if existing Results rows are detected." },
        ],
        note: "Use Run Audit only when this queue is ready. You can remove selected conversations before starting.",
        confirmText: "Run Audit",
        cancelText: "Review Queue",
      });
      return;
    }

    await executeRunAudit();
  }

  async function executeRunAudit() {
    await startBatchAudit({ duplicateMode: "", autoTriggered: false });
  }

  async function handleDuplicateSkip() {
    if (duplicateDecisionLoading) return;

    setDuplicateDecisionLoading(true);
    setDuplicateWarningOpen(false);
    setRunError("");
    addLog("Manual duplicate choice: skip existing.", "notice");

    await startBatchAudit({
      conversationsOverride: pendingDuplicateConversations,
      duplicateMode: "skip_existing",
      autoTriggered: false,
    });
  }

  async function handleDuplicateOverwrite() {
    if (duplicateDecisionLoading) return;

    setDuplicateDecisionLoading(true);
    setDuplicateWarningOpen(false);
    setRunError("");
    addLog("Manual duplicate choice: overwrite existing.", "warning");

    await startBatchAudit({
      conversationsOverride: pendingDuplicateConversations,
      duplicateMode: "overwrite_existing",
      autoTriggered: false,
    });
  }

  function handleDuplicateCancel() {
    setDuplicateWarningOpen(false);
    setDuplicateSummary(null);
    setDuplicateDecisionLoading(false);
    setRunError("Audit paused. Duplicate conversations need your decision.");
    setOperationStatus("paused");
    addLog("Duplicate decision modal cancelled.", "warning");
  }

  const summaryText = useMemo(() => {
    if (authLoading) return "Checking access.";
    if (!session?.user) return "Sign in to continue.";
    if (profile && !canRunTests) return "This account does not have test-run access.";
    if (fetchLoading) return FETCH_STEPS[fetchStepIndex] || "Fetching.";
    if (runLoading) return auditProgress.detail;
    if (operationStatus === "cancelled") return "The current operation was cancelled.";
    if (operationStatus === "paused") return "Audit is paused and needs your duplicate decision.";
    if (operationStatus === "failed") return "The last operation needs your attention.";
    if (runData?.partial) {
      return `Partial run: ${formatNumber(runData.meta?.auditedCount || 0)} result row(s) returned before the run stopped.`;
    }
    if (runData?.meta?.auditedCount >= 0) {
      return `Latest audit processed ${formatNumber(runData.meta.auditedCount)} result row(s).`;
    }
    if (fetchData?.meta?.fetchedCount > 0) {
      return `${formatNumber(fetchData.meta.fetchedCount)} conversation(s) are ready for audit.`;
    }
    if (startDate && endDate) {
      return limiterEnabled
        ? `Ready to fetch up to ${formatNumber(limitCount || 0)} conversation(s) from ${startDate} to ${endDate}.`
        : `Ready to fetch all eligible conversations from ${startDate} to ${endDate}.`;
    }
    return "Choose a date range to begin.";
  }, [
    authLoading,
    session,
    profile,
    canRunTests,
    fetchLoading,
    runLoading,
    operationStatus,
    auditProgress,
    runData,
    fetchData,
    startDate,
    endDate,
    limiterEnabled,
    limitCount,
    fetchStepIndex,
  ]);

  const operationLabel = getOperationLabel(
    operationStatus,
    fetchLoading,
    runLoading,
    duplicateWarningOpen
  );
  const operationTone = getOperationTone(
    fetchLoading ? "fetching" : runLoading ? "auditing" : duplicateWarningOpen ? "paused" : operationStatus
  );

  const statCards = [
    {
      label: "Fetched Queue",
      value: fetchData?.meta?.fetchedCount ? formatNumber(fetchData.meta.fetchedCount) : "0",
      subtext: "Conversations returned from Intercom",
      tone: fetchData?.meta?.fetchedCount ? "success" : "neutral",
    },
    {
      label: "Audit Queue",
      value: queuedConversationCount ? formatNumber(queuedConversationCount) : "0",
      subtext: limiterEnabled ? "Conversations ready after limiter" : "Conversations ready to audit",
      tone: queuedConversationCount ? "notice" : "neutral",
    },
    {
      label: "Completed rows",
      value: runData?.meta?.auditedCount ? formatNumber(runData.meta.auditedCount) : "0",
      subtext: runData?.partial ? "Partial saved rows" : "Rows returned from latest run",
      tone: runData?.meta?.auditedCount ? (runData?.partial ? "warning" : "success") : "neutral",
    },
    {
      label: "Auto-Run",
      value: autoRunAfterFetch ? "On" : "Off",
      subtext: autoRunAfterFetch ? "Starts after fetch finishes" : "Manual audit start",
      tone: autoRunAfterFetch ? "success" : "neutral",
    },
  ];

  const workflowStatus = {
    setup: startDate && endDate ? "done" : "active",
    fetch: fetchData?.meta?.fetchedCount > 0 ? "done" : fetchLoading ? "active" : "idle",
    review:
      duplicateWarningOpen || queuedConversationCount > 0 || runLoading || runData ? "active" : "idle",
    run: runData?.meta?.auditedCount > 0 ? "done" : runLoading ? "active" : "idle",
  };

  function buildLargeFetchConfirmation() {
    const dayCount = getDateRangeDayCount(startDate, endDate);
    const parsedLimit = Number(limitCount);
    const limiterOff = !limiterEnabled;
    const highLimit = limiterEnabled && Number.isFinite(parsedLimit) && parsedLimit > LARGE_FETCH_LIMIT_THRESHOLD;
    const anyRating = !conversationRatings.length;
    const allAgents = !selectedSupervisorTeamIds.length && !selectedEmployeeNames.length && !selectedIntercomAgentNames.length;
    const longRange = dayCount >= LARGE_FETCH_RANGE_DAYS;

    if (!(limiterOff || highLimit) || !(longRange || anyRating || allAgents)) {
      return null;
    }

    return {
      action: "large_fetch",
      tone: "warning",
      badge: "Large Fetch Detected",
      title: "Large Fetch Detected",
      countLabel: limiterOff ? "All" : formatNumber(parsedLimit),
      message:
        "This may fetch a high number of Intercom conversations and take several minutes. You can cancel anytime, but this may create a large audit queue.",
      details: [
        { label: "Date Range", value: `${startDate} to ${endDate}`, helper: dayCount ? `${formatNumber(dayCount)} day(s) selected` : "Custom range selected" },
        { label: "Limiter", value: limiterOff ? "Off" : `Up to ${formatNumber(parsedLimit)} conversation(s)`, helper: limiterOff ? "All eligible conversations can be fetched." : "High limit selected." },
        { label: "Ratings", value: anyRating ? "Any Rating" : describeSelection(conversationRatings, "Any Rating"), helper: anyRating ? "The rating filter is broad." : "Using selected conversation ratings." },
        { label: "Agent Scope", value: allAgents ? "All Employees" : selectedFilterSummary.employees, helper: allAgents ? "No Employee, Intercom Agent, or Supervisor Team filter is narrowing this fetch." : selectedFilterSummary.agents },
        { label: "Auto-Run", value: autoRunAfterFetch ? "On" : "Off", helper: autoRunAfterFetch ? "Audit will start automatically after fetch completes." : "Audit will wait for a manual start." },
      ],
      note: "Use Start Fetch only when this broad range is intentional. Choose Go Back to narrow the date range, enable the limiter, or select a team/employee first.",
      confirmText: "Start Fetch",
      cancelText: "Go Back",
    };
  }

  function openSafetyConfirmation(config) {
    setSafetyConfirmation({ ...config, openedAt: Date.now() });
  }

  function closeSafetyConfirmation() {
    setSafetyConfirmation(null);
  }

  async function handleSafetyConfirmationConfirm() {
    const confirmation = safetyConfirmation;
    if (!confirmation?.action) return;

    setSafetyConfirmation(null);

    if (confirmation.action === "large_fetch") {
      await executeFetchConversations();
      return;
    }

    if (confirmation.action === "remove_selected") {
      performRemoveSelectedFromQueue();
      return;
    }

    if (confirmation.action === "clear_queue") {
      performClearFetchedQueue();
      return;
    }

    if (confirmation.action === "cancel_fetch") {
      if (fetchLoading) performCancelFetch();
      return;
    }

    if (confirmation.action === "cancel_audit") {
      if (runLoading) performCancelAudit();
      return;
    }

    if (confirmation.action === "run_large_audit") {
      await executeRunAudit();
    }
  }

  return (
    <main className="run-page">
      <style>{runStyles}</style>

      <DuplicateWarningModal
        open={duplicateWarningOpen}
        duplicateSummary={duplicateSummary}
        processing={duplicateDecisionLoading}
        onCancel={handleDuplicateCancel}
        onSkip={handleDuplicateSkip}
        onOverwrite={handleDuplicateOverwrite}
      />

      <SafetyConfirmationModal
        confirmation={safetyConfirmation}
        onCancel={closeSafetyConfirmation}
        onConfirm={handleSafetyConfirmationConfirm}
      />

      <section className="run-intro-strip surface-card">
        <div>
          <span className="mini-label">Run Audit</span>
          <h1>Setup and Controls</h1>
          <p>{summaryText}</p>
        </div>
        <div className="run-intro-meta">
          <span className={`state-pill ${operationTone}`}>{operationLabel}</span>
          <strong>{startDate && endDate ? `${startDate} to ${endDate}` : "Choose Date Range"}</strong>
          <small>{selectedPresetLabel} · Auto-Run {autoRunAfterFetch ? "On" : "Off"}</small>
        </div>
      </section>

      <section className="surface-card quick-run-panel">
        <div className="quick-run-copy">
          <span className="mini-label">Quick Actions</span>
          <strong>{queuedConversationCount ? `${formatNumber(queuedConversationCount)} Ready For Audit` : "Ready To Fetch"}</strong>
          <small>{startDate && endDate ? `${startDate} to ${endDate}` : "Choose an audit range first"} · {selectedFilterSummary.conversationRatings} · {selectedFilterSummary.employees}</small>
        </div>

        <div className="quick-run-metrics">
          <div><span>Fetched</span><strong>{formatNumber(fetchedConversations.length)}</strong></div>
          <div><span>Queued</span><strong>{formatNumber(queuedConversationCount)}</strong></div>
          <div><span>Saved</span><strong>{formatNumber(runData?.meta?.auditedCount || 0)}</strong></div>
        </div>

        <div className="quick-run-actions">
          {!fetchLoading ? (
            <button
              type="button"
              className="primary-btn"
              onClick={handleFetchConversations}
              disabled={!canRunTests || !session?.user || !startDate || !endDate || runLoading}
            >
              Fetch Conversations
            </button>
          ) : (
            <button type="button" className="danger-btn" onClick={handleCancelFetch}>
              Cancel Fetch
            </button>
          )}

          {!runLoading ? (
            <button
              type="button"
              className="secondary-btn"
              onClick={handleRunAudit}
              disabled={fetchLoading || !fetchedConversations.length}
            >
              Run Audit
            </button>
          ) : (
            <button type="button" className="danger-btn" onClick={handleCancelAudit}>
              Cancel Audit
            </button>
          )}
        </div>
      </section>

      <section className="command-grid">
        <div className="surface-card command-card">
          <div className="section-head">
            <div>
              <span className="mini-label">Command Center</span>
              <h2>Setup and Controls</h2>
            </div>
            <button
              type="button"
              className={autoRunAfterFetch ? "toggle-chip on" : "toggle-chip"}
              onClick={toggleAutoRun}
            >
              <span />
              {autoRunAfterFetch ? "Auto-Run enabled" : "Auto-Run after fetch"}
            </button>
          </div>

          <div className="auth-shell-card">
            <div>
              <span className="mini-label">Session</span>
              <strong>
                {authLoading ? "Checking session" : session?.user?.email || "Not signed in"}
              </strong>
              <small>
                {authLoading
                  ? "Please wait"
                  : canRunTests
                  ? "This account can run audits"
                  : "This account cannot run audits"}
              </small>
            </div>
            <div className={`access-badge ${canRunTests ? "success" : "danger"}`}>
              {canRunTests ? "Allowed" : "Locked"}
            </div>
          </div>

          {authMessage ? <div className="message error subtle">{authMessage}</div> : null}

          <div className="control-section-grid">
            <div className="control-block">
              <div className="block-head">
                <span className="mini-label">Step 1</span>
                <h3>Choose the Audit Range</h3>
              </div>

              <RunDateRangePicker
                startDate={startDate}
                endDate={endDate}
                selectedDatePreset={selectedDatePreset}
                selectedPresetLabel={selectedPresetLabel}
                onApplyPreset={applyDatePreset}
                onApplyCustom={applyCustomDateRange}
              />
            </div>

            <div className="control-block filter-control-block">
              <div className="block-head">
                <span className="mini-label">Step 2</span>
                <h3>Choose Fetch Filters</h3>
                <small>These filters control which Intercom conversations are fetched before the GPT audit starts.</small>
              </div>

              <div className="filter-control-grid">
                <MultiSelectFilter
                  label="Conversation Rating"
                  options={SCORE_FILTER_OPTIONS}
                  selected={conversationRatings}
                  onChange={(value) => {
                    setConversationRatings(value);
                    resetRunStateForInputChange();
                  }}
                  placeholder="Any Rating"
                  helper="Default: 3, 4, and 5. Clear selection to fetch any rating."
                />
                <MultiSelectFilter
                  label="Supervisor Team"
                  options={supervisorTeamFilterOptions}
                  selected={selectedSupervisorTeamIds}
                  onChange={applySupervisorTeamFilterSelection}
                  placeholder="All Supervisor Teams"
                  helper="Selecting one or more Supervisor Teams auto-selects their mapped employees and Intercom agents."
                />
                <MultiSelectFilter
                  label="Employee"
                  options={employeeFilterOptions}
                  selected={selectedEmployeeNames}
                  onChange={applyEmployeeFilterSelection}
                  placeholder="All Employees"
                  helper="Pulled from active Admin Agent Mappings. Selecting employees auto-selects their Intercom agents."
                />
                <MultiSelectFilter
                  label="Intercom Agent"
                  options={intercomAgentFilterOptions}
                  selected={selectedIntercomAgentNames}
                  onChange={applyIntercomAgentFilterSelection}
                  placeholder="All Intercom Agents"
                  helper="Selecting Intercom agents updates the matching Employee filter."
                />
              </div>

              <div className="filter-summary-grid">
                <div><span>Conversation Rating</span><strong>{selectedFilterSummary.conversationRatings}</strong></div>
                <div><span>Supervisor Teams</span><strong>{selectedFilterSummary.supervisorTeams}</strong></div>
                <div><span>Employees</span><strong>{selectedFilterSummary.employees}</strong></div>
                <div><span>Intercom Agents</span><strong>{selectedFilterSummary.agents}</strong></div>
              </div>

              {mappingFilterLoading ? <div className="message subtle">Loading active Agent Mappings...</div> : null}
              {mappingFilterError ? <div className="message error subtle">{mappingFilterError}</div> : null}
            </div>

            <div className="control-block">
              <div className="block-head">
                <span className="mini-label">Step 3</span>
                <h3>Set Run Behavior</h3>
              </div>


              <div className="behavior-grid">
                <div className="behavior-card">
                  <div className="behavior-row">
                    <div>
                      <span className="mini-label">Limiter</span>
                      <strong>{limiterEnabled ? "Enabled" : "Disabled"}</strong>
                    </div>
                    <button
                      type="button"
                      className={limiterEnabled ? "switch on" : "switch"}
                      onClick={() => {
                        setLimiterEnabled((prev) => !prev);
                        resetRunStateForInputChange();
                      }}
                    >
                      <span />
                    </button>
                  </div>

                  {limiterEnabled ? (
                    <label>
                      <span>Conversation Limit</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={limitCount}
                        onChange={(event) => {
                          setLimitCount(event.target.value);
                          resetRunStateForInputChange();
                        }}
                        placeholder="Enter number"
                      />
                    </label>
                  ) : (
                    <small className="behavior-copy">
                      All eligible conversations in the selected range will be fetched.
                    </small>
                  )}
                </div>

                <div
                  className={autoRunAfterFetch ? "behavior-card interactive active" : "behavior-card interactive"}
                  role="button"
                  tabIndex={0}
                  onClick={toggleAutoRun}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleAutoRun();
                    }
                  }}
                >
                  <div className="behavior-row">
                    <div>
                      <span className="mini-label">Auto-Run</span>
                      <strong>{autoRunAfterFetch ? "Enabled" : "Disabled"}</strong>
                    </div>
                    <button
                      type="button"
                      className={autoRunAfterFetch ? "switch on" : "switch"}
                      aria-label="Toggle auto-run after fetch"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleAutoRun();
                      }}
                    >
                      <span />
                    </button>
                  </div>

                  <small className="behavior-copy">
                    Click this card to turn auto-run on or off. When enabled, the audit starts automatically after fetch.
                  </small>
                </div>
              </div>
            </div>

            <div className="control-block action-block">
              <div className="block-head">
                <span className="mini-label">Step 4</span>
                <h3>Run the Workflow</h3>
              </div>

              <div className="action-summary-grid">
                <div>
                  <span className="mini-label">Fetched Queue</span>
                  <strong>{formatNumber(fetchedConversations.length)}</strong>
                </div>
                <div>
                  <span className="mini-label">Audit Queue</span>
                  <strong>{formatNumber(queuedConversationCount)}</strong>
                </div>
                <div>
                  <span className="mini-label">Duplicate Handling</span>
                  <strong>
                    {duplicateWarningOpen
                      ? "Decision needed"
                      : autoRunAfterFetch
                      ? "Auto decision"
                      : "Ask before audit"}
                  </strong>
                  <small>
                    {autoRunAfterFetch
                      ? "Auto-Run applies the safe duplicate rule."
                      : "Manual runs pause only if duplicates are found."}
                  </small>
                </div>
              </div>

              <div className="button-row large">
                {!fetchLoading ? (
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={handleFetchConversations}
                    disabled={!canRunTests || !session?.user || !startDate || !endDate || runLoading}
                  >
                    Fetch Conversations
                  </button>
                ) : (
                  <button type="button" className="danger-btn" onClick={handleCancelFetch}>
                    Cancel Fetch
                  </button>
                )}

                {!runLoading ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={handleRunAudit}
                    disabled={fetchLoading || !fetchedConversations.length}
                  >
                    Run Audit
                  </button>
                ) : (
                  <button type="button" className="danger-btn" onClick={handleCancelAudit}>
                    Cancel Audit
                  </button>
                )}
              </div>
            </div>
          </div>

          {(fetchError || fetchSuccess || runError || runSuccess) ? (
            <div className="message-stack">
              {fetchError ? <div className="message error">{fetchError}</div> : null}
              {fetchSuccess ? <div className="message success">{fetchSuccess}</div> : null}
              {runError ? <div className="message error">{runError}</div> : null}
              {runSuccess ? <div className="message success">{runSuccess}</div> : null}
            </div>
          ) : null}
        </div>

        <div className="monitor-column">
          <div className="surface-card monitor-card">
            <div className="section-head compact alt">
              <div>
                <span className="mini-label">Live Monitor</span>
                <h2>Progress and System Feedback</h2>
              </div>
              <span className={`state-pill ${operationTone}`}>{operationLabel}</span>
            </div>

            {fetchLoading ? (
              <ProgressPanel
                type="Fetch progress"
                label={FETCH_STEPS[fetchStepIndex] || "Fetching"}
                detail="Fetching and hydrating Intercom conversations that match the selected filters."
                percent={Math.min(96, ((fetchStepIndex + 1) / FETCH_STEPS.length) * 100)}
                elapsed={formatElapsed(fetchStartedAt)}
                handled={0}
                total={0}
                batchIndex={0}
                totalBatches={0}
                savedRows={0}
                skippedRows={0}
                failedRows={0}
                onCancel={handleCancelFetch}
              />
            ) : null}

            {runLoading ? (
              <>
                <div className="ai-working-inline"><span className="gear-loader" /> AI audit engine is working through the selected queue.</div>
                <ProgressPanel
                type="Audit progress"
                label={auditProgress.label}
                detail={auditProgress.detail}
                percent={auditProgress.percent}
                elapsed={formatElapsed(runStartedAt)}
                handled={auditProgress.handled}
                total={auditProgress.total}
                batchIndex={auditProgress.batchIndex}
                totalBatches={auditProgress.totalBatches}
                savedRows={auditProgress.savedRows}
                skippedRows={auditProgress.skippedRows}
                failedRows={auditProgress.failedRows}
                onCancel={handleCancelAudit}
              />
              </>
            ) : null}

            {!fetchLoading && !runLoading ? (
              <div className="resting-panel">
                <div className="resting-icon-wrap">
                  <SparklesIcon />
                </div>
                <div>
                  <strong>{operationLabel}</strong>
                  <p>{summaryText}</p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="surface-card run-summary-card">
            <div className="section-head compact alt">
              <div>
                <span className="mini-label">Run Summary</span>
                <h2>At a Glance</h2>
              </div>
            </div>

            <div className="mini-grid polished">
              <div>
                <span>Fetched</span>
                <strong>{formatNumber(fetchData?.meta?.fetchedCount || 0)}</strong>
              </div>
              <div>
                <span>Queued</span>
                <strong>{formatNumber(queuedConversationCount || 0)}</strong>
              </div>
              <div>
                <span>Handled</span>
                <strong>{formatNumber(runData?.meta?.handledCount || 0)}</strong>
              </div>
              <div>
                <span>Saved</span>
                <strong>{formatNumber(runData?.meta?.auditedCount || 0)}</strong>
              </div>
              <div>
                <span>Skipped</span>
                <strong>{formatNumber(runData?.meta?.skippedCount || 0)}</strong>
              </div>
              <div>
                <span>Errors</span>
                <strong>{formatNumber(errorCount || 0)}</strong>
              </div>
            </div>
          </div>

          <div className="surface-card log-panel">
            <div className="section-head compact alt">
              <div>
                <span className="mini-label">Execution log</span>
                <h2>Recent Activity</h2>
              </div>
              <button type="button" className="ghost-btn small" onClick={() => setExecutionLog([])}>
                Clear log
              </button>
            </div>

            {executionLog.length ? (
              <div className="log-list">
                {executionLog.map((item) => (
                  <div key={item.id} className={`log-item ${item.tone}`}>
                    <span>{item.time}</span>
                    <strong>{item.message}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-box small">No activity yet.</div>
            )}
          </div>
        </div>
      </section>

      <section className="stats-grid compact-run-stats">
        {statCards.map((card) => (
          <article key={card.label} className={`stat-card ${card.tone}`}>
            <p>{card.label}</p>
            <strong>{card.value}</strong>
            <span>{card.subtext}</span>
          </article>
        ))}
      </section>

      <section className="surface-card preview-panel fetched-queue-panel compact-preview-panel">
        <div className="section-head">
          <div>
            <span className="mini-label">Fetched Conversation Preview</span>
            <h2>Fetched Queue</h2>
            <p className="soft-copy">Review, preview, remove, or skip conversations before starting the GPT audit.</p>
          </div>
          <div className="header-right-meta">
            <span className="count-pill">{formatNumber(fetchedConversations.length)} fetched</span>
            <span className="count-pill muted">{formatNumber(queuedConversationCount)} in audit queue</span>
            <span className="count-pill muted">{formatNumber(selectedQueueIds.length)} selected</span>
          </div>
        </div>

        {!fetchData ? (
          <div className="empty-box">Fetch Conversations first. The queue table will appear here.</div>
        ) : fetchedConversations.length === 0 ? (
          <div className="empty-box">No conversations are currently queued. Fetch again or adjust filters.</div>
        ) : (
          <>
            <div className="fetched-queue-toolbar">
              <label className="queue-search-field">
                <span>Search Fetched Conversations</span>
                <input
                  value={queueSearchText}
                  onChange={(event) => setQueueSearchText(event.target.value)}
                  placeholder="Conversation, agent, client, rating"
                />
              </label>
              <div className="queue-toolbar-actions">
                <button type="button" className="secondary-btn" onClick={toggleAllVisibleQueueSelection}>
                  {allVisibleQueueSelected ? "Clear Visible" : "Select Visible"}
                </button>
                <button type="button" className="secondary-btn" onClick={() => setSelectedQueueIds([])} disabled={!selectedQueueIds.length}>
                  Clear Selection
                </button>
                <button type="button" className="danger-btn" onClick={removeSelectedFromQueue} disabled={!selectedQueueIds.length || runLoading}>
                  Remove Selected
                </button>
                <button type="button" className="danger-btn" onClick={clearFetchedQueue} disabled={!fetchedConversations.length || runLoading}>
                  Clear Queue
                </button>
              </div>
            </div>

            <div className="queue-table-wrap">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th><input className="queue-select" type="checkbox" checked={allVisibleQueueSelected} onChange={toggleAllVisibleQueueSelection} /></th>
                    <th>Conversation</th>
                    <th>Agent</th>
                    <th>Client</th>
                    <th>Rating</th>
                    <th>Replied</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFetchedQueue.map((item, index) => {
                    const id = conversationIdOf(item);
                    return (
                      <tr key={id || `queue-${index}`}>
                        <td><input className="queue-select" type="checkbox" checked={selectedQueueSet.has(id)} onChange={() => toggleQueueSelection(id)} /></td>
                        <td><strong>{id || "-"}</strong><small>Fetched from Intercom</small></td>
                        <td>{item?.agentName || "Unassigned"}</td>
                        <td>{item?.clientEmail || "-"}</td>
                        <td>{item?.conversationRating || item?.csatScore || "-"}</td>
                        <td>{formatClock(item?.repliedAt)}</td>
                        <td>
                          <div className="queue-action-cell">
                            <button type="button" className="queue-action-btn" onClick={() => setPreviewConversationId(id)} disabled={!id}>Preview</button>
                            {id ? <a className="queue-action-btn" href={intercomConversationUrl(id)} target="_blank" rel="noreferrer">Open on Intercom</a> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="queue-table-footer">
              <span className="soft-copy">Showing {formatNumber(visibleFetchedQueue.length)} of {formatNumber(filteredFetchedQueue.length)} filtered conversation(s).</span>
              {filteredFetchedQueue.length > 8 ? (
                <button type="button" className="secondary-btn" onClick={() => setQueueExpanded((prev) => !prev)}>
                  {queueExpanded ? "Show Less" : `Show More (${formatNumber(filteredFetchedQueue.length - visibleFetchedQueue.length)} more)`}
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>

      <section className="surface-card output-panel">
        <div className="section-head">
          <div>
            <span className="mini-label">Audit Output</span>
            <h2>Result Cards</h2>
          </div>

          <div className="result-metrics">
            <span>{formatNumber(runData?.meta?.auditedCount || 0)} result rows</span>
            <span>{formatNumber(runData?.meta?.handledCount || 0)} handled</span>
            <span>{formatNumber(runData?.meta?.skippedCount || 0)} skipped</span>
            <span>{formatNumber(successCount)} success</span>
            <span>{formatNumber(errorCount)} errors</span>
          </div>
        </div>

        {!runData ? (
          <div className="empty-box">Audit results will appear here after Run Audit completes.</div>
        ) : (
          <>
            <div className="run-meta-card polished">
              <div>
                <span>Requested By</span>
                <strong>{runData?.meta?.requestedBy || "-"}</strong>
              </div>
              <div>
                <span>Duplicate Handling</span>
                <strong>{runData?.meta?.duplicateModeApplied || "none"}</strong>
              </div>
              <div>
                <span>Storage</span>
                <strong>{runData?.meta?.storageStatus || "-"}</strong>
              </div>
              <div>
                <span>Mapped</span>
                <strong>{formatNumber(runData?.meta?.mappedCount || 0)}</strong>
              </div>
              <div>
                <span>Batches</span>
                <strong>{formatNumber(runData?.meta?.totalBatches || 0)}</strong>
              </div>
            </div>

            <div className="results-grid">
              {visibleResults.map((item, index) => {
                const statusLabel = getResultStatusLabel(item);
                const findings = getFindingsList(item);

                return (
                  <article
                    key={item?.conversationId || `result-${index}`}
                    className={item?.error ? "result-card error" : "result-card"}
                  >
                    <div className="conversation-head">
                      <div>
                        <span>Conversation</span>
                        <strong>{item?.conversationId || "Unknown"}</strong>
                      </div>
                      <span className={`pill ${getStatusTone(statusLabel)}`}>{statusLabel}</span>
                    </div>

                    <div className="conversation-details four">
                      <div>
                        <span>Agent</span>
                        <strong>{item?.agentName || "Unassigned"}</strong>
                      </div>
                      <div>
                        <span>Client</span>
                        <strong>{item?.clientEmail || "-"}</strong>
                      </div>
                      <div>
                        <span>Conversation Rating</span>
                        <strong>{item?.conversationRating || item?.csatScore || "-"}</strong>
                      </div>
                      <div>
                        <span>Replied</span>
                        <strong>{formatClock(item?.repliedAt)}</strong>
                      </div>
                    </div>

                    <div className="verdict-box">
                      <span>{item?.error ? "Error" : "AI verdict"}</span>
                      <p>{getResultSummary(item)}</p>
                    </div>

                    {!item?.error ? (
                      <div className="findings-box">
                        {findings.length ? findings.join(" | ") : "No additional findings."}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>

            {results.length > 8 ? (
              <div className="show-more-row">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setShowAllResults((prev) => !prev)}
                >
                  {showAllResults
                    ? "Show less"
                    : `Show more (${formatNumber(results.length - visibleResults.length)} more)`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      {fetchData ? (
        <section className="surface-card diagnostics-panel">
          <details>
            <summary>Fetch diagnostics</summary>
            <div className="diagnostics-grid">
              <div>
                <span>Intercom Per Page</span>
                <strong>{fetchData?.debug?.intercomPerPage ?? "-"}</strong>
              </div>
              <div>
                <span>Max Pages per Day</span>
                <strong>{fetchData?.debug?.maxFetchPagesPerDay ?? "-"}</strong>
              </div>
              <div>
                <span>Daily Summaries</span>
                <strong>{formatNumber(dailySummary.length)}</strong>
              </div>
            </div>
          </details>
        </section>
      ) : null}

      {previewConversationId ? (
        <ConversationPreviewModal conversationId={previewConversationId} onClose={() => setPreviewConversationId("")} />
      ) : null}

      {showJumpTop ? (
        <button
          type="button"
          className="jump-top"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          Jump to top
        </button>
      ) : null}
    </main>
  );
}

const runStyles = `
  .run-page {
    min-height: 100vh;
    width: 100%;
    padding: 18px clamp(14px, 1.8vw, 28px) 72px;
    color: #f5f7ff;
    background:
      radial-gradient(circle at 10% 0%, rgba(59, 130, 246, 0.14), transparent 24%),
      radial-gradient(circle at 88% 2%, rgba(139, 92, 246, 0.14), transparent 26%),
      radial-gradient(circle at 50% 100%, rgba(6, 182, 212, 0.08), transparent 24%),
      linear-gradient(180deg, #040714 0%, #050918 46%, #04060d 100%);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .hero-shell,
  .stats-grid,
  .command-grid,
  .surface-card,
  .diagnostics-panel,
  .quick-run-panel {
    width: 100%;
    max-width: none;
    margin-left: 0;
    margin-right: 0;
    box-sizing: border-box;
  }

  .surface-card,
  .stat-card,
  .hero-copy-card,
  .workflow-card,
  .insight-card {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background:
      linear-gradient(180deg, rgba(14, 20, 40, 0.92), rgba(7, 10, 24, 0.96));
    box-shadow:
      0 24px 80px rgba(0, 0, 0, 0.38),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .mini-label,
  .eyebrow,
  label span,
  .conversation-head span,
  .conversation-details span,
  .run-meta-card span,
  .mini-grid span,
  .verdict-box span,
  .diagnostics-grid span,
  .progress-metrics-grid span,
  .workflow-step p,
  .modal-note-card span,
  .duplicate-sample-box span {
    margin: 0 0 8px;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .hero-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
    gap: 18px;
    margin-bottom: 18px;
  }

  .hero-copy-card,
  .workflow-card,
  .insight-card,
  .command-card,
  .monitor-card,
  .run-summary-card,
  .log-panel,
  .preview-panel,
  .output-panel,
  .diagnostics-panel {
    border-radius: 30px;
  }

  .hero-copy-card {
    position: relative;
    overflow: hidden;
    padding: 30px;
  }

  .hero-copy-card::before {
    content: "";
    position: absolute;
    inset: auto -80px -120px auto;
    width: 360px;
    height: 360px;
    border-radius: 50%;
    background: rgba(124, 58, 237, 0.18);
    filter: blur(54px);
    pointer-events: none;
  }

  .hero-badge-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 16px;
  }

  .hero-badge,
  .state-pill,
  .primary-btn,
  .secondary-btn,
  .danger-btn,
  .ghost-btn,
  .pill,
  .count-pill,
  .toggle-chip,
  .modal-badge,
  .progress-percent-chip,
  .access-badge {
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
    color: #e7ecff;
    border: 1px solid rgba(129, 140, 248, 0.24);
    background: rgba(99, 102, 241, 0.16);
    font-size: 14px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .state-pill {
    min-height: 34px;
    padding: 0 12px;
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .state-pill.success,
  .pill.success,
  .access-badge.success {
    color: #bbf7d0;
    border: 1px solid rgba(16, 185, 129, 0.24);
    background: rgba(16, 185, 129, 0.1);
  }

  .state-pill.notice,
  .pill.notice,
  .count-pill,
  .progress-percent-chip {
    color: #dbeafe;
    border: 1px solid rgba(59, 130, 246, 0.22);
    background: rgba(59, 130, 246, 0.12);
  }

  .state-pill.warning,
  .pill.warning,
  .modal-badge.warning {
    color: #fde68a;
    border: 1px solid rgba(245, 158, 11, 0.24);
    background: rgba(245, 158, 11, 0.1);
  }

  .modal-badge.danger {
    color: #fecaca;
    border: 1px solid rgba(244, 63, 94, 0.28);
    background: rgba(244, 63, 94, 0.12);
  }

  .state-pill.danger,
  .pill.danger,
  .access-badge.danger {
    color: #fecaca;
    border: 1px solid rgba(244, 63, 94, 0.24);
    background: rgba(244, 63, 94, 0.1);
  }

  .state-pill.neutral,
  .pill.neutral,
  .count-pill.muted {
    color: #c7d2fe;
    border: 1px solid rgba(255, 255, 255, 0.09);
    background: rgba(255, 255, 255, 0.04);
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
    position: relative;
    z-index: 1;
  }

  h1 {
    margin-bottom: 12px;
    font-size: clamp(42px, 5vw, 74px);
    line-height: 0.96;
    letter-spacing: -0.07em;
  }

  h2 {
    margin: 0;
    font-size: 28px;
    letter-spacing: -0.04em;
  }

  h3 {
    margin: 0;
    font-size: 20px;
    letter-spacing: -0.03em;
  }

  .hero-copy {
    margin: 0 0 20px;
    color: #a9b4d0;
    font-size: 20px;
    line-height: 1.65;
    max-width: 760px;
  }

  .hero-summary-card,
  .hero-quick-card,
  .auth-shell-card,
  .control-block,
  .behavior-card,
  .resting-panel,
  .run-meta-card,
  .verdict-box,
  .findings-box,
  .empty-box,
  .progress-panel,
  .duplicate-sample-box,
  .modal-note-card {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    border-radius: 22px;
  }

  .hero-summary-card {
    padding: 18px;
    margin-bottom: 16px;
  }

  .hero-summary-card strong {
    display: block;
    color: #f5f7ff;
    font-size: 17px;
    line-height: 1.7;
  }

  .hero-quick-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }

  .hero-quick-card {
    padding: 16px;
  }

  .hero-quick-card strong,
  .hero-quick-card small {
    display: block;
  }

  .hero-quick-card strong {
    font-size: 17px;
    line-height: 1.45;
    color: #f5f7ff;
  }

  .hero-quick-card small {
    margin-top: 6px;
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.55;
  }

  .hero-side-column {
    display: grid;
    gap: 18px;
    align-self: stretch;
  }

  .workflow-card,
  .insight-card {
    padding: 24px;
  }

  .workflow-stack {
    display: grid;
    gap: 12px;
  }

  .workflow-step {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    align-items: start;
    gap: 12px;
    padding: 14px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.03);
  }

  .workflow-step.active {
    border-color: rgba(59, 130, 246, 0.2);
    background: rgba(59, 130, 246, 0.08);
  }

  .workflow-step.done {
    border-color: rgba(16, 185, 129, 0.2);
    background: rgba(16, 185, 129, 0.08);
  }

  .workflow-dot {
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border-radius: 14px;
    color: #ffffff;
    font-size: 15px;
    font-weight: 900;
    background: linear-gradient(135deg, #2563eb, #7c3aed, #db2777);
    box-shadow: 0 10px 22px rgba(91, 33, 182, 0.28);
  }

  .workflow-step strong {
    display: block;
    font-size: 17px;
    margin-bottom: 6px;
  }

  .workflow-step p {
    margin: 0;
    text-transform: none;
    line-height: 1.6;
    letter-spacing: normal;
    color: #a9b4d0;
    font-size: 15px;
    font-weight: 700;
  }

  .insight-card {
    display: grid;
    gap: 12px;
  }

  .insight-line {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #dce7ff;
    font-size: 16px;
    line-height: 1.6;
  }

  .insight-line svg {
    color: #8b5cf6;
    flex: 0 0 auto;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
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
    width: 138px;
    height: 138px;
    border-radius: 50%;
    filter: blur(34px);
    background: rgba(59, 130, 246, 0.14);
  }

  .stat-card.success::before {
    background: rgba(16, 185, 129, 0.16);
  }

  .stat-card.warning::before {
    background: rgba(245, 158, 11, 0.16);
  }

  .stat-card.notice::before {
    background: rgba(59, 130, 246, 0.16);
  }

  .stat-card p {
    margin: 0 0 10px;
    color: #8ea0d6;
    font-size: 14px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .stat-card strong {
    display: block;
    color: #f5f7ff;
    font-size: 30px;
    letter-spacing: -0.05em;
    margin-bottom: 6px;
  }

  .stat-card span {
    color: #a9b4d0;
    font-size: 15px;
    font-weight: 800;
    line-height: 1.6;
  }

  .command-grid {
    display: grid;
    grid-template-columns: minmax(700px, 1.14fr) minmax(430px, 0.86fr);
    gap: 18px;
    margin-bottom: 18px;
    align-items: start;
  }

  .command-card,
  .monitor-card,
  .run-summary-card,
  .log-panel,
  .preview-panel,
  .output-panel,
  .diagnostics-panel {
    padding: 24px;
    margin-bottom: 18px;
  }

  .monitor-column {
    display: grid;
    gap: 18px;
    align-self: start;
  }

  .section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 18px;
  }

  .section-head.compact.alt {
    align-items: center;
  }

  .toggle-chip,
  .primary-btn,
  .secondary-btn,
  .danger-btn,
  .ghost-btn {
    gap: 8px;
    border: none;
    cursor: pointer;
    font: inherit;
    font-weight: 900;
    transition: transform 0.18s ease, opacity 0.18s ease, border-color 0.18s ease;
  }

  .toggle-chip:hover,
  .primary-btn:hover,
  .secondary-btn:hover,
  .danger-btn:hover,
  .ghost-btn:hover,
  .preset-button:hover,
  .icon-btn:hover,
  .switch:hover {
    transform: translateY(-1px);
  }

  .toggle-chip {
    min-height: 42px;
    padding: 0 14px 0 10px;
    color: #dbeafe;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .toggle-chip span,
  .switch span {
    display: inline-block;
    position: relative;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    transition: transform 0.18s ease, background 0.18s ease;
  }

  .toggle-chip.on {
    color: #bbf7d0;
    border-color: rgba(16, 185, 129, 0.24);
    background: rgba(16, 185, 129, 0.1);
  }

  .toggle-chip.on span {
    background: #10b981;
    box-shadow: 0 0 18px rgba(16, 185, 129, 0.4);
  }

  .auth-shell-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 16px;
    margin-bottom: 14px;
  }

  .auth-shell-card strong,
  .auth-shell-card small {
    display: block;
  }

  .auth-shell-card strong {
    font-size: 17px;
    line-height: 1.5;
    word-break: break-word;
  }

  .auth-shell-card small {
    margin-top: 4px;
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.6;
  }

  .control-section-grid {
    display: grid;
    grid-template-columns: minmax(300px, 0.9fr) minmax(500px, 1.1fr);
    gap: 14px;
    align-items: stretch;
  }

  .control-section-grid > .control-block:nth-child(1) {
    grid-column: 1;
    grid-row: 1;
  }

  .control-section-grid > .filter-control-block {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .control-section-grid > .control-block:nth-child(3) {
    grid-column: 1;
    grid-row: 2;
  }

  .control-section-grid > .action-block {
    grid-column: 1 / -1;
    grid-row: 3;
  }

  .control-block {
    padding: 16px;
    overflow: visible;
  }

  .block-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 14px;
  }

  .preset-box {
    position: relative;
    margin-bottom: 14px;
  }

  .preset-box label {
    display: block;
    margin-bottom: 10px;
    color: #9fb2ee;
    font-size: 15px;
    font-weight: 800;
  }

  .preset-button {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: #f5f7ff;
    cursor: pointer;
    text-align: left;
  }

  .preset-button span,
  .preset-button small,
  .preset-button b {
    display: block;
  }

  .preset-button span {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 17px;
    font-weight: 800;
    color: #ffffff;
  }

  .preset-button small {
    color: #a9b4d0;
    font-size: 14px;
  }

  .preset-button b {
    color: #9fb2ee;
    font-size: 14px;
  }

  .preset-menu {
    position: absolute;
    z-index: 40;
    top: calc(100% + 10px);
    left: 0;
    width: min(100%, 320px);
    display: grid;
    gap: 8px;
    padding: 10px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(8, 12, 24, 0.98);
    box-shadow: 0 24px 50px rgba(0, 0, 0, 0.35);
  }

  .preset-menu button {
    min-height: 40px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.03);
    color: #dbe7ff;
    font: inherit;
    font-size: 15px;
    font-weight: 800;
    text-align: left;
    cursor: pointer;
  }

  .preset-menu button.active,
  .preset-menu button:hover {
    border-color: rgba(59, 130, 246, 0.24);
    background: rgba(59, 130, 246, 0.12);
  }

  .form-grid.two {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  label {
    display: block;
  }

  label span {
    display: block;
  }

  input {
    width: 100%;
    min-height: 48px;
    padding: 0 14px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    background: rgba(255, 255, 255, 0.04);
    color: #f5f7ff;
    outline: none;
    font: inherit;
    font-size: 16px;
  }

  input:focus {
    border-color: rgba(96, 165, 250, 0.4);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
  }

  input[type="date"]::-webkit-calendar-picker-indicator {
    opacity: 0;
  }

  .date-control {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
  }

  .icon-btn {
    width: 46px;
    height: 46px;
    display: inline-grid;
    place-items: center;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: #dbeafe;
    cursor: pointer;
  }

  .behavior-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    align-items: stretch;
  }

  .behavior-card {
    padding: 14px;
    min-height: 122px;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: visible;
  }

  .behavior-card.interactive {
    cursor: pointer;
    transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
  }

  .behavior-card.interactive:hover,
  .behavior-card.interactive:focus {
    transform: translateY(-1px);
    border-color: rgba(96, 165, 250, 0.32);
    background: rgba(59, 130, 246, 0.08);
    outline: none;
  }

  .behavior-card.interactive.active {
    border-color: rgba(16, 185, 129, 0.28);
    background: rgba(16, 185, 129, 0.08);
  }

  .behavior-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .behavior-row strong {
    display: block;
    font-size: 17px;
    line-height: 1.4;
  }

  .behavior-copy {
    display: block;
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.6;
  }

  .switch {
    width: 58px;
    min-width: 58px;
    height: 34px;
    position: relative;
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    cursor: pointer;
    transition: background 0.18s ease, border-color 0.18s ease;
  }

  .switch span {
    width: 24px;
    height: 24px;
    margin-left: 4px;
    background: #cbd5e1;
  }

  .switch.on {
    border-color: rgba(16, 185, 129, 0.24);
    background: rgba(16, 185, 129, 0.14);
  }

  .switch.on span {
    transform: translateX(24px);
    background: #10b981;
  }

  .action-block {
    background:
      radial-gradient(circle at 0% 0%, rgba(34, 211, 238, 0.1), transparent 34%),
      radial-gradient(circle at 100% 0%, rgba(168, 85, 247, 0.1), transparent 30%),
      rgba(17, 24, 39, 0.78);
  }

  .action-block .block-head {
    margin-bottom: 16px;
  }

  .action-summary-grid {
    display: grid;
    grid-template-columns: minmax(160px, 0.8fr) minmax(160px, 0.8fr) minmax(260px, 1.4fr);
    gap: 12px;
    margin-bottom: 16px;
  }

  .action-summary-grid div:nth-child(3) {
    grid-column: auto;
  }

  .action-summary-grid div {
    min-height: 88px;
    padding: 16px;
    border-radius: 20px;
    border: 1px solid rgba(148, 163, 184, 0.14);
    background: linear-gradient(180deg, rgba(30, 41, 59, 0.74), rgba(15, 23, 42, 0.68));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  .action-summary-grid strong {
    display: block;
    font-size: 18px;
    line-height: 1.45;
    color: #ffffff;
  }

  .action-summary-grid small {
    display: block;
    margin-top: 6px;
    color: #a9b4d0;
    font-size: 14px;
    line-height: 1.55;
    font-weight: 700;
  }

  .button-row {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .button-row.large {
    gap: 14px;
    align-items: center;
  }

  .action-block .button-row.large .primary-btn,
  .action-block .button-row.large .secondary-btn,
  .action-block .button-row.large .danger-btn {
    min-height: 48px;
    min-width: 170px;
  }

  .primary-btn,
  .secondary-btn,
  .danger-btn,
  .ghost-btn {
    min-height: 46px;
    padding: 0 18px;
  }

  .primary-btn {
    color: #ffffff;
    background: linear-gradient(135deg, #2563eb, #7c3aed, #db2777);
    box-shadow: 0 18px 30px rgba(91, 33, 182, 0.28);
  }

  .secondary-btn {
    color: #dbeafe;
    border: 1px solid rgba(59, 130, 246, 0.24);
    background: rgba(59, 130, 246, 0.1);
  }

  .danger-btn {
    color: #fee2e2;
    border: 1px solid rgba(244, 63, 94, 0.24);
    background: rgba(244, 63, 94, 0.12);
  }

  .danger-btn.compact {
    min-height: 42px;
    padding: 0 14px;
  }

  .ghost-btn {
    color: #dbe7ff;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  .ghost-btn.small {
    min-height: 38px;
    padding: 0 12px;
    font-size: 15px;
  }

  button:disabled {
    opacity: 0.56;
    cursor: not-allowed;
    transform: none !important;
  }

  .message-stack {
    display: grid;
    gap: 10px;
    margin-top: 16px;
  }

  .message {
    padding: 14px 16px;
    border-radius: 16px;
    font-size: 16px;
    font-weight: 700;
    line-height: 1.6;
  }

  .message.success {
    color: #bbf7d0;
    border: 1px solid rgba(16, 185, 129, 0.18);
    background: rgba(16, 185, 129, 0.08);
  }

  .message.error {
    color: #fecaca;
    border: 1px solid rgba(244, 63, 94, 0.18);
    background: rgba(244, 63, 94, 0.08);
  }

  .message.subtle {
    margin-bottom: 14px;
  }

  .resting-panel {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 18px;
  }

  .resting-icon-wrap {
    width: 52px;
    height: 52px;
    display: grid;
    place-items: center;
    border-radius: 18px;
    background: linear-gradient(135deg, rgba(37, 99, 235, 0.2), rgba(124, 58, 237, 0.2));
    color: #ffffff;
    flex: 0 0 auto;
  }

  .resting-panel strong {
    display: block;
    font-size: 20px;
    margin-bottom: 6px;
  }

  .resting-panel p {
    margin: 0;
    color: #a9b4d0;
    line-height: 1.7;
    font-size: 16px;
  }

  .progress-visual {
    position: relative;
    min-height: 76px;
    margin: 2px 0 16px;
    overflow: hidden;
    border-radius: 22px;
    border: 1px solid rgba(148, 163, 184, 0.12);
    background:
      radial-gradient(circle at 18% 50%, rgba(148, 163, 184, 0.18), transparent 28%),
      radial-gradient(circle at 80% 40%, rgba(30, 41, 59, 0.56), transparent 34%),
      linear-gradient(135deg, rgba(15, 23, 42, 0.92), rgba(9, 12, 21, 0.94));
  }

  .fetch-visual::before {
    content: "";
    position: absolute;
    inset: 12px;
    border-radius: 18px;
    border: 1px dashed rgba(148, 163, 184, 0.22);
  }

  .fetch-node {
    position: absolute;
    top: 50%;
    width: 42px;
    height: 42px;
    border-radius: 16px;
    transform: translateY(-50%);
    border: 1px solid rgba(148, 163, 184, 0.22);
    background: linear-gradient(145deg, #111827, #020617);
    box-shadow: 0 16px 34px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  .fetch-node.source { left: 26px; }
  .fetch-node.queue { right: 26px; }

  .fetch-node.source::after,
  .fetch-node.queue::after {
    content: "";
    position: absolute;
    inset: 12px;
    border-radius: 10px;
    background: #94a3b8;
    opacity: 0.72;
  }

  .fetch-node.queue::after {
    background: #d1d5db;
  }

  .fetch-stream {
    position: absolute;
    left: 86px;
    right: 86px;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.12);
  }

  .fetch-stream i {
    position: absolute;
    top: -4px;
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: #cbd5e1;
    box-shadow: 0 0 14px rgba(203, 213, 225, 0.28);
    animation: fetchPacket 2.2s ease-in-out infinite;
  }

  .fetch-stream i:nth-child(2) { animation-delay: 0.45s; }
  .fetch-stream i:nth-child(3) { animation-delay: 0.9s; }

  .fetch-scan-line {
    position: absolute;
    top: 12px;
    bottom: 12px;
    width: 2px;
    border-radius: 999px;
    background: linear-gradient(180deg, transparent, #d1d5db, transparent);
    box-shadow: 0 0 18px rgba(209, 213, 219, 0.35);
    animation: fetchScan 2.6s ease-in-out infinite;
  }

  @keyframes fetchPacket {
    0% { left: 0%; opacity: 0; transform: scale(0.75); }
    12% { opacity: 1; }
    88% { opacity: 1; }
    100% { left: calc(100% - 12px); opacity: 0; transform: scale(1); }
  }

  @keyframes fetchScan {
    0%, 100% { left: 20%; opacity: 0.2; }
    50% { left: 80%; opacity: 0.9; }
  }

  .audit-visual {
    min-height: 88px;
  }

  .mechanic-gear {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #d1d5db;
    filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.45));
  }

  .mechanic-gear::before {
    content: "⚙︎";
    font-family: Arial, Helvetica, sans-serif;
    line-height: 1;
  }

  .gear-large {
    left: calc(50% - 54px);
    top: 15px;
    font-size: 48px;
    animation: mechanicSpin 2.6s linear infinite;
  }

  .gear-small {
    left: calc(50% - 8px);
    top: 29px;
    font-size: 34px;
    color: #6b7280;
    animation: mechanicSpinReverse 1.9s linear infinite;
  }

  .gear-mid {
    left: calc(50% + 26px);
    top: 20px;
    font-size: 40px;
    color: #9ca3af;
    animation: mechanicSpin 2.2s linear infinite;
  }

  .audit-spark {
    position: absolute;
    left: 50%;
    bottom: 15px;
    width: 92px;
    height: 4px;
    border-radius: 999px;
    transform: translateX(-50%);
    background: linear-gradient(90deg, transparent, #9ca3af, transparent);
    opacity: 0.65;
    animation: sparkPulse 1.8s ease-in-out infinite;
  }

  @keyframes mechanicSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes mechanicSpinReverse { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
  @keyframes sparkPulse { 0%, 100% { opacity: 0.2; width: 70px; } 50% { opacity: 0.75; width: 112px; } }

  .progress-panel.enhanced {
    padding: 18px;
  }

  .progress-panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 14px;
  }

  .progress-panel-head h3 {
    font-size: 22px;
    margin-bottom: 6px;
  }

  .progress-panel-head p {
    margin: 0;
    color: #a9b4d0;
    line-height: 1.6;
    font-size: 16px;
  }

  .progress-percent-chip {
    min-height: 38px;
    padding: 0 12px;
    font-size: 16px;
    font-weight: 900;
  }

  .progress-meter-shell {
    height: 12px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.06);
    margin-bottom: 16px;
  }

  .progress-meter-fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #2563eb, #7c3aed, #db2777);
    box-shadow: 0 0 20px rgba(124, 58, 237, 0.35);
  }

  .progress-metrics-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .progress-metrics-grid div {
    padding: 13px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.03);
  }

  .progress-metrics-grid strong {
    display: block;
    font-size: 17px;
    line-height: 1.45;
  }

  .progress-bottom-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .progress-tip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #a9b4d0;
  }

  .progress-tip small {
    font-size: 15px;
    line-height: 1.6;
  }

  .progress-tip svg {
    color: #8b5cf6;
  }

  .mini-grid.polished,
  .run-meta-card.polished {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .mini-grid.polished div,
  .run-meta-card.polished div {
    padding: 14px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .mini-grid.polished strong,
  .run-meta-card.polished strong {
    display: block;
    font-size: 17px;
    line-height: 1.5;
    color: #ffffff;
  }

  .log-list {
    display: grid;
    gap: 10px;
    max-height: 430px;
    overflow: auto;
    padding-right: 4px;
  }

  .log-item {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 14px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.03);
  }

  .log-item span {
    color: #9fb2ee;
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .log-item strong {
    font-size: 15px;
    line-height: 1.7;
  }

  .log-item.success {
    border-color: rgba(16, 185, 129, 0.16);
    background: rgba(16, 185, 129, 0.07);
  }

  .log-item.warning,
  .log-item.notice {
    border-color: rgba(59, 130, 246, 0.16);
    background: rgba(59, 130, 246, 0.07);
  }

  .log-item.danger {
    border-color: rgba(244, 63, 94, 0.16);
    background: rgba(244, 63, 94, 0.07);
  }

  .preview-panel,
  .output-panel,
  .diagnostics-panel {
    margin-bottom: 18px;
  }

  .header-right-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .count-pill {
    min-height: 34px;
    padding: 0 12px;
    font-size: 14px;
    font-weight: 900;
  }

  .conversation-grid,
  .results-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .conversation-card,
  .result-card {
    padding: 18px;
    border-radius: 22px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
  }

  .result-card.error {
    border-color: rgba(244, 63, 94, 0.16);
    background: rgba(244, 63, 94, 0.06);
  }

  .conversation-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }

  .conversation-head strong {
    display: block;
    font-size: 18px;
    line-height: 1.4;
    color: #ffffff;
  }

  .conversation-details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .conversation-details.four {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .conversation-details div {
    padding: 12px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.025);
  }

  .conversation-details strong {
    display: block;
    color: #ffffff;
    font-size: 15px;
    line-height: 1.55;
    word-break: break-word;
  }

  .verdict-box,
  .findings-box {
    padding: 14px;
    margin-top: 14px;
  }

  .verdict-box p,
  .findings-box {
    margin: 0;
    color: #dbe7ff;
    font-size: 15px;
    line-height: 1.75;
  }

  .result-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .result-metrics span {
    min-height: 34px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    color: #dbe7ff;
    font-size: 14px;
    font-weight: 900;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
  }

  .show-more-row {
    display: flex;
    justify-content: center;
    margin-top: 18px;
  }

  .empty-box {
    padding: 22px;
    color: #a9b4d0;
    font-size: 16px;
    line-height: 1.7;
  }

  .empty-box.small {
    padding: 18px;
  }

  details summary {
    cursor: pointer;
    list-style: none;
    font-size: 17px;
    font-weight: 900;
    color: #ffffff;
  }

  details summary::-webkit-details-marker {
    display: none;
  }

  .diagnostics-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 16px;
  }

  .diagnostics-grid div {
    padding: 14px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .diagnostics-grid strong {
    display: block;
    font-size: 17px;
    line-height: 1.5;
    color: #ffffff;
  }

  .jump-top {
    position: fixed;
    right: 22px;
    bottom: 22px;
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
    z-index: 50;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(2, 6, 23, 0.72);
    backdrop-filter: blur(12px);
  }

  .duplicate-modal {
    width: min(760px, 100%);
    padding: 24px;
    border-radius: 30px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: linear-gradient(180deg, rgba(15, 22, 43, 0.96), rgba(7, 10, 24, 0.98));
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.55);
  }

  .modal-shell-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }

  .modal-count {
    min-width: 72px;
    height: 72px;
    display: grid;
    place-items: center;
    border-radius: 24px;
    color: #fde68a;
    font-size: 26px;
    font-weight: 900;
    border: 1px solid rgba(245, 158, 11, 0.24);
    background: rgba(245, 158, 11, 0.08);
  }

  .modal-count.danger {
    color: #fecaca;
    border-color: rgba(244, 63, 94, 0.28);
    background: rgba(244, 63, 94, 0.1);
  }

  .modal-count.notice {
    color: #dbeafe;
    border-color: rgba(59, 130, 246, 0.24);
    background: rgba(59, 130, 246, 0.1);
  }

  .duplicate-modal h2 {
    margin-bottom: 10px;
    font-size: 34px;
    letter-spacing: -0.05em;
  }

  .modal-copy {
    margin: 0 0 16px;
    color: #a9b4d0;
    line-height: 1.75;
    font-size: 17px;
  }

  .modal-note-grid,
  .safety-detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .safety-detail-grid {
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  }

  .modal-note-card {
    padding: 16px;
  }

  .safety-modal {
    width: min(820px, 100%);
  }

  .safety-detail-card span {
    display: block;
    margin-bottom: 6px;
    color: #8ea0d6;
    font-size: 12px;
    font-weight: 950;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .safety-hint {
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(129, 140, 248, 0.16);
    background: rgba(99, 102, 241, 0.08);
  }

  .modal-note-card strong,
  .modal-note-card small {
    display: block;
  }

  .modal-note-card strong {
    margin-bottom: 6px;
    font-size: 17px;
    line-height: 1.45;
    color: #ffffff;
  }

  .modal-note-card small {
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.65;
  }

  .duplicate-sample-box {
    padding: 16px;
    margin-bottom: 14px;
  }

  .duplicate-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .duplicate-list strong {
    min-height: 32px;
    padding: 0 10px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 14px;
    color: #dbe7ff;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
  }

  .duplicate-sample-box small {
    color: #a9b4d0;
    font-size: 15px;
  }

  .modal-hint {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    color: #dbe7ff;
    font-size: 15px;
    line-height: 1.6;
  }

  .modal-hint svg {
    color: #8b5cf6;
    flex: 0 0 auto;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
  }

  .run-intro-strip {
    margin: 0 0 12px;
    padding: 14px 18px;
    border-radius: 28px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 18px;
    background: radial-gradient(circle at 14% 0%, rgba(34, 211, 238, 0.1), transparent 30%), linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(19, 13, 45, 0.94));
  }

  .run-intro-strip h1 {
    font-size: clamp(24px, 2.4vw, 34px);
    letter-spacing: -0.05em;
    line-height: 1.04;
    margin: 0 0 6px;
  }

  .run-intro-strip p {
    margin: 0;
    color: #a9b4d0;
    font-size: 16px;
    line-height: 1.65;
    max-width: 820px;
  }

  .run-intro-meta {
    min-width: 280px;
    padding: 14px;
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    display: grid;
    gap: 8px;
    justify-items: start;
  }

  .run-intro-meta strong,
  .run-intro-meta small {
    display: block;
  }

  .run-intro-meta strong {
    color: #f5f7ff;
    font-size: 17px;
  }

  .run-intro-meta small {
    color: #a9b4d0;
    font-size: 14px;
    font-weight: 800;
  }

  .compact-run-stats {
    margin-top: 0;
  }

  .filter-control-block .block-head small {
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.6;
    font-weight: 750;
  }

  .filter-control-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .run-multi-filter {
    position: relative;
    z-index: 40;
    isolation: isolate;
  }

  .run-multi-filter label {
    display: grid;
    gap: 8px;
  }

  .run-multi-filter label > small {
    color: #8ea0d6;
    font-size: 14px;
    line-height: 1.55;
    font-weight: 750;
    text-transform: none;
    letter-spacing: normal;
  }

  .run-multi-button,
  .run-date-button {
    width: 100%;
    min-height: 48px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    background: rgba(2, 6, 23, 0.72);
    color: #f8fbff;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .run-multi-button strong,
  .run-date-button strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 16px;
    font-weight: 900;
  }

  .run-multi-button b,
  .run-date-button b {
    color: #9fb2ee;
    font-size: 13px;
    font-weight: 900;
  }

  .run-multi-menu {
    position: absolute;
    z-index: 9999;
    top: calc(100% + 10px);
    left: 0;
    right: 0;
    min-width: 280px;
    padding: 10px;
    border-radius: 18px;
    border: 1px solid rgba(96, 165, 250, 0.34);
    background: linear-gradient(180deg, #071126 0%, #050915 100%);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(15, 23, 42, 0.9);
  }

  .run-multi-menu input {
    width: 100%;
    min-height: 42px;
    margin-bottom: 8px;
    border-radius: 13px;
    border: 1px solid rgba(96, 165, 250, 0.18);
    background: #020617;
    color: #ffffff;
    padding: 0 12px;
  }

  .run-multi-options {
    display: grid;
    gap: 7px;
    max-height: 260px;
    overflow: auto;
    padding-right: 2px;
  }

  .run-multi-option {
    width: 100%;
    min-height: 44px;
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border-radius: 13px;
    border: 1px solid rgba(96, 165, 250, 0.14);
    background: #0b1326;
    color: #dbe7ff;
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: 8px 10px;
  }

  .run-multi-option span {
    color: #93c5fd;
    font-size: 12px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .run-multi-option strong {
    color: #ffffff;
    font-size: 15px;
    line-height: 1.35;
  }

  .run-multi-option em {
    grid-column: 2;
    color: #9fb2ee;
    font-size: 13px;
    font-style: normal;
    line-height: 1.4;
  }

  .run-multi-option.active,
  .run-multi-option:hover {
    border-color: rgba(34, 211, 238, 0.42);
    background: linear-gradient(135deg, #083044 0%, #0b2144 100%);
  }

  .run-multi-empty {
    padding: 14px;
    color: #8ea0d6;
    font-size: 15px;
  }

  .filter-summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-top: 14px;
  }

  .filter-summary-grid div {
    padding: 12px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.03);
  }

  .filter-summary-grid span,
  .filter-summary-grid strong {
    display: block;
  }

  .filter-summary-grid span {
    color: #8ea0d6;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .filter-summary-grid strong {
    color: #f8fbff;
    font-size: 15px;
    line-height: 1.45;
  }

  .run-date-range-picker {
    position: relative;
    z-index: 25;
  }

  .run-date-range-picker label {
    display: grid;
    gap: 10px;
  }

  .run-date-button {
    grid-template-columns: minmax(0, 1fr) auto auto;
    min-height: 56px;
  }

  .run-date-button strong {
    display: inline-flex;
    align-items: center;
    gap: 9px;
  }

  .run-date-button small {
    color: #a9b4d0;
    font-size: 14px;
    font-weight: 800;
  }

  .run-date-popover {
    position: absolute;
    z-index: 90;
    top: calc(100% + 12px);
    left: 0;
    width: min(940px, calc(100vw - 52px));
    border-radius: 24px;
    border: 1px solid rgba(96, 165, 250, 0.22);
    background: rgba(8, 13, 28, 0.98);
    box-shadow: 0 34px 90px rgba(0, 0, 0, 0.55);
    padding: 18px;
  }

  .date-popover-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 12px;
    margin-bottom: 14px;
  }

  .date-popover-tabs div {
    padding: 10px 12px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.035);
  }

  .date-popover-tabs div.active {
    border-bottom: 2px solid #22c55e;
  }

  .date-popover-tabs span,
  .date-popover-tabs strong {
    display: block;
  }

  .date-popover-tabs span {
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .date-popover-tabs strong {
    color: #f8fbff;
    font-size: 16px;
  }

  .date-popover-body {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
    gap: 16px;
  }

  .date-preset-column {
    display: grid;
    align-content: start;
    gap: 8px;
  }

  .date-preset-column button,
  .calendar-nav-row button {
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: #dbe7ff;
    min-height: 38px;
    padding: 0 10px;
    font: inherit;
    font-size: 14px;
    font-weight: 900;
    cursor: pointer;
  }

  .date-preset-column button.active,
  .date-preset-column button:hover,
  .calendar-nav-row button:hover {
    border-color: rgba(34, 211, 238, 0.24);
    background: rgba(14, 165, 233, 0.12);
  }

  .calendar-nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }

  .calendar-nav-row strong {
    color: #f8fbff;
    font-size: 17px;
  }

  .calendar-months-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }

  .calendar-month-card h4 {
    margin: 0 0 12px;
    color: #f8fbff;
    font-size: 17px;
  }

  .calendar-weekdays,
  .calendar-day-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 4px;
  }

  .calendar-weekdays span {
    color: #8ea0d6;
    font-size: 12px;
    font-weight: 900;
    text-align: center;
    padding: 6px 0;
  }

  .calendar-day {
    min-height: 36px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: transparent;
    color: #dbe7ff;
    font: inherit;
    font-size: 15px;
    font-weight: 850;
    cursor: pointer;
  }

  .calendar-day.muted {
    color: rgba(148, 163, 184, 0.36);
  }

  .calendar-day.in-range {
    background: rgba(34, 197, 94, 0.12);
  }

  .calendar-day.range-start,
  .calendar-day.range-end {
    color: #ffffff;
    border-color: rgba(34, 197, 94, 0.4);
    background: rgba(22, 163, 74, 0.72);
    box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.16), 0 0 20px rgba(34, 197, 94, 0.18);
  }

  .date-popover-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 16px;
  }

  .primary-btn.light {
    background: #f8fafc;
    color: #0f172a;
    border: 1px solid rgba(255, 255, 255, 0.22);
  }


  /* Final Run Audit overlay repair */
  .run-multi-filter.open,
  .run-date-range-picker.open {
    z-index: 9000;
  }

  .run-multi-menu {
    z-index: 99999 !important;
    width: max(100%, 330px);
    background: #050a16 !important;
    background-image: linear-gradient(180deg, #0a1430 0%, #050a16 100%) !important;
    border-color: rgba(96, 165, 250, 0.42) !important;
    box-shadow: 0 34px 90px rgba(0, 0, 0, 0.86), 0 0 0 1px rgba(2, 6, 23, 0.98), 0 0 38px rgba(14, 165, 233, 0.12) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  .filter-control-grid > .run-multi-filter:nth-child(2n) .run-multi-menu {
    left: auto;
    right: 0;
  }

  .run-multi-menu input {
    background: #020617 !important;
    border-color: rgba(96, 165, 250, 0.26) !important;
  }

  .run-multi-option {
    background: #0b1326 !important;
    border-color: rgba(96, 165, 250, 0.2) !important;
  }

  .run-multi-option.active,
  .run-multi-option:hover {
    background: linear-gradient(135deg, #083044 0%, #0b2144 100%) !important;
    border-color: rgba(34, 211, 238, 0.58) !important;
  }

  .run-date-popover {
    z-index: 99999 !important;
    background: #f8fafc !important;
    color: #0f172a !important;
    border: 1px solid rgba(15, 23, 42, 0.14) !important;
    box-shadow: 0 34px 100px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.9) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  .date-popover-tabs { border-bottom-color: rgba(15, 23, 42, 0.1) !important; }
  .date-popover-tabs div { background: #ffffff !important; border: 1px solid rgba(15, 23, 42, 0.08) !important; }
  .date-popover-tabs span { color: #64748b !important; }
  .date-popover-tabs strong,
  .calendar-nav-row strong,
  .calendar-month-card h4 { color: #0f172a !important; }
  .date-preset-column button,
  .calendar-nav-row button { background: #ffffff !important; color: #0f172a !important; border: 1px solid rgba(15, 23, 42, 0.1) !important; }
  .date-preset-column button.active,
  .date-preset-column button:hover,
  .calendar-nav-row button:hover { background: #dcfce7 !important; color: #14532d !important; border-color: rgba(22, 163, 74, 0.28) !important; }
  .calendar-weekdays span { color: #94a3b8 !important; }
  .calendar-day { color: #0f172a !important; background: transparent !important; }
  .calendar-day.muted { color: #cbd5e1 !important; }
  .calendar-day.in-range { background: #e8f5ec !important; }
  .calendar-day.range-start,
  .calendar-day.range-end { color: #ffffff !important; border-radius: 999px; border-color: #15803d !important; background: #15803d !important; }
  .date-popover-actions { border-top: 1px solid rgba(15, 23, 42, 0.08); }
  .date-popover-actions .ghost-btn { background: #ffffff !important; color: #0f172a !important; border: 1px solid rgba(15, 23, 42, 0.1) !important; }
  .primary-btn.light { background: #15803d !important; color: #ffffff !important; }

  .monitor-column > .surface-card {
    width: 100%;
    box-sizing: border-box;
  }

  .run-summary-card .mini-grid.polished {
    width: 100%;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .run-summary-card .mini-grid.polished div {
    min-height: 78px;
  }


  .command-card,
  .control-block,
  .filter-control-block {
    overflow: visible !important;
  }

  .filter-control-block {
    position: relative;
    z-index: 80;
  }

  .control-block:has(.run-multi-filter.open),
  .filter-control-block:has(.run-multi-filter.open),
  .control-block:has(.run-date-range-picker.open),
  .filter-control-block:has(.run-date-range-picker.open) {
    z-index: 8000;
  }

  .quick-run-panel {
    margin: 0 0 14px;
    padding: 14px 16px;
    border-radius: 24px;
    display: grid;
    grid-template-columns: minmax(260px, 1fr) minmax(260px, 0.8fr) auto;
    align-items: center;
    gap: 14px;
    background:
      radial-gradient(circle at 0% 0%, rgba(34, 211, 238, 0.08), transparent 32%),
      linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(12, 16, 34, 0.98));
  }

  .quick-run-copy strong,
  .quick-run-copy small {
    display: block;
  }

  .quick-run-copy strong {
    color: #ffffff;
    font-size: 20px;
    letter-spacing: -0.02em;
    line-height: 1.3;
  }

  .quick-run-copy small {
    margin-top: 5px;
    color: #a9b4d0;
    font-size: 14px;
    font-weight: 750;
    line-height: 1.45;
  }

  .quick-run-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .quick-run-metrics div {
    min-height: 58px;
    padding: 10px 12px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  .quick-run-metrics span,
  .quick-run-metrics strong {
    display: block;
  }

  .quick-run-metrics span {
    color: #8ea0d6;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .quick-run-metrics strong {
    color: #ffffff;
    font-size: 20px;
    line-height: 1.1;
  }

  .quick-run-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
  }

  .quick-run-actions .primary-btn,
  .quick-run-actions .secondary-btn,
  .quick-run-actions .danger-btn {
    min-height: 44px;
  }

  @media (max-width: 1280px) {
    .hero-grid,
    .command-grid,
    .run-intro-strip,
    .quick-run-panel,
    .control-section-grid {
      grid-template-columns: 1fr;
    }

    .control-section-grid > .control-block,
    .control-section-grid > .filter-control-block,
    .control-section-grid > .action-block {
      grid-column: auto;
      grid-row: auto;
    }

    .hero-side-column,
    .monitor-column {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 1080px) {
    .stats-grid,
    .hero-quick-grid,
    .filter-control-grid,
    .filter-summary-grid,
    .behavior-grid,
    .conversation-grid,
    .results-grid,
    .mini-grid.polished,
    .run-meta-card.polished,
    .diagnostics-grid,
    .action-summary-grid,
    .progress-metrics-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .conversation-details.four {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 780px) {
    .run-page {
      padding-left: 12px;
      padding-right: 12px;
    }

    .stats-grid,
    .hero-quick-grid,
    .filter-control-grid,
    .filter-summary-grid,
    .date-popover-body,
    .calendar-months-grid,
    .behavior-grid,
    .conversation-grid,
    .results-grid,
    .mini-grid.polished,
    .run-meta-card.polished,
    .diagnostics-grid,
    .action-summary-grid,
    .progress-metrics-grid,
    .modal-note-grid,
    .form-grid.two {
      grid-template-columns: 1fr;
    }

    .section-head,
    .modal-shell-top,
    .progress-bottom-row,
    .auth-shell-card,
    .behavior-row,
    .conversation-head {
      flex-direction: column;
      align-items: stretch;
    }

    .header-right-meta,
    .result-metrics,
    .button-row,
    .modal-actions {
      justify-content: stretch;
    }

    .primary-btn,
    .secondary-btn,
    .danger-btn,
    .ghost-btn,
    .toggle-chip {
      width: 100%;
    }

    .log-item {
      grid-template-columns: 1fr;
    }

    .duplicate-modal {
      padding: 18px;
    }

    .duplicate-modal h2 {
      font-size: 28px;
    }
  }
  .fetched-queue-panel.compact-preview-panel { padding: 20px; }
  .fetched-queue-toolbar { display: grid; grid-template-columns: minmax(260px, 1fr) auto; gap: 14px; align-items: end; margin-bottom: 14px; }
  .queue-search-field span { display: block; margin-bottom: 8px; color: #8ea0d6; font-size: 13px; font-weight: 950; letter-spacing: .13em; text-transform: uppercase; }
  .queue-search-field input { width: 100%; min-height: 46px; padding: 0 14px; border-radius: 16px; border: 1px solid rgba(148,163,184,.16); color: #e7ecff; background: rgba(5,8,18,.92); outline: none; }
  .queue-toolbar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .queue-table-wrap { overflow: auto; border-radius: 18px; border: 1px solid rgba(148,163,184,.12); background: rgba(2,6,23,.35); max-height: 420px; }
  .queue-table { width: 100%; border-collapse: collapse; min-width: 980px; }
  .queue-table th, .queue-table td { padding: 12px 14px; border-bottom: 1px solid rgba(148,163,184,.1); text-align: left; vertical-align: top; }
  .queue-table th { color: #8ea0d6; background: rgba(15,23,42,.86); font-size: 12px; font-weight: 950; letter-spacing: .14em; text-transform: uppercase; position: sticky; top: 0; z-index: 5; }
  .queue-table td { color: #e7ecff; font-size: 15px; font-weight: 750; }
  .queue-table small { display: block; margin-top: 4px; color: #8ea0d6; font-size: 13px; line-height: 1.4; }
  .queue-select { width: 18px; height: 18px; accent-color: #22d3ee; }
  .queue-action-cell { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .queue-action-btn { min-height: 30px; padding: 0 10px; border-radius: 999px; border: 1px solid rgba(148,163,184,.18); background: rgba(15,23,42,.9); color: #e7ecff; font-size: 13px; font-weight: 900; cursor: pointer; text-decoration: none; white-space: nowrap; }
  .queue-action-btn:hover { border-color: rgba(34,211,238,.45); background: rgba(14,165,233,.16); }
  .queue-table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
  .ai-working-inline { display: inline-flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 999px; border: 1px solid rgba(148,163,184,.24); background: rgba(15,23,42,.78); color: #e5e7eb; font-size: 15px; font-weight: 900; box-shadow: 0 12px 34px rgba(0,0,0,.24); }
  .gear-loader { position: relative; width: 42px; height: 28px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
  .gear-loader::before, .gear-loader::after { content: "⚙︎"; position: absolute; font-family: Arial, Helvetica, sans-serif; line-height: 1; color: #d1d5db; text-shadow: 0 8px 18px rgba(0,0,0,.48); animation: gearSpin 1.8s linear infinite; }
  .gear-loader::before { left: 0; top: 0; font-size: 27px; }
  .gear-loader::after { left: 20px; top: 8px; font-size: 20px; color: #6b7280; animation-direction: reverse; animation-duration: 1.25s; }
  @keyframes gearSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .conversation-preview-backdrop { position: fixed; inset: 0; z-index: 999999; display: flex; align-items: center; justify-content: center; padding: 28px; background: rgba(2,6,23,.76); backdrop-filter: blur(16px); }
  .conversation-preview-modal { width: min(980px, 96vw); max-height: min(86vh, 860px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(148,163,184,.18); border-radius: 28px; background: linear-gradient(180deg,#10172b 0%,#050917 100%); box-shadow: 0 34px 120px rgba(0,0,0,.76), 0 0 0 1px rgba(96,165,250,.08); }
  .conversation-preview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 22px 24px; border-bottom: 1px solid rgba(148,163,184,.12); }
  .conversation-preview-head p { margin: 0 0 6px; color: #8ea0d6; font-size: 13px; font-weight: 950; letter-spacing: .14em; text-transform: uppercase; }
  .conversation-preview-head h2 { margin: 0 0 6px; color: #fff; font-size: 26px; letter-spacing: -.04em; }
  .conversation-preview-head span { color: #a9b4d0; font-size: 15px; font-weight: 750; }
  .conversation-preview-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  .conversation-preview-meta { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; padding: 16px 24px; border-bottom: 1px solid rgba(148,163,184,.1); }
  .conversation-preview-meta div { min-height: 62px; padding: 12px; border-radius: 16px; border: 1px solid rgba(148,163,184,.1); background: rgba(255,255,255,.035); }
  .conversation-preview-meta span, .conversation-preview-meta strong { display: block; }
  .conversation-preview-meta span { margin-bottom: 6px; color: #8ea0d6; font-size: 12px; font-weight: 950; letter-spacing: .12em; text-transform: uppercase; }
  .conversation-preview-meta strong { color: #f8fbff; font-size: 15px; line-height: 1.35; }
  .conversation-transcript-list { overflow: auto; padding: 20px 24px 24px; display: grid; gap: 12px; }
  .conversation-message { max-width: 82%; padding: 14px 16px; border-radius: 18px; border: 1px solid rgba(148,163,184,.12); background: rgba(15,23,42,.82); }
  .conversation-message.client { justify-self: start; border-color: rgba(59,130,246,.18); background: rgba(30,64,175,.18); }
  .conversation-message.agent { justify-self: end; border-color: rgba(16,185,129,.18); background: rgba(6,78,59,.18); }
  .conversation-message.system { justify-self: center; max-width: 92%; background: rgba(255,255,255,.045); }
  .conversation-message-top { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .conversation-message-top strong { color: #f8fbff; font-size: 15px; }
  .conversation-message-top span, .conversation-message small { color: #8ea0d6; font-size: 13px; font-weight: 800; }
  .conversation-message p { margin: 0; color: #dbe7ff; white-space: pre-wrap; line-height: 1.6; font-size: 15px; }
  .conversation-preview-loading, .conversation-preview-empty, .conversation-preview-error { margin: 20px 24px 24px; padding: 22px; border-radius: 18px; border: 1px dashed rgba(148,163,184,.18); color: #dbe7ff; background: rgba(15,23,42,.7); }
  .conversation-preview-error strong, .conversation-preview-error span, .conversation-preview-error small { display: block; }
  .conversation-preview-error strong { color: #fecaca; margin-bottom: 8px; }
  .conversation-preview-error span { color: #f8fbff; margin-bottom: 6px; }

`;
