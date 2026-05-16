"use client";

import { useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";

const REVIEW_STATUS_OPTIONS = [
  "Likely Negative Review",
  "Likely Positive Review",
  "Highly Likely Negative Review",
  "Highly Likely Positive Review",
  "Missed Opportunity",
  "Negative Outcome - No Review Request",
];

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function getResultIdentifier(result) {
  return result?.id || result?.result_id || result?.audit_result_id || "";
}

export default function MasterVerdictEditButton({ result, visible = false, onChanged }) {
  const [open, setOpen] = useState(false);
  const [newStatus, setNewStatus] = useState(result?.review_sentiment || "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const payload = useMemo(() => ({
    result_id: getResultIdentifier(result || {}),
    conversation_id: normalizeText(result?.conversation_id),
    current_review_status: normalizeText(result?.review_sentiment),
  }), [result]);

  if (!visible) return null;

  async function submitChange(event) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!payload.result_id) {
      setError("This row does not have a saved result ID, so the verdict cannot be edited.");
      return;
    }

    if (!newStatus) {
      setError("Choose the corrected Review Status.");
      return;
    }

    if (!normalizeText(reason)) {
      setError("Please write the reason for this manual verdict edit.");
      return;
    }

    setSaving(true);
    setMessage("Saving verdict change...");

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Please sign in again before editing the verdict.");

      const response = await fetch("/api/results/verdict", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          result_id: payload.result_id,
          new_review_status: newStatus,
          reason: normalizeText(reason),
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not update verdict.");

      setMessage("Review Status updated successfully.");
      onChanged?.(data.result);
      setTimeout(() => {
        setOpen(false);
        setMessage("");
      }, 1200);
    } catch (saveError) {
      setMessage("");
      setError(saveError instanceof Error ? saveError.message : "Could not update verdict.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" className="mini-edit-btn" onClick={() => setOpen(true)}>
        Edit Verdict
      </button>

      {open ? (
        <div className="dispute-modal-backdrop" onClick={() => !saving && setOpen(false)}>
          <form className="dispute-modal" onSubmit={submitChange} onClick={(event) => event.stopPropagation()}>
            <div className="dispute-modal-head">
              <div>
                <p>Master Admin Only</p>
                <h2>Edit Review Status</h2>
              </div>
              <button type="button" className="close-btn" onClick={() => setOpen(false)} disabled={saving}>×</button>
            </div>

            <div className="dispute-summary-grid">
              <div><span>Conversation</span><strong>{payload.conversation_id || "-"}</strong></div>
              <div><span>Current Review Status</span><strong>{payload.current_review_status || "-"}</strong></div>
            </div>

            <label className="field-block">
              <span>Corrected Review Status</span>
              <select value={newStatus} onChange={(event) => setNewStatus(event.target.value)} required>
                <option value="">Select Review Status</option>
                {REVIEW_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>

            <label className="field-block">
              <span>Reason for edit <em>Required</em></span>
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={6} required />
            </label>

            {message ? <div className="message success">{message}</div> : null}
            {error ? <div className="message error">{error}</div> : null}

            <div className="dispute-modal-actions">
              <button type="button" className="secondary-btn" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={saving || !newStatus || !normalizeText(reason)}>{saving ? "Saving..." : "Save Verdict Change"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
