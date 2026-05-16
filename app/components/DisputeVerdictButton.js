"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
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

function getResultIdentifier(result) {
  return result?.id || result?.result_id || result?.audit_result_id || "";
}

function buildResultPayload(result) {
  return {
    result_id: getResultIdentifier(result) || null,
    conversation_id: normalizeText(result?.conversation_id),
    agent_name: normalizeText(result?.agent_name),
    employee_name: normalizeText(result?.employee_name),
    employee_email: normalizeEmail(result?.employee_email),
    team_name: normalizeText(result?.team_name),
    current_review_status: normalizeText(result?.review_sentiment),
    client_sentiment: normalizeText(result?.client_sentiment),
    resolution_status: normalizeText(result?.resolution_status),
    replied_at: result?.replied_at || null,
    created_at: result?.created_at || null,
  };
}

export default function DisputeVerdictButton({
  result,
  onSubmitted,
  panelMode = "drawer",
  hideButton = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onOpenRequest,
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const isControlled = typeof controlledOpen === "boolean";
  const open = isControlled ? controlledOpen : internalOpen;
  const payload = useMemo(() => buildResultPayload(result || {}), [result]);
  const canOpen = Boolean(payload.result_id || payload.conversation_id);

  useEffect(() => {
    setSubmitted(false);
    setMessage("");
    setError("");
    setReason("");
  }, [payload.result_id, payload.conversation_id]);

  function setOpen(nextOpen) {
    if (!isControlled) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen && !submitting && !submitted) {
      setMessage("");
      setError("");
    }
  }

  async function submitDispute(event) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (submitted) return;

    if (!normalizeText(reason)) {
      setError("Please write the reason before submitting the dispute.");
      return;
    }

    setSubmitting(true);
    setMessage("Submitting dispute...");

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      if (!token) throw new Error("Please sign in again before submitting a dispute.");

      const response = await fetch("/api/disputes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...payload, reason: normalizeText(reason) }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        const duplicatePending = response.status === 409 && String(data?.error || "").toLowerCase().includes("pending dispute");
        if (duplicatePending) {
          setSubmitted(true);
          setReason("");
          setMessage("Dispute request already submitted. A Master Admin can review it in Dispute Management.");
          onSubmitted?.(data?.dispute || null);
          return;
        }
        throw new Error(data?.error || "Could not submit dispute.");
      }

      setSubmitted(true);
      setReason("");
      setMessage("Dispute request submitted. A Master Admin can now review it in Dispute Management.");
      onSubmitted?.(data.dispute);
    } catch (submitError) {
      setMessage("");
      setError(submitError instanceof Error ? submitError.message : "Could not submit dispute.");
    } finally {
      setSubmitting(false);
    }
  }

  const panel = open ? (
    <form
      className={panelMode === "inline" ? "dispute-panel dispute-panel-inline" : "dispute-panel dispute-panel-drawer"}
      onSubmit={submitDispute}
    >
      <div className="dispute-panel-head">
        <div>
          <p>Review Status Dispute</p>
          <h2>Dispute AI Verdict</h2>
          <span>Only the Review Status verdict will be disputed. Client Sentiment and Resolution Status remain unchanged.</span>
        </div>
        <button type="button" className="close-btn" onClick={() => setOpen(false)} disabled={submitting}>×</button>
      </div>

      <div className="dispute-summary-grid">
        <div><span>Conversation</span><strong>{payload.conversation_id || "-"}</strong></div>
        <div><span>Employee</span><strong>{payload.employee_name || payload.employee_email || "Unmapped"}</strong></div>
        <div><span>Team</span><strong>{payload.team_name || "-"}</strong></div>
        <div><span>Current Review Status</span><strong>{payload.current_review_status || "-"}</strong></div>
        <div><span>Client Sentiment</span><strong>{payload.client_sentiment || "Not disputed"}</strong></div>
        <div><span>Resolution Status</span><strong>{payload.resolution_status || "Not disputed"}</strong></div>
        <div><span>Date</span><strong>{formatDateTime(payload.replied_at || payload.created_at)}</strong></div>
        <div><span>Scope</span><strong>Review Status only</strong></div>
      </div>

      <label className="field-block dispute-reason-block">
        <span>Reason for dispute <em>Required</em></span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={submitted ? "Dispute request submitted." : "Explain why the Review Status verdict is incorrect. Example: This should not be Missed Opportunity because the agent answered the exact policy question and there was no reasonable next action available."}
          rows={panelMode === "inline" ? 10 : 8}
          disabled={submitted || submitting}
          required={!submitted}
        />
      </label>

      {message ? <div className="message success">{message}</div> : null}
      {error ? <div className="message error">{error}</div> : null}

      <div className="dispute-panel-actions">
        <button type="button" className="secondary-btn" onClick={() => setOpen(false)} disabled={submitting}>{submitted ? "Close" : "Cancel"}</button>
        <button type="submit" className="primary-btn" disabled={submitted || submitting || !normalizeText(reason)}>
          {submitted ? "Dispute Request Submitted" : submitting ? "Submitting..." : "Submit Dispute"}
        </button>
      </div>
    </form>
  ) : null;

  return (
    <>
      {!hideButton ? (
        <button
          type="button"
          className="mini-dispute-btn"
          onClick={() => {
            if (onOpenRequest) {
              onOpenRequest(result || {}, payload);
              return;
            }
            setOpen(true);
          }}
          disabled={!canOpen || submitted}
          title={!canOpen ? "This row does not have enough saved result data to dispute." : submitted ? "A dispute request has already been submitted from this screen." : "Dispute this Review Status verdict"}
        >
          {submitted ? "Dispute Request Submitted" : "Dispute Verdict"}
        </button>
      ) : null}

      {panel}

      <style jsx global>{`
        .mini-dispute-btn {
          min-height: 34px;
          padding: 0 12px;
          border-radius: 999px;
          border: 1px solid rgba(251, 113, 133, 0.34);
          color: #fff4f6;
          font-size: 13px;
          font-weight: 950;
          cursor: pointer;
          white-space: nowrap;
          background: linear-gradient(135deg, rgba(127, 29, 29, 0.92), rgba(190, 24, 93, 0.78));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(190, 24, 93, 0.18);
          transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, background .18s ease;
        }
        .mini-dispute-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          border-color: rgba(251, 113, 133, 0.62);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.1), 0 14px 34px rgba(190, 24, 93, 0.26);
        }
        .mini-dispute-btn:disabled {
          cursor: not-allowed;
          opacity: .76;
          transform: none;
          background: linear-gradient(135deg, rgba(22, 163, 74, 0.48), rgba(14, 165, 233, 0.36));
          border-color: rgba(74, 222, 128, 0.34);
          color: #dcfce7;
        }
        .dispute-panel {
          border: 1px solid rgba(129, 140, 248, 0.34);
          border-radius: 24px;
          background:
            radial-gradient(circle at top right, rgba(168, 85, 247, 0.24), transparent 34%),
            linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(11, 18, 38, 0.98));
          box-shadow: 0 30px 80px rgba(0, 0, 0, 0.48), 0 0 0 1px rgba(255,255,255,0.04) inset;
          color: #eef4ff;
        }
        .dispute-panel-drawer {
          position: fixed;
          z-index: 80;
          right: clamp(16px, 3vw, 48px);
          top: 92px;
          width: min(500px, calc(100vw - 32px));
          max-height: calc(100vh - 116px);
          overflow: auto;
          padding: 20px;
        }
        .dispute-panel-inline {
          width: 100%;
          max-height: none;
          overflow: visible;
          padding: 18px;
        }
        .dispute-panel-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 16px;
        }
        .dispute-panel-head p {
          margin: 0 0 6px;
          color: #a9bbff;
          font-size: 11px;
          font-weight: 950;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }
        .dispute-panel-head h2 {
          margin: 0 0 7px;
          color: #ffffff;
          font-size: 24px;
          line-height: 1;
          letter-spacing: -0.04em;
        }
        .dispute-panel-head span {
          display: block;
          color: #9facce;
          font-size: 12px;
          font-weight: 800;
          line-height: 1.45;
        }
        .dispute-summary-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 16px;
        }
        .dispute-summary-grid div {
          min-width: 0;
          border: 1px solid rgba(148, 163, 184, 0.18);
          border-radius: 14px;
          background: rgba(15, 23, 42, 0.66);
          padding: 11px 12px;
        }
        .dispute-summary-grid span {
          display: block;
          margin-bottom: 6px;
          color: #9fb5ff;
          font-size: 10px;
          font-weight: 950;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .dispute-summary-grid strong {
          display: block;
          color: #ffffff;
          font-size: 12px;
          font-weight: 900;
          line-height: 1.35;
          overflow-wrap: anywhere;
        }
        .dispute-reason-block textarea {
          min-height: 168px;
          resize: vertical;
        }
        .dispute-panel-actions {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: 10px;
          margin-top: 14px;
        }
        .conversation-preview-actions .dispute-action {
          border-color: rgba(251, 113, 133, 0.35);
          background: linear-gradient(135deg, rgba(127, 29, 29, 0.72), rgba(190, 24, 93, 0.54));
          color: #fff4f6;
        }
        .conversation-preview-actions .dispute-action.active {
          border-color: rgba(251, 113, 133, 0.7);
          box-shadow: 0 16px 36px rgba(190, 24, 93, 0.24);
        }
        .conversation-preview-body.has-dispute {
          grid-template-columns: minmax(0, 1fr) minmax(340px, 430px);
          align-items: stretch;
          min-height: 0;
          overflow: hidden;
        }
        .conversation-preview-body.has-dispute .conversation-preview-sidebar {
          display: none;
        }
        .conversation-preview-dispute-panel {
          min-height: 0;
          height: 100%;
          overflow: auto;
        }
        .conversation-preview-body.has-dispute .conversation-preview-main {
          min-width: 0;
          min-height: 0;
          overflow: hidden;
        }
        .conversation-preview-body.has-dispute .conversation-transcript-list {
          min-height: 0;
          overflow: auto;
        }
        @media (max-width: 1100px) {
          .conversation-preview-body.has-dispute {
            grid-template-columns: 1fr;
          }
          .conversation-preview-dispute-panel {
            position: static;
            max-height: none;
            order: -1;
          }
        }
        @media (max-width: 720px) {
          .dispute-panel-drawer {
            left: 12px;
            right: 12px;
            top: 76px;
            width: auto;
            max-height: calc(100vh - 92px);
            padding: 16px;
          }
          .dispute-summary-grid {
            grid-template-columns: 1fr;
          }
          .dispute-panel-actions {
            flex-direction: column-reverse;
            align-items: stretch;
          }
          .dispute-panel-actions button {
            width: 100%;
          }
        }
      `}</style>
    </>
  );
}
