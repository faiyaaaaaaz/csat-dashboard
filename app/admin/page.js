"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../../lib/supabase";

const MASTER_ADMIN_EMAIL = "faiyaz@nextventures.io";
const TIMEOUT_MS = 10000;

const ROLE_OPTIONS = [
  {
    value: "master_admin",
    label: "Master Admin",
    description: "Full control over audits, admin, prompts, mappings, users, and history.",
    defaultCanRunTests: true,
  },
  {
    value: "supervisor_admin",
    label: "Supervisor Admin",
    description: "Can view dashboard and results. Run Audit and Admin remain locked unless extra access is granted.",
    defaultCanRunTests: false,
  },
  {
    value: "co_admin",
    label: "Co-Admin",
    description: "Can access Admin operational controls such as mappings, prompt management, and Supervisor Teams.",
    defaultCanRunTests: false,
  },
  {
    value: "audit_runner",
    label: "Audit Runner",
    description: "Can access Run Audit and Results, but cannot manage Admin controls.",
    defaultCanRunTests: true,
  },
  {
    value: "viewer",
    label: "Viewer",
    description: "Can view dashboard only unless additional access is granted later.",
    defaultCanRunTests: false,
  },
];

const API_KEY_TYPES = [
  {
    value: "intercom",
    label: "Intercom",
    description: "Used when fetching conversations before audits.",
    placeholder: "Paste new Intercom API key",
  },
  {
    value: "openai",
    label: "OpenAI / GPT",
    description: "Used when running AI audit analysis.",
    placeholder: "Paste new OpenAI API key",
  },
];

const ACTIVITY_DATE_PRESET_OPTIONS = [
  { key: "all", label: "All Time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "past_7_days", label: "Past 7 Days" },
  { key: "past_30_days", label: "Past 30 Days" },
  { key: "this_month", label: "This Month" },
  { key: "custom", label: "Custom" },
];

const ACTIVITY_LIMIT_OPTIONS = [50, 100, 150, 300, 500, 1000];


function withTimeout(promise, label, timeoutMs = TIMEOUT_MS) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} took too long. The page was not locked. Try again or refresh once.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
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

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
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

function getActivityPresetRange(key) {
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
    default:
      return { startDate: "", endDate: "" };
  }
}

function activityDateLabel(startDate, endDate, presetKey) {
  const preset = ACTIVITY_DATE_PRESET_OPTIONS.find((item) => item.key === presetKey)?.label || "Custom";
  if (!startDate && !endDate) return preset === "Custom" ? "All Time" : preset;
  if (startDate && endDate) return `${startDate} to ${endDate}`;
  if (startDate) return `From ${startDate}`;
  return `Until ${endDate}`;
}

function toActivityDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : normalizeToStartOfDay(date);
}

function shiftActivityMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return normalizeToStartOfDay(next);
}

function activityMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function activityMonthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function sameActivityDay(a, b) {
  return a && b && formatDateInput(a) === formatDateInput(b);
}

