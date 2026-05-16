"use client";

import { useEffect, useMemo, useState } from "react";

const REVIEW_STATUS_OPTIONS = [
  "Likely Negative Review",
  "Likely Positive Review",
  "Highly Likely Negative Review",
  "Highly Likely Positive Review",
  "Missed Opportunity",
  "Negative Outcome - No Review Request",
];

function normalizeText(value) {
  return String(value || "").trim();
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

async function readApiJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned a non-JSON response. Status ${response.status}.`);
  }
}

function emptyDraft() {
  return {
    id: "",
    title: "",
    wrong_verdict: "",
    correct_verdict: "",
    rule_text: "",
    applies_when: "",
    does_not_apply_when: "",
    example_context: "",
    is_active: false,
    source_dispute_id: "",
  };
}

export default function CalibrationSnippetsPanel({ session }) {
  const [snippets, setSnippets] = useState([]);
  const [approvedDisputes, setApprovedDisputes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(emptyDraft());

  const accessToken = session?.access_token || "";
  const snippetDisputeIds = useMemo(
    () => new Set(snippets.map((item) => item.source_dispute_id).filter(Boolean)),
    [snippets]
  );
  const unusedApprovedDisputes = useMemo(
    () => approvedDisputes.filter((item) => item?.id && !snippetDisputeIds.has(item.id)),
    [approvedDisputes, snippetDisputeIds]
  );
  const activeCount = snippets.filter((item) => item.is_active).length;

  async function loadData(silent = false) {
    if (!accessToken) return;
    if (!silent) setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/calibration-snippets?include_disputes=approved", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      const data = await readApiJson(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not load calibration snippets.");
      setSnippets(Array.isArray(data.snippets) ? data.snippets : []);
      setApprovedDisputes(Array.isArray(data.approvedDisputes) ? data.approvedDisputes : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load calibration snippets.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  function editSnippet(snippet) {
    setDraft({
      id: snippet.id || "",
      title: snippet.title || "",
      wrong_verdict: snippet.wrong_verdict || "",
      correct_verdict: snippet.correct_verdict || "",
      rule_text: snippet.rule_text || "",
      applies_when: snippet.applies_when || "",
      does_not_apply_when: snippet.does_not_apply_when || "",
      example_context: snippet.example_context || "",
      is_active: snippet.is_active === true,
      source_dispute_id: snippet.source_dispute_id || "",
    });
    setMessage("Snippet loaded into the editor. Review and save when ready.");
    setError("");
  }

  async function generateFromDispute(dispute) {
    if (!accessToken || !dispute?.id) return;
    setActionId(`generate:${dispute.id}`);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/calibration-snippets/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ dispute_id: dispute.id }),
      });
      const data = await readApiJson(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not generate snippet.");
      setMessage("AI generated a draft snippet from the approved dispute. It is inactive until you activate it.");
      if (data.snippet) editSnippet(data.snippet);
      await loadData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate snippet.");
    } finally {
      setActionId("");
    }
  }

  async function saveSnippet() {
    if (!accessToken) return;
    if (!normalizeText(draft.title) || !normalizeText(draft.rule_text)) {
      setError("Snippet title and rule are required.");
      return;
    }

    setActionId("save");
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/calibration-snippets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action: draft.id ? "update" : "create", snippet: draft }),
      });
      const data = await readApiJson(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not save snippet.");
      setMessage(draft.is_active ? "Snippet saved and active for future audits." : "Snippet saved as inactive draft.");
      setDraft(emptyDraft());
      await loadData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save snippet.");
    } finally {
      setActionId("");
    }
  }

  async function toggleSnippet(snippet) {
    if (!accessToken || !snippet?.id) return;
    setActionId(`toggle:${snippet.id}`);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/calibration-snippets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          action: "toggle_active",
          id: snippet.id,
          is_active: snippet.is_active !== true,
        }),
      });
      const data = await readApiJson(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not update snippet.");
      setMessage(data.snippet?.is_active ? "Snippet activated. Future audits will receive it." : "Snippet deactivated.");
      await loadData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update snippet.");
    } finally {
      setActionId("");
    }
  }

  async function deleteSnippet(snippet) {
    if (!accessToken || !snippet?.id) return;
    const confirmed = window.confirm("Delete this calibration snippet? This cannot be undone.");
    if (!confirmed) return;

    setActionId(`delete:${snippet.id}`);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/calibration-snippets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action: "delete", id: snippet.id }),
      });
      const data = await readApiJson(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not delete snippet.");
      setMessage("Snippet deleted.");
      await loadData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete snippet.");
    } finally {
      setActionId("");
    }
  }

  return (
    <section className="panel wide calibration-panel" id="calibration-snippets">
      <div className="section-head">
        <div>
          <p className="eyebrow">Master Admin Only</p>
          <h2>Calibration Snippets</h2>
          <p className="muted">
            Approved snippets are appended to audit runs separately. The original live prompt remains untouched.
          </p>
        </div>
        <div className="snippet-head-actions">
          <span className={activeCount ? "status active" : "status inactive"}>{activeCount} Active</span>
          <button type="button" className="secondary-btn" onClick={() => loadData(false)} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Snippets"}
          </button>
        </div>
      </div>

      {message ? <div className="success-box">{message}</div> : null}
      {error ? <div className="error-box">{error}</div> : null}

      <div className="snippet-grid">
        <article className="snippet-editor-card">
          <div className="section-head compact">
            <div>
              <h3>{draft.id ? "Edit Calibration Snippet" : "Create Calibration Snippet"}</h3>
              <p className="muted">Review Status snippets only affect future AI audit classification.</p>
            </div>
            {draft.id ? <button type="button" className="secondary-btn small-btn" onClick={() => setDraft(emptyDraft())}>Clear</button> : null}
          </div>

          <label>
            <span>Snippet Title</span>
            <input value={draft.title} onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))} placeholder="Do not mark simple clarification chats as Missed Opportunity" />
          </label>

          <div className="snippet-two-col">
            <label>
              <span>Wrong Verdict To Avoid</span>
              <select value={draft.wrong_verdict} onChange={(event) => setDraft((prev) => ({ ...prev, wrong_verdict: event.target.value }))}>
                <option value="">Select verdict</option>
                {REVIEW_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label>
              <span>Correct Verdict Guidance</span>
              <select value={draft.correct_verdict} onChange={(event) => setDraft((prev) => ({ ...prev, correct_verdict: event.target.value }))}>
                <option value="">Select verdict</option>
                {REVIEW_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>

          <label>
            <span>Rule</span>
            <textarea value={draft.rule_text} onChange={(event) => setDraft((prev) => ({ ...prev, rule_text: event.target.value }))} rows={4} placeholder="If the client only asks for policy clarification and the agent gives a direct, correct answer, do not classify it as Missed Opportunity unless there was a clear missed next action." />
          </label>

          <label>
            <span>Applies When</span>
            <textarea value={draft.applies_when} onChange={(event) => setDraft((prev) => ({ ...prev, applies_when: event.target.value }))} rows={3} placeholder="Client asks for status/rule clarification; answer is direct and complete; no clear sales, escalation, retention, or follow-up action was available." />
          </label>

          <label>
            <span>Does Not Apply When</span>
            <textarea value={draft.does_not_apply_when} onChange={(event) => setDraft((prev) => ({ ...prev, does_not_apply_when: event.target.value }))} rows={3} placeholder="Client shows buying intent, unresolved frustration, churn risk, incomplete resolution, or escalation need." />
          </label>

          <label>
            <span>Example Pattern</span>
            <textarea value={draft.example_context} onChange={(event) => setDraft((prev) => ({ ...prev, example_context: event.target.value }))} rows={3} placeholder="The AI marked the chat as Missed Opportunity, but the conversation only required a direct policy answer and no extra action was reasonably available." />
          </label>

          <label className="snippet-toggle-line">
            <input type="checkbox" checked={draft.is_active} onChange={(event) => setDraft((prev) => ({ ...prev, is_active: event.target.checked }))} />
            <span>Activate this snippet for future audits</span>
          </label>

          <div className="action-row">
            <button type="button" className="primary-btn" onClick={saveSnippet} disabled={Boolean(actionId)}>
              {actionId === "save" ? "Saving..." : draft.id ? "Save Snippet" : "Create Snippet"}
            </button>
          </div>
        </article>

        <article className="snippet-source-card">
          <div className="section-head compact">
            <div>
              <h3>Approved Disputes Ready For Snippets</h3>
              <p className="muted">AI will reread the conversation before drafting a snippet.</p>
            </div>
          </div>

          {!unusedApprovedDisputes.length ? (
            <div className="empty-box">No approved disputes are waiting for snippet generation.</div>
          ) : (
            <div className="snippet-source-list">
              {unusedApprovedDisputes.slice(0, 12).map((dispute) => (
                <div className="snippet-source-item" key={dispute.id}>
                  <div>
                    <strong>{dispute.conversation_id || dispute.result_id || "Conversation"}</strong>
                    <span>{dispute.current_review_status || "-"} → {dispute.corrected_review_status || "Corrected"}</span>
                    <small>{dispute.reason || "No dispute reason saved."}</small>
                  </div>
                  <button type="button" className="secondary-btn small-btn" onClick={() => generateFromDispute(dispute)} disabled={Boolean(actionId)}>
                    {actionId === `generate:${dispute.id}` ? "Generating..." : "Generate Snippet"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>

      <article className="snippet-list-card">
        <div className="section-head compact">
          <div>
            <h3>Saved Calibration Snippets</h3>
            <p className="muted">Only active snippets are appended to the audit prompt during future runs.</p>
          </div>
        </div>

        {!snippets.length ? (
          <div className="empty-box">No calibration snippets saved yet.</div>
        ) : (
          <div className="snippet-card-list">
            {snippets.map((snippet) => (
              <div className="snippet-card" key={snippet.id}>
                <div>
                  <span className={snippet.is_active ? "pill success" : "pill warning"}>{snippet.is_active ? "Active" : "Inactive"}</span>
                  <h4>{snippet.title || "Untitled snippet"}</h4>
                  <p>{snippet.rule_text || "No rule text saved."}</p>
                  <small>{snippet.wrong_verdict || "-"} → {snippet.correct_verdict || "-"} · Updated {formatDateTime(snippet.updated_at)}</small>
                </div>
                <div className="snippet-card-actions">
                  <button type="button" className="secondary-btn small-btn" onClick={() => editSnippet(snippet)}>Edit</button>
                  <button type="button" className="secondary-btn small-btn" onClick={() => toggleSnippet(snippet)} disabled={Boolean(actionId)}>
                    {actionId === `toggle:${snippet.id}` ? "Updating..." : snippet.is_active ? "Deactivate" : "Activate"}
                  </button>
                  <button type="button" className="danger-btn small-btn" onClick={() => deleteSnippet(snippet)} disabled={Boolean(actionId)}>
                    {actionId === `delete:${snippet.id}` ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </article>

      <style jsx>{`
        .calibration-panel { display: grid; gap: 18px; }
        .snippet-head-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
        .snippet-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr); gap: 16px; align-items: start; }
        .snippet-editor-card, .snippet-source-card, .snippet-list-card { border: 1px solid rgba(148, 163, 255, 0.14); border-radius: 22px; padding: 16px; background: rgba(2, 6, 23, 0.32); }
        .section-head.compact { margin-bottom: 12px; }
        .snippet-editor-card label { display: grid; gap: 7px; margin-bottom: 12px; }
        .snippet-editor-card label span, .snippet-toggle-line span { color: #a9bcff; font-size: 12px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
        .snippet-editor-card input, .snippet-editor-card select, .snippet-editor-card textarea { width: 100%; border: 1px solid rgba(148, 163, 255, 0.22); border-radius: 14px; padding: 11px 12px; background: rgba(2, 6, 23, 0.62); color: #f8fbff; outline: none; font: inherit; }
        .snippet-editor-card textarea { resize: vertical; line-height: 1.45; }
        .snippet-two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .snippet-toggle-line { display: flex !important; grid-template-columns: auto 1fr; align-items: center; gap: 10px !important; }
        .snippet-toggle-line input { width: auto; }
        .snippet-source-list, .snippet-card-list { display: grid; gap: 10px; }
        .snippet-source-item, .snippet-card { display: flex; justify-content: space-between; gap: 14px; padding: 13px; border-radius: 16px; border: 1px solid rgba(148, 163, 255, 0.12); background: rgba(15, 23, 42, 0.56); }
        .snippet-source-item strong, .snippet-source-item span, .snippet-source-item small, .snippet-card small { display: block; }
        .snippet-source-item span, .snippet-card small { color: #a9bcff; margin-top: 4px; }
        .snippet-source-item small { color: #dbe7ff; line-height: 1.4; margin-top: 6px; max-width: 620px; }
        .snippet-card h4 { margin: 8px 0 8px; font-size: 18px; }
        .snippet-card p { margin: 0 0 8px; color: #dbe7ff; line-height: 1.55; }
        .snippet-card-actions { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; justify-content: flex-end; min-width: 260px; }
        @media (max-width: 1100px) { .snippet-grid { grid-template-columns: 1fr; } .snippet-source-item, .snippet-card { flex-direction: column; } .snippet-card-actions { min-width: 0; justify-content: flex-start; } }
      `}</style>
    </section>
  );
}
