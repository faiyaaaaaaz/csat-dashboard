"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";

const MASTER_ADMIN_EMAIL = "faiyaz@nextventures.io";
const SESSION_TIMEOUT_MS = 8000;
const PROFILE_TIMEOUT_MS = 10000;

const navItems = [
  { label: "Dashboard", href: "/", permission: "dashboard", icon: "dashboard" },
  { label: "Run Audit", href: "/run", permission: "run_audit", icon: "spark" },
  { label: "Results", href: "/results", permission: "results", icon: "results" },
  { label: "Admin", href: "/admin", permission: "admin", icon: "shield" },
];

function withTimeout(promise, label, timeoutMs = SESSION_TIMEOUT_MS) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} took too long. Please refresh once or sign in again.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim();
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
      full_name:
        normalizeText(user.user_metadata?.full_name) ||
        normalizeText(user.user_metadata?.name) ||
        "",
      role: "viewer",
      can_run_tests: false,
      is_active: true,
    };
  }

  return null;
}

function roleLabel(role) {
  const value = String(role || "viewer").replaceAll("_", " ");

  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getAvatarUrl(profile, session) {
  const candidates = [
    session?.user?.user_metadata?.avatar_url,
    session?.user?.user_metadata?.picture,
    session?.user?.identities?.[0]?.identity_data?.avatar_url,
    session?.user?.identities?.[0]?.identity_data?.picture,
    profile?.avatar_url,
  ];

  for (const value of candidates) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }

  return "";
}


async function postClientActivity(session, payload) {
  const token = session?.access_token;

  if (!token) return;

  try {
    await fetch("/api/admin/activity-logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch (_error) {
    // Activity logs should never block the user experience.
  }
}

function SidebarIcon({ kind, active = false }) {
  const stroke = active ? "#22d3ee" : "#94a3b8";
  const glow = active ? "rgba(34, 211, 238, 0.22)" : "rgba(148, 163, 184, 0.08)";

  const shared = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    'aria-hidden': 'true',
  };

  if (kind === "spark") {
    return (
      <span className="nav-link-icon" style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px ${glow}` }}>
        <svg {...shared}>
          <path d="M12 3L13.7 8.3L19 10L13.7 11.7L12 17L10.3 11.7L5 10L10.3 8.3L12 3Z" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M18.2 4.8L18.8 6.2L20.2 6.8L18.8 7.4L18.2 8.8L17.6 7.4L16.2 6.8L17.6 6.2L18.2 4.8Z" fill={stroke} />
        </svg>
      </span>
    );
  }

  if (kind === "results") {
    return (
      <span className="nav-link-icon" style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px ${glow}` }}>
        <svg {...shared}>
          <rect x="4.5" y="5" width="15" height="14" rx="3" stroke={stroke} strokeWidth="1.8" />
          <path d="M8 14L10.8 11.2L12.9 13.3L16 10.2" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="8" cy="14" r="1" fill={stroke} />
          <circle cx="10.8" cy="11.2" r="1" fill={stroke} />
          <circle cx="12.9" cy="13.3" r="1" fill={stroke} />
          <circle cx="16" cy="10.2" r="1" fill={stroke} />
        </svg>
      </span>
    );
  }

  if (kind === "shield") {
    return (
      <span className="nav-link-icon" style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px ${glow}` }}>
        <svg {...shared}>
          <path d="M12 3.8L18 6.1V11.3C18 15.1 15.6 18.5 12 20.2C8.4 18.5 6 15.1 6 11.3V6.1L12 3.8Z" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M9.2 11.9L10.8 13.5L14.9 9.4" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  return (
    <span className="nav-link-icon" style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px ${glow}` }}>
      <svg {...shared}>
        <path d="M5 12.5C5 8.35 8.35 5 12.5 5H18.5V11C18.5 15.15 15.15 18.5 11 18.5H5V12.5Z" stroke={stroke} strokeWidth="1.8" />
        <path d="M9 13.2H14.8" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M9 9.8H14" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function getInitials(nameOrEmail) {
  const value = String(nameOrEmail || "NV").trim();

  if (value.includes("@")) {
    return value.slice(0, 2).toUpperCase();
  }

  const parts = value.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  return value.slice(0, 2).toUpperCase();
}

function canRunAudits(profile) {
  const role = String(profile?.role || "").toLowerCase();

  return Boolean(
    profile?.is_active === true &&
      (role === "master_admin" ||
        role === "admin" ||
        profile?.can_run_tests === true)
  );
}

function canAccessAdmin(profile) {
  const role = String(profile?.role || "").toLowerCase();

  return Boolean(
    profile?.is_active === true &&
      (role === "master_admin" || role === "admin" || role === "co_admin")
  );
}

function canViewResults(profile) {
  return Boolean(profile?.is_active === true);
}

function canViewNavItem(item, profile) {
  if (item.permission === "dashboard") return true;
  if (item.permission === "results") return canViewResults(profile);
  if (item.permission === "run_audit") return canRunAudits(profile);
  if (item.permission === "admin") return canAccessAdmin(profile);

  return true;
}

function getLockReason(pathname, session, profile) {
  if (pathname === "/run" && !session?.user) {
    return {
      title: "Sign In Required",
      message: "Please sign in with your NEXT Ventures account to visit Run Audit.",
    };
  }

  if (pathname === "/run" && !canRunAudits(profile)) {
    return {
      title: "Permission required",
      message:
        "Sorry, you do not have permission to visit this section. Please contact the Master Admin.",
    };
  }

  if (pathname === "/admin" && !session?.user) {
    return {
      title: "Sign In Required",
      message: "Please sign in with your NEXT Ventures account to visit Admin.",
    };
  }

  if (pathname === "/admin" && !canAccessAdmin(profile)) {
    return {
      title: "Admin Access Required",
      message:
        "Sorry, you do not have permission to visit this section. Please contact the Master Admin.",
    };
  }

  if (pathname === "/results" && !session?.user) {
    return {
      title: "Sign In Required",
      message: "Please sign in with your NEXT Ventures account to visit Results.",
    };
  }

  if (pathname === "/results" && !canViewResults(profile)) {
    return {
      title: "Access required",
      message:
        "Sorry, you do not have permission to visit this section. Please contact the Master Admin.",
    };
  }

  return null;
}


