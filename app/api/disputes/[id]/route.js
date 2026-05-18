import { createClient } from "@supabase/supabase-js";
import {
  PLATFORM_OWNER_EMAIL,
  buildPermissionsForRole,
  hasPermission,
  readRolePermissionRows,
} from "../../../../lib/permissionRules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MASTER_ADMIN_EMAIL = PLATFORM_OWNER_EMAIL;
const REVIEW_STATUS_OPTIONS = new Set([
  "Likely Negative Review",
  "Likely Positive Review",
  "Highly Likely Negative Review",
  "Highly Likely Positive Review",
  "Missed Opportunity",
  "Negative Outcome - No Review Request",
]);

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate", ...(init.headers || {}) },
  });
}

function getEnv(name) { const value = process.env[name]; return typeof value === "string" ? value.trim() : ""; }
function normalizeText(value) { return String(value || "").trim(); }
function normalizeEmail(value) { return normalizeText(value).toLowerCase(); }
function normalizeKey(value) { return normalizeText(value).toLowerCase(); }

function createClients() {
  const supabaseUrl = getEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) throw new Error("Missing required Supabase environment variables.");
  return {
    authClient: createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    adminClient: createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }),
  };
}

async function authenticate(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!token) return { ok: false, response: json({ ok: false, error: "Missing access token." }, { status: 401 }) };
  const { authClient, adminClient } = createClients();
  const { data: { user }, error: userError } = await authClient.auth.getUser(token);
  if (userError || !user) return { ok: false, response: json({ ok: false, error: "Invalid or expired session." }, { status: 401 }) };
  const email = normalizeEmail(user.email);
  if (!email.endsWith("@nextventures.io")) return { ok: false, response: json({ ok: false, error: "Only nextventures.io accounts are allowed." }, { status: 403 }) };

  const { data: profileById, error: idError } = await adminClient.from("profiles").select("id, email, full_name, role, can_run_tests, is_active").eq("id", user.id).maybeSingle();
  if (idError) throw new Error(idError.message || "Could not load profile.");
  let profile = profileById || null;
  if (!profile) {
    const { data: profileByEmail, error: emailError } = await adminClient.from("profiles").select("id, email, full_name, role, can_run_tests, is_active").ilike("email", email).limit(1).maybeSingle();
    if (emailError) throw new Error(emailError.message || "Could not load profile by email.");
    profile = profileByEmail || null;
  }
  if (email === MASTER_ADMIN_EMAIL) profile = { ...(profile || {}), id: user.id, email, full_name: profile?.full_name || "Faiyaz Muhtasim Ahmed", role: "master_admin", can_run_tests: true, is_active: true };
  if (!profile?.is_active) return { ok: false, response: json({ ok: false, error: "This account is not active." }, { status: 403 }) };
  const permissionRows = await readRolePermissionRows(adminClient);
  const permissions = buildPermissionsForRole(email, profile?.role, permissionRows);
  if (!hasPermission({ email, profile, permissions }, "disputes_review")) return { ok: false, response: json({ ok: false, error: "You do not have permission to approve or reject disputes." }, { status: 403 }) };
  return { ok: true, user, email, profile, permissions, adminClient };
}

async function writeActivityLog(adminClient, request, auth, payload) {
  try {
    const forwardedFor = request.headers.get("x-forwarded-for") || "";
    await adminClient.from("system_activity_logs").insert({
      actor_user_id: auth.user?.id || auth.profile?.id || null,
      actor_email: auth.email || "unknown",
      actor_name: normalizeText(auth.profile?.full_name) || normalizeText(auth.user?.user_metadata?.full_name) || auth.email || "Unknown",
      actor_role: normalizeText(auth.profile?.role) || "viewer",
      action_type: payload.action_type,
      action_label: payload.action_label || payload.action_type,
      area: "Dispute Management",
      status: payload.status || "success",
      target_type: payload.target_type || "verdict_dispute",
      target_id: payload.target_id || null,
      target_label: payload.target_label || null,
      description: payload.description || null,
      metadata: payload.metadata || {},
      ip_address: forwardedFor.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null,
      user_agent: request.headers.get("user-agent") || null,
      request_path: new URL(request.url).pathname,
    });
  } catch (error) {
    console.warn("[disputes-id] activity log failed", error);
  }
}