function formatActivityMonthTitle(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function buildActivityCalendarDays(monthDate) {
  const first = activityMonthStart(monthDate);
  const last = activityMonthEnd(monthDate);
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

function isActivityDateInDraftRange(date, draftStart, draftEnd) {
  if (!draftStart || !draftEnd) return false;
  const value = normalizeToStartOfDay(date).getTime();
  return value >= normalizeToStartOfDay(draftStart).getTime() && value <= normalizeToStartOfDay(draftEnd).getTime();
}

function AdminActivityCalendarMonth({ monthDate, draftStart, draftEnd, onSelectDate }) {
  const days = buildActivityCalendarDays(monthDate);

  return (
    <div className="admin-calendar-month-card">
      <h4>{formatActivityMonthTitle(monthDate)}</h4>
      <div className="admin-calendar-weekdays notranslate" translate="no">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} className="notranslate" translate="no">{day}</span>)}
      </div>
      <div className="admin-calendar-day-grid">
        {days.map(({ date, muted }) => {
          const isStart = draftStart && sameActivityDay(date, draftStart);
          const isEnd = draftEnd && sameActivityDay(date, draftEnd);
          const inRange = isActivityDateInDraftRange(date, draftStart, draftEnd);

          return (
            <button
              key={formatDateInput(date)}
              type="button"
              className={["admin-calendar-day", muted ? "muted" : "", inRange ? "in-range" : "", isStart ? "range-start" : "", isEnd ? "range-end" : ""].filter(Boolean).join(" ")}
              onClick={() => onSelectDate(date)}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatActivityPath(path) {
  const text = normalizeText(path);
  if (!text) return "No path saved";
  if (text === "/") return "Dashboard";
  return text
    .replace(/^\//, "")
    .replaceAll("/", " / ")
    .replaceAll("-", " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function pagePathFromActivityDescription(description) {
  const text = normalizeText(description);
  if (!text) return "";

  const match = text.match(/\b(?:viewed|opened)\s+(\/[^.\s]*)/i);
  return normalizeText(match?.[1]);
}

function readablePageFromLog(row) {
  const metadata = row && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
  const savedPage = normalizeText(metadata.page || metadata.pathname || metadata.route || row?.target_id);
  const targetLabel = normalizeText(row?.target_label);
  const descriptionPage = pagePathFromActivityDescription(row?.description);

  if (targetLabel && targetLabel !== "No direct target") return targetLabel;
  if (savedPage) return formatActivityPath(savedPage);
  if (descriptionPage) return formatActivityPath(descriptionPage);

  const requestPath = normalizeText(row?.request_path);
  if (requestPath === "/api/admin/activity-logs") return "App Session Tracker";
  return formatActivityPath(requestPath);
}

function summarizeActivityLog(row) {
  const actor = normalizeText(row?.actor_name) || normalizeText(row?.actor_email) || "A user";
  const action = normalizeText(row?.action_type);
  const savedDescription = normalizeText(row?.description);

  if (action === "page_viewed") {
    const pageLabel = readablePageFromLog(row);
    if (pageLabel === "App Session Tracker") {
      return `${actor} generated a navigation tracking event.`;
    }
    return `${actor} opened ${pageLabel}.`;
  }

  if (action === "session_ended") return `${actor} signed out.`;
  if (savedDescription) return savedDescription;

  const label = normalizeText(row?.action_label) || activityActionLabel(action);
  return `${actor} performed ${label}.`;
}

function summarizeActivityTarget(row) {
  const action = normalizeText(row?.action_type);
  if (action === "page_viewed") return readablePageFromLog(row);
  return normalizeText(row?.target_label) || normalizeText(row?.target_id) || normalizeText(row?.target_type) || "No direct target";
}

function activityTechnicalPath(row) {
  const metadata = row && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
  const savedPage = normalizeText(metadata.page || metadata.pathname || metadata.route || row?.target_id);
  const requestPath = normalizeText(row?.request_path);

  if (savedPage && requestPath) return `Page: ${savedPage} · Tracker API: ${requestPath}`;
  if (savedPage) return `Page: ${savedPage}`;
  if (requestPath) return `Tracker API: ${requestPath}`;
  return "No path saved";
}

function safeJsonPreview(value) {
  if (!value || typeof value !== "object") return "No structured data saved.";

  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return "Could not render structured data.";
  }
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

function HelpTip({ text }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 340, placement: "top" });
  const buttonRef = useRef(null);

  function updateTooltipPosition() {
    if (!buttonRef.current || typeof window === "undefined") return;

    const rect = buttonRef.current.getBoundingClientRect();
    const tooltipWidth = Math.min(360, Math.max(280, window.innerWidth - 32));
    const left = Math.min(
      Math.max(16, rect.left + rect.width / 2 - tooltipWidth / 2),
      window.innerWidth - tooltipWidth - 16
    );
    const hasRoomAbove = rect.top > 130;
    const top = hasRoomAbove ? rect.top - 12 : rect.bottom + 12;

    setPosition({
      top,
      left,
      width: tooltipWidth,
      placement: hasRoomAbove ? "top" : "bottom",
    });
  }

  function showTooltip() {
    updateTooltipPosition();
    setOpen(true);
  }

  function hideTooltip() {
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return undefined;

    function syncPosition() {
      updateTooltipPosition();
    }

    window.addEventListener("scroll", syncPosition, true);
    window.addEventListener("resize", syncPosition);

    return () => {
      window.removeEventListener("scroll", syncPosition, true);
      window.removeEventListener("resize", syncPosition);
    };
  }, [open]);

  return (
    <span className="help-tip-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="help-tip"
        aria-label={text}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        ?
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className={`help-tip-popover ${position.placement}`}
              role="tooltip"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              {text}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}

function MoreMembersChip({ members = [], count = 0 }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 320, placement: "top" });
  const chipRef = useRef(null);

  const hiddenMembers = useMemo(
    () =>
      (members || [])
        .map((member) => member?.employee_name || member?.employee_email || member?.intercom_agent_name || "Unnamed member")
        .filter(Boolean),
    [members]
  );

  const tooltipText = hiddenMembers.join(", ");

  function updateTooltipPosition() {
    if (!chipRef.current || typeof window === "undefined") return;

    const rect = chipRef.current.getBoundingClientRect();
    const tooltipWidth = Math.min(360, Math.max(260, window.innerWidth - 32));
    const left = Math.min(
      Math.max(16, rect.left + rect.width / 2 - tooltipWidth / 2),
      window.innerWidth - tooltipWidth - 16
    );
    const hasRoomAbove = rect.top > 150;
    const top = hasRoomAbove ? rect.top - 10 : rect.bottom + 10;

    setPosition({
      top,
      left,
      width: tooltipWidth,
      placement: hasRoomAbove ? "top" : "bottom",
    });
  }

  function showTooltip() {
    updateTooltipPosition();
    setOpen(true);
  }

  function hideTooltip() {
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return undefined;

    function syncPosition() {
      updateTooltipPosition();
    }

    window.addEventListener("scroll", syncPosition, true);
    window.addEventListener("resize", syncPosition);

    return () => {
      window.removeEventListener("scroll", syncPosition, true);
      window.removeEventListener("resize", syncPosition);
    };
  }, [open]);

  if (!count || !hiddenMembers.length) return null;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="member-more-chip notranslate"
        translate="no"
        aria-label={`Show ${formatNumber(count)} hidden team member${count === 1 ? "" : "s"}: ${tooltipText}`}
        title={tooltipText}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        +{formatNumber(count)} more
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className={`member-more-popover ${position.placement}`}
              role="tooltip"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              <strong>Hidden Team Members</strong>
              <div className="notranslate" translate="no">{tooltipText}</div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function AdminActivityDateRangePicker({ startDate, endDate, presetKey, onApplyPreset, onApplyCustom }) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(() => toActivityDate(startDate));
  const [draftEnd, setDraftEnd] = useState(() => toActivityDate(endDate));
  const [visibleMonth, setVisibleMonth] = useState(() => activityMonthStart(toActivityDate(startDate) || new Date()));
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const nextStart = toActivityDate(startDate);
    const nextEnd = toActivityDate(endDate);
    setDraftStart(nextStart);
    setDraftEnd(nextEnd);
    setVisibleMonth(activityMonthStart(nextStart || new Date()));
  }, [open, startDate, endDate]);

  useEffect(() => {
    function handleOutside(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    }

    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  function applyPreset(key) {
    onApplyPreset(key);
    if (key !== "custom") setOpen(false);
  }

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

  const selectedPreset = ACTIVITY_DATE_PRESET_OPTIONS.find((item) => item.key === presetKey)?.label || "Custom";
  const displayRange = activityDateLabel(startDate, endDate, presetKey);
  const secondMonth = shiftActivityMonths(visibleMonth, 1);

  return (
    <div className={open ? "admin-date-range-field open" : "admin-date-range-field"} ref={wrapRef}>
      <label>
        <span>
          Date Range
          <HelpTip text="Choose a preset or click two dates on the calendar. This controls which activity logs and sessions are loaded." />
        </span>
        <button type="button" className="admin-date-button" onClick={() => setOpen((prev) => !prev)}>
          <strong><CalendarIcon /> {selectedPreset}</strong>
          <small>{displayRange}</small>
          <b>{open ? "Up" : "Down"}</b>
        </button>
      </label>

      {open ? (
        <div className="admin-date-popover">
          <div className="admin-date-popover-tabs">
            <div>
              <span>From</span>
              <strong>{draftStart ? formatDateInput(draftStart) : "Choose Start"}</strong>
            </div>
            <div className={draftEnd ? "active" : ""}>
              <span>To</span>
              <strong>{draftEnd ? formatDateInput(draftEnd) : "Choose End"}</strong>
            </div>
          </div>

          <div className="admin-date-popover-body">
            <aside className="admin-date-preset-column">
              {ACTIVITY_DATE_PRESET_OPTIONS.map((item) => (
                <button key={item.key} type="button" className={item.key === presetKey ? "active" : ""} onClick={() => applyPreset(item.key)}>
                  {item.label}
                </button>
              ))}
            </aside>

            <div className="admin-date-calendar-zone">
              <div className="admin-calendar-nav-row">
                <button type="button" onClick={() => setVisibleMonth((prev) => shiftActivityMonths(prev, -1))}>‹</button>
                <strong>{formatActivityMonthTitle(visibleMonth)} - {formatActivityMonthTitle(secondMonth)}</strong>
                <button type="button" onClick={() => setVisibleMonth((prev) => shiftActivityMonths(prev, 1))}>›</button>
              </div>

              <div className="admin-calendar-months-grid">
                <AdminActivityCalendarMonth monthDate={visibleMonth} draftStart={draftStart} draftEnd={draftEnd} onSelectDate={selectDate} />
                <AdminActivityCalendarMonth monthDate={secondMonth} draftStart={draftStart} draftEnd={draftEnd} onSelectDate={selectDate} />
              </div>
            </div>
          </div>

          <div className="admin-date-popover-actions">
            <button type="button" className="secondary-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={applyCustomRange} disabled={!draftStart && !draftEnd}>Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
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
      full_name: user.user_metadata?.full_name || "",
      role: "viewer",
      can_run_tests: false,
      is_active: true,
    };
  }

  return null;
}

function canManageAdmin(profile) {
  const role = normalizeKey(profile?.role);

  return Boolean(
    profile?.is_active === true &&
      (role === "master_admin" || role === "admin" || role === "co_admin")
  );
}

function canManageUsers(profile) {
  const email = normalizeEmail(profile?.email);
  const role = normalizeKey(profile?.role);

  return Boolean(
    profile?.is_active === true &&
      (email === MASTER_ADMIN_EMAIL || role === "master_admin" || role === "admin")
  );
}

function canManageApiKeys(profile) {
  const email = normalizeEmail(profile?.email);
  const role = normalizeKey(profile?.role);

  return Boolean(
    profile?.is_active === true && email === MASTER_ADMIN_EMAIL && role === "master_admin"
  );
}

function canViewActivityLogs(profile) {
  const email = normalizeEmail(profile?.email);
  const role = normalizeKey(profile?.role);

  return Boolean(
    profile?.is_active === true && (email === MASTER_ADMIN_EMAIL || role === "master_admin")
  );
}

function createEmptyActivityFilters() {
  return {
    start_date: "",
    end_date: "",
    email: "",
    action_type: "",
    status: "",
    area: "",
    search: "",
  };
}

function formatDuration(seconds) {
  const totalSeconds = Number(seconds || 0);

  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "Active / Unknown";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = Math.floor(totalSeconds % 60);

  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;

  return `${remainingSeconds}s`;
}

function activityActionLabel(value) {
  const normalized = normalizeText(value).replaceAll("_", " ");
  if (!normalized) return "Activity";

  return normalized
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function createEmptyApiKeyForm() {
  return {
    key_label: "Primary key",
    secret_value: "",
    make_active: true,
  };
}

function apiTypeLabel(keyType) {
  return API_KEY_TYPES.find((item) => item.value === keyType)?.label || keyType;
}

function roleLabel(role) {
  const found = ROLE_OPTIONS.find((item) => item.value === role);
  if (found) return found.label;

  return String(role || "viewer")
    .replaceAll("_", " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function roleDescription(role) {
  const found = ROLE_OPTIONS.find((item) => item.value === role);
  return found?.description || "Legacy or custom role.";
}

function getMemberKey(member) {
  return normalizeEmail(member?.employee_email) || normalizeKey(member?.employee_name);
}

function createEmptyMappingForm() {
  return {
    id: "",
    intercom_agent_name: "",
    employee_name: "",
    employee_email: "",
    team_name: "",
    notes: "",
    is_active: true,
  };
}

function createEmptyRoleForm() {
  return {
    id: "",
    email: "",
    full_name: "",
    role: "viewer",
    can_run_tests: false,
    is_active: true,
  };
}

function createEmptySupervisorForm() {
  return {
    id: "",
    supervisor_name: "",
    supervisor_email: "",
    notes: "",
    is_active: true,
    members: [],
  };
}

function buildEmployeeOptionsFromMappings(rows) {
  const byEmployee = new Map();

  for (const row of rows || []) {
    if (row?.is_active === false) continue;

    const employeeName = normalizeText(row?.employee_name);
    if (!employeeName) continue;

    const key = normalizeEmail(row?.employee_email) || normalizeKey(employeeName);

    if (!byEmployee.has(key)) {
      byEmployee.set(key, {
        employee_name: employeeName,
        employee_email: row?.employee_email || null,
        intercom_agent_name: row?.intercom_agent_name || null,
        team_name: row?.team_name || null,
      });
    }
  }

  return Array.from(byEmployee.values()).sort((a, b) =>
    a.employee_name.localeCompare(b.employee_name)
  );
}

function sortSupervisorTeams(teams) {
  return [...(teams || [])].sort((a, b) =>
    normalizeText(a?.supervisor_name).localeCompare(normalizeText(b?.supervisor_name))
  );
}

function getRowDate(row) {
  return row?.replied_at || row?.created_at || null;
}

function buildStoredAgentStats(auditRows) {
  const stats = new Map();

  for (const row of auditRows || []) {
    const agentName = normalizeText(row?.agent_name);
    const key = normalizeKey(agentName);
    if (!key) continue;

    const current = stats.get(key) || {
      agent_name: agentName,
      appearances: 0,
      mapped_result_count: 0,
      unmapped_result_count: 0,
      latest_seen_at: getRowDate(row),
    };

    current.appearances += 1;

    const matchStatus = normalizeKey(row?.employee_match_status);
    if (matchStatus === "mapped") current.mapped_result_count += 1;
    if (matchStatus === "unmapped") current.unmapped_result_count += 1;

    const previousSeen = new Date(current.latest_seen_at || 0).getTime();
    const rowSeen = new Date(getRowDate(row) || 0).getTime();

    if (rowSeen > previousSeen) {
      current.latest_seen_at = getRowDate(row);
    }

    stats.set(key, current);
  }

  return stats;
}

function buildSuggestions(existingMappings, auditRows) {
  const existingKeys = new Set(
    (existingMappings || [])
      .map((item) => normalizeKey(item?.intercom_agent_name))
      .filter(Boolean)
  );

  const byAgent = new Map();

  for (const row of auditRows || []) {
    const rawAgent = normalizeText(row?.agent_name);
    const key = normalizeKey(rawAgent);

    if (!key || existingKeys.has(key)) continue;

    const current = byAgent.get(key) || {
      intercom_agent_name: rawAgent,
      employee_name: "",
      employee_email: "",
      team_name: "",
      notes: "Detected from stored audit results.",
      result_count: 0,
      latest_seen_at: getRowDate(row),
    };

    current.result_count += 1;

    if (!current.employee_name && row?.employee_name) {
      current.employee_name = normalizeText(row.employee_name);
    }

    if (!current.employee_email && row?.employee_email) {
      current.employee_email = normalizeText(row.employee_email);
    }

    if (!current.team_name && row?.team_name) {
      current.team_name = normalizeText(row.team_name);
    }

    const previousSeen = new Date(current.latest_seen_at || 0).getTime();
    const rowSeen = new Date(getRowDate(row) || 0).getTime();

    if (rowSeen > previousSeen) {
      current.latest_seen_at = getRowDate(row);
    }

    byAgent.set(key, current);
  }

  return Array.from(byAgent.values())
    .map((item) => ({
      ...item,
      employee_name: item.employee_name || item.intercom_agent_name,
    }))
    .sort((a, b) => b.result_count - a.result_count);
}

function buildUnmappedRows(existingMappings, auditRows) {
  const activeKeys = new Set(
    (existingMappings || [])
      .filter((item) => item?.is_active !== false)
      .map((item) => normalizeKey(item?.intercom_agent_name))
      .filter(Boolean)
  );

  const inactiveKeys = new Set(
    (existingMappings || [])
      .filter((item) => item?.is_active === false)
      .map((item) => normalizeKey(item?.intercom_agent_name))
      .filter(Boolean)
  );

  const grouped = new Map();

  for (const row of auditRows || []) {
    const rawAgent = normalizeText(row?.agent_name);
    const key = normalizeKey(rawAgent);
    if (!key || activeKeys.has(key)) continue;

    const issueType = inactiveKeys.has(key) ? "inactive_mapping" : "missing_mapping";

    const current = grouped.get(key) || {
      intercom_agent_name: rawAgent,
      issue_type: issueType,
      issue_label: issueType === "inactive_mapping" ? "Inactive mapping" : "No active mapping",
      appearances: 0,
      latest_seen_at: getRowDate(row),
      sample_employee_name: normalizeText(row?.employee_name),
      sample_employee_email: normalizeText(row?.employee_email),
      sample_team_name: normalizeText(row?.team_name),
    };

    current.appearances += 1;

    const previousSeen = new Date(current.latest_seen_at || 0).getTime();
    const rowSeen = new Date(getRowDate(row) || 0).getTime();

    if (rowSeen > previousSeen) {
      current.latest_seen_at = getRowDate(row);
      current.sample_employee_name = normalizeText(row?.employee_name);
      current.sample_employee_email = normalizeText(row?.employee_email);
      current.sample_team_name = normalizeText(row?.team_name);
    }

    grouped.set(key, current);
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (a.issue_type !== b.issue_type) {
      return a.issue_type === "missing_mapping" ? -1 : 1;
    }

    if (a.appearances !== b.appearances) return b.appearances - a.appearances;
    return a.intercom_agent_name.localeCompare(b.intercom_agent_name);
  });
}

function getMappingQuality(row, stats) {
  if (row?.is_active === false) {
    return {
      key: "inactive",
      label: "Inactive",
      detail: "Not used for future audits.",
      tone: "warning",
    };
  }

  const missingEmail = !normalizeText(row?.employee_email);
  const missingTeam = !normalizeText(row?.team_name);

  if (missingEmail && missingTeam) {
    return {
      key: "missing_email_team",
      label: "Needs email and team",
      detail: "Complete the employee profile.",
      tone: "warning",
    };
  }

  if (missingEmail) {
    return {
      key: "missing_email",
      label: "Needs email",
      detail: "Employee email is blank.",
      tone: "notice",
    };
  }

  if (missingTeam) {
    return {
      key: "missing_team",
      label: "Needs team",
      detail: "Team is blank.",
      tone: "notice",
    };
  }

  if (!stats?.appearances) {
    return {
      key: "no_stored_usage",
      label: "Ready",
      detail: "No recent stored usage.",
      tone: "neutral",
    };
  }

  return {
    key: "healthy",
    label: "Healthy",
    detail: "Active and complete.",
    tone: "success",
  };
}

function toneClass(tone) {
  if (tone === "success") return "tone success";
  if (tone === "warning") return "tone warning";
  if (tone === "danger") return "tone danger";
  if (tone === "notice") return "tone notice";
  return "tone neutral";
}

function getLockedNameForEmail(email, mappings) {
  const normalized = normalizeEmail(email);

  if (!normalized) return "";

  const match = (mappings || []).find(
    (item) => normalizeEmail(item?.employee_email) === normalized
  );

  return normalizeText(match?.employee_name);
}

function getCanonicalSupervisorName(team, mappings) {
  const lockedName = getLockedNameForEmail(team?.supervisor_email, mappings);
  const savedName = normalizeText(team?.supervisor_name);
  const email = normalizeEmail(team?.supervisor_email);

  return lockedName || savedName || email || "Supervisor Team";
}

function getSavedNameMismatchNote(savedName, displayName) {
  const saved = normalizeText(savedName);
  const display = normalizeText(displayName);

  if (!saved || !display || normalizeKey(saved) === normalizeKey(display)) return "";

  return `Saved label: ${saved}`;
}

async function readApiJson(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`Server returned a non-JSON response. Status ${response.status}.`);
  }
}

export default function AdminPage() {
  const mappingFormRef = useRef(null);
  const roleFormRef = useRef(null);
  const supervisorFormRef = useRef(null);

  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMessage, setAuthMessage] = useState("");

  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [pageSuccess, setPageSuccess] = useState("");
  const [showJumpTop, setShowJumpTop] = useState(false);

  const [dbReady, setDbReady] = useState(false);
  const [promptData, setPromptData] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [livePromptInput, setLivePromptInput] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [saveLoading, setSaveLoading] = useState(false);

  const [mappingRows, setMappingRows] = useState([]);
  const [auditRows, setAuditRows] = useState([]);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingForm, setMappingForm] = useState(createEmptyMappingForm());
  const [mappingSearch, setMappingSearch] = useState("");
  const [mappingStatusFilter, setMappingStatusFilter] = useState("all");
  const [mappingQualityFilter, setMappingQualityFilter] = useState("all");
  const [mappingSaveLoading, setMappingSaveLoading] = useState(false);
  const [mappingToggleLoadingId, setMappingToggleLoadingId] = useState("");
  const [seedLoading, setSeedLoading] = useState(false);

  const [profileRows, setProfileRows] = useState([]);
  const [roleGrantRows, setRoleGrantRows] = useState([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [roleForm, setRoleForm] = useState(createEmptyRoleForm());
  const [roleSearch, setRoleSearch] = useState("");
  const [roleCandidateSearch, setRoleCandidateSearch] = useState("");
  const [roleSaveLoading, setRoleSaveLoading] = useState(false);

  const [apiKeys, setApiKeys] = useState([]);
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [apiKeySaveLoading, setApiKeySaveLoading] = useState("");
  const [apiKeyActionLoadingId, setApiKeyActionLoadingId] = useState("");
  const [apiKeyForms, setApiKeyForms] = useState({
    intercom: createEmptyApiKeyForm(),
    openai: createEmptyApiKeyForm(),
  });

  const [supervisorTeams, setSupervisorTeams] = useState([]);
  const [supervisorEmployeeOptions, setSupervisorEmployeeOptions] = useState([]);
  const [supervisorLoading, setSupervisorLoading] = useState(false);
  const [supervisorSaveLoading, setSupervisorSaveLoading] = useState(false);
  const [supervisorToggleLoadingId, setSupervisorToggleLoadingId] = useState("");
  const [supervisorForm, setSupervisorForm] = useState(createEmptySupervisorForm());
  const [supervisorSearch, setSupervisorSearch] = useState("");
  const [supervisorMemberSearch, setSupervisorMemberSearch] = useState("");

  const [activityLogs, setActivityLogs] = useState([]);
  const [activitySessions, setActivitySessions] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [activityFilters, setActivityFilters] = useState(createEmptyActivityFilters());
  const [activityLimit, setActivityLimit] = useState(150);
  const [activityVisibleCount, setActivityVisibleCount] = useState(25);
  const [activityDatePreset, setActivityDatePreset] = useState("all");
  const [expandedActivityLogId, setExpandedActivityLogId] = useState("");

  const isAdmin = canManageAdmin(profile);
  const canManageUsersNow = canManageUsers(profile);
  const canManageApiKeysNow = canManageApiKeys(profile);
  const canViewActivityLogsNow = canViewActivityLogs(profile);

  const activityActionOptions = useMemo(() => {
    const values = new Set(activityLogs.map((row) => normalizeText(row.action_type)).filter(Boolean));
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [activityLogs]);

  const activityAreaOptions = useMemo(() => {
    const values = new Set(activityLogs.map((row) => normalizeText(row.area)).filter(Boolean));
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [activityLogs]);

  const activeActivitySessions = useMemo(
    () => activitySessions.filter((item) => item.status === "active").length,
    [activitySessions]
  );

  const visibleActivityLogs = useMemo(
    () => activityLogs.slice(0, activityVisibleCount),
    [activityLogs, activityVisibleCount]
  );

  function updateActivityFilter(key, value) {
    setActivityFilters((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  function applyActivityPreset(key) {
    setActivityDatePreset(key);
    const range = getActivityPresetRange(key);
    setActivityFilters((prev) => ({
      ...prev,
      start_date: range.startDate,
      end_date: range.endDate,
    }));
  }

  function applyCustomActivityRange(startDate, endDate) {
    setActivityDatePreset("custom");
    setActivityFilters((prev) => ({
      ...prev,
      start_date: startDate || "",
      end_date: endDate || "",
    }));
  }

  async function getFreshSession() {
    const result = await withTimeout(supabase.auth.getSession(), "Session check");

    const nextSession = result?.data?.session || null;
    setSession(nextSession);

    if (!nextSession?.access_token) {
      throw new Error("Your login session is missing or expired. Please sign in again.");
    }

    return nextSession;
  }

  async function loadProfile(user) {
    const email = normalizeEmail(user?.email);
    const domain = email.split("@")[1] || "";

    if (!user) return { profile: null, message: "" };

    if (domain !== "nextventures.io") {
      return {
        profile: null,
        message: "Access blocked. Use a nextventures.io Google account.",
      };
    }

    const fallbackProfile = buildFallbackProfile(user);

    try {
      const { data, error } = await withTimeout(
        supabase
          .from("profiles")
          .select("id, email, full_name, role, can_run_tests, is_active")
          .or(`id.eq.${user.id},email.eq.${email}`)
          .maybeSingle(),
        "Profile check"
      );

      if (error) {
        if (fallbackProfile) return { profile: fallbackProfile, message: "" };

        return {
          profile: null,
          message: error.message || "Signed in, but profile loading failed.",
        };
      }

      if (data) {
        if (email === MASTER_ADMIN_EMAIL) {
          return {
            profile: {
              ...data,
              email,
              role: "master_admin",
              can_run_tests: true,
              is_active: true,
            },
            message: "",
          };
        }

        return { profile: data, message: "" };
      }

      if (fallbackProfile) return { profile: fallbackProfile, message: "" };

      return {
        profile: {
          id: user.id,
          email,
          full_name: user.user_metadata?.full_name || "",
          role: "viewer",
          can_run_tests: false,
          is_active: true,
        },
        message: "Signed in, but this account has not been granted Admin access.",
      };
    } catch (error) {
      if (fallbackProfile) return { profile: fallbackProfile, message: "" };

      return {
        profile: null,
        message: error instanceof Error ? error.message : "Signed in, but profile loading failed.",
      };
    }
  }

  async function loadPromptData(activeSession) {
    if (!activeSession?.access_token) {
      setPromptData(null);
      setHistoryRows([]);
      setDbReady(false);
      return;
    }

    const response = await withTimeout(
      fetch("/api/admin/prompt", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${activeSession.access_token}`,
        },
      }),
      "Loading prompt settings"
    );

    const data = await readApiJson(response);

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "Could not load Admin prompt settings.");
    }

    setPromptData(data.prompt || null);
    setHistoryRows(Array.isArray(data.history) ? data.history : []);
    setDbReady(Boolean(data.dbReady));
    setLivePromptInput(data?.prompt?.livePrompt || "");
  }

  async function loadMappingsData() {
    setMappingLoading(true);

    try {
      const [mappingsResponse, auditResponse] = await Promise.all([
        withTimeout(
          supabase
            .from("agent_mappings")
            .select("*")
            .order("employee_name", { ascending: true })
            .order("intercom_agent_name", { ascending: true }),
          "Loading agent mappings"
        ),
        withTimeout(
          supabase
            .from("audit_results")
            .select(
              "id, agent_name, employee_name, employee_email, team_name, employee_match_status, created_at, replied_at"
            )
            .order("created_at", { ascending: false })
            .limit(5000),
          "Loading stored audit samples"
        ),
      ]);

      if (mappingsResponse.error) {
        throw new Error(mappingsResponse.error.message || "Could not load agent mappings.");
      }

      if (auditResponse.error) {
        throw new Error(auditResponse.error.message || "Could not load audit rows.");
      }

      const mappings = Array.isArray(mappingsResponse.data) ? mappingsResponse.data : [];

      setMappingRows(mappings);
      setAuditRows(Array.isArray(auditResponse.data) ? auditResponse.data : []);
      setSupervisorEmployeeOptions(buildEmployeeOptionsFromMappings(mappings));
    } finally {
      setMappingLoading(false);
    }
  }

  async function loadSupervisorTeamsData(activeSession = session) {
    setSupervisorLoading(true);

    try {
      const usableSession = activeSession?.access_token ? activeSession : await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/supervisor-teams", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${usableSession.access_token}`,
          },
          cache: "no-store",
        }),
        "Loading Supervisor Teams"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not load Supervisor Teams.");
      }

      setSupervisorTeams(sortSupervisorTeams(Array.isArray(data.teams) ? data.teams : []));

      if (Array.isArray(data.employeeOptions) && data.employeeOptions.length > 0) {
        setSupervisorEmployeeOptions(data.employeeOptions);
      }
    } finally {
      setSupervisorLoading(false);
    }
  }

  async function loadRoleAccessData(activeSession, allowed = canManageUsersNow) {
    if (!allowed || !activeSession?.access_token) {
      setProfileRows([]);
      setRoleGrantRows([]);
      return;
    }

    setProfileLoading(true);

    try {
      const response = await withTimeout(
        fetch("/api/admin/role-grants", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${activeSession.access_token}`,
          },
        }),
        "Loading user role grants"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not load user role grants.");
      }

      setProfileRows(Array.isArray(data.profiles) ? data.profiles : []);
      setRoleGrantRows(Array.isArray(data.grants) ? data.grants : []);
    } finally {
      setProfileLoading(false);
    }
  }


  async function loadApiKeysData(activeSession, allowed = canManageApiKeysNow) {
    if (!allowed || !activeSession?.access_token) {
      setApiKeys([]);
      return;
    }

    setApiKeyLoading(true);

    try {
      const response = await withTimeout(
        fetch("/api/admin/api-keys", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${activeSession.access_token}`,
          },
        }),
        "Loading API keys"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not load API keys.");
      }

      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
    } finally {
      setApiKeyLoading(false);
    }
  }

  async function loadActivityLogsData(activeSession, allowed = canViewActivityLogsNow, filters = activityFilters) {
    if (!allowed || !activeSession?.access_token) {
      setActivityLogs([]);
      setActivitySessions([]);
      return;
    }

    setActivityLoading(true);
    setActivityError("");

    try {
      const params = new URLSearchParams();
      params.set("limit", String(activityLimit || 150));

      for (const [key, value] of Object.entries(filters || {})) {
        const normalized = normalizeText(value);
        if (normalized) params.set(key, normalized);
      }

      const response = await withTimeout(
        fetch(`/api/admin/activity-logs?${params.toString()}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${activeSession.access_token}`,
          },
          cache: "no-store",
        }),
        "Loading system activity logs"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not load system activity logs.");
      }

      setActivityLogs(Array.isArray(data.logs) ? data.logs : []);
      setActivitySessions(Array.isArray(data.sessions) ? data.sessions : []);
      setActivityVisibleCount(25);
      setExpandedActivityLogId("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load system activity logs.";
      setActivityError(message);
      setActivityLogs([]);
      setActivitySessions([]);
    } finally {
      setActivityLoading(false);
    }
  }

  async function handleRefreshActivityLogs(nextFilters = activityFilters) {
    setPageError("");

    try {
      const freshSession = await getFreshSession();
      await loadActivityLogsData(freshSession, canViewActivityLogsNow, nextFilters);
    } catch (error) {
      setActivityError(error instanceof Error ? error.message : "Could not refresh system activity logs.");
    }
  }

  function handleClearActivityFilters() {
    const nextFilters = createEmptyActivityFilters();
    setActivityDatePreset("all");
    setActivityFilters(nextFilters);
    handleRefreshActivityLogs(nextFilters);
  }

  function handleExportActivityLogs() {
    const headers = [
      "Timestamp",
      "User name",
      "User email",
      "Role",
      "Action",
      "Area",
      "Status",
      "Target",
      "Description",
      "Session ID",
    ];

    const csvRows = activityLogs.map((row) => [
      formatDateTime(row.created_at),
      row.actor_name || "",
      row.actor_email || "",
      roleLabel(row.actor_role),
      row.action_label || activityActionLabel(row.action_type),
      row.area || "",
      row.status || "",
      row.target_label || row.target_id || "",
      row.description || "",
      row.session_id || "",
    ]);

    const csv = [headers, ...csvRows]
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `system-activity-logs-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadAll(activeSession, options = {}) {
    const silent = options.silent === true;
    const effectiveProfile = options.profile || profile;
    const allowApiKeys = canManageApiKeys(effectiveProfile);

    if (!silent) {
      setLoading(true);
      setPageError("");
      setPageSuccess("");
    }

    const jobs = [
      loadPromptData(activeSession),
      loadMappingsData(),
      loadSupervisorTeamsData(activeSession),
      loadRoleAccessData(activeSession, canManageUsers(effectiveProfile)),
    ];

    if (allowApiKeys) {
      jobs.push(loadApiKeysData(activeSession, true));
    } else {
      setApiKeys([]);
    }

    if (canViewActivityLogs(effectiveProfile)) {
      jobs.push(loadActivityLogsData(activeSession, true));
    } else {
      setActivityLogs([]);
      setActivitySessions([]);
    }

    const results = await Promise.allSettled(jobs);
    const rejected = results.find((item) => item.status === "rejected");

    if (rejected) {
      setPageError(
        rejected.reason instanceof Error
          ? rejected.reason.message
          : "Some Admin data could not load."
      );
    } else if (!silent) {
      setPageSuccess("Admin loaded successfully.");
    }

    if (!silent) setLoading(false);
  }

  async function bootAdmin() {
    setAuthChecked(false);
    setAuthMessage("");
    setPageError("");

    try {
      const result = await withTimeout(supabase.auth.getSession(), "Session check");
      const currentSession = result?.data?.session || null;

      setSession(currentSession);

      if (!currentSession?.user) {
        setProfile(null);
        setAuthChecked(true);
        setLoading(false);
        return;
      }

      const profileResult = await loadProfile(currentSession.user);
      setProfile(profileResult.profile);
      setAuthMessage(profileResult.message || "");
      setAuthChecked(true);

      if (profileResult.profile && canManageAdmin(profileResult.profile)) {
        await loadAll(currentSession, { silent: true, profile: profileResult.profile });
      }

      setLoading(false);
    } catch (error) {
      setSession(null);
      setProfile(null);
      setAuthChecked(true);
      setLoading(false);
      setPageError(
        error instanceof Error
          ? error.message
          : "Could not complete Admin session check."
      );
    }
  }

  useEffect(() => {
    let active = true;

    bootAdmin();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;

      const isBackgroundRefresh = event === "TOKEN_REFRESHED" || event === "USER_UPDATED";

      setSession(nextSession || null);

      if (!nextSession?.user) {
        setProfile(null);
        setAuthChecked(true);
        setAuthMessage("");
        return;
      }

      loadProfile(nextSession.user).then((result) => {
        if (!active) return;

        setProfile(result.profile);
        setAuthMessage(result.message || "");
        setAuthChecked(true);

        if (!isBackgroundRefresh && result.profile && canManageAdmin(result.profile)) {
          loadAll(nextSession, { silent: true, profile: result.profile });
        }
      });
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    function handleScroll() {
      setShowJumpTop(window.scrollY > 700);
    }

    handleScroll();
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  async function handleReload() {
    setPageError("");
    setPageSuccess("");

    try {
      const freshSession = await getFreshSession();
      await loadAll(freshSession, { profile });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not reload Admin.");
    }
  }

  async function handleGoogleLogin() {
    setPageError("");
    setPageSuccess("");

    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}/admin` : undefined;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) setPageError(error.message || "Google sign-in failed.");
  }

  async function handleSavePrompt() {
    setPageError("");
    setPageSuccess("");

    if (!isAdmin) {
      setPageError("Only Master Admins and Co-Admins can save prompt settings.");
      return;
    }

    if (!livePromptInput.trim()) {
      setPageError("Live Prompt cannot be empty.");
      return;
    }

    setSaveLoading(true);

    try {
      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/prompt", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            livePrompt: livePromptInput,
            changeNote,
          }),
        }),
        "Saving live prompt"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not save the live prompt.");
      }

      setPromptData(data.prompt || null);
      setHistoryRows(Array.isArray(data.history) ? data.history : []);
      setDbReady(Boolean(data.dbReady));
      setLivePromptInput(data?.prompt?.livePrompt || livePromptInput);
      setChangeNote("");
      setPageSuccess("Live Prompt saved. New audits will use the updated live prompt.");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not save the live prompt.");
    } finally {
      setSaveLoading(false);
    }
  }

  function updateApiKeyForm(keyType, updates) {
    setApiKeyForms((prev) => ({
      ...prev,
      [keyType]: {
        ...(prev[keyType] || createEmptyApiKeyForm()),
        ...updates,
      },
    }));
  }

  async function handleSaveApiKey(keyType) {
    setPageError("");
    setPageSuccess("");

    if (!canManageApiKeysNow) {
      setPageError("Only the Creator Master Admin can manage API keys.");
      return;
    }

    const form = apiKeyForms[keyType] || createEmptyApiKeyForm();
    const secretValue = normalizeText(form.secret_value);
    const keyLabel = normalizeText(form.key_label) || "Primary key";

    if (!secretValue) {
      setPageError(`${apiTypeLabel(keyType)} API key is required.`);
      return;
    }

    setApiKeySaveLoading(keyType);

    try {
      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/api-keys", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            keyType,
            keyLabel,
            secretValue,
            makeActive: form.make_active !== false,
          }),
        }),
        `Saving ${apiTypeLabel(keyType)} API key`
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `Could not save ${apiTypeLabel(keyType)} API key.`);
      }

      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
      updateApiKeyForm(keyType, createEmptyApiKeyForm());
      setPageSuccess(data.message || `${apiTypeLabel(keyType)} API key saved.`);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : `Could not save ${apiTypeLabel(keyType)} API key.`);
    } finally {
      setApiKeySaveLoading("");
    }
  }

  async function handleActivateApiKey(row) {
    setPageError("");
    setPageSuccess("");

    if (!canManageApiKeysNow) {
      setPageError("Only the Creator Master Admin can manage API keys.");
      return;
    }

    setApiKeyActionLoadingId(row?.id || "");

    try {
      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/api-keys", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            id: row.id,
            isActive: true,
          }),
        }),
        `Activating ${apiTypeLabel(row?.key_type)} API key`
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not activate API key.");
      }

      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
      setPageSuccess(data.message || "API key activated.");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not activate API key.");
    } finally {
      setApiKeyActionLoadingId("");
    }
  }

  async function handleDeactivateApiKey(row) {
    setPageError("");
    setPageSuccess("");

    if (!canManageApiKeysNow) {
      setPageError("Only the Creator Master Admin can manage API keys.");
      return;
    }

    const confirmed = window.confirm(
      `Deactivate this ${apiTypeLabel(row?.key_type)} API key? The app may fail if there is no other active key of this type.`
    );

    if (!confirmed) return;

    setApiKeyActionLoadingId(row?.id || "");

    try {
      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch(`/api/admin/api-keys?id=${encodeURIComponent(row.id)}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${freshSession.access_token}`,
          },
        }),
        `Deactivating ${apiTypeLabel(row?.key_type)} API key`
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not deactivate API key.");
      }

      setApiKeys(Array.isArray(data.keys) ? data.keys : []);
      setPageSuccess(data.message || "API key deactivated.");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not deactivate API key.");
    } finally {
      setApiKeyActionLoadingId("");
    }
  }

  function scrollToMappingForm() {
    setTimeout(() => {
      mappingFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function scrollToSupervisorForm() {
    setTimeout(() => {
      supervisorFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function handleEditMapping(row) {
    setMappingForm({
      id: row?.id || "",
      intercom_agent_name: row?.intercom_agent_name || "",
      employee_name: row?.employee_name || "",
      employee_email: row?.employee_email || "",
      team_name: row?.team_name || "",
      notes: row?.notes || "",
      is_active: row?.is_active !== false,
    });

    setPageError("");
    setPageSuccess(`Editing mapping for ${row?.intercom_agent_name || "selected agent"}.`);
    scrollToMappingForm();
  }

  function handleUseSuggestion(item) {
    setMappingForm({
      id: "",
      intercom_agent_name: item?.intercom_agent_name || "",
      employee_name: item?.employee_name || item?.intercom_agent_name || "",
      employee_email: item?.employee_email || "",
      team_name: item?.team_name || "",
      notes: item?.notes || "Detected from stored audit results.",
      is_active: true,
    });

    setPageError("");
    setPageSuccess("Mapping form updated from detected agent.");
    scrollToMappingForm();
  }

  function handleResetMappingForm() {
    setMappingForm(createEmptyMappingForm());
    setPageError("");
    setPageSuccess("");
  }

  async function handleSaveMapping() {
    setPageError("");
    setPageSuccess("");

    if (!isAdmin) {
      setPageError("Only Master Admins and Co-Admins can save mappings.");
      return;
    }

    const intercomAgentName = normalizeText(mappingForm.intercom_agent_name);
    const employeeName = normalizeText(mappingForm.employee_name) || intercomAgentName;
    const employeeEmail = normalizeEmail(mappingForm.employee_email);
    const teamName = normalizeText(mappingForm.team_name);
    const notes = normalizeText(mappingForm.notes);

    if (!intercomAgentName) {
      setPageError("Intercom agent name is required.");
      return;
    }

    if (!employeeName) {
      setPageError("Employee name is required.");
      return;
    }

    if (employeeEmail && !employeeEmail.endsWith("@nextventures.io")) {
      setPageError("Employee email must use the nextventures.io domain.");
      return;
    }

    setMappingSaveLoading(true);

    try {
      const existingMatch = mappingRows.find(
        (item) => normalizeKey(item?.intercom_agent_name) === normalizeKey(intercomAgentName)
      );

      const payload = {
        intercom_agent_name: intercomAgentName,
        employee_name: employeeName,
        employee_email: employeeEmail || null,
        team_name: teamName || null,
        notes: notes || null,
        is_active: mappingForm.is_active !== false,
        updated_at: new Date().toISOString(),
      };

      const targetId = mappingForm.id || existingMatch?.id || "";

      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/agent-mappings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            id: targetId,
            mapping: payload,
          }),
        }),
        targetId ? "Updating agent mapping" : "Creating agent mapping"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not save the mapping.");
      }

      setPageSuccess(data.message || "Agent mapping saved successfully.");
      setMappingForm(createEmptyMappingForm());
      await loadMappingsData();
      await loadSupervisorTeamsData(freshSession);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not save mapping.");
    } finally {
      setMappingSaveLoading(false);
    }
  }

  async function handleToggleMappingActive(row) {
    setPageError("");
    setPageSuccess("");
    setMappingToggleLoadingId(row?.id || "");

    try {
      const nextActive = row?.is_active === false;

      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/agent-mappings", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            id: row.id,
            isActive: nextActive,
          }),
        }),
        "Updating mapping status"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not update mapping status.");
      }

      setPageSuccess(data.message || (nextActive ? "Mapping activated." : "Mapping deactivated."));
      await loadMappingsData();
      await loadSupervisorTeamsData(freshSession);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not update mapping status.");
    } finally {
      setMappingToggleLoadingId("");
    }
  }

  async function handleSeedSuggestedMappings() {
    setPageError("");
    setPageSuccess("");

    if (!isAdmin) {
      setPageError("Only Master Admins and Co-Admins can prefill mappings.");
      return;
    }

    if (!mappingSuggestions.length) {
      setPageError("No detected agents to prefill.");
      return;
    }

    setSeedLoading(true);

    try {
      const rows = mappingSuggestions.map((item) => ({
        intercom_agent_name: item.intercom_agent_name,
        employee_name: item.employee_name || item.intercom_agent_name,
        employee_email: item.employee_email || null,
        team_name: item.team_name || null,
        notes: item.notes || "Detected from stored audit results.",
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/agent-mappings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            action: "seed",
            rows,
          }),
        }),
        "Prefilling detected agents"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not prefill mappings.");
      }

      setPageSuccess(data.message || `${rows.length} mapping(s) added.`);
      await loadMappingsData();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not prefill mappings.");
    } finally {
      setSeedLoading(false);
    }
  }

  function isSupervisorMemberSelected(option) {
    const optionKey = getMemberKey(option);
    return supervisorForm.members.some((member) => getMemberKey(member) === optionKey);
  }

  function handleToggleSupervisorMember(option) {
    const optionKey = getMemberKey(option);

    setSupervisorForm((prev) => {
      const exists = prev.members.some((member) => getMemberKey(member) === optionKey);

      if (exists) {
        return {
          ...prev,
          members: prev.members.filter((member) => getMemberKey(member) !== optionKey),
        };
      }

      return {
        ...prev,
        members: [
          ...prev.members,
          {
            employee_name: option.employee_name,
            employee_email: option.employee_email || null,
            intercom_agent_name: option.intercom_agent_name || null,
            team_name: option.team_name || null,
            is_active: true,
          },
        ],
      };
    });
  }

  function handleUseSupervisorCandidate(option) {
    setSupervisorForm((prev) => ({
      ...prev,
      supervisor_name: option.employee_name || prev.supervisor_name,
      supervisor_email: option.employee_email || prev.supervisor_email,
    }));
  }

  function handleEditSupervisorTeam(team) {
    setSupervisorForm({
      id: team?.id || "",
      supervisor_name: team?.supervisor_name || "",
      supervisor_email: team?.supervisor_email || "",
      notes: team?.notes || "",
      is_active: team?.is_active !== false,
      members: Array.isArray(team?.members) ? team.members : [],
    });

    setSupervisorMemberSearch("");
    setPageError("");
    setPageSuccess(`Editing Supervisor Team for ${team?.supervisor_name || "selected supervisor"}.`);
    scrollToSupervisorForm();
  }

  function handleClearSupervisorForm() {
    setSupervisorForm(createEmptySupervisorForm());
    setSupervisorMemberSearch("");
    setPageError("");
    setPageSuccess("");
  }

  async function handleSaveSupervisorTeam() {
    setPageError("");
    setPageSuccess("");

    if (!isAdmin) {
      setPageError("Only Master Admins and Co-Admins can save Supervisor Teams.");
      return;
    }

    const supervisorName = normalizeText(supervisorForm.supervisor_name);
    const supervisorEmail = normalizeEmail(supervisorForm.supervisor_email);

    if (!supervisorName) {
      setPageError("Supervisor Name is required.");
      return;
    }

    if (supervisorEmail && !supervisorEmail.endsWith("@nextventures.io")) {
      setPageError("Supervisor Email must use the nextventures.io domain.");
      return;
    }

    setSupervisorSaveLoading(true);

    try {
      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/supervisor-teams", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            team: {
              id: supervisorForm.id || "",
              supervisor_name: supervisorName,
              supervisor_email: supervisorEmail || null,
              notes: normalizeText(supervisorForm.notes) || null,
              is_active: supervisorForm.is_active !== false,
            },
            members: supervisorForm.members || [],
          }),
        }),
        supervisorForm.id ? "Updating Supervisor Team" : "Saving Supervisor Team"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not save Supervisor Team.");
      }

      const savedTeam = data.team || {};
      const savedTeams = Array.isArray(data.teams) ? data.teams : [];
      const savedMembers = savedTeams.find((team) => team.id === savedTeam.id)?.members || supervisorForm.members || [];

      setSupervisorForm(createEmptySupervisorForm());
      setSupervisorMemberSearch("");
      setPageSuccess(
        data.message ||
          `${savedTeam.supervisor_name || supervisorName} saved successfully with ${formatNumber(savedMembers.length)} member(s).`
      );

      setSupervisorTeams(sortSupervisorTeams(savedTeams));

      if (Array.isArray(data.employeeOptions) && data.employeeOptions.length > 0) {
        setSupervisorEmployeeOptions(data.employeeOptions);
      }

      await loadActivityLogsData(freshSession, canViewActivityLogsNow);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not save Supervisor Team.");
    } finally {
      setSupervisorSaveLoading(false);
    }
  }

  async function handleToggleSupervisorTeamActive(team) {
    setPageError("");
    setPageSuccess("");

    if (!isAdmin) {
      setPageError("Only Master Admins and Co-Admins can update Supervisor Teams.");
      return;
    }

    setSupervisorToggleLoadingId(team?.id || "");

    try {
      const nextActive = team?.is_active === false;
      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/supervisor-teams", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            id: team.id,
            is_active: nextActive,
          }),
        }),
        "Updating Supervisor Team status"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not update Supervisor Team.");
      }

      setPageSuccess(data.message || (nextActive ? "Supervisor Team activated." : "Supervisor Team deactivated."));
      setSupervisorTeams(sortSupervisorTeams(Array.isArray(data.teams) ? data.teams : []));

      if (Array.isArray(data.employeeOptions) && data.employeeOptions.length > 0) {
        setSupervisorEmployeeOptions(data.employeeOptions);
      }

      await loadActivityLogsData(freshSession, canViewActivityLogsNow);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not update Supervisor Team.");
    } finally {
      setSupervisorToggleLoadingId("");
    }
  }

  function handleUseRoleCandidate(option) {
    const email = normalizeEmail(option?.employee_email);
    const existingAccess = email
      ? roleAccessRows.find((row) => normalizeEmail(row?.email) === email)
      : null;

    setRoleCandidateSearch(option?.employee_name || "");
    setRoleForm({
      id: existingAccess?.id || "",
      email,
      full_name: option?.employee_name || existingAccess?.full_name || "",
      role: existingAccess?.role || "viewer",
      can_run_tests: Boolean(existingAccess?.can_run_tests),
      is_active: existingAccess ? existingAccess.is_active !== false : true,
    });

    setPageError("");
    setPageSuccess(
      existingAccess
        ? `Selected ${option?.employee_name || email}. Existing access record found.`
        : "Employee selected. You can pre-grant access before this user signs in."
    );
  }

  function handleEditRole(row) {
    const email = normalizeEmail(row?.email);
    const lockedName = getLockedNameForEmail(email, mappingRows);

    setRoleForm({
      id: row?.id || "",
      email,
      full_name: lockedName || row?.full_name || "",
      role: row?.role || "viewer",
      can_run_tests: Boolean(row?.can_run_tests),
      is_active: row?.is_active !== false,
    });

    setRoleCandidateSearch(row?.full_name || row?.email || "");
    setPageError("");
    setPageSuccess(`Editing access for ${email}.`);

    setTimeout(() => {
      roleFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function handleRoleChange(nextRole) {
    const roleConfig = ROLE_OPTIONS.find((item) => item.value === nextRole);

    setRoleForm((prev) => ({
      ...prev,
      role: nextRole,
      can_run_tests:
        nextRole === "master_admin"
          ? true
          : roleConfig?.defaultCanRunTests ?? prev.can_run_tests,
    }));
  }

  function handleClearRoleForm() {
    setRoleForm(createEmptyRoleForm());
    setRoleCandidateSearch("");
    setPageError("");
    setPageSuccess("");
  }

  async function handleSaveRole() {
    setPageError("");
    setPageSuccess("");

    if (!canManageUsersNow) {
      setPageError("Only Master Admins can manage user roles.");
      return;
    }

    const email = normalizeEmail(roleForm.email);
    const domain = email.split("@")[1] || "";

    if (!email || domain !== "nextventures.io") {
      setPageError("Use a valid nextventures.io email address.");
      return;
    }

    const lockedName = getLockedNameForEmail(email, mappingRows);
    const nextRole = email === MASTER_ADMIN_EMAIL ? "master_admin" : roleForm.role;
    const nextCanRunTests = email === MASTER_ADMIN_EMAIL ? true : Boolean(roleForm.can_run_tests);
    const nextIsActive = email === MASTER_ADMIN_EMAIL ? true : Boolean(roleForm.is_active);
    const nextName = lockedName || normalizeText(roleForm.full_name) || null;

    if (nextRole === "master_admin" && email !== MASTER_ADMIN_EMAIL) {
      const confirmed = window.confirm(
        `You are about to grant Master Admin access to ${email}. This gives full control over the platform. Continue?`
      );

      if (!confirmed) return;
    }

    setRoleSaveLoading(true);

    try {
      const freshSession = await getFreshSession();

      const response = await withTimeout(
        fetch("/api/admin/role-grants", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freshSession.access_token}`,
          },
          body: JSON.stringify({
            email,
            fullName: nextName,
            role: nextRole,
            canRunTests: nextCanRunTests,
            isActive: nextIsActive,
          }),
        }),
        "Saving user role grant"
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Could not save user role grant.");
      }

      setProfileRows(Array.isArray(data.profiles) ? data.profiles : []);
      setRoleGrantRows(Array.isArray(data.grants) ? data.grants : []);
      setPageSuccess(data.message || "User role grant saved.");
      setRoleForm(createEmptyRoleForm());
      setRoleCandidateSearch("");

      if (session?.user) {
        const profileResult = await loadProfile(session.user);
        setProfile(profileResult.profile);
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not save user role grant.");
    } finally {
      setRoleSaveLoading(false);
    }
  }

  const storedAgentStats = useMemo(() => buildStoredAgentStats(auditRows), [auditRows]);

  const mappingSuggestions = useMemo(
    () => buildSuggestions(mappingRows, auditRows),
    [mappingRows, auditRows]
  );

  const unmappedRows = useMemo(
    () => buildUnmappedRows(mappingRows, auditRows),
    [mappingRows, auditRows]
  );

  const mappingTableRows = useMemo(
    () =>
      mappingRows.map((row) => {
        const key = normalizeKey(row?.intercom_agent_name);

        const stats = storedAgentStats.get(key) || {
          appearances: 0,
          mapped_result_count: 0,
          unmapped_result_count: 0,
          latest_seen_at: null,
        };

        return {
          ...row,
          stats,
          quality: getMappingQuality(row, stats),
        };
      }),
    [mappingRows, storedAgentStats]
  );

  const activeMappingsCount = mappingRows.filter((item) => item?.is_active !== false).length;
  const inactiveMappingsCount = mappingRows.length - activeMappingsCount;

  const incompleteMappingsCount = mappingTableRows.filter((row) =>
    ["missing_email_team", "missing_email", "missing_team"].includes(row.quality.key)
  ).length;

  const healthyMappingsCount = mappingTableRows.filter(
    (row) => row.quality.key === "healthy"
  ).length;

  const totalStoredAgentNames = storedAgentStats.size;

  const mappedCoveragePercent = totalStoredAgentNames
    ? Math.max(
        0,
        Math.round(((totalStoredAgentNames - unmappedRows.length) / totalStoredAgentNames) * 100)
      )
    : 100;

  const activeSupervisorTeamsCount = supervisorTeams.filter((item) => item?.is_active !== false).length;
  const totalSupervisorMembersCount = supervisorTeams.reduce(
    (sum, team) => sum + (Array.isArray(team.members) ? team.members.length : 0),
    0
  );

  const filteredMappings = useMemo(() => {
    const term = normalizeKey(mappingSearch);

    return mappingTableRows.filter((row) => {
      if (mappingStatusFilter === "active" && row?.is_active === false) return false;
      if (mappingStatusFilter === "inactive" && row?.is_active !== false) return false;

      if (mappingQualityFilter === "needs_attention") {
        if (
          !["missing_email_team", "missing_email", "missing_team", "inactive"].includes(
            row.quality.key
          )
        ) {
          return false;
        }
      } else if (mappingQualityFilter !== "all" && row.quality.key !== mappingQualityFilter) {
        return false;
      }

      if (!term) return true;

      return [
        row?.intercom_agent_name,
        row?.employee_name,
        row?.employee_email,
        row?.team_name,
        row?.notes,
        row?.quality?.label,
        row?.quality?.detail,
      ]
        .map((value) => normalizeKey(value))
        .join(" ")
        .includes(term);
    });
  }, [mappingTableRows, mappingSearch, mappingStatusFilter, mappingQualityFilter]);

  const roleAccessRows = useMemo(() => {
    const byEmail = new Map();

    for (const row of profileRows || []) {
      const email = normalizeEmail(row?.email);
      if (!email) continue;

      byEmail.set(email, {
        id: row.id || email,
        profile_id: row.id || "",
        grant_id: "",
        email,
        full_name: row.full_name || "",
        role: row.role || "viewer",
        can_run_tests: Boolean(row.can_run_tests),
        is_active: row.is_active !== false,
        has_profile: true,
        has_grant: false,
        source_label: "Signed in",
      });
    }

    for (const grant of roleGrantRows || []) {
      const email = normalizeEmail(grant?.email);
      if (!email) continue;

      const existing = byEmail.get(email) || {};

      byEmail.set(email, {
        ...existing,
        id: grant.id || existing.id || email,
        profile_id: existing.profile_id || "",
        grant_id: grant.id || "",
        email,
        full_name: grant.full_name || existing.full_name || "",
        role: grant.role || existing.role || "viewer",
        can_run_tests: Boolean(grant.can_run_tests),
        is_active: grant.is_active !== false,
        has_profile: Boolean(existing.has_profile),
        has_grant: true,
        source_label: existing.has_profile ? "Signed in + pre-grant" : "Pre-granted",
      });
    }

    return Array.from(byEmail.values()).sort((a, b) => {
      const aCreator = normalizeEmail(a.email) === MASTER_ADMIN_EMAIL;
      const bCreator = normalizeEmail(b.email) === MASTER_ADMIN_EMAIL;

      if (aCreator !== bCreator) return aCreator ? -1 : 1;

      const aName = normalizeText(a.full_name) || normalizeEmail(a.email);
      const bName = normalizeText(b.full_name) || normalizeEmail(b.email);
      return aName.localeCompare(bName);
    });
  }, [profileRows, roleGrantRows]);

  const filteredProfileRows = useMemo(() => {
    const term = normalizeKey(roleSearch);

    return roleAccessRows.filter((row) => {
      if (!term) return true;

      return [
        row?.email,
        row?.full_name,
        row?.role,
        row?.source_label,
        row?.can_run_tests ? "run audit" : "no run audit",
        row?.is_active ? "active" : "inactive",
      ]
        .map((value) => normalizeKey(value))
        .join(" ")
        .includes(term);
    });
  }, [roleAccessRows, roleSearch]);

  const filteredSupervisorTeams = useMemo(() => {
    const term = normalizeKey(supervisorSearch);

    return supervisorTeams.filter((team) => {
      if (!term) return true;

      const memberText = (team.members || [])
        .map((member) =>
          [
            member.employee_name,
            member.employee_email,
            member.intercom_agent_name,
            member.team_name,
          ]
            .filter(Boolean)
            .join(" ")
        )
        .join(" ");

      return [
        team.supervisor_name,
        team.supervisor_email,
        team.notes,
        team.is_active === false ? "inactive" : "active",
        memberText,
      ]
        .map((value) => normalizeKey(value))
        .join(" ")
        .includes(term);
    });
  }, [supervisorTeams, supervisorSearch]);

  const filteredSupervisorEmployeeOptions = useMemo(() => {
    const term = normalizeKey(supervisorMemberSearch);

    return supervisorEmployeeOptions.filter((item) => {
      if (!term) return true;

      return [
        item.employee_name,
        item.employee_email,
        item.intercom_agent_name,
        item.team_name,
      ]
        .map((value) => normalizeKey(value))
        .join(" ")
        .includes(term);
    });
  }, [supervisorEmployeeOptions, supervisorMemberSearch]);

  const filteredSupervisorCandidateOptions = useMemo(() => {
    const term = normalizeKey(supervisorForm.supervisor_name);

    if (term.length < 2) return [];

    return supervisorEmployeeOptions
      .filter((item) =>
        [item.employee_name, item.employee_email, item.intercom_agent_name, item.team_name]
          .map((value) => normalizeKey(value))
          .join(" ")
          .includes(term)
      )
      .slice(0, 8);
  }, [supervisorEmployeeOptions, supervisorForm.supervisor_name]);

  const lockedRoleName = getLockedNameForEmail(roleForm.email, mappingRows);

  const filteredRoleCandidateOptions = useMemo(() => {
    const term = normalizeKey(roleCandidateSearch || roleForm.email || roleForm.full_name);

    if (term.length < 2) return [];

    return supervisorEmployeeOptions
      .filter((item) =>
        [item.employee_name, item.employee_email, item.intercom_agent_name, item.team_name]
          .map((value) => normalizeKey(value))
          .join(" ")
          .includes(term)
      )
      .slice(0, 10);
  }, [supervisorEmployeeOptions, roleCandidateSearch, roleForm.email, roleForm.full_name]);

  const apiKeysByType = useMemo(() => {
    const grouped = new Map();

    for (const type of API_KEY_TYPES) {
      grouped.set(type.value, []);
    }

    for (const row of apiKeys || []) {
      const current = grouped.get(row.key_type) || [];
      current.push(row);
      grouped.set(row.key_type, current);
    }

    return grouped;
  }, [apiKeys]);

  const statusCards = [
    {
      label: "Prompt",
      value: dbReady ? "Ready" : "Not ready",
      note: dbReady ? "Live Prompt connected." : "Prompt storage unavailable.",
      tone: dbReady ? "success" : "warning",
    },
    {
      label: "Coverage",
      value: `${mappedCoveragePercent}%`,
      note: totalStoredAgentNames
        ? `${formatNumber(totalStoredAgentNames - unmappedRows.length)} of ${formatNumber(
            totalStoredAgentNames
          )} agents covered.`
        : "No stored agent sample.",
      tone: unmappedRows.length ? "warning" : "success",
    },
    {
      label: "Mappings",
      value: `${formatNumber(activeMappingsCount)} / ${formatNumber(inactiveMappingsCount)}`,
      note: "Active / inactive.",
      tone: inactiveMappingsCount ? "notice" : "success",
    },
    {
      label: "Supervisor Teams",
      value: formatNumber(activeSupervisorTeamsCount),
      note: `${formatNumber(totalSupervisorMembersCount)} assigned member(s).`,
      tone: activeSupervisorTeamsCount ? "success" : "notice",
    },
    {
      label: "Needs work",
      value: String(incompleteMappingsCount + unmappedRows.length),
      note: `${formatNumber(incompleteMappingsCount)} incomplete, ${formatNumber(
        unmappedRows.length
      )} unmapped.`,
      tone: incompleteMappingsCount || unmappedRows.length ? "warning" : "success",
    },
  ];

  return (
    <main className="admin-page">
      <style>{adminStyles}</style>

      <section className="hero">
        <div>
          <div className="hero-badge">Admin Operations</div>
          <h1>Control Center</h1>
          <p>
            Manage Live Prompts, Secure Keys, Role Access, Agent Mappings, And Supervisor Teams From One Premium Command Workspace.
          </p>
        </div>

        <div className="hero-side-card">
          <span>Current Access</span>
          <strong>{authChecked ? roleLabel(profile?.role) : "Checking..."}</strong>
          <small>{profile?.email || session?.user?.email || "Not signed in"}</small>
        </div>

        <div className="hero-actions">
          <div className="action-row">
            <button
              type="button"
              className="secondary-btn"
              onClick={handleReload}
              disabled={!session || loading || mappingLoading || supervisorLoading || profileLoading}
            >
              {loading || mappingLoading || supervisorLoading || profileLoading ? "Loading..." : "Reload"}
            </button>

            <button
              type="button"
              className="primary-btn"
              onClick={handleSeedSuggestedMappings}
              disabled={!isAdmin || seedLoading || !mappingSuggestions.length}
            >
              {seedLoading ? "Prefilling..." : `Prefill agents (${mappingSuggestions.length})`}
            </button>
          </div>

          <div className="admin-quick-nav" aria-label="Admin quick navigation">
            <a href="#live-prompt">Prompt</a>
            {canManageApiKeysNow ? <a href="#api-vault">API Vault</a> : null}
            {canViewActivityLogsNow ? <a href="#system-activity-logs">Activity Logs</a> : null}
            <a href="#supervisor-teams">Supervisor Teams</a>
            <a href="#user-roles">Roles</a>
            <a href="#agent-mappings">Mappings</a>
          </div>
        </div>
      </section>

      <section className="status-grid">
        {statusCards.map((card) => (
          <article key={card.label} className={`stat-card ${card.tone}`}>
            <p>{card.label}</p>
            <strong>{card.value}</strong>
            <span>{card.note}</span>
          </article>
        ))}
      </section>

      {(pageError || pageSuccess || authMessage) && (
        <section className="message-stack">
          {pageError ? <div className="message error">{pageError}</div> : null}
          {authMessage ? <div className="message warning">{authMessage}</div> : null}
          {pageSuccess ? <div className="message success">{pageSuccess}</div> : null}
        </section>
      )}

      {!session?.user ? (
        <section className="panel gate-panel">
          <p className="eyebrow">Sign In Required</p>
          <h2>Admin Is Ready, but You Are Not Signed In.</h2>
          <p className="muted">Use your nextventures.io Google account to continue.</p>
          <button type="button" className="primary-btn" onClick={handleGoogleLogin}>
            Sign In with Google
          </button>
        </section>
      ) : !isAdmin ? (
        <section className="panel gate-panel">
          <p className="eyebrow">Admin Access Required</p>
          <h2>This section is restricted.</h2>
          <p className="muted">Please contact the Master Admin if you need Admin access.</p>
        </section>
      ) : (
        <>
          {canViewActivityLogsNow ? (
            <section className="panel wide activity-panel" id="system-activity-logs">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Master Admin Only</p>
                  <h2>System Activity Logs</h2>
                  <p className="muted">
                    Review sign-ins, page visits, admin changes, and session history with clearer event details.
                  </p>
                </div>

                <div className="action-row">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => handleRefreshActivityLogs()}
                    disabled={activityLoading}
                  >
                    {activityLoading ? "Loading..." : "Refresh Logs"}
                  </button>

                  <button
                    type="button"
                    className="primary-btn"
                    onClick={handleExportActivityLogs}
                    disabled={!activityLogs.length}
                  >
                    Export CSV
                  </button>
                </div>
              </div>

              <div className="activity-summary-grid">
                <article>
                  <span>Log Events</span>
                  <strong>{formatNumber(activityLogs.length)}</strong>
                  <small>Latest protected events</small>
                </article>
                <article>
                  <span>Sessions</span>
                  <strong>{formatNumber(activitySessions.length)}</strong>
                  <small>Recent user sessions</small>
                </article>
                <article>
                  <span>Active Now</span>
                  <strong>{formatNumber(activeActivitySessions)}</strong>
                  <small>Based on last heartbeat</small>
                </article>
                <article>
                  <span>Visibility</span>
                  <strong>Master Admin</strong>
                  <small>Co-Admins cannot view this section</small>
                </article>
              </div>

              <div className="filter-grid activity-filter-grid">
                <AdminActivityDateRangePicker
                  startDate={activityFilters.start_date}
                  endDate={activityFilters.end_date}
                  presetKey={activityDatePreset}
                  onApplyPreset={applyActivityPreset}
                  onApplyCustom={applyCustomActivityRange}
                />

                <label>
                  <span>User Email <HelpTip text="Filter logs by the user who performed the action. Use the full email for the most accurate result." /></span>
                  <input
                    value={activityFilters.email}
                    onChange={(event) => updateActivityFilter("email", normalizeEmail(event.target.value))}
                    placeholder="user@nextventures.io"
                  />
                </label>

                <label>
                  <span>Action <HelpTip text="The event type captured by the system, such as page view, prompt save, mapping update, or sign-out." /></span>
                  <select
                    value={activityFilters.action_type}
                    onChange={(event) => updateActivityFilter("action_type", event.target.value)}
                  >
                    <option value="">All Actions</option>
                    {activityActionOptions.map((item) => (
                      <option key={item} value={item}>
                        {activityActionLabel(item)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Status <HelpTip text="Info is normal tracking. Failed means an action did not complete. Warning means the event needs attention." /></span>
                  <select
                    value={activityFilters.status}
                    onChange={(event) => updateActivityFilter("status", event.target.value)}
                  >
                    <option value="">All Statuses</option>
                    <option value="success">Success</option>
                    <option value="failed">Failed</option>
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                  </select>
                </label>

                <label>
                  <span>Area <HelpTip text="The product area where the event happened, such as Navigation, Admin, Mapping, Prompt, or Authentication." /></span>
                  <select
                    value={activityFilters.area}
                    onChange={(event) => updateActivityFilter("area", event.target.value)}
                  >
                    <option value="">All Areas</option>
                    {activityAreaOptions.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="activity-search-field">
                  <span>Search <HelpTip text="Search logs by user name, email, page path, action, target, or detail. Search now runs before the row limit is applied." /></span>
                  <input
                    value={activityFilters.search}
                    onChange={(event) => updateActivityFilter("search", event.target.value)}
                    placeholder="Search user, email, action, area, or detail"
                  />
                </label>

                <label>
                  <span>Limit <HelpTip text="Maximum log rows returned for the selected date range and filters. Use 500 or 1000 for longer investigations." /></span>
                  <select
                    value={activityLimit}
                    onChange={(event) => setActivityLimit(Number(event.target.value))}
                  >
                    {ACTIVITY_LIMIT_OPTIONS.map((limit) => (
                      <option key={limit} value={limit}>{formatNumber(limit)} Rows</option>
                    ))}
                  </select>
                </label>

                <div className="activity-filter-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => handleRefreshActivityLogs()}
                    disabled={activityLoading}
                  >
                    Apply Filters
                  </button>

                  <button type="button" className="secondary-btn" onClick={handleClearActivityFilters}>
                    Clear
                  </button>
                </div>
              </div>

              {activityError ? <div className="message error">{activityError}</div> : null}

              <div className="activity-layout">
                <div className="activity-table-shell">
                  {activityLoading ? (
                    <div className="empty-box">Loading System Activity Logs...</div>
                  ) : activityLogs.length === 0 ? (
                    <div className="empty-box">No matching activity logs yet.</div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>User</th>
                          <th>Action</th>
                          <th>Area</th>
                          <th>Status</th>
                          <th>Target</th>
                          <th>Details</th>
                        </tr>
                      </thead>

                      <tbody>
                        {visibleActivityLogs.map((row) => {
                          const expanded = expandedActivityLogId === row.id;
                          return (
                            <Fragment key={row.id}>
                              <tr>
                                <td>
                                  <strong>{formatDateTime(row.created_at)}</strong>
                                  {row.session_id ? <small>Session {String(row.session_id).slice(0, 8)}</small> : null}
                                </td>

                                <td>
                                  <strong>{row.actor_name || row.actor_email || "Unknown User"}</strong>
                                  <small>{row.actor_email || "No email"}</small>
                                  <em>{roleLabel(row.actor_role)}</em>
                                </td>

                                <td>
                                  <strong>{row.action_label || activityActionLabel(row.action_type)}</strong>
                                  <small>{row.action_type || "activity"}</small>
                                </td>

                                <td>{row.area || "-"}</td>

                                <td>
                                  <span className={`status ${row.status === "failed" ? "inactive" : row.status === "warning" ? "inactive" : "active"}`}>
                                    {activityActionLabel(row.status || "info")}
                                  </span>
                                </td>

                                <td>
                                  <strong>{summarizeActivityTarget(row)}</strong>
                                  {row.target_type ? <small>{row.target_type}</small> : null}
                                </td>

                                <td>
                                  <span>{summarizeActivityLog(row)}</span>
                                  {row.request_path ? <small>{row.request_path}</small> : null}
                                  <button
                                    type="button"
                                    className="activity-detail-toggle"
                                    onClick={() => setExpandedActivityLogId(expanded ? "" : row.id)}
                                  >
                                    {expanded ? "Hide Details" : "Show Details"}
                                  </button>
                                </td>
                              </tr>

                              {expanded ? (
                                <tr className="activity-detail-row">
                                  <td colSpan={7}>
                                    <div className="activity-detail-card">
                                      <div>
                                        <span>Full Description</span>
                                        <p>{row.description || summarizeActivityLog(row)}</p>
                                      </div>
                                      <div>
                                        <span>Request Path</span>
                                        <p>{row.request_path || "No path saved."}</p>
                                      </div>
                                      <div>
                                        <span>IP / Browser</span>
                                        <p>{row.ip_address || "No IP saved."}</p>
                                        <small>{row.user_agent || "No browser details saved."}</small>
                                      </div>
                                      <div className="activity-json-card">
                                        <span>Safe Metadata</span>
                                        <pre>{safeJsonPreview(row.metadata)}</pre>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}

                  {activityLogs.length > 0 ? (
                    <div className="activity-log-pagination">
                      <span>
                        Showing {formatNumber(Math.min(visibleActivityLogs.length, activityLogs.length))} Of {formatNumber(activityLogs.length)} Logs
                      </span>

                      <div>
                        {visibleActivityLogs.length < activityLogs.length ? (
                          <button
                            type="button"
                            className="secondary-btn small"
                            onClick={() => setActivityVisibleCount((count) => Math.min(count + 25, activityLogs.length))}
                          >
                            Show More
                          </button>
                        ) : null}

                        {visibleActivityLogs.length > 25 ? (
                          <button
                            type="button"
                            className="secondary-btn small"
                            onClick={() => setActivityVisibleCount(25)}
                          >
                            Show Less
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>

                <aside className="session-panel">
                  <div className="section-head compact-head">
                    <div>
                      <p className="eyebrow">Session Activity</p>
                      <h3>Recent Sessions</h3>
                      <p className="session-help-text">Recent sign-in sessions for the same date range and search filters.</p>
                    </div>
                  </div>

                  <div className="session-list">
                    {activitySessions.length === 0 ? (
                      <div className="empty-box compact">No recent sessions.</div>
                    ) : (
                      activitySessions.slice(0, 12).map((item) => (
                        <article className="session-card" key={item.id}>
                          <div>
                            <strong>{item.full_name || item.email}</strong>
                            <span>{item.email}</span>
                          </div>

                          <span className={item.status === "active" ? "status active" : "status inactive"}>
                            {activityActionLabel(item.status)}
                          </span>

                          <dl>
                            <div>
                              <dt>Role</dt>
                              <dd>{roleLabel(item.role)}</dd>
                            </div>
                            <div>
                              <dt>Started</dt>
                              <dd>{formatDateTime(item.started_at)}</dd>
                            </div>
                            <div>
                              <dt>Last Seen</dt>
                              <dd>{formatDateTime(item.last_seen_at)}</dd>
                            </div>
                            <div>
                              <dt>Duration</dt>
                              <dd>{formatDuration(item.duration_seconds)}</dd>
                            </div>
                          </dl>
                        </article>
                      ))
                    )}
                  </div>
                </aside>
              </div>
            </section>
          ) : null}

          <section className={canManageApiKeysNow ? "control-grid" : "control-grid single-column"}>
            <article className="panel prompt-panel" id="live-prompt">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Live configuration</p>
                  <h2>Live Prompt</h2>
                  <p className="muted">This is the prompt used by new audits. Update it here without changing code.</p>
                </div>

                <span className={dbReady ? "status active" : "status inactive"}>
                  {dbReady ? "Connected" : "Not ready"}
                </span>
              </div>

              <textarea
                className="textarea live"
                value={livePromptInput}
                onChange={(event) => setLivePromptInput(event.target.value)}
                placeholder="Live Prompt"
              />

              <textarea
                className="textarea note"
                value={changeNote}
                onChange={(event) => setChangeNote(event.target.value)}
                placeholder="Optional change note"
              />

              <div className="action-row">
                <button
                  type="button"
                  className="primary-btn"
                  onClick={handleSavePrompt}
                  disabled={saveLoading || !livePromptInput.trim()}
                >
                  {saveLoading ? "Saving..." : "Save Prompt"}
                </button>
              </div>

              <details className="trusted-prompt-drawer">
                <summary>Original Trusted Prompt Reference</summary>
                <p>
                  This is kept as a read-only baseline. It is not meant to take over the live prompt unless you copy it manually.
                </p>
                <textarea
                  className="textarea trusted"
                  value={promptData?.originalTrustedPrompt || ""}
                  readOnly
                />
              </details>
            </article>

            {canManageApiKeysNow ? (
              <article className="panel api-panel" id="api-vault">
                <div className="section-head">
                  <div>
                    <p className="eyebrow">Creator Master Admin only</p>
                    <h2>API Key Vault</h2>
                    <p className="muted">
                      Save Replacement Keys Securely. Full Key Values Are Never Displayed After Saving; Only Masked Values Are Returned To This Page.
                    </p>
                  </div>

                  <span className="status active">Protected</span>
                </div>

                <div className="api-card-grid">
                  {API_KEY_TYPES.map((type) => {
                    const keys = apiKeysByType.get(type.value) || [];
                    const activeKey = keys.find((item) => item.is_active);
                    const form = apiKeyForms[type.value] || createEmptyApiKeyForm();

                    return (
                      <div className="api-card secure" key={type.value}>
                        <div className="api-card-top">
                          <div>
                            <span>{type.label}</span>
                            <strong>{activeKey ? activeKey.masked_value : "No Active Key Saved"}</strong>
                            <p>{type.description}</p>
                          </div>

                          <span className={activeKey ? "status active" : "status inactive"}>
                            {activeKey ? "Active" : "Missing"}
                          </span>
                        </div>

                        {activeKey ? (
                          <div className="api-meta-grid">
                            <div>
                              <b>Label</b>
                              <span>{activeKey.key_label || "Primary key"}</span>
                            </div>
                            <div>
                              <b>Updated</b>
                              <span>{formatDateTime(activeKey.updated_at)}</span>
                            </div>
                            <div>
                              <b>Fingerprint</b>
                              <span>{String(activeKey.fingerprint || "").slice(0, 12)}...</span>
                            </div>
                          </div>
                        ) : null}

                        <div className="api-key-form">
                          <label>
                            <span>Key label</span>
                            <input
                              value={form.key_label}
                              onChange={(event) =>
                                updateApiKeyForm(type.value, { key_label: event.target.value })
                              }
                              placeholder="Primary key"
                            />
                          </label>

                          <label>
                            <span>New API key</span>
                            <input
                              type="password"
                              value={form.secret_value}
                              onChange={(event) =>
                                updateApiKeyForm(type.value, { secret_value: event.target.value })
                              }
                              placeholder={type.placeholder}
                              autoComplete="off"
                            />
                          </label>

                          <label className="check-row api-active-check">
                            <input
                              type="checkbox"
                              checked={form.make_active !== false}
                              onChange={(event) =>
                                updateApiKeyForm(type.value, { make_active: event.target.checked })
                              }
                            />
                            <span>Make Active Immediately</span>
                          </label>

                          <button
                            type="button"
                            className="primary-btn"
                            onClick={() => handleSaveApiKey(type.value)}
                            disabled={apiKeySaveLoading === type.value || !normalizeText(form.secret_value)}
                          >
                            {apiKeySaveLoading === type.value ? "Saving..." : `Save ${type.label} key`}
                          </button>
                        </div>

                        <div className="api-key-list">
                          {apiKeyLoading ? (
                            <div className="empty-box">Loading saved keys...</div>
                          ) : keys.length === 0 ? (
                            <div className="empty-box">No saved {type.label} keys yet.</div>
                          ) : (
                            keys.map((keyRow) => (
                              <div className="key-record" key={keyRow.id}>
                                <div>
                                  <strong>{keyRow.key_label || "Primary key"}</strong>
                                  <span>{keyRow.masked_value}</span>
                                  <small>Updated {formatDateTime(keyRow.updated_at)}</small>
                                </div>

                                <div className="table-actions">
                                  <span className={keyRow.is_active ? "status active" : "status inactive"}>
                                    {keyRow.is_active ? "Active" : "Inactive"}
                                  </span>

                                  {!keyRow.is_active ? (
                                    <button
                                      type="button"
                                      className="secondary-btn small"
                                      disabled={apiKeyActionLoadingId === keyRow.id}
                                      onClick={() => handleActivateApiKey(keyRow)}
                                    >
                                      {apiKeyActionLoadingId === keyRow.id ? "Saving..." : "Activate"}
                                    </button>
                                  ) : null}

                                  <button
                                    type="button"
                                    className="secondary-btn small danger-soft"
                                    disabled={apiKeyActionLoadingId === keyRow.id}
                                    onClick={() => handleDeactivateApiKey(keyRow)}
                                  >
                                    {apiKeyActionLoadingId === keyRow.id ? "Saving..." : "Deactivate"}
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            ) : null}
          </section>

          <section className="control-grid supervisor-area" id="supervisor-teams" ref={supervisorFormRef}>
            <article className="panel supervisor-builder">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Supervisor Teams</p>
                  <h2>{supervisorForm.id ? "Edit supervisor team" : "Create Supervisor Team"}</h2>
                  <p className="muted">
                    Add a supervisor, select mapped employees, and use this later as a Dashboard filter.
                  </p>
                </div>

                {supervisorForm.id ? (
                  <span className="status active">Editing</span>
                ) : (
                  <span className="status neutral">New</span>
                )}
              </div>

              <div className="form-grid single">
                <div className="form-grid two">
                  <label className="supervisor-name-field">
                    <span>Supervisor Name</span>
                    <input
                      value={supervisorForm.supervisor_name}
                      onChange={(event) =>
                        setSupervisorForm((prev) => ({
                          ...prev,
                          supervisor_name: event.target.value,
                        }))
                      }
                      placeholder="Search Existing Employee or type a new supervisor"
                    />

                    {supervisorForm.supervisor_name.trim().length >= 2 ? (
                      <div className="supervisor-suggestion-list">
                        {filteredSupervisorCandidateOptions.length ? (
                          filteredSupervisorCandidateOptions.map((option) => (
                            <button
                              type="button"
                              key={getMemberKey(option)}
                              className="supervisor-suggestion"
                              onClick={() => handleUseSupervisorCandidate(option)}
                            >
                              <strong>{option.employee_name}</strong>
                              <span>
                                {option.employee_email || "No email"} • {option.team_name || "No team"}
                              </span>
                              <em>{option.intercom_agent_name || "No Intercom agent"}</em>
                            </button>
                          ))
                        ) : (
                          <div className="manual-supervisor-hint">
                            No existing employee matched. You can still save this as a new supervisor.
                          </div>
                        )}
                      </div>
                    ) : null}
                  </label>

                  <label>
                    <span>Supervisor Email</span>
                    <input
                      type="email"
                      value={supervisorForm.supervisor_email}
                      onChange={(event) =>
                        setSupervisorForm((prev) => ({
                          ...prev,
                          supervisor_email: event.target.value,
                        }))
                      }
                      placeholder="supervisor@nextventures.io"
                    />
                  </label>
                </div>

                <label>
                  <span>Notes</span>
                  <textarea
                    className="textarea note"
                    value={supervisorForm.notes}
                    onChange={(event) =>
                      setSupervisorForm((prev) => ({
                        ...prev,
                        notes: event.target.value,
                      }))
                    }
                    placeholder="Optional notes"
                  />
                </label>

                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={supervisorForm.is_active}
                    onChange={(event) =>
                      setSupervisorForm((prev) => ({
                        ...prev,
                        is_active: event.target.checked,
                      }))
                    }
                  />
                  <span>Active Supervisor Team</span>
                </label>

                <div className="member-picker">
                  <div className="member-picker-head">
                    <div>
                      <p className="eyebrow">Team Members</p>
                      <h3>{formatNumber(supervisorForm.members.length)} selected</h3>
                    </div>

                    <button
                      type="button"
                      className="secondary-btn small"
                      onClick={() => setSupervisorForm((prev) => ({ ...prev, members: [] }))}
                      disabled={!supervisorForm.members.length}
                    >
                      Clear Members
                    </button>
                  </div>

                  <input
                    value={supervisorMemberSearch}
                    onChange={(event) => setSupervisorMemberSearch(event.target.value)}
                    placeholder="Search employee, email, Intercom name, or team"
                  />

                  {supervisorForm.members.length ? (
                    <div className="selected-member-chips">
                      {supervisorForm.members.map((member) => (
                        <button
                          type="button"
                          key={getMemberKey(member)}
                          className="selected-member-chip"
                          onClick={() => handleToggleSupervisorMember(member)}
                        >
                          {member.employee_name}
                          <span>Remove</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="member-option-list">
                    {supervisorLoading || mappingLoading ? (
                      <div className="empty-box">Loading employees...</div>
                    ) : filteredSupervisorEmployeeOptions.length === 0 ? (
                      <div className="empty-box">No employee options found. Add active agent mappings first.</div>
                    ) : (
                      filteredSupervisorEmployeeOptions.slice(0, 180).map((option) => {
                        const selected = isSupervisorMemberSelected(option);

                        return (
                          <button
                            type="button"
                            key={getMemberKey(option)}
                            className={selected ? "member-option selected" : "member-option"}
                            onClick={() => handleToggleSupervisorMember(option)}
                          >
                            <span className="member-check">{selected ? "✓" : "+"}</span>

                            <span className="member-copy notranslate" translate="no">
                              <strong translate="no">{option.employee_name}</strong>
                              <small translate="no">{option.employee_email || "No email"} • {option.team_name || "No team"}</small>
                              <em translate="no">{option.intercom_agent_name || "No Intercom agent"}</em>
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="action-row">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={handleSaveSupervisorTeam}
                    disabled={supervisorSaveLoading}
                  >
                    {supervisorSaveLoading
                      ? "Saving..."
                      : supervisorForm.id
                      ? "Update supervisor team"
                      : "Save Supervisor Team"}
                  </button>

                  <button type="button" className="secondary-btn" onClick={handleClearSupervisorForm}>
                    Clear
                  </button>
                </div>
              </div>
            </article>

            <article className="panel supervisor-list-panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Saved supervisor teams</p>
                  <h2>Team Directory</h2>
                  <p className="muted">Edit Supervisor Groups and keep Dashboard filtering clean.</p>
                </div>
              </div>

              <div className="filter-grid compact">
                <label>
                  <span>Search Supervisor Teams</span>
                  <input
                    value={supervisorSearch}
                    onChange={(event) => setSupervisorSearch(event.target.value)}
                    placeholder="Search supervisor, email, member, or status"
                  />
                </label>
              </div>

              {supervisorLoading ? (
                <div className="empty-box">Loading Supervisor Teams...</div>
              ) : filteredSupervisorTeams.length === 0 ? (
                <div className="empty-box">No Supervisor Teams Saved Yet.</div>
              ) : (
                <div className="supervisor-card-list">
                  {filteredSupervisorTeams.map((team) => {
                    const supervisorDisplayName = getCanonicalSupervisorName(team, mappingRows);
                    const savedNameNote = getSavedNameMismatchNote(team.supervisor_name, supervisorDisplayName);

                    return (
                      <article key={team.id} className={team.is_active === false ? "supervisor-card inactive" : "supervisor-card"}>
                        <div className="supervisor-card-head">
                          <div className="notranslate" translate="no">
                            <h3 translate="no">{supervisorDisplayName}</h3>
                            <p translate="no">{team.supervisor_email || "No email saved"}</p>
                            {savedNameNote ? <small className="canonical-note" translate="no">{savedNameNote}</small> : null}
                          </div>

                          <span className={team.is_active === false ? "status inactive" : "status active"}>
                            {team.is_active === false ? "Inactive" : "Active"}
                          </span>
                        </div>

                        {team.notes ? <p className="supervisor-note notranslate" translate="no">{team.notes}</p> : null}

                        <div className="supervisor-member-preview notranslate" translate="no">
                          {(team.members || []).slice(0, 10).map((member) => (
                            <span key={getMemberKey(member)} translate="no">{member.employee_name}</span>
                          ))}

                          {(team.members || []).length > 10 ? (
                            <MoreMembersChip
                              members={(team.members || []).slice(10)}
                              count={(team.members || []).length - 10}
                            />
                          ) : null}

                          {(team.members || []).length === 0 ? <span>No members assigned</span> : null}
                        </div>

                        <div className="supervisor-card-foot">
                          <small>
                            {formatNumber((team.members || []).length)} member(s) • Updated {formatDateTime(team.updated_at)}
                          </small>

                          <div className="table-actions">
                            <button
                              type="button"
                              className="secondary-btn small"
                              onClick={() => handleEditSupervisorTeam(team)}
                            >
                              Edit
                            </button>

                            <button
                              type="button"
                              className="secondary-btn small"
                              disabled={supervisorToggleLoadingId === team.id}
                              onClick={() => handleToggleSupervisorTeamActive(team)}
                            >
                              {supervisorToggleLoadingId === team.id
                                ? "Saving..."
                                : team.is_active === false
                                ? "Activate"
                                : "Deactivate"}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </article>
          </section>

          <section className="control-grid mapping-area" id="mapping-workbench">
            <article className="panel" ref={mappingFormRef}>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Agent mapping</p>
                  <h2>{mappingForm.id ? "Edit mapping" : "Map Agent"}</h2>
                  <p className="muted">Map raw Intercom names to employee identity, team, and email.</p>
                </div>

                {mappingForm.id ? <span className="status active">Editing</span> : <span className="status neutral">New</span>}
              </div>

              <div className="form-grid single">
                <label>
                  <span>Intercom agent name</span>
                  <input
                    value={mappingForm.intercom_agent_name}
                    onChange={(event) =>
                      setMappingForm((prev) => ({
                        ...prev,
                        intercom_agent_name: event.target.value,
                      }))
                    }
                    placeholder="Intercom name"
                  />
                </label>

                <label>
                  <span>Employee name</span>
                  <input
                    value={mappingForm.employee_name}
                    onChange={(event) =>
                      setMappingForm((prev) => ({
                        ...prev,
                        employee_name: event.target.value,
                      }))
                    }
                    placeholder="Employee name"
                  />
                </label>

                <div className="form-grid two">
                  <label>
                    <span>Employee email</span>
                    <input
                      type="email"
                      value={mappingForm.employee_email}
                      onChange={(event) =>
                        setMappingForm((prev) => ({
                          ...prev,
                          employee_email: event.target.value,
                        }))
                      }
                      placeholder="employee@nextventures.io"
                    />
                  </label>

                  <label>
                    <span>Team name</span>
                    <input
                      value={mappingForm.team_name}
                      onChange={(event) =>
                        setMappingForm((prev) => ({
                          ...prev,
                          team_name: event.target.value,
                        }))
                      }
                      placeholder="Example: CEx"
                    />
                  </label>
                </div>

                <label>
                  <span>Notes</span>
                  <textarea
                    className="textarea note"
                    value={mappingForm.notes}
                    onChange={(event) =>
                      setMappingForm((prev) => ({
                        ...prev,
                        notes: event.target.value,
                      }))
                    }
                    placeholder="Optional notes"
                  />
                </label>

                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={mappingForm.is_active}
                    onChange={(event) =>
                      setMappingForm((prev) => ({
                        ...prev,
                        is_active: event.target.checked,
                      }))
                    }
                  />
                  <span>Active mapping for future audits</span>
                </label>

                <div className="action-row">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={handleSaveMapping}
                    disabled={mappingSaveLoading}
                  >
                    {mappingSaveLoading ? "Saving..." : mappingForm.id ? "Update mapping" : "Save mapping"}
                  </button>

                  <button type="button" className="secondary-btn" onClick={handleResetMappingForm}>
                    Clear
                  </button>
                </div>
              </div>
            </article>

            <article className="panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Detected agents</p>
                  <h2>Suggested Mappings</h2>
                  <p className="muted">Agents found in stored results without saved mappings.</p>
                </div>
              </div>

              {mappingSuggestions.length === 0 ? (
                <div className="empty-box">No new agent suggestions.</div>
              ) : (
                <div className="scroll-stack">
                  {mappingSuggestions.map((item) => (
                    <article className="mini-card" key={item.intercom_agent_name}>
                      <div className="mini-head">
                        <div>
                          <p className="eyebrow">Intercom agent</p>
                          <h3>{item.intercom_agent_name}</h3>
                        </div>

                        <button
                          type="button"
                          className="secondary-btn small"
                          onClick={() => handleUseSuggestion(item)}
                        >
                          Use
                        </button>
                      </div>

                      <div className="mini-grid">
                        <span>
                          <b>Employee</b>
                          {item.employee_name || "-"}
                        </span>
                        <span>
                          <b>Email</b>
                          {item.employee_email || "-"}
                        </span>
                        <span>
                          <b>Team</b>
                          {item.team_name || "-"}
                        </span>
                        <span>
                          <b>Seen</b>
                          {formatDateTime(item.latest_seen_at)}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </article>
          </section>

          <section className="control-grid mapping-support-grid">
            <article className="panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Mapping risk</p>
                  <h2>Unmapped Agents</h2>
                  <p className="muted">Stored agents without active mapping coverage.</p>
                </div>
              </div>

              {unmappedRows.length === 0 ? (
                <div className="empty-box success-box">No unmapped stored agents.</div>
              ) : (
                <div className="scroll-stack compact-list">
                  {unmappedRows.map((item) => (
                    <article className="mini-card warning-card" key={item.intercom_agent_name}>
                      <div className="mini-head">
                        <div>
                          <p className="eyebrow amber">{item.issue_label}</p>
                          <h3>{item.intercom_agent_name}</h3>
                        </div>

                        <button
                          type="button"
                          className="secondary-btn small"
                          onClick={() =>
                            handleUseSuggestion({
                              intercom_agent_name: item.intercom_agent_name,
                              employee_name: item.sample_employee_name || item.intercom_agent_name,
                              employee_email: item.sample_employee_email || "",
                              team_name: item.sample_team_name || "",
                              notes: "Prefilled from unmapped stored result.",
                            })
                          }
                        >
                          Map
                        </button>
                      </div>

                      <div className="mini-grid two-items">
                        <span>
                          <b>Count</b>
                          {item.appearances}
                        </span>
                        <span>
                          <b>Latest</b>
                          {formatDateTime(item.latest_seen_at)}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </article>

            <article className="panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Mapping summary</p>
                  <h2>Current Status</h2>
                </div>
              </div>

              <div className="rule-list">
                <div>
                  <b>Active</b>
                  <span>{formatNumber(activeMappingsCount)} mapping(s)</span>
                </div>

                <div>
                  <b>Inactive</b>
                  <span>{formatNumber(inactiveMappingsCount)} mapping(s)</span>
                </div>

                <div>
                  <b>Healthy</b>
                  <span>{formatNumber(healthyMappingsCount)} mapping(s)</span>
                </div>

                <div>
                  <b>Needs work</b>
                  <span>{formatNumber(incompleteMappingsCount + unmappedRows.length)} item(s)</span>
                </div>
              </div>
            </article>
          </section>

          <section className="panel wide" id="user-roles" ref={roleFormRef}>
            <div className="section-head">
              <div>
                <p className="eyebrow">Access control</p>
                <h2>User Roles</h2>
                <p className="muted">
                  Pre-Grant Access By nextventures.io Email Before A User Signs In, Or Update Users Who Already Have Profiles.
                </p>
              </div>

              <span className={canManageUsersNow ? "status active" : "status inactive"}>
                {canManageUsersNow ? "Role Manager" : "Read only"}
              </span>
            </div>

            <div className="role-grid">
              <div className="role-form-card">
                <h3>{roleForm.id ? "Edit user access" : "Select A User To Edit"}</h3>

                <div className="form-grid single">
                  <label className="role-candidate-field">
                    <span>Search Existing Employee</span>
                    <input
                      value={roleCandidateSearch}
                      onChange={(event) => setRoleCandidateSearch(event.target.value)}
                      placeholder="Search mapped employee, email, Intercom name, or team"
                    />

                    {roleCandidateSearch.trim().length >= 2 ? (
                      <div className="role-candidate-list">
                        {filteredRoleCandidateOptions.length ? (
                          filteredRoleCandidateOptions.map((option) => (
                            <button
                              type="button"
                              key={getMemberKey(option)}
                              className="role-candidate-option"
                              onClick={() => handleUseRoleCandidate(option)}
                            >
                              <strong>{option.employee_name}</strong>
                              <span>{option.employee_email || "No email saved"} • {option.team_name || "No team"}</span>
                              <em>{option.intercom_agent_name || "No Intercom agent"}</em>
                            </button>
                          ))
                        ) : (
                          <div className="manual-supervisor-hint">
                            No mapped employee matched. You can still type a nextventures.io email manually below.
                          </div>
                        )}
                      </div>
                    ) : null}
                  </label>

                  <label>
                    <span>Email</span>
                    <input
                      value={roleForm.email}
                      onChange={(event) =>
                        setRoleForm((prev) => ({
                          ...prev,
                          email: normalizeEmail(event.target.value),
                        }))
                      }
                      placeholder="employee@nextventures.io"
                    />
                  </label>

                  <label>
                    <span>Name</span>
                    <input
                      value={lockedRoleName || roleForm.full_name}
                      disabled={Boolean(lockedRoleName)}
                      onChange={(event) =>
                        setRoleForm((prev) => ({
                          ...prev,
                          full_name: event.target.value,
                        }))
                      }
                      placeholder="Optional name"
                    />
                    {lockedRoleName ? (
                      <small className="lock-note">
                        Name locked from Agent Mapping for audit trackability.
                      </small>
                    ) : null}
                  </label>

                  <label>
                    <span>Role</span>
                    <select
                      value={roleForm.role}
                      onChange={(event) => handleRoleChange(event.target.value)}
                      disabled={normalizeEmail(roleForm.email) === MASTER_ADMIN_EMAIL}
                    >
                      {ROLE_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <small className="lock-note">{roleDescription(roleForm.role)}</small>

                    <div className="role-hover-guide" aria-label="Role Permission Guide">
                      {ROLE_OPTIONS.map((item) => (
                        <span key={item.value} className={roleForm.role === item.value ? "active" : ""}>
                          {item.label}
                          <em>{item.description}</em>
                        </span>
                      ))}
                    </div>
                  </label>

                  <div className="permission-grid">
                    <label className="check-row permission-check">
                      <input
                        type="checkbox"
                        checked={roleForm.can_run_tests}
                        disabled={normalizeEmail(roleForm.email) === MASTER_ADMIN_EMAIL}
                        onChange={(event) =>
                          setRoleForm((prev) => ({
                            ...prev,
                            can_run_tests: event.target.checked,
                          }))
                        }
                      />
                      <span>Can Run Audits</span>
                    </label>

                    <label className="check-row permission-check">
                      <input
                        type="checkbox"
                        checked={roleForm.is_active}
                        disabled={normalizeEmail(roleForm.email) === MASTER_ADMIN_EMAIL}
                        onChange={(event) =>
                          setRoleForm((prev) => ({
                            ...prev,
                            is_active: event.target.checked,
                          }))
                        }
                      />
                      <span>Active User</span>
                    </label>
                  </div>

                  <div className="action-row">
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={handleSaveRole}
                      disabled={!canManageUsersNow || roleSaveLoading || !normalizeEmail(roleForm.email)}
                    >
                      {roleSaveLoading ? "Saving..." : "Save Role"}
                    </button>

                    <button type="button" className="secondary-btn" onClick={handleClearRoleForm}>
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              <div className="role-table-card">
                <div className="filter-grid compact">
                  <label>
                    <span>Search Users</span>
                    <input
                      value={roleSearch}
                      onChange={(event) => setRoleSearch(event.target.value)}
                      placeholder="Search by email, name, role, or status"
                    />
                  </label>
                </div>

                <div className="profile-list">
                  {profileLoading ? (
                    <div className="empty-box">Loading profiles...</div>
                  ) : filteredProfileRows.length === 0 ? (
                    <div className="empty-box">No matching profiles.</div>
                  ) : (
                    filteredProfileRows.map((row) => {
                      const email = normalizeEmail(row?.email);
                      const isCreator = email === MASTER_ADMIN_EMAIL;

                      return (
                        <article className="profile-card" key={row.id || row.email}>
                          <div>
                            <strong>{row.full_name || row.email}</strong>
                            <small>{row.email}</small>
                            <em>{row.source_label || (row.has_profile ? "Signed in" : "Pre-granted")}</em>
                          </div>

                          <div className="profile-card-meta">
                            <span className={row.is_active === false ? "status inactive" : "status active"}>
                              {row.is_active === false ? "Inactive" : "Active"}
                            </span>
                            <span className="tone notice">{roleLabel(isCreator ? "master_admin" : row.role)}</span>
                            <span className={row.can_run_tests || isCreator ? "tone success" : "tone neutral"}>
                              {row.can_run_tests || isCreator ? "Run audit" : "No audit"}
                            </span>
                          </div>

                          <button
                            type="button"
                            className="secondary-btn small"
                            onClick={() =>
                              handleEditRole({
                                ...row,
                                role: isCreator ? "master_admin" : row.role,
                                can_run_tests: isCreator ? true : row.can_run_tests,
                                is_active: isCreator ? true : row.is_active,
                              })
                            }
                          >
                            Edit
                          </button>
                        </article>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="panel wide" id="agent-mappings">
            <div className="section-head">
              <div>
                <p className="eyebrow">Mapping Table</p>
                <h2>Agent Mappings</h2>
                <p className="muted">Edit, activate, deactivate, and review mapping quality.</p>
              </div>

              <div className="tiny-metrics">
                <span>
                  <b>{formatNumber(mappingRows.length)}</b>
                  total
                </span>
                <span>
                  <b>{formatNumber(activeMappingsCount)}</b>
                  active
                </span>
                <span>
                  <b>{formatNumber(incompleteMappingsCount)}</b>
                  incomplete
                </span>
                <span>
                  <b>{formatNumber(unmappedRows.length)}</b>
                  risk
                </span>
              </div>
            </div>

            <div className="filter-grid">
              <label>
                <span>Search <HelpTip text="Search by Intercom agent, mapped employee, email, team, notes, or quality state." /></span>
                <input
                  value={mappingSearch}
                  onChange={(event) => setMappingSearch(event.target.value)}
                  placeholder="Search Mappings"
                />
              </label>

              <label>
                <span>Status <HelpTip text="Filter active or inactive mapping records. Active mappings are used by future audits." /></span>
                <select
                  value={mappingStatusFilter}
                  onChange={(event) => setMappingStatusFilter(event.target.value)}
                >
                  <option value="all">All Statuses</option>
                  <option value="active">Active only</option>
                  <option value="inactive">Inactive only</option>
                </select>
              </label>

              <label>
                <span>Quality <HelpTip text="Mapping quality explains whether a mapping is healthy, missing email/team data, inactive, or simply has no stored usage yet." /></span>
                <select
                  value={mappingQualityFilter}
                  onChange={(event) => setMappingQualityFilter(event.target.value)}
                >
                  <option value="all">All Quality States</option>
                  <option value="needs_attention">Needs attention</option>
                  <option value="missing_email_team">Needs email and team</option>
                  <option value="missing_email">Needs email</option>
                  <option value="missing_team">Needs team</option>
                  <option value="inactive">Inactive</option>
                  <option value="healthy">Healthy</option>
                  <option value="no_stored_usage">Ready, no stored usage</option>
                </select>
              </label>

              <button
                type="button"
                className="secondary-btn clear-btn"
                onClick={() => {
                  setMappingSearch("");
                  setMappingStatusFilter("all");
                  setMappingQualityFilter("all");
                }}
              >
                Clear
              </button>
            </div>

            <div className="chip-row">
              <span>
                Showing {formatNumber(filteredMappings.length)} of {formatNumber(mappingRows.length)}
              </span>
              <span className={unmappedRows.length ? "chip warning" : "chip success"}>
                {formatNumber(unmappedRows.length)} risk
              </span>
              <span className={mappingSuggestions.length ? "chip notice" : "chip success"}>
                {formatNumber(mappingSuggestions.length)} detected
              </span>
            </div>

            {mappingLoading ? (
              <div className="empty-box">Loading mappings...</div>
            ) : filteredMappings.length === 0 ? (
              <div className="empty-box">No matching mapping rows.</div>
            ) : (
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>Intercom agent</th>
                      <th>Employee</th>
                      <th>Team</th>
                      <th>Quality</th>
                      <th>Usage</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {filteredMappings.map((row) => (
                      <tr key={row.id || row.intercom_agent_name}>
                        <td className="notranslate" translate="no">
                          <strong translate="no">{row.intercom_agent_name || "-"}</strong>
                          <small>Raw Intercom name</small>
                        </td>

                        <td className="notranslate" translate="no">
                          <strong translate="no">{row.employee_name || "-"}</strong>
                          <small translate="no">{row.employee_email || "No email"}</small>
                          {row.notes ? <em translate="no">{row.notes}</em> : null}
                        </td>

                        <td>
                          {row.team_name ? (
                            <span className="team-pill notranslate" translate="no">{row.team_name}</span>
                          ) : (
                            <span className="missing-text">No team</span>
                          )}
                        </td>

                        <td>
                          <span className={toneClass(row.quality.tone)}>{row.quality.label}</span>
                          <small>{row.quality.detail}</small>
                        </td>

                        <td>
                          <strong>{formatNumber(row.stats.appearances)}</strong>
                          <small>
                            {row.stats.appearances
                              ? `Latest: ${formatDateTime(row.stats.latest_seen_at)}`
                              : "No stored usage"}
                          </small>
                        </td>

                        <td>
                          <span className={row.is_active === false ? "status inactive" : "status active"}>
                            {row.is_active === false ? "Inactive" : "Active"}
                          </span>
                        </td>

                        <td>
                          <div className="table-actions">
                            <button
                              type="button"
                              className="secondary-btn small"
                              onClick={() => handleEditMapping(row)}
                            >
                              Edit
                            </button>

                            <button
                              type="button"
                              className="secondary-btn small"
                              disabled={mappingToggleLoadingId === row.id}
                              onClick={() => handleToggleMappingActive(row)}
                            >
                              {mappingToggleLoadingId === row.id
                                ? "Saving..."
                                : row.is_active === false
                                ? "Activate"
                                : "Deactivate"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel wide" id="prompt-history">
            <div className="section-head">
              <div>
                <p className="eyebrow">Prompt History</p>
                <h2>Recent Changes</h2>
                <p className="muted">Recent saved prompt changes.</p>
              </div>
            </div>

            {historyRows.length === 0 ? (
              <div className="empty-box">No prompt history yet.</div>
            ) : (
              <div className="history-list">
                {historyRows.slice(0, 12).map((item, index) => (
                  <article className="history-card" key={item?.id || index}>
                    <div>
                      <strong>{item?.prompt_type || "Prompt change"}</strong>
                      <span>{formatDateTime(item?.created_at || item?.updated_at)}</span>
                    </div>

                    <p>{item?.change_note || item?.notes || "No change note."}</p>
                    <dl className="history-meta-grid">
                      <div>
                        <dt>Performer</dt>
                        <dd>{item?.changed_by_name || item?.changed_by_email || item?.created_by_email || "Not saved"}</dd>
                      </div>
                      <div>
                        <dt>Saved At</dt>
                        <dd>{formatDateTime(item?.created_at || item?.updated_at)}</dd>
                      </div>
                    </dl>
                    {item?.id ? (
                      <details className="history-details">
                        <summary>Show Details</summary>
                        <pre>{safeJsonPreview({
                          id: item.id,
                          prompt_type: item.prompt_type,
                          changed_by: item.changed_by_email || item.created_by_email || item.updated_by_email || null,
                          created_at: item.created_at,
                          updated_at: item.updated_at,
                          note: item.change_note || item.notes || null,
                        })}</pre>
                      </details>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}

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

const adminStyles = `
  .admin-page {
    min-height: 100vh;
    padding: 22px 18px 76px;
    color: #f5f7ff;
    background:
      radial-gradient(circle at 8% 0%, rgba(37, 99, 235, 0.14), transparent 24%),
      radial-gradient(circle at 88% 3%, rgba(139, 92, 246, 0.16), transparent 26%),
      radial-gradient(circle at 50% 100%, rgba(6, 182, 212, 0.08), transparent 24%),
      linear-gradient(180deg, #040714 0%, #050918 46%, #04060d 100%);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    scroll-behavior: smooth;
  }

  .hero,
  .panel,
  .stat-card,
  .status-grid,
  .control-grid,
  .message-stack {
    max-width: 1440px;
    margin-left: auto;
    margin-right: auto;
  }

  .hero,
  .panel,
  .stat-card,
  .mini-card,
  .history-card,
  .api-card,
  .role-form-card,
  .role-table-card,
  .profile-card,
  .member-picker,
  .supervisor-card {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background:
      linear-gradient(180deg, rgba(14, 20, 40, 0.92), rgba(7, 10, 24, 0.96));
    box-shadow:
      0 24px 80px rgba(0, 0, 0, 0.34),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .eyebrow {
    margin: 0 0 8px;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .eyebrow.amber {
    color: #fcd34d;
  }

  .hero {
    position: relative;
    overflow: hidden;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(290px, 340px);
    gap: 22px;
    align-items: stretch;
    padding: 30px;
    margin-bottom: 18px;
    border-radius: 30px;
  }

  .hero::before {
    content: "";
    position: absolute;
    inset: -170px auto auto -130px;
    width: 390px;
    height: 390px;
    border-radius: 999px;
    background: rgba(37, 99, 235, 0.14);
    filter: blur(62px);
    pointer-events: none;
  }

  .hero::after {
    content: "";
    position: absolute;
    inset: -140px -120px auto auto;
    width: 440px;
    height: 440px;
    border-radius: 999px;
    background: rgba(124, 58, 237, 0.22);
    filter: blur(58px);
    pointer-events: none;
  }

  .hero > * {
    position: relative;
    z-index: 1;
  }

  .hero-badge,
  .team-pill,
  .chip,
  .tone,
  .status,
  .admin-quick-nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: fit-content;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 900;
    text-decoration: none;
  }

  .hero-badge {
    min-height: 34px;
    padding: 0 12px;
    margin-bottom: 16px;
    color: #e7ecff;
    border: 1px solid rgba(129, 140, 248, 0.24);
    background: rgba(99, 102, 241, 0.16);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    position: relative;
  }

  h1 {
    max-width: 940px;
    margin: 0 0 16px;
    font-size: clamp(42px, 5vw, 72px);
    line-height: 0.98;
    letter-spacing: -0.07em;
  }

  h2 {
    margin: 0 0 10px;
    font-size: 30px;
    line-height: 1.1;
    letter-spacing: -0.04em;
  }

  h3 {
    margin: 0;
    font-size: 20px;
  }

  .hero p,
  .muted {
    color: #a9b4d0;
    font-size: 17px;
    line-height: 1.7;
  }

  .hero p {
    max-width: 820px;
    margin: 0 0 20px;
    font-size: 20px;
  }

  .hero-side-card {
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

  .hero-side-card span,
  .hero-side-card strong,
  .hero-side-card small {
    display: block;
  }

  .hero-side-card span {
    margin-bottom: 8px;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .hero-side-card strong {
    margin-bottom: 6px;
    font-size: 26px;
    letter-spacing: -0.04em;
  }

  .hero-side-card small {
    color: #a9b4d0;
    word-break: break-word;
  }

  .hero-actions {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding-top: 4px;
  }

  .action-row,
  .chip-row,
  .table-actions,
  .admin-quick-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .admin-quick-nav a {
    min-height: 38px;
    padding: 0 13px;
    color: #dbe7ff;
    border: 1px solid rgba(96, 165, 250, 0.16);
    background: rgba(59, 130, 246, 0.07);
    transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
  }

  .admin-quick-nav a:hover {
    transform: translateY(-1px);
    border-color: rgba(96, 165, 250, 0.32);
    background: rgba(59, 130, 246, 0.13);
  }

  button,
  input,
  textarea,
  select {
    font: inherit;
  }

  button:disabled,
  input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .primary-btn,
  .secondary-btn {
    min-height: 46px;
    border-radius: 15px;
    padding: 12px 18px;
    font-size: 16px;
    font-weight: 900;
    cursor: pointer;
    transition: transform 0.18s ease, opacity 0.18s ease, border-color 0.18s ease, background 0.18s ease;
  }

  .primary-btn:hover,
  .secondary-btn:hover,
  .jump-top:hover {
    transform: translateY(-1px);
  }

  .primary-btn {
    color: white;
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
    min-height: 38px;
    padding: 9px 12px;
    font-size: 14px;
  }

  .status-grid,
  .control-grid,
  .filter-grid {
    display: grid;
    gap: 18px;
  }

  .status-grid {
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    margin-bottom: 18px;
  }

  .control-grid {
    grid-template-columns: minmax(0, 1.14fr) minmax(400px, 0.86fr);
    margin-bottom: 20px;
  }

  .control-grid.single-column {
    grid-template-columns: 1fr;
  }

  .mapping-area,
  .mapping-support-grid {
    grid-template-columns: repeat(2, minmax(360px, 1fr));
    align-items: stretch;
  }

  .mapping-area > .panel,
  .mapping-support-grid > .panel {
    width: 100%;
    min-height: 420px;
  }

  .mapping-support-grid > .panel {
    min-height: 330px;
  }

  .mapping-support-grid .rule-list {
    max-width: 100%;
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
    left: -55px;
    top: -55px;
    width: 150px;
    height: 150px;
    border-radius: 50%;
    filter: blur(34px);
    background: rgba(59, 130, 246, 0.13);
  }

  .stat-card.success::before { background: rgba(16, 185, 129, 0.13); }
  .stat-card.warning::before { background: rgba(245, 158, 11, 0.15); }
  .stat-card.notice::before { background: rgba(59, 130, 246, 0.14); }

  .stat-card p,
  .stat-card strong,
  .stat-card span {
    position: relative;
    z-index: 1;
  }

  .stat-card p {
    margin: 0 0 10px;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .stat-card strong {
    display: block;
    margin-bottom: 8px;
    font-size: 30px;
    letter-spacing: -0.05em;
  }

  .stat-card span {
    display: block;
    color: #a9b4d0;
    font-size: 16px;
    line-height: 1.6;
  }

  .message-stack {
    margin-bottom: 18px;
    display: grid;
    gap: 12px;
  }

  .message {
    padding: 14px 16px;
    border-radius: 18px;
    font-size: 16px;
    line-height: 1.6;
  }

  .message.error {
    color: #fecdd3;
    border: 1px solid rgba(244, 63, 94, 0.23);
    background: rgba(244, 63, 94, 0.08);
  }

  .message.warning {
    color: #fde68a;
    border: 1px solid rgba(245, 158, 11, 0.23);
    background: rgba(245, 158, 11, 0.08);
  }

  .message.success {
    color: #bbf7d0;
    border: 1px solid rgba(16, 185, 129, 0.23);
    background: rgba(16, 185, 129, 0.08);
  }

  .panel {
    position: relative;
    overflow: hidden;
    padding: 24px;
    border-radius: 28px;
  }

  .panel::before {
    content: "";
    position: absolute;
    inset: -120px auto auto -120px;
    width: 250px;
    height: 250px;
    border-radius: 999px;
    background: rgba(59, 130, 246, 0.06);
    filter: blur(42px);
    pointer-events: none;
  }

  .panel > * {
    position: relative;
    z-index: 1;
  }

  .panel.wide {
    margin-bottom: 20px;
  }

  .gate-panel {
    display: grid;
    gap: 12px;
  }

  .gate-panel .primary-btn {
    width: fit-content;
  }

  .section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }

  .textarea,
  input,
  select {
    width: 100%;
    box-sizing: border-box;
    color: #e7ecff;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 16px;
    outline: none;
    background: rgba(5, 8, 18, 0.9);
  }

  input,
  select {
    min-height: 50px;
    padding: 0 14px;
    color-scheme: dark;
  }

  .textarea {
    min-height: 110px;
    padding: 15px;
    line-height: 1.7;
    resize: vertical;
  }

  input:focus,
  select:focus,
  textarea:focus {
    border-color: rgba(96, 165, 250, 0.38);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.12);
  }

  .textarea.live {
    min-height: 420px;
    margin-bottom: 14px;
  }

  .textarea.note {
    min-height: 88px;
    margin-bottom: 14px;
  }

  .textarea.trusted {
    min-height: 260px;
    margin-top: 12px;
  }

  .trusted-prompt-drawer {
    margin-top: 18px;
    padding: 16px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
  }

  .trusted-prompt-drawer summary {
    cursor: pointer;
    color: #e5ebff;
    font-weight: 900;
  }

  .trusted-prompt-drawer p {
    color: #a9b4d0;
    line-height: 1.7;
  }

  .api-card-grid {
    display: grid;
    gap: 14px;
  }

  .api-card {
    padding: 18px;
    border-radius: 22px;
    background:
      radial-gradient(circle at top right, rgba(139, 92, 246, 0.1), transparent 34%),
      rgba(255, 255, 255, 0.035);
  }

  .api-card span,
  .api-card strong,
  .api-card p {
    display: block;
  }

  .api-card span {
    margin-bottom: 8px;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .api-card strong {
    margin-bottom: 8px;
    color: #ffffff;
    font-size: 20px;
  }

  .api-card p {
    margin: 0;
    color: #a9b4d0;
    line-height: 1.7;
  }

  .api-card.secure {
    display: grid;
    gap: 16px;
  }

  .api-card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .api-meta-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .api-meta-grid div,
  .api-key-form,
  .key-record,
  .rule-list div,
  .permission-check {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  .api-meta-grid div {
    padding: 12px;
    border-radius: 16px;
  }

  .api-meta-grid b,
  .api-meta-grid span {
    display: block;
  }

  .api-meta-grid b {
    margin-bottom: 5px;
    color: #8ea0d6;
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .api-meta-grid span {
    color: #dbe7ff;
    word-break: break-word;
  }

  .api-key-form {
    display: grid;
    gap: 12px;
    padding: 14px;
    border-radius: 18px;
  }

  .api-active-check {
    width: fit-content;
  }

  .api-key-list {
    display: grid;
    gap: 10px;
  }

  .key-record {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    padding: 13px;
    border-radius: 16px;
  }

  .key-record strong,
  .key-record span,
  .key-record small {
    display: block;
  }

  .key-record strong {
    margin-bottom: 5px;
    color: #ffffff;
  }

  .key-record span {
    color: #dbe7ff;
    word-break: break-word;
  }

  .key-record small {
    margin-top: 5px;
    color: #8ea0d6;
  }

  .danger-soft {
    border-color: rgba(244, 63, 94, 0.18);
    color: #fecdd3;
    background: rgba(244, 63, 94, 0.08);
  }

  .form-grid {
    display: grid;
    gap: 14px;
  }

  .form-grid.two {
    grid-template-columns: 1fr 1fr;
  }

  label span,
  .filter-grid label span {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 18px;
    margin-bottom: 8px;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    line-height: 1.1;
    text-transform: uppercase;
  }

  .supervisor-name-field,
  .role-candidate-field {
    position: relative;
  }

  .supervisor-suggestion-list,
  .role-candidate-list {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(100% + 8px);
    z-index: 30;
    display: grid;
    gap: 8px;
    max-height: 360px;
    overflow: auto;
    padding: 10px;
    border-radius: 18px;
    border: 1px solid rgba(96, 165, 250, 0.22);
    background: rgba(5, 8, 18, 0.98);
    box-shadow: 0 22px 50px rgba(0, 0, 0, 0.55);
  }

  .supervisor-suggestion,
  .role-candidate-option {
    display: grid;
    gap: 3px;
    width: 100%;
    text-align: left;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 12px;
    color: #e5ebff;
    background: rgba(255, 255, 255, 0.035);
    cursor: pointer;
  }

  .supervisor-suggestion:hover,
  .role-candidate-option:hover {
    border-color: rgba(16, 185, 129, 0.35);
    background: rgba(16, 185, 129, 0.09);
  }

  .supervisor-suggestion strong,
  .supervisor-suggestion span,
  .supervisor-suggestion em,
  .role-candidate-option strong,
  .role-candidate-option span,
  .role-candidate-option em {
    display: block;
  }

  .supervisor-suggestion strong,
  .role-candidate-option strong {
    color: #ffffff;
  }

  .supervisor-suggestion span,
  .role-candidate-option span {
    color: #a9b4d0;
    font-size: 14px;
  }

  .supervisor-suggestion em,
  .role-candidate-option em {
    color: #8ea0d6;
    font-size: 14px;
    font-style: normal;
  }

  .manual-supervisor-hint {
    padding: 12px;
    color: #a9b4d0;
    border-radius: 14px;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.03);
    line-height: 1.5;
  }

  .check-row {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  .check-row input {
    width: auto;
    min-height: auto;
  }

  .check-row span {
    margin: 0;
    color: #dbe7ff;
    letter-spacing: 0;
    font-size: 16px;
    text-transform: none;
  }

  .permission-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .permission-check {
    padding: 14px;
    border-radius: 16px;
  }

  .lock-note {
    display: block;
    margin-top: 8px;
    color: #a9b4d0;
    line-height: 1.5;
  }

  .scroll-stack {
    display: grid;
    gap: 12px;
    width: 100%;
  }

  .scroll-stack .mini-card {
    width: 100%;
  }

  .empty-box {
    padding: 20px;
    color: #a9b4d0;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.025);
    line-height: 1.7;
  }

  .success-box {
    color: #bbf7d0;
    border-color: rgba(16, 185, 129, 0.22);
    background: rgba(16, 185, 129, 0.07);
  }

  .scroll-stack {
    display: grid;
    gap: 12px;
    max-height: 560px;
    overflow: auto;
    padding-right: 4px;
  }

  .scroll-stack.compact-list {
    max-height: 520px;
  }

  .mini-card {
    padding: 16px;
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.035);
  }

  .warning-card {
    border-color: rgba(251, 191, 36, 0.18);
    background: rgba(245, 158, 11, 0.08);
  }

  .mini-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }

  .mini-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .mini-grid span {
    color: #dbe7ff;
    font-size: 16px;
    line-height: 1.5;
  }

  .mini-grid b {
    display: block;
    color: #8ea0d6;
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .member-picker {
    padding: 18px;
    border-radius: 22px;
    background:
      radial-gradient(circle at top left, rgba(59, 130, 246, 0.12), transparent 32%),
      rgba(255, 255, 255, 0.03);
  }

  .member-picker-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 14px;
  }

  .selected-member-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
  }

  .selected-member-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 1px solid rgba(16, 185, 129, 0.24);
    background: rgba(16, 185, 129, 0.08);
    color: #bbf7d0;
    border-radius: 999px;
    padding: 8px 10px;
    font-size: 14px;
    font-weight: 900;
    cursor: pointer;
  }

  .selected-member-chip span {
    color: #fca5a5;
    font-size: 13px;
  }

  .member-option-list {
    display: grid;
    gap: 9px;
    max-height: 420px;
    overflow: auto;
    margin-top: 12px;
    padding-right: 4px;
  }

  .member-option {
    width: 100%;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    text-align: left;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(5, 8, 18, 0.72);
    color: #e5ebff;
    border-radius: 16px;
    padding: 12px;
    cursor: pointer;
  }

  .member-option.selected {
    border-color: rgba(16, 185, 129, 0.34);
    background: rgba(16, 185, 129, 0.09);
  }

  .member-check {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.06);
    color: #bfdbfe;
    font-weight: 900;
  }

  .member-option.selected .member-check {
    background: rgba(16, 185, 129, 0.18);
    color: #bbf7d0;
  }

  .member-copy strong,
  .member-copy small,
  .member-copy em {
    display: block;
  }

  .member-copy strong {
    color: #fff;
    margin-bottom: 4px;
  }

  .member-copy small {
    color: #a9b4d0;
    line-height: 1.4;
  }

  .member-copy em {
    margin-top: 4px;
    color: #8ea0d6;
    font-size: 14px;
    font-style: normal;
  }

  .supervisor-card-list {
    display: grid;
    gap: 14px;
    max-height: 820px;
    overflow: auto;
    padding-right: 4px;
  }

  .supervisor-card {
    padding: 18px;
    border-radius: 22px;
    background:
      radial-gradient(circle at top right, rgba(139, 92, 246, 0.11), transparent 34%),
      rgba(255, 255, 255, 0.035);
  }

  .supervisor-card.inactive {
    opacity: 0.72;
  }

  .supervisor-card-head,
  .supervisor-card-foot {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 14px;
  }

  .supervisor-card-head p,
  .supervisor-note,
  .supervisor-card-foot small {
    color: #a9b4d0;
    line-height: 1.6;
  }

  .supervisor-card-head p {
    margin: 6px 0 0;
  }

  .supervisor-note {
    margin: 12px 0 0;
  }

  .supervisor-member-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 14px 0;
  }

  .supervisor-member-preview span {
    padding: 7px 10px;
    border-radius: 999px;
    color: #dbe7ff;
    background: rgba(96, 165, 250, 0.1);
    border: 1px solid rgba(96, 165, 250, 0.18);
    font-size: 14px;
    font-weight: 800;
  }

  .member-more-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 7px 10px;
    border-radius: 999px;
    color: #dbe7ff;
    border: 1px solid rgba(34, 211, 238, 0.26) !important;
    background: rgba(34, 211, 238, 0.1) !important;
    font-size: 14px;
    font-weight: 900;
    line-height: 1;
    cursor: help;
  }

  .member-more-chip:hover,
  .member-more-chip:focus-visible {
    color: #ffffff;
    border-color: rgba(34, 211, 238, 0.5) !important;
    background: rgba(34, 211, 238, 0.16) !important;
    outline: none;
    box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.14), 0 10px 26px rgba(15, 23, 42, 0.34);
  }

  .member-more-popover {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    padding: 12px 14px;
    border-radius: 14px;
    color: #eef3ff;
    border: 1px solid rgba(34, 211, 238, 0.3);
    background:
      radial-gradient(circle at top right, rgba(34, 211, 238, 0.16), transparent 38%),
      linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(7, 12, 28, 0.98));
    box-shadow: 0 22px 70px rgba(0, 0, 0, 0.64), 0 0 0 1px rgba(255, 255, 255, 0.04);
    font-size: 13px;
    font-style: normal;
    font-weight: 800;
    line-height: 1.55;
    white-space: normal;
  }

  .member-more-popover.top {
    transform: translateY(-100%);
  }

  .member-more-popover.bottom {
    transform: none;
  }

  .member-more-popover strong {
    display: block;
    margin-bottom: 5px;
    color: #93c5fd;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .rule-list {
    display: grid;
    gap: 12px;
  }

  .rule-list div {
    padding: 16px;
    border-radius: 18px;
  }

  .rule-list b,
  .rule-list span {
    display: block;
  }

  .rule-list span {
    margin-top: 6px;
    color: #a9b4d0;
    line-height: 1.6;
  }

  .role-grid {
    display: grid;
    grid-template-columns: minmax(320px, 0.8fr) minmax(0, 1.2fr);
    gap: 18px;
  }

  .role-form-card,
  .role-table-card {
    padding: 18px;
    border-radius: 22px;
  }

  .role-form-card {
    position: relative;
    overflow: visible;
    z-index: 8;
  }

  #user-roles.panel {
    overflow: visible;
  }

  .profile-list {
    display: grid;
    gap: 12px;
    max-height: 640px;
    overflow: auto;
    padding-right: 4px;
  }

  .profile-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 14px;
    align-items: center;
    padding: 16px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.035);
  }

  .profile-card strong,
  .profile-card small,
  .profile-card em {
    display: block;
  }

  .profile-card small {
    margin-top: 5px;
    color: #a9b4d0;
    word-break: break-word;
  }

  .profile-card em {
    margin-top: 6px;
    color: #8ea0d6;
    font-size: 14px;
    font-style: normal;
  }

  .profile-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .tiny-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(120px, 1fr));
    gap: 10px;
    min-width: 300px;
  }

  .tiny-metrics span {
    padding: 12px;
    color: #a9b4d0;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  .tiny-metrics b {
    display: block;
    color: #f5f7ff;
    font-size: 20px;
  }

  .filter-grid {
    grid-template-columns: minmax(260px, 1fr) 180px 230px auto;
    align-items: end;
    margin-bottom: 16px;
  }

  .filter-grid.compact {
    grid-template-columns: 1fr;
  }

  .clear-btn {
    min-height: 50px;
  }

  .chip-row {
    margin-bottom: 16px;
    align-items: center;
  }

  .chip-row > span,
  .chip {
    padding: 8px 12px;
    color: #dbe7ff;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    font-size: 15px;
    font-weight: 900;
  }

  .chip.success {
    color: #bbf7d0;
    border-color: rgba(16, 185, 129, 0.22);
    background: rgba(16, 185, 129, 0.08);
  }

  .chip.warning {
    color: #fde68a;
    border-color: rgba(245, 158, 11, 0.22);
    background: rgba(245, 158, 11, 0.09);
  }

  .chip.notice {
    color: #bfdbfe;
    border-color: rgba(96, 165, 250, 0.22);
    background: rgba(59, 130, 246, 0.1);
  }

  .table-shell {
    max-height: 760px;
    overflow: auto;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 24px;
    background: rgba(4, 8, 20, 0.72);
  }

  table {
    width: 100%;
    min-width: 1260px;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 15px 14px;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.065);
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 2;
    color: #8ea0d6;
    background: rgba(10, 18, 34, 0.98);
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
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
    margin-bottom: 4px;
  }

  td small {
    color: #a9b4d0;
    line-height: 1.5;
  }

  td em {
    margin-top: 8px;
    color: #8ea0d6;
    font-size: 14px;
    line-height: 1.5;
    font-style: normal;
  }

  .team-pill {
    padding: 7px 11px;
    color: #dbe7ff;
    border: 1px solid rgba(96, 165, 250, 0.2);
    background: rgba(59, 130, 246, 0.1);
  }

  .missing-text {
    color: #fcd34d;
    font-weight: 900;
  }

  .tone,
  .status {
    padding: 7px 10px;
    margin-bottom: 8px;
  }

  .tone.success,
  .status.active {
    color: #bbf7d0;
    border: 1px solid rgba(16, 185, 129, 0.22);
    background: rgba(16, 185, 129, 0.1);
  }

  .tone.warning,
  .status.inactive {
    color: #fde68a;
    border: 1px solid rgba(245, 158, 11, 0.24);
    background: rgba(245, 158, 11, 0.1);
  }

  .tone.notice,
  .status.neutral {
    color: #bfdbfe;
    border: 1px solid rgba(96, 165, 250, 0.24);
    background: rgba(59, 130, 246, 0.1);
  }

  .tone.neutral {
    color: #dbe7ff;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.05);
  }

  .tone.danger {
    color: #fecdd3;
    border: 1px solid rgba(244, 63, 94, 0.24);
    background: rgba(244, 63, 94, 0.1);
  }

  .history-list {
    display: grid;
    gap: 12px;
  }

  .history-card {
    padding: 16px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.03);
  }

  .history-card div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .history-card span,
  .history-card p {
    margin: 0;
    color: #a9b4d0;
    line-height: 1.6;
  }

  .history-meta-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0 0;
  }

  .history-meta-grid div,
  .history-details {
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    padding: 12px;
  }

  .history-meta-grid dt {
    color: #8ea0d6;
    font-size: 12px;
    font-weight: 950;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .history-meta-grid dd {
    margin: 5px 0 0;
    color: #f5f7ff;
    font-weight: 850;
    overflow-wrap: anywhere;
  }

  .history-details {
    margin-top: 12px;
  }

  .history-details summary {
    cursor: pointer;
    color: #dbeafe;
    font-weight: 900;
  }

  .history-details pre {
    margin-top: 10px;
  }


  .help-tip-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    line-height: 1;
  }

  .help-tip {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    min-width: 18px;
    padding: 0;
    border-radius: 999px;
    color: #dbeafe;
    border: 1px solid rgba(147, 197, 253, 0.32);
    background: rgba(59, 130, 246, 0.15);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    font-family: inherit;
    font-size: 11px;
    font-weight: 950;
    line-height: 1;
    letter-spacing: 0;
    cursor: help;
    vertical-align: middle;
  }

  .help-tip:hover,
  .help-tip:focus-visible {
    color: #ffffff;
    border-color: rgba(147, 197, 253, 0.58);
    background: rgba(37, 99, 235, 0.34);
    outline: none;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2), 0 10px 26px rgba(15, 23, 42, 0.32);
  }

  .help-tip-popover {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    padding: 12px 14px;
    border-radius: 14px;
    color: #eef3ff;
    border: 1px solid rgba(147, 197, 253, 0.3);
    background:
      radial-gradient(circle at top right, rgba(124, 58, 237, 0.2), transparent 38%),
      linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(7, 12, 28, 0.98));
    box-shadow: 0 22px 70px rgba(0, 0, 0, 0.64), 0 0 0 1px rgba(255, 255, 255, 0.04);
    font-size: 13px;
    font-style: normal;
    font-weight: 800;
    line-height: 1.55;
    letter-spacing: 0;
    text-transform: none;
    white-space: normal;
  }

  .help-tip-popover.top {
    transform: translateY(-100%);
  }

  .help-tip-popover.bottom {
    transform: none;
  }

  .admin-date-range-field {
    position: relative;
    grid-column: span 2;
    z-index: 30;
  }

  .admin-date-range-field.open {
    z-index: 9999;
  }

  .admin-date-range-field > label {
    display: grid;
    gap: 8px;
  }

  .admin-date-button {
    width: 100%;
    min-height: 50px;
    display: grid;
    grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    color: #e7ecff;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 16px;
    background: rgba(5, 8, 18, 0.94);
    cursor: pointer;
    text-align: left;
    outline: none;
  }

  .admin-date-button:hover,
  .admin-date-range-field.open .admin-date-button {
    border-color: rgba(96, 165, 250, 0.28);
    box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.1), 0 16px 34px rgba(15, 23, 42, 0.2);
  }

  .admin-date-button strong {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    white-space: nowrap;
    font-weight: 900;
  }

  .admin-date-button small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #8ea0d6;
    font-size: 14px;
    font-weight: 850;
  }

  .admin-date-button b {
    color: #8ea0d6;
    font-size: 13px;
  }

  .admin-date-popover {
    position: absolute;
    left: 0;
    top: calc(100% + 10px);
    z-index: 99999;
    width: min(780px, calc(100vw - 48px));
    overflow: hidden;
    border-radius: 22px;
    border: 1px solid rgba(15, 23, 42, 0.14);
    background: #f8fafc;
    color: #0f172a;
    box-shadow: 0 34px 100px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.9);
  }

  .admin-date-popover-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding: 18px 20px 10px;
    border-bottom: 1px solid rgba(15, 23, 42, 0.1);
  }

  .admin-date-popover-tabs div {
    padding: 10px 12px;
    border-radius: 14px;
    background: #ffffff;
    border: 1px solid rgba(15, 23, 42, 0.08);
  }

  .admin-date-popover-tabs div.active {
    border-bottom-color: #15803d;
    box-shadow: inset 0 -2px 0 #15803d;
  }

  .admin-date-popover-tabs span {
    display: block;
    color: #64748b;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .admin-date-popover-tabs strong,
  .admin-calendar-nav-row strong,
  .admin-calendar-month-card h4 {
    color: #0f172a;
  }

  .admin-date-popover-body {
    display: grid;
    grid-template-columns: 160px minmax(0, 1fr);
    gap: 16px;
    padding: 16px 20px;
  }

  .admin-date-preset-column {
    display: grid;
    align-content: start;
    gap: 8px;
  }

  .admin-date-preset-column button,
  .admin-calendar-nav-row button {
    min-height: 38px;
    border-radius: 12px;
    border: 1px solid rgba(15, 23, 42, 0.1);
    background: #ffffff;
    color: #0f172a;
    font-weight: 850;
    cursor: pointer;
  }

  .admin-date-preset-column button {
    text-align: left;
    padding: 0 12px;
  }

  .admin-date-preset-column button.active,
  .admin-date-preset-column button:hover,
  .admin-calendar-nav-row button:hover {
    background: #dcfce7;
    color: #14532d;
    border-color: rgba(22, 163, 74, 0.28);
  }

  .admin-date-calendar-zone {
    min-width: 0;
  }

  .admin-calendar-nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }

  .admin-calendar-nav-row button {
    width: 42px;
    font-size: 20px;
  }

  .admin-calendar-months-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .admin-calendar-month-card h4 {
    margin: 0 0 10px;
    text-align: center;
    font-size: 17px;
  }

  .admin-calendar-weekdays,
  .admin-calendar-day-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }

  .admin-calendar-weekdays span {
    color: #94a3b8;
    text-align: center;
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.01em;
    text-transform: none;
  }

  .admin-calendar-day {
    min-height: 34px;
    border: 0;
    border-radius: 10px;
    color: #0f172a;
    background: transparent;
    cursor: pointer;
    font-weight: 800;
  }

  .admin-calendar-day:hover {
    background: #e0f2fe;
  }

  .admin-calendar-day.muted {
    color: #cbd5e1;
  }

  .admin-calendar-day.in-range {
    background: #e8f5ec;
  }

  .admin-calendar-day.range-start,
  .admin-calendar-day.range-end {
    color: #ffffff;
    border-radius: 999px;
    background: #15803d;
  }

  .admin-date-popover-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px 18px;
    border-top: 1px solid rgba(15, 23, 42, 0.08);
  }

  .admin-date-popover-actions .secondary-btn {
    background: #ffffff;
    color: #0f172a;
    border: 1px solid rgba(15, 23, 42, 0.1);
  }

  .admin-date-popover-actions .primary-btn {
    background: #15803d;
    color: #ffffff;
  }

  @media (max-width: 820px) {
    .admin-date-popover {
      width: min(94vw, 540px);
    }

    .admin-date-popover-body,
    .admin-calendar-months-grid {
      grid-template-columns: 1fr;
    }
  }

  .activity-panel {
    overflow: visible;
    margin-bottom: 18px;
    background:
      radial-gradient(circle at 10% 0%, rgba(34, 211, 238, 0.08), transparent 30%),
      radial-gradient(circle at 92% 12%, rgba(139, 92, 246, 0.14), transparent 34%),
      linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(5, 8, 20, 0.98));
  }

  .activity-summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .activity-summary-grid article {
    padding: 16px;
    border-radius: 20px;
    border: 1px solid rgba(147, 197, 253, 0.11);
    background:
      radial-gradient(circle at top right, rgba(34, 211, 238, 0.07), transparent 36%),
      rgba(255, 255, 255, 0.035);
  }

  .activity-summary-grid span,
  .activity-summary-grid strong,
  .activity-summary-grid small {
    display: block;
  }

  .activity-summary-grid span {
    margin-bottom: 8px;
    color: #9fb4ff;
    font-size: 13px;
    font-weight: 950;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }

  .activity-summary-grid strong {
    color: #ffffff;
    font-size: 25px;
    letter-spacing: -0.04em;
  }

  .activity-summary-grid small {
    margin-top: 6px;
    color: #b8c4e5;
    line-height: 1.5;
  }

  .activity-filter-grid {
    position: relative;
    z-index: 15;
    overflow: visible;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    margin-bottom: 16px;
    align-items: end;
  }

  .activity-search-field {
    grid-column: span 2;
  }

  .activity-filter-actions {
    display: flex;
    gap: 10px;
    align-items: end;
  }

  .activity-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  .activity-table-shell {
    position: relative;
    z-index: 1;
    overflow: auto;
    max-height: 640px;
    border-radius: 22px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(4, 8, 20, 0.74);
  }

  .activity-table-shell table {
    min-width: 1180px;
  }

  .activity-table-shell td span {
    display: block;
    color: #e5ebff;
    line-height: 1.5;
  }

  .activity-table-shell td em {
    display: block;
    margin-top: 6px;
    color: #93c5fd;
    font-size: 14px;
    font-style: normal;
    font-weight: 800;
  }

  .activity-detail-toggle {
    display: inline-flex;
    margin-top: 8px;
    min-height: 30px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid rgba(96, 165, 250, 0.22);
    background: rgba(59, 130, 246, 0.11);
    color: #dbeafe;
    font-size: 13px;
    font-weight: 900;
    cursor: pointer;
  }

  .activity-detail-row td {
    padding-top: 0;
    background: rgba(255, 255, 255, 0.02) !important;
  }

  .activity-detail-card {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    padding: 16px;
    border-radius: 18px;
    border: 1px solid rgba(96, 165, 250, 0.16);
    background: rgba(15, 23, 42, 0.68);
  }

  .activity-detail-card div {
    min-width: 0;
  }

  .activity-detail-card span {
    display: block;
    margin-bottom: 7px;
    color: #9fb4ff;
    font-size: 12px;
    font-weight: 950;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .activity-detail-card p,
  .activity-detail-card small {
    display: block;
    margin: 0;
    color: #dbe7ff;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  .activity-json-card {
    grid-column: 1 / -1;
  }

  .activity-json-card pre,
  .history-details pre {
    margin: 0;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    color: #dbe7ff;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    line-height: 1.65;
  }


  .activity-log-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(15, 23, 42, 0.72);
  }

  .activity-log-pagination span {
    color: #b8c4e5;
    font-size: 14px;
    font-weight: 850;
  }

  .activity-log-pagination div {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .session-panel {
    position: static;
    max-height: none;
    overflow: visible;
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background:
      radial-gradient(circle at top right, rgba(139, 92, 246, 0.12), transparent 34%),
      rgba(255, 255, 255, 0.03);
    padding: 16px;
  }

  .compact-head {
    margin-bottom: 12px;
  }

  .compact-head h3 {
    margin: 0;
    font-size: 22px;
  }

  .session-help-text {
    margin: 6px 0 0;
    color: #a9b4d0;
    font-size: 14px;
    line-height: 1.6;
  }

  .session-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
    max-height: none;
    overflow: visible;
    padding-right: 0;
  }

  .session-card {
    display: grid;
    gap: 12px;
    padding: 14px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.035);
  }

  .session-card strong,
  .session-card span {
    display: block;
  }

  .session-card strong {
    color: #ffffff;
    font-size: 17px;
  }

  .session-card span {
    color: #aebbe1;
    font-size: 14px;
    line-height: 1.5;
  }

  .session-card dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
    margin: 0;
  }

  .session-card dt {
    color: #8ea0d6;
    font-size: 12px;
    font-weight: 950;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .session-card dd {
    margin: 3px 0 0;
    color: #eef3ff;
    font-size: 14px;
    font-weight: 800;
    line-height: 1.45;
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


  .role-hover-guide {
    position: relative;
    z-index: 30;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .role-hover-guide span {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 0 10px;
    border-radius: 999px;
    color: #c7d2fe;
    border: 1px solid rgba(96, 165, 250, 0.16);
    background: rgba(59, 130, 246, 0.07);
    font-size: 14px;
    font-weight: 900;
    cursor: help;
  }

  .role-hover-guide span.active {
    color: #bbf7d0;
    border-color: rgba(16, 185, 129, 0.28);
    background: rgba(16, 185, 129, 0.12);
  }

  .role-hover-guide span em {
    position: absolute;
    left: 0;
    bottom: calc(100% + 10px);
    z-index: 80;
    width: min(340px, calc(100vw - 48px));
    transform: translateY(6px);
    opacity: 0;
    pointer-events: none;
    padding: 12px;
    border-radius: 14px;
    color: #e5ebff;
    border: 1px solid rgba(147, 197, 253, 0.22);
    background:
      radial-gradient(circle at top right, rgba(124, 58, 237, 0.16), transparent 36%),
      #0b1122;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.46);
    font-size: 14px;
    font-style: normal;
    line-height: 1.55;
    transition: opacity 0.16s ease, transform 0.16s ease;
  }

  .role-hover-guide span:hover em,
  .role-hover-guide span:focus-within em {
    opacity: 1;
    transform: translateY(0);
  }


  @media (max-width: 1180px) {
    .hero,
    .control-grid,
    .role-grid {
      grid-template-columns: 1fr;
    }

    .hero-side-card {
      max-width: 100%;
    }

    .hero-actions {
      align-items: flex-start;
      flex-direction: column;
    }
  }

  @media (max-width: 980px) {
    .filter-grid,
    .form-grid.two,
    .permission-grid,
    .api-meta-grid,
    .key-record,
    .profile-card,
    .activity-filter-grid,
    .activity-detail-card,
    .admin-date-popover,
    .admin-date-popover-body,
    .admin-calendar-months-grid,
    .history-meta-grid,
    .mapping-area,
    .mapping-support-grid {
      grid-template-columns: 1fr;
    }

    .admin-date-range-field,
    .activity-search-field {
      grid-column: auto;
    }

    .section-head,
    .mini-head,
    .supervisor-card-head,
    .supervisor-card-foot,
    .member-picker-head,
    .api-card-top {
      grid-template-columns: 1fr;
      flex-direction: column;
      align-items: stretch;
    }

    .tiny-metrics {
      min-width: 0;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .profile-card-meta {
      justify-content: flex-start;
    }
  }

  @media (max-width: 640px) {
    .admin-page {
      padding: 18px 12px 60px;
    }

    .hero,
    .panel {
      padding: 22px;
    }

    h1 {
      font-size: 42px;
    }

    .tiny-metrics,
    .mini-grid {
      grid-template-columns: 1fr;
    }

    .primary-btn,
    .secondary-btn {
      width: 100%;
    }
  }
  .canonical-note {
    display: block;
    margin-top: 3px;
    color: #7fa7ff;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: .01em;
  }

`;