function PlatformLogo({ size = "normal" }) {
  return (
    <div className={`platform-logo ${size}`} aria-hidden="true">
      <span className="platform-logo-halo" />
      <span className="platform-logo-orbit orbit-a" />
      <span className="platform-logo-orbit orbit-b" />
      <span className="platform-logo-node node-a" />
      <span className="platform-logo-node node-b" />
      <span className="platform-logo-node node-c" />
      <div className="platform-logo-core">
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 12L34 12L26 29L40 29L18 52L25 36L13 36L16 12Z" fill="url(#platformLogoMain)" />
          <path d="M34 14L50 14L40 28L51 28L35 47L39 34L30 34L34 14Z" fill="url(#platformLogoAccent)" opacity="0.94" />
          <defs>
            <linearGradient id="platformLogoMain" x1="13" y1="12" x2="44" y2="50" gradientUnits="userSpaceOnUse">
              <stop stopColor="#22D3EE" />
              <stop offset="0.48" stopColor="#8B5CF6" />
              <stop offset="1" stopColor="#EC4899" />
            </linearGradient>
            <linearGradient id="platformLogoAccent" x1="30" y1="14" x2="52" y2="44" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FDE047" />
              <stop offset="1" stopColor="#F97316" />
            </linearGradient>
          </defs>
        </svg>
      </div>
    </div>
  );
}

function LaunchScreen({ title = "Initializing Secure Workspace...", subtitle = "Checking Session And Preparing The Platform." }) {
  return (
    <div className="auth-stage">
      <div className="auth-bg-grid" />
      <div className="launch-card compact-launch">
        <PlatformLogo size="large" />
        <p>NEXT Ventures</p>
        <h1>{title}</h1>
        <span>{subtitle}</span>
        <div className="launch-progress">
          <i />
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: appShellStyles }} />
    </div>
  );
}

function LoginScreen({ authMessage, onGoogleLogin }) {
  return (
    <div className="auth-stage">
      <div className="auth-bg-grid" />

      <section className="login-card">
        <div className="login-orb orb-a" />
        <div className="login-orb orb-b" />

        <div className="login-brand">
          <PlatformLogo size="large" />
          <div>
            <p>NEXT Ventures</p>
            <h1>AI Auditor & Insights Platform</h1>
            <span>Secure review intelligence, client sentiment, and resolution tracking.</span>
          </div>
        </div>

        <div className="login-copy">
          <span>Secure Access Required</span>
          <h2>Sign In to Enter the Command Center</h2>
          <p>
            Use your NEXT Ventures Google account to access the dashboard, results, audit workflow,
            and Admin controls assigned to your role.
          </p>

          {authMessage ? <div className="login-warning">{authMessage}</div> : null}

          <button type="button" className="login-google-btn" onClick={onGoogleLogin}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M21.6 12.23c0-.76-.07-1.49-.2-2.19H12v4.14h5.38c-.23 1.25-.94 2.31-2 3.02v2.51h3.24c1.9-1.75 2.98-4.32 2.98-7.48z" />
              <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.24-2.51c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.06v2.59C4.71 19.75 8.08 22 12 22z" />
              <path fill="#FBBC05" d="M6.41 13.9c-.2-.6-.31-1.24-.31-1.9s.11-1.3.31-1.9V7.51H3.06A9.98 9.98 0 0 0 2 12c0 1.61.39 3.14 1.06 4.49l3.35-2.59z" />
              <path fill="#EA4335" d="M12 5.98c1.47 0 2.79.51 3.82 1.5l2.87-2.87C16.95 2.99 14.69 2 12 2 8.08 2 4.71 4.25 3.06 7.51l3.35 2.59C7.2 7.74 9.4 5.98 12 5.98z" />
            </svg>
            Sign In with Google
          </button>

          <small>Only nextventures.io accounts can continue.</small>
        </div>
      </section>

      <style dangerouslySetInnerHTML={{ __html: appShellStyles }} />
    </div>
  );
}