export async function PATCH(request, context) {
  try {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const id = normalizeText(context?.params?.id);
    if (!id) return json({ ok: false, error: "Missing dispute ID." }, { status: 400 });

    const body = await request.json().catch(() => ({}));
    const action = normalizeKey(body.action);
    const decisionNote = normalizeText(body.decision_note);
    const correctedReviewStatus = normalizeText(body.corrected_review_status);

    if (!["approve", "reject"].includes(action)) return json({ ok: false, error: "Choose approve or reject." }, { status: 400 });
    if (action === "approve" && !REVIEW_STATUS_OPTIONS.has(correctedReviewStatus)) return json({ ok: false, error: "Choose a valid corrected Review Status before approval." }, { status: 400 });
    if (action === "reject" && !decisionNote) return json({ ok: false, error: "Decision note is required when rejecting a dispute." }, { status: 400 });

    const { data: dispute, error: disputeError } = await auth.adminClient.from("verdict_disputes").select("*").eq("id", id).maybeSingle();
    if (disputeError) throw new Error(disputeError.message || "Could not load dispute.");
    if (!dispute?.id) return json({ ok: false, error: "Dispute not found." }, { status: 404 });
    if (dispute.status !== "pending") return json({ ok: false, error: "Only pending disputes can be updated." }, { status: 409 });

    let updatedResult = null;
    if (action === "approve") {
      const { data: currentResult, error: currentError } = await auth.adminClient
        .from("audit_results")
        .select("id, conversation_id, review_sentiment")
        .eq("id", dispute.result_id)
        .maybeSingle();
      if (currentError) throw new Error(currentError.message || "Could not load audit result.");
      if (!currentResult?.id) return json({ ok: false, error: "The original audit result was not found, so the dispute cannot update the verdict." }, { status: 404 });

      const oldStatus = currentResult.review_sentiment || dispute.current_review_status || null;
      const { data: savedResult, error: updateError } = await auth.adminClient
        .from("audit_results")
        .update({ review_sentiment: correctedReviewStatus })
        .eq("id", currentResult.id)
        .select("*")
        .single();
      if (updateError) throw new Error(updateError.message || "Could not update Review Status.");
      updatedResult = savedResult;

      await auth.adminClient.from("verdict_change_logs").insert({
        result_id: currentResult.id,
        conversation_id: currentResult.conversation_id || dispute.conversation_id || null,
        changed_by_user_id: auth.user?.id || auth.profile?.id || null,
        changed_by_name: normalizeText(auth.profile?.full_name) || auth.email,
        changed_by_email: auth.email,
        old_review_status: oldStatus,
        new_review_status: correctedReviewStatus,
        change_source: "dispute_approval",
        reason: decisionNote || dispute.reason || "Approved dispute.",
        dispute_id: dispute.id,
      });
    }

    const updatePayload = {
      status: action === "approve" ? "approved" : "rejected",
      corrected_review_status: action === "approve" ? correctedReviewStatus : null,
      master_admin_decision_note: decisionNote || null,
      reviewed_by_user_id: auth.user?.id || auth.profile?.id || null,
      reviewed_by_name: normalizeText(auth.profile?.full_name) || auth.email,
      reviewed_by_email: auth.email,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: updatedDispute, error: updateDisputeError } = await auth.adminClient.from("verdict_disputes").update(updatePayload).eq("id", id).select("*").single();
    if (updateDisputeError) throw new Error(updateDisputeError.message || "Could not update dispute.");

    await writeActivityLog(auth.adminClient, request, auth, {
      action_type: action === "approve" ? "verdict_dispute_approved" : "verdict_dispute_rejected",
      action_label: action === "approve" ? "Verdict dispute approved" : "Verdict dispute rejected",
      target_id: updatedDispute.id,
      target_label: updatedDispute.conversation_id || updatedDispute.result_id,
      description: `${auth.email} ${action === "approve" ? "approved" : "rejected"} a Review Status dispute for ${updatedDispute.conversation_id || updatedDispute.result_id}.`,
      metadata: { corrected_review_status: correctedReviewStatus || null, result_id: updatedDispute.result_id },
    });

    return json({ ok: true, dispute: updatedDispute, result: updatedResult });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Could not update dispute." }, { status: 500 });
  }
}
