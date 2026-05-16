"use client";

import { useMemo, useState } from "react";
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

export default function DisputeVerdictButton({ result, onSubmitted }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const payload = useMemo(() => buildResultPayload(result || {}), [result]);
  const canOpen = Boolean(payload.result_id || payload.conversation_id);

  async function submitDispute(event) {
    event.preventDefault();
    setError("");
    setMessage("");

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
        throw new Error(data?.error || "Could not submit dispute.");
      }

      setMessage("Dispute submitted successfully. A Master Admin can now review it in Dispute Management.");
      setReason("");
      onSubmitted?.(data.dispute);
      setTimeout(() => {
        setOpen(false);
        setMessage("");
      }, 1300);
    } catch (submitError) {
      setMessage("");
      setError(submitError instanceof Error ? submitError.message : "Could not submit dispute.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="mini-dispute-btn"
        onClick={() => setOpen(true)}
        disabled={!canOpen}
        title={!canOpen ? "This row does not have enough saved result data to dispute." : "Dispute this Review Status verdict"}
      >
        Dispute Verdict
      </button>

      {open ? (
        <div className="dispute-modal-backdrop" onClick={() => !submitting && setOpen(false)}>
          <form className="dispute-modal" onSubmit={submitDispute} onClick={(event) => event.stopPropagation()}>
            <div className="dispute-modal-head">
              <div>
                <p>Review Status Dispute</p>
                <h2>Dispute AI Verdict</h2>
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

            <label className="field-block">
              <span>Reason for dispute <em>Required</em></span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Explain why the Review Status verdict is incorrect. Example: This should not be Missed Opportunity because the agent answered the exact policy question and there was no reasonable next action available."
                rows={7}
                required
              />
            </label>

            {message ? <div className="message success">{message}</div> : null}
            {error ? <div className="message error">{error}</div> : null}

            <div className="dispute-modal-actions">
              <button type="button" className="secondary-btn" onClick={() => setOpen(false)} disabled={submitting}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={submitting || !normalizeText(reason)}>
                {submitting ? "Submitting..." : "Submit Dispute"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