export default function AppShellClient({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const profileMenuRef = useRef(null);
  const authRunIdRef = useRef(0);
  const lastAuthUserIdRef = useRef("");

  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [authMessage, setAuthMessage] = useState("");

  const displayName = useMemo(() => {
    return (
      profile?.full_name ||
      session?.user?.user_metadata?.full_name ||
      session?.user?.email ||
      "Guest user"
    );
  }, [profile, session]);

  const displayAvatarUrl = useMemo(() => getAvatarUrl(profile, session), [profile, session]);
  const displayEmail = session?.user?.email || profile?.email || "";
  const lockReason = getLockReason(pathname, session, profile);
  const pageLocked = Boolean(!authLoading && lockReason);

  async function loadProfile(nextSession) {
    const user = nextSession?.user;

    if (!user) {
      return { profile: null, message: "" };
    }

    const email = normalizeEmail(user.email);
    const domain = email.split("@")[1] || "";

    if (domain !== "nextventures.io") {
      return {
        profile: null,
        message: "Only nextventures.io accounts are allowed.",
      };
    }

    const fallbackProfile = buildFallbackProfile(user);
    let profileSyncError = "";

    if (nextSession?.access_token) {
      try {
        const response = await withTimeout(
          fetch("/api/auth/profile", {
            method: "GET",
            headers: {
              Authorization: `Bearer ${nextSession.access_token}`,
            },
            cache: "no-store",
          }),
          "Profile sync",
          PROFILE_TIMEOUT_MS
        );

        const data = await response.json().catch(() => null);

        if (response.ok && data?.ok && data?.profile) {
          return {
            profile: data.profile,
            message: "",
          };
        }

        profileSyncError = data?.error || "Profile sync did not return a usable profile.";
      } catch (error) {
        profileSyncError =
          error instanceof Error ? error.message : "Profile sync failed.";
      }
    }

    try {
      const byId = await withTimeout(
        supabase
          .from("profiles")
          .select("id, email, full_name, role, can_run_tests, is_active")
          .eq("id", user.id)
          .maybeSingle(),
        "Profile check by user ID",
        PROFILE_TIMEOUT_MS
      );

      if (byId?.data) {
        if (email === MASTER_ADMIN_EMAIL) {
          return {
            profile: {
              ...byId.data,
              email,
              role: "master_admin",
              can_run_tests: true,
              is_active: true,
            },
            message: "",
          };
        }

        return { profile: byId.data, message: profileSyncError };
      }

      const byEmail = await withTimeout(
        supabase
          .from("profiles")
          .select("id, email, full_name, role, can_run_tests, is_active")
          .ilike("email", email)
          .limit(1),
        "Profile check by email",
        PROFILE_TIMEOUT_MS
      );

      const emailProfile = Array.isArray(byEmail?.data) ? byEmail.data[0] : null;

      if (emailProfile) {
        if (email === MASTER_ADMIN_EMAIL) {
          return {
            profile: {
              ...emailProfile,
              email,
              role: "master_admin",
              can_run_tests: true,
              is_active: true,
            },
            message: "",
          };
        }

        return { profile: emailProfile, message: profileSyncError };
      }

      if (fallbackProfile && email === MASTER_ADMIN_EMAIL) {
        return { profile: fallbackProfile, message: "" };
      }

      return {
        profile: null,
        message:
          profileSyncError ||
          "Signed in, but this account has not been granted access yet.",
      };
    } catch (error) {
      if (fallbackProfile && email === MASTER_ADMIN_EMAIL) {
        return { profile: fallbackProfile, message: "" };
      }

      return {
        profile: null,
        message:
          profileSyncError ||
          (error instanceof Error
            ? error.message
            : "Signed in, but profile loading failed."),
      };
    }
  }

  async function completeSessionCheck(nextSession, runId) {
    if (runId !== authRunIdRef.current) return;

    setSession(nextSession || null);
    lastAuthUserIdRef.current = nextSession?.user?.id || "";

    if (!nextSession?.user) {
      setProfile(null);
      setAuthMessage("");
      setAuthLoading(false);
      return;
    }

    const result = await loadProfile(nextSession);

    if (runId !== authRunIdRef.current) return;

    setProfile(result.profile);
    setAuthMessage(result.message);
    setAuthLoading(false);
  }

  useEffect(() => {
    let active = true;

    async function init() {
      const runId = authRunIdRef.current + 1;
      authRunIdRef.current = runId;

      setAuthLoading(true);
      setAuthMessage("");

      try {
        const {
          data: { session: currentSession },
        } = await withTimeout(
          supabase.auth.getSession(),
          "Session check",
          SESSION_TIMEOUT_MS
        );

        if (!active) return;

        await completeSessionCheck(currentSession || null, runId);
      } catch (error) {
        if (!active || runId !== authRunIdRef.current) return;

        setSession(null);
        setProfile(null);
        setAuthMessage(
          error instanceof Error
            ? error.message
            : "Could not complete session check."
        );
        setAuthLoading(false);
      }
    }

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!active) return;

      const isSameSignedInUser =
        event === "SIGNED_IN" &&
        newSession?.user?.id &&
        newSession.user.id === lastAuthUserIdRef.current;
      const isBackgroundRefresh = event === "TOKEN_REFRESHED" || event === "USER_UPDATED" || isSameSignedInUser;

      if (isBackgroundRefresh) {
        setSession(newSession || null);
        lastAuthUserIdRef.current = newSession?.user?.id || "";

        if (!newSession?.user) {
          setProfile(null);
          setAuthMessage("");
          setAuthLoading(false);
          return;
        }

        loadProfile(newSession)
          .then((result) => {
            if (!active) return;
            setProfile(result.profile);
            setAuthMessage(result.message);
            setAuthLoading(false);
          })
          .catch((error) => {
            if (!active) return;
            setProfile(buildFallbackProfile(newSession?.user) || null);
            setAuthMessage(
              error instanceof Error
                ? error.message
                : "Could not refresh profile quietly."
            );
            setAuthLoading(false);
          });

        return;
      }

      const runId = authRunIdRef.current + 1;
      authRunIdRef.current = runId;

      setAuthLoading(true);
      setAuthMessage("");

      completeSessionCheck(newSession || null, runId).catch((error) => {
        if (!active || runId !== authRunIdRef.current) return;

        setSession(newSession || null);
        setProfile(buildFallbackProfile(newSession?.user) || null);
        setAuthMessage(
          error instanceof Error
            ? error.message
            : "Could not complete session check."
        );
        setAuthLoading(false);
      });
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    function handleOutsideClick(event) {
      if (!profileMenuRef.current) return;
      if (!profileMenuRef.current.contains(event.target)) setProfileOpen(false);
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!session?.access_token) return undefined;

    postClientActivity(session, {
      action_type: "page_viewed",
      page: pathname || "/",
    });

    const intervalId = window.setInterval(() => {
      postClientActivity(session, {
        action_type: "session_heartbeat",
        page: pathname || "/",
      });
    }, 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, [pathname, session?.access_token]);


  async function handleGoogleLogin() {
    setAuthMessage("");

    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}${pathname}` : undefined;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) setAuthMessage(error.message || "Google sign-in failed.");
  }

  async function handleLogout() {
    await postClientActivity(session, {
      action_type: "session_ended",
      page: pathname || "/",
    });

    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setProfileOpen(false);
    router.push("/");
  }

  if (authLoading) {
    return (
      <LaunchScreen
        title="Initializing Secure Workspace..."
        subtitle="Checking Session And Preparing Access."
      />
    );
  }

  if (!session?.user) {
    return <LoginScreen authMessage={authMessage} onGoogleLogin={handleGoogleLogin} />;
  }

  return (
    <div className="app-shell">
      <div className="app-bg">
        <div className="bg-orb orb-one" />
        <div className="bg-orb orb-two" />
        <div className="bg-orb orb-three" />
        <div className="bg-grid" />
        <div className="bg-vignette" />
      </div>

      <div className="shell-frame">
        <aside className="sidebar">
          <div className="brand-wrap">
            <div className="brand-badge">NEXT Ventures</div>

            <div className="brand-block">
              <div className="brand-mark" aria-hidden="true">
                <span className="brand-mark-halo" />
                <span className="brand-orbit orbit-one" />
                <span className="brand-orbit orbit-two" />
                <span className="brand-node node-one" />
                <span className="brand-node node-two" />
                <span className="brand-node node-three" />
                <div className="brand-mark-core">
                  <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M16 12L34 12L26 29L40 29L18 52L25 36L13 36L16 12Z" fill="url(#brandGradientMain)" />
                    <path d="M34 14L50 14L40 28L51 28L35 47L39 34L30 34L34 14Z" fill="url(#brandGradientAccent)" opacity="0.92" />
                    <defs>
                      <linearGradient id="brandGradientMain" x1="13" y1="12" x2="44" y2="50" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#22D3EE" />
                        <stop offset="0.48" stopColor="#8B5CF6" />
                        <stop offset="1" stopColor="#EC4899" />
                      </linearGradient>
                      <linearGradient id="brandGradientAccent" x1="30" y1="14" x2="52" y2="44" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#FDE047" />
                        <stop offset="1" stopColor="#F97316" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>

              <div>
                <h1 className="brand-title">AI Auditor & Insights Platform</h1>
                <p className="brand-subtitle">
                  Review Approach & Client Sentiment Tracking.
                </p>
              </div>
            </div>
          </div>

          <nav className="nav">
            <div className="nav-section-label">Navigation</div>

            <div className="nav-list">
              {navItems.map((item) => {
                const allowed = canViewNavItem(item, profile);
                const active =
                  item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${active ? "nav-link active" : "nav-link"} ${
                      !allowed && session?.user ? "locked-nav" : ""
                    }`}
                  >
                    <SidebarIcon kind={item.icon} active={active} />
                    <span>{item.label}</span>
                    {!allowed && session?.user ? <em>Locked</em> : null}
                  </Link>
                );
              })}
            </div>
          </nav>

          <div className="sidebar-mini developer-credit">
            <span>Developed by</span>
            <strong>Faiyaz Ahmed</strong>
          </div>
        </aside>

        <div className="content-shell">
          <header className="topbar">
            <div>
              <div className="topbar-kicker">Internal quality platform</div>
              <div className="topbar-title">Review Approach, Client Sentiment & Resolution Status Tracking</div>
            </div>

            <div ref={profileMenuRef} className="profile-wrap">
              {authLoading ? (
                <div className="profile-loading">Checking session</div>
              ) : session?.user ? (
                <>
                  <button
                    type="button"
                    className="profile-button"
                    onClick={() => setProfileOpen((prev) => !prev)}
                  >
                    <span className="profile-avatar">
                      {displayAvatarUrl ? (
                        <img src={displayAvatarUrl} alt={displayName} className="profile-avatar-image" />
                      ) : (
                        getInitials(displayName)
                      )}
                    </span>

                    <span className="profile-copy">
                      <strong>{displayName}</strong>
                      <small>{roleLabel(profile?.role)}</small>
                    </span>

                    <b>{profileOpen ? "Up" : "Down"}</b>
                  </button>

                  {profileOpen ? (
                    <div className="profile-menu">
                      <div className="profile-menu-head">
                        <span className="profile-avatar large">
                          {displayAvatarUrl ? (
                            <img src={displayAvatarUrl} alt={displayName} className="profile-avatar-image" />
                          ) : (
                            getInitials(displayName)
                          )}
                        </span>
                        <div>
                          <strong>{displayName}</strong>
                          <small>{displayEmail}</small>
                        </div>
                      </div>

                      <div className="profile-detail-grid">
                        <div>
                          <span>Role</span>
                          <strong>{roleLabel(profile?.role)}</strong>
                        </div>

                        <div>
                          <span>Run Audit</span>
                          <strong>{canRunAudits(profile) ? "Allowed" : "Locked"}</strong>
                        </div>

                        <div>
                          <span>Admin</span>
                          <strong>{canAccessAdmin(profile) ? "Allowed" : "Locked"}</strong>
                        </div>

                        <div>
                          <span>Status</span>
                          <strong>{profile?.is_active ? "Active" : "Inactive"}</strong>
                        </div>
                      </div>

                      <p className="profile-note">
                        Roles are controlled from Admin. Users cannot change their own role here.
                      </p>

                      {authMessage ? <p className="profile-warning">{authMessage}</p> : null}

                      <button type="button" className="signout-btn" onClick={handleLogout}>
                        Sign Out
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <button type="button" className="signin-btn" onClick={handleGoogleLogin}>
                  Sign In
                </button>
              )}
            </div>
          </header>

          <main className={pageLocked ? "page-content locked-content" : "page-content"}>
            <div className={pageLocked ? "blurred-page" : ""}>{children}</div>

            {pageLocked ? (
              <div className="locked-overlay">
                <div className="locked-card">
                  <div className="locked-orb" />
                  <span>Restricted Section</span>
                  <h2>{lockReason.title}</h2>
                  <p>{lockReason.message}</p>

                  {!session?.user ? (
                    <button type="button" className="signin-btn large" onClick={handleGoogleLogin}>
                      Sign In with Google
                    </button>
                  ) : (
                    <Link href="/" className="locked-link">
                      Return to dashboard
                    </Link>
                  )}
                </div>
              </div>
            ) : null}
          </main>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: appShellStyles }} />
    </div>
  );
}

const appShellStyles = `

  .auth-stage {
    position: relative;
    min-height: 100vh;
    display: grid;
    place-items: center;
    overflow: hidden;
    padding: 30px;
    background:
      radial-gradient(circle at 14% 16%, rgba(34, 211, 238, 0.13), transparent 26%),
      radial-gradient(circle at 84% 18%, rgba(139, 92, 246, 0.2), transparent 28%),
      radial-gradient(circle at 52% 82%, rgba(236, 72, 153, 0.12), transparent 22%),
      linear-gradient(180deg, #030611 0%, #050918 48%, #02040b 100%);
  }

  .auth-bg-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.028) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.028) 1px, transparent 1px);
    background-size: 72px 72px;
    mask-image: radial-gradient(circle at center, rgba(255,255,255,0.44), transparent 72%);
    opacity: 0.42;
  }

  .platform-logo {
    position: relative;
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    flex: 0 0 auto;
    border-radius: 26px;
    overflow: hidden;
    background:
      radial-gradient(circle at 28% 22%, rgba(255,255,255,0.22), transparent 22%),
      linear-gradient(145deg, rgba(5, 12, 31, 0.98), rgba(15, 23, 42, 0.94));
    border: 1px solid rgba(125, 211, 252, 0.18);
    box-shadow:
      0 24px 60px rgba(18, 31, 67, 0.42),
      0 0 42px rgba(34, 211, 238, 0.15),
      inset 0 1px 0 rgba(255, 255, 255, 0.12),
      inset 0 0 42px rgba(45, 212, 191, 0.06);
  }

  .platform-logo.large {
    width: 96px;
    height: 96px;
    border-radius: 34px;
  }

  .platform-logo-halo {
    position: absolute;
    inset: 9px;
    border-radius: 22px;
    background: radial-gradient(circle at center, rgba(34, 211, 238, 0.14), rgba(139, 92, 246, 0.1), transparent 70%);
    filter: blur(7px);
  }

  .platform-logo-orbit,
  .platform-logo-node {
    position: absolute;
    pointer-events: none;
  }

  .platform-logo-orbit {
    border: 1px solid rgba(191, 219, 254, 0.32);
    border-radius: 999px;
  }

  .platform-logo .orbit-a {
    width: 78%;
    height: 38%;
    transform: rotate(-24deg);
    animation: orbitFloatA 4.8s ease-in-out infinite;
  }

  .platform-logo .orbit-b {
    width: 38%;
    height: 78%;
    transform: rotate(28deg);
    animation: orbitFloatB 5.4s ease-in-out infinite;
  }

  .platform-logo-node {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: #cffafe;
    box-shadow: 0 0 16px rgba(34, 211, 238, 0.88);
  }

  .platform-logo .node-a {
    top: 19%;
    right: 21%;
  }

  .platform-logo .node-b {
    left: 22%;
    bottom: 24%;
  }

  .platform-logo .node-c {
    right: 22%;
    bottom: 20%;
    background: #f0abfc;
    box-shadow: 0 0 16px rgba(217, 70, 239, 0.78);
  }

  .platform-logo-core {
    position: relative;
    z-index: 1;
    width: 52%;
    height: 52%;
    display: grid;
    place-items: center;
    filter: drop-shadow(0 0 18px rgba(139, 92, 246, 0.44));
  }

  .platform-logo-core svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .launch-card,
  .login-card {
    position: relative;
    z-index: 1;
    border: 1px solid rgba(255,255,255,0.1);
    background:
      radial-gradient(circle at 20% 0%, rgba(34, 211, 238, 0.1), transparent 30%),
      radial-gradient(circle at 90% 10%, rgba(139, 92, 246, 0.18), transparent 34%),
      linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(5, 8, 20, 0.98));
    box-shadow:
      0 34px 110px rgba(0,0,0,0.52),
      inset 0 1px 0 rgba(255,255,255,0.06);
    backdrop-filter: blur(22px);
  }

  .launch-card {
    display: grid;
    justify-items: center;
    gap: 15px;
    width: min(620px, 92vw);
    padding: 44px;
    border-radius: 34px;
    text-align: center;
  }

  .launch-card p,
  .login-brand p,
  .login-copy span {
    margin: 0;
    color: #93b4ff;
    font-size: 14px;
    font-weight: 950;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .launch-card h1 {
    margin: 8px 0 0;
    color: #ffffff;
    font-size: clamp(26px, 4vw, 46px);
    line-height: 0.98;
    letter-spacing: -0.06em;
  }

  .launch-card span {
    color: #aebbe1;
    line-height: 1.6;
  }

  .launch-progress {
    width: min(340px, 80vw);
    height: 7px;
    margin-top: 12px;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255,255,255,0.08);
  }

  .launch-progress i {
    display: block;
    width: 44%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #22d3ee, #8b5cf6, #ec4899);
    animation: progressSweep 1.45s ease-in-out infinite;
  }

  .login-card {
    width: min(1040px, 94vw);
    min-height: 610px;
    display: grid;
    grid-template-columns: minmax(0, 0.95fr) minmax(360px, 0.72fr);
    gap: 30px;
    align-items: stretch;
    padding: 34px;
    border-radius: 38px;
    overflow: hidden;
  }

  .login-orb {
    position: absolute;
    border-radius: 999px;
    filter: blur(60px);
    opacity: 0.72;
  }

  .login-orb.orb-a {
    width: 320px;
    height: 320px;
    top: -110px;
    right: -70px;
    background: rgba(139, 92, 246, 0.26);
  }

  .login-orb.orb-b {
    width: 300px;
    height: 300px;
    bottom: -120px;
    left: -80px;
    background: rgba(34, 211, 238, 0.12);
  }

  .login-brand,
  .login-copy {
    position: relative;
    z-index: 1;
  }

  .login-brand {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 28px;
    border-radius: 30px;
    background: rgba(255,255,255,0.035);
    border: 1px solid rgba(255,255,255,0.07);
  }

  .login-brand h1 {
    margin: 12px 0 10px;
    max-width: 560px;
    color: #ffffff;
    font-size: clamp(48px, 7vw, 84px);
    line-height: 0.9;
    letter-spacing: -0.08em;
  }

  .login-brand span {
    display: block;
    max-width: 520px;
    color: #aebbe1;
    font-size: 17px;
    line-height: 1.6;
  }

  .login-copy {
    align-self: center;
    padding: 28px;
    border-radius: 30px;
    background:
      radial-gradient(circle at top right, rgba(139, 92, 246, 0.16), transparent 36%),
      rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
  }

  .login-copy h2 {
    margin: 14px 0 14px;
    color: #ffffff;
    font-size: clamp(32px, 3.6vw, 52px);
    line-height: 0.98;
    letter-spacing: -0.06em;
  }

  .login-copy p {
    margin: 0 0 22px;
    color: #aebbe1;
    font-size: 17px;
    line-height: 1.7;
  }

  .login-google-btn {
    width: 100%;
    min-height: 56px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    border-radius: 18px;
    border: 1px solid rgba(255,255,255,0.1);
    color: #ffffff;
    background: linear-gradient(135deg, #2563eb, #7c3aed, #db2777);
    box-shadow: 0 22px 42px rgba(91, 33, 182, 0.34);
    font-weight: 950;
    cursor: pointer;
  }

  .login-google-btn svg {
    width: 22px;
    height: 22px;
    padding: 3px;
    border-radius: 999px;
    background: #ffffff;
  }

  .login-copy small {
    display: block;
    margin-top: 14px;
    color: #8ea0c9;
    text-align: center;
  }

  .login-warning {
    margin: 0 0 16px;
    padding: 12px 14px;
    border-radius: 16px;
    color: #fecaca;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.2);
    font-size: 15px;
    line-height: 1.5;
  }

  @keyframes progressSweep {
    0% { transform: translateX(-120%); }
    55% { transform: translateX(92%); }
    100% { transform: translateX(220%); }
  }

  @keyframes orbitFloatA {
    0%, 100% { transform: rotate(-24deg) scale(1); opacity: 0.72; }
    50% { transform: rotate(-14deg) scale(1.05); opacity: 1; }
  }

  @keyframes orbitFloatB {
    0%, 100% { transform: rotate(28deg) scale(1); opacity: 0.72; }
    50% { transform: rotate(42deg) scale(1.05); opacity: 1; }
  }

  :root {
    color-scheme: dark;
  }

  * {
    box-sizing: border-box;
  }

  html,
  body {
    margin: 0;
    min-height: 100%;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system,
      BlinkMacSystemFont, "Segoe UI", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(91, 33, 182, 0.2), transparent 26%),
      radial-gradient(circle at 85% 12%, rgba(37, 99, 235, 0.18), transparent 24%),
      radial-gradient(circle at 70% 28%, rgba(217, 70, 239, 0.12), transparent 18%),
      linear-gradient(180deg, #030611 0%, #050918 42%, #02040b 100%);
    color: #f8fbff;
  }

  a {
    color: inherit;
  }

  .app-shell {
    position: relative;
    min-height: 100vh;
  }

  .app-bg {
    pointer-events: none;
    position: fixed;
    inset: 0;
    overflow: hidden;
  }

  .bg-orb {
    position: absolute;
    border-radius: 999px;
    filter: blur(90px);
    opacity: 0.75;
  }

  .orb-one {
    top: -120px;
    left: -100px;
    height: 340px;
    width: 340px;
    background: rgba(139, 92, 246, 0.18);
  }

  .orb-two {
    top: 70px;
    right: -60px;
    height: 300px;
    width: 300px;
    background: rgba(59, 130, 246, 0.16);
  }

  .orb-three {
    bottom: -80px;
    left: 22%;
    height: 320px;
    width: 320px;
    background: rgba(217, 70, 239, 0.12);
  }

  .bg-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px);
    background-size: 72px 72px;
    mask-image: linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0));
    opacity: 0.2;
  }

  .bg-vignette {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at center, transparent 40%, rgba(2, 6, 23, 0.28) 78%, rgba(2, 6, 23, 0.62) 100%);
  }

  .shell-frame {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    min-height: 100vh;
    align-items: start;
  }

  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 26px;
    padding: 22px 16px 18px;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    background:
      linear-gradient(180deg, rgba(8, 14, 32, 0.92) 0%, rgba(5, 10, 24, 0.88) 100%);
    backdrop-filter: blur(22px);
    box-shadow:
      inset -1px 0 0 rgba(255, 255, 255, 0.03),
      20px 0 80px rgba(2, 6, 23, 0.25);
  }

  .brand-wrap {
    display: grid;
    gap: 18px;
  }

  .brand-badge {
    width: fit-content;
    max-width: 100%;
    border: 1px solid rgba(139, 92, 246, 0.28);
    background: linear-gradient(135deg, rgba(91, 33, 182, 0.26), rgba(30, 41, 59, 0.32));
    color: #e9ddff;
    padding: 9px 14px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 850;
    letter-spacing: 0.12em;
  }

  .brand-block {
    display: flex;
    align-items: center;
    gap: 13px;
  }

  .brand-mark {
    position: relative;
    display: grid;
    place-items: center;
    width: 58px;
    height: 58px;
    flex: 0 0 auto;
    border-radius: 22px;
    overflow: hidden;
    background:
      radial-gradient(circle at 28% 22%, rgba(255,255,255,0.22), transparent 22%),
      linear-gradient(145deg, rgba(5, 12, 31, 0.96), rgba(15, 23, 42, 0.92));
    border: 1px solid rgba(125, 211, 252, 0.18);
    box-shadow:
      0 20px 44px rgba(18, 31, 67, 0.34),
      inset 0 1px 0 rgba(255, 255, 255, 0.1),
      inset 0 0 42px rgba(45, 212, 191, 0.06);
  }

  .brand-mark-halo {
    position: absolute;
    inset: 8px;
    border-radius: 18px;
    background: radial-gradient(circle at center, rgba(34, 211, 238, 0.1), rgba(139, 92, 246, 0.08), transparent 70%);
    filter: blur(6px);
  }

  .brand-orbit,
  .brand-node {
    position: absolute;
    pointer-events: none;
  }

  .brand-orbit {
    border: 1px solid rgba(191, 219, 254, 0.28);
    border-radius: 999px;
    transform: rotate(-24deg);
  }

  .orbit-one {
    width: 48px;
    height: 23px;
  }

  .orbit-two {
    width: 23px;
    height: 48px;
    transform: rotate(28deg);
  }

  .brand-node {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #cffafe;
    box-shadow: 0 0 14px rgba(34, 211, 238, 0.8);
  }

  .node-one {
    top: 12px;
    right: 14px;
  }

  .node-two {
    left: 13px;
    bottom: 15px;
  }

  .node-three {
    right: 13px;
    bottom: 13px;
    background: #f0abfc;
    box-shadow: 0 0 14px rgba(217, 70, 239, 0.75);
  }

  .brand-mark-core {
    position: relative;
    z-index: 1;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    filter: drop-shadow(0 0 18px rgba(139, 92, 246, 0.4));
  }

  .brand-mark-core svg {
    width: 34px;
    height: 34px;
    display: block;
  }

  .brand-title {
    margin: 0;
    max-width: 165px;
    font-size: 19px;
    line-height: 1.12;
    letter-spacing: -0.045em;
    font-weight: 900;
    color: #ffffff;
  }

  .brand-subtitle {
    margin: 8px 0 0;
    max-width: 170px;
    font-size: 15px;
    line-height: 1.45;
    color: #9caed3;
  }

  .nav {
    display: grid;
    gap: 12px;
  }

  .nav-section-label {
    padding: 0 6px;
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.14em;
    color: #8296c4;
  }

  .nav-list {
    display: grid;
    gap: 10px;
  }

  .nav-link {
    position: relative;
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 0 16px;
    border-radius: 18px;
    text-decoration: none;
    color: #dce7ff;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 10px 24px rgba(2, 6, 23, 0.18);
    font-size: 17px;
    font-weight: 800;
    transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
  }

  .nav-link:hover,
  .nav-link.active {
    transform: translateY(-1px);
    border-color: rgba(139, 92, 246, 0.28);
    background: linear-gradient(180deg, rgba(91, 33, 182, 0.18), rgba(255, 255, 255, 0.03));
  }

  .nav-link-icon {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
    transition: transform 0.18s ease, background 0.18s ease;
  }

  .nav-link:hover .nav-link-icon,
  .nav-link.active .nav-link-icon {
    transform: translateY(-1px);
    background: linear-gradient(180deg, rgba(34, 211, 238, 0.1), rgba(139, 92, 246, 0.08));
  }

  .nav-link em {
    color: #fbbf24;
    font-size: 12px;
    font-style: normal;
    font-weight: 850;
  }

  .locked-nav {
    opacity: 0.72;
  }

  .sidebar-mini {
    margin-top: auto;
    border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.035);
    padding: 14px;
  }

  .sidebar-mini span {
    display: block;
    color: #7f92bc;
    font-size: 13px;
    font-weight: 850;
    letter-spacing: 0.12em;
    margin-bottom: 8px;
  }

  .sidebar-mini strong {
    color: #ffffff;
    font-size: 17px;
  }

  .content-shell {
    min-width: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    padding: 14px 18px 24px;
  }

  .topbar {
    position: relative;
    z-index: 500;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 76px;
    padding: 16px 20px;
    margin-bottom: 18px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 24px;
    background:
      radial-gradient(circle at top right, rgba(139, 92, 246, 0.1), transparent 34%),
      linear-gradient(180deg, rgba(11, 18, 39, 0.94), rgba(7, 12, 28, 0.9));
    backdrop-filter: blur(18px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 18px 60px rgba(2, 6, 23, 0.18);
  }

  .topbar-kicker {
    font-size: 13px;
    font-weight: 850;
    letter-spacing: 0.12em;
    color: #7e92bd;
  }

  .topbar-title {
    margin-top: 7px;
    font-size: 23px;
    line-height: 1.1;
    letter-spacing: -0.04em;
    font-weight: 900;
    color: #ffffff;
    max-width: min(980px, 64vw);
    white-space: normal;
    line-height: 1.15;
  }

  .profile-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  .profile-button,
  .signin-btn,
  .signout-btn,
  .locked-link {
    border: 0;
    cursor: pointer;
    text-decoration: none;
    font: inherit;
  }

  .profile-button {
    min-width: 260px;
    min-height: 52px;
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    align-items: center;
    gap: 11px;
    padding: 7px 12px 7px 7px;
    border-radius: 18px;
    color: #ffffff;
    border: 1px solid rgba(255,255,255,0.08);
    background:
      linear-gradient(135deg, rgba(59,130,246,0.14), rgba(139,92,246,0.16), rgba(236,72,153,0.08));
  }

  .profile-avatar {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: 15px;
    color: #ffffff;
    font-size: 15px;
    font-weight: 900;
    background: linear-gradient(135deg, #2563eb, #7c3aed, #db2777);
    box-shadow: 0 0 24px rgba(139,92,246,0.42);
  }

  .profile-avatar-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .profile-avatar.large {
    width: 48px;
    height: 48px;
    border-radius: 17px;
  }

  .profile-copy {
    min-width: 0;
    text-align: left;
  }

  .profile-copy strong,
  .profile-copy small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .profile-copy strong {
    font-size: 16px;
  }

  .profile-copy small {
    margin-top: 3px;
    color: #a9b4d0;
    font-size: 14px;
  }

  .profile-button b {
    color: #8ea0d6;
    font-size: 13px;
  }

  .profile-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 10px);
    z-index: 1000;
    width: min(380px, 92vw);
    padding: 16px;
    border-radius: 24px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(9, 14, 30, 0.98);
    box-shadow: 0 24px 80px rgba(0,0,0,0.5);
  }

  .profile-menu-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }

  .profile-menu-head strong,
  .profile-menu-head small {
    display: block;
  }

  .profile-menu-head small {
    margin-top: 4px;
    color: #9caed3;
  }

  .profile-detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }

  .profile-detail-grid div {
    padding: 12px;
    border-radius: 16px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.07);
  }

  .profile-detail-grid span {
    display: block;
    color: #8ea0d6;
    font-size: 13px;
    font-weight: 850;
    margin-bottom: 6px;
  }

  .profile-detail-grid strong {
    color: #ffffff;
    font-size: 15px;
  }

  .profile-note,
  .profile-warning {
    margin: 0 0 12px;
    color: #a9b4d0;
    font-size: 15px;
    line-height: 1.6;
  }

  .profile-warning {
    color: #fca5a5;
  }

  .signin-btn,
  .signout-btn,
  .locked-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 42px;
    padding: 0 16px;
    border-radius: 14px;
    color: #ffffff;
    font-size: 15px;
    font-weight: 850;
    background: linear-gradient(135deg, #2563eb, #7c3aed, #db2777);
    box-shadow: 0 14px 30px rgba(91,33,182,0.32);
  }

  .signin-btn.large,
  .locked-link {
    min-height: 48px;
    padding: 0 18px;
  }

  .signout-btn {
    width: 100%;
    background: rgba(244,63,94,0.12);
    border: 1px solid rgba(244,63,94,0.24);
    box-shadow: none;
  }

  .profile-loading {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    padding: 0 14px;
    border-radius: 999px;
    color: #cbd5e1;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.035);
    font-size: 15px;
    font-weight: 800;
  }

  .page-content {
    position: relative;
    min-width: 0;
    padding-top: 16px;
  }

  .locked-content {
    min-height: calc(100vh - 100px);
  }

  .blurred-page {
    filter: blur(8px);
    opacity: 0.32;
    pointer-events: none;
    user-select: none;
  }

  .locked-overlay {
    position: absolute;
    inset: 16px 0 0;
    z-index: 50;
    display: grid;
    place-items: start center;
    padding-top: 80px;
  }

  .locked-card {
    position: relative;
    overflow: hidden;
    width: min(620px, 92%);
    padding: 34px;
    border-radius: 30px;
    text-align: center;
    border: 1px solid rgba(255,255,255,0.1);
    background:
      linear-gradient(180deg, rgba(15,22,43,0.96), rgba(7,10,24,0.98));
    box-shadow: 0 30px 90px rgba(0,0,0,0.55);
  }

  .locked-orb {
    position: absolute;
    inset: -120px -100px auto auto;
    width: 300px;
    height: 300px;
    border-radius: 999px;
    background: rgba(168,85,247,0.2);
    filter: blur(40px);
  }

  .locked-card span,
  .locked-card h2,
  .locked-card p,
  .locked-card a,
  .locked-card button {
    position: relative;
    z-index: 1;
  }

  .locked-card span {
    color: #9fb2ee;
    font-size: 14px;
    font-weight: 850;
    letter-spacing: 0.14em;
  }

  .locked-card h2 {
    margin: 12px 0 10px;
    color: #ffffff;
    font-size: 38px;
    letter-spacing: -0.05em;
  }

  .locked-card p {
    margin: 0 auto 22px;
    max-width: 480px;
    color: #a9b4d0;
    line-height: 1.7;
  }

  @media (max-width: 1100px) {
    .login-card {
      grid-template-columns: 1fr;
      min-height: auto;
    }

    .login-brand {
      align-items: flex-start;
      flex-direction: column;
    }

    .shell-frame {
      grid-template-columns: 1fr;
    }

    .sidebar {
      position: relative;
      height: auto;
      overflow: visible;
      border-right: none;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }

    .nav-list {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .sidebar-mini {
      display: none;
    }

    .content-shell {
      padding-top: 14px;
    }
  }

  @media (max-width: 760px) {
    .auth-stage {
      padding: 14px;
    }

    .login-card,
    .launch-card {
      padding: 20px;
      border-radius: 26px;
    }

    .login-brand,
    .login-copy {
      padding: 20px;
      border-radius: 22px;
    }

    .login-brand h1 {
      font-size: 44px;
    }

    .content-shell,
    .sidebar {
      padding-left: 12px;
      padding-right: 12px;
    }

    .topbar {
      position: relative;
      top: auto;
      flex-direction: column;
      align-items: stretch;
    }

    .profile-button {
      width: 100%;
      min-width: 0;
    }

    .nav-list {
      grid-template-columns: 1fr;
    }

    .locked-card {
      padding: 26px;
    }

    .locked-card h2 {
      font-size: 30px;
    }
  }
`;
