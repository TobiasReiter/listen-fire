"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
import { PublicClientApplication, type Configuration } from "@azure/msal-browser";
import { useAuth } from "@/lib/auth";
import { firstMountedHref, loginMode } from "@/lib/capabilities";
import { useCapabilities, useCapabilitiesSettled } from "@/lib/capabilities-provider";
import { useSignInConfig } from "@/lib/sign-in-config-hook";
import { usePageTitle } from "@/components/page-title";

// Only allow same-origin paths to prevent open-redirect via ?returnUrl=...
function safeReturnUrl(raw: string | null): string | null {
  if (!raw) return null;
  // Must start with exactly one slash (not "//" which is protocol-relative).
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

/**
 * Leave the login page after a successful sign-in. A `returnUrl` may point at
 * a rewritten non-Next path (the OAuth `/oauth/authorize` consent screen that
 * bounced here), which the client-side router can't resolve — so returnUrl
 * navigation is always a full page load; the in-app defaults stay on the
 * client router.
 */
function leaveLogin(
  router: { replace: (url: string) => void },
  returnUrl: string | null,
  fallback: string,
): void {
  if (returnUrl) {
    window.location.replace(returnUrl);
    return;
  }
  router.replace(fallback);
}

type Attribution = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrer?: string;
};

// Transient signup attribution — read at submit, sent in the request, never stored.
function buildAttribution(): Attribution {
  const attribution: Attribution = {};
  if (typeof window === "undefined") return attribution;
  const params = new URLSearchParams(window.location.search);
  const map: [keyof Omit<Attribution, "referrer">, string][] = [
    ["utmSource", "utm_source"],
    ["utmMedium", "utm_medium"],
    ["utmCampaign", "utm_campaign"],
    ["utmTerm", "utm_term"],
    ["utmContent", "utm_content"],
  ];
  for (const [key, param] of map) {
    const value = params.get(param);
    if (value) attribution[key] = value;
  }
  if (document.referrer) attribution.referrer = document.referrer;
  return attribution;
}

// The client id arrives from the API at run time (see `useSignInConfig`), so
// MSAL cannot be built at module load the way a `NEXT_PUBLIC_*` constant let it
// be. It is still a singleton — MSAL keeps redirect state in session storage and
// a second instance for the same id would race the first over it — just one
// keyed on the id it was built for.
let msalInstance: PublicClientApplication | null = null;
let msalInstanceClientId: string | null = null;
let msalInitPromise: Promise<void> | null = null;

function getMsalInstance(clientId: string | undefined) {
  if (!clientId || typeof window === "undefined") return null;
  if (msalInstance && msalInstanceClientId === clientId) return msalInstance;

  const config: Configuration = {
    auth: {
      clientId,
      authority: "https://login.microsoftonline.com/common",
      redirectUri: window.location.origin + "/login",
    },
  };
  msalInstance = new PublicClientApplication(config);
  msalInstanceClientId = clientId;
  msalInitPromise = msalInstance.initialize();
  return msalInstance;
}

/** Shared auth chrome — the Listen-Fire wordmark over a clean card on slate, echoing
 *  the marketing site's brand (primary #8778F7, slate palette, rounded
 *  cards). Every login/signup state renders through this for coherence. */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="text-lg font-bold uppercase tracking-[0.2em] text-primary">
            KIPP
          </span>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}

function LoginForm({
  googleClientId,
  microsoftClientId,
}: {
  googleClientId?: string;
  microsoftClientId?: string;
}) {
  const searchParams = useSearchParams();
  const isSignup = searchParams.get("mode") === "signup";

  usePageTitle(isSignup ? "Sign up — KIPP" : "Sign in — KIPP");

  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const returnUrl = safeReturnUrl(searchParams.get("returnUrl"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Signup requires an explicit terms acceptance before we start an OAuth flow.
  const [termsAccepted, setTermsAccepted] = useState(false);
  // Set when the server refuses an address nobody has been invited: sign-in is
  // invited-only, so this is a dead end with a plain explanation, not an error.
  const [notInvited, setNotInvited] = useState(false);
  // Email + password (an additional option alongside the social buttons).
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Full name — required for email+password signup (social signups get the name
  // from the OAuth profile server-side).
  const [name, setName] = useState("");
  // Password-signup terminal states.
  const [checkEmailSent, setCheckEmailSent] = useState(false);
  const [accountExists, setAccountExists] = useState(false);
  // Magic-link request terminal state.
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const msalHandled = useRef(false);
  const capabilities = useCapabilities();
  const [apiKey, setApiKey] = useState("");

  // Both /callback and /signup sign in; an invited address that has no account
  // yet gets one on the way. They differ only in mode-specific UI, and either
  // can 403 for an address nobody invited.
  const googleEndpoint = isSignup
    ? "/api/public/auth/google/signup"
    : "/api/public/auth/google/callback";
  const microsoftEndpoint = isSignup
    ? "/api/public/auth/microsoft/signup"
    : "/api/public/auth/microsoft/callback";

  // In signup mode the OAuth buttons are inert until the user accepts the terms.
  const signupBlocked = isSignup && !termsAccepted;

  const handleGateRefusal = async (res: Response): Promise<boolean> => {
    if (res.status !== 403) return false;
    // Only the invite door speaks `not_invited`. A 403 WITHOUT a recognised
    // reason (a proxy error, an auth edge, a stale API) is a different problem
    // — surface it as an error rather than telling somebody they weren't asked.
    const reason = await res
      .json()
      .then((b: { reason?: string }) => b?.reason)
      .catch(() => undefined);
    if (reason === "not_invited") {
      setNotInvited(true);
    } else {
      setError("Sign-in was refused. Please try again — if this persists, contact support.");
    }
    setLoading(false);
    return true;
  };

  const handlePasswordLogin = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public/auth/password/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError("Invalid email or password.");
        setLoading(false);
        return;
      }
      const data = await res.json();
      leaveLogin(
        router,
        returnUrl,
        data.email ? `/dashboard?email=${encodeURIComponent(data.email)}` : "/dashboard",
      );
    } catch {
      setError("Failed to sign in. Is the API running?");
      setLoading(false);
    }
  };

  const handleStaticLogin = async () => {
    if (!apiKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public/auth/static/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) {
        setError("That key was not accepted.");
        setLoading(false);
        return;
      }
      // A full page load, not the client router: the session marker cookie the
      // API just set is read once when the auth provider mounts, and a static
      // install has no email in the URL to tell the mounted one to re-read.
      window.location.replace(returnUrl ?? firstMountedHref(capabilities));
    } catch {
      setError("Failed to sign in. Is the API running?");
      setLoading(false);
    }
  };

  const handlePasswordSignup = async () => {
    if (signupBlocked || !name.trim() || !email || !password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public/auth/password/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email, password, attribution: buildAttribution() }),
      });

      if (await handleGateRefusal(res)) return;

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Could not create your account.");
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.status === "exists") {
        setAccountExists(true);
      } else {
        // Default to the check-email state for `{status:'check_email'}`.
        setCheckEmailSent(true);
      }
      setLoading(false);
    } catch {
      setError("Failed to create your account. Is the API running?");
      setLoading(false);
    }
  };

  /**
   * The endpoint answers 200 whether or not the address has an account — it
   * refuses to be an account-existence oracle — so the confirmation state is
   * reached unconditionally and its copy must not assert that the account
   * exists.
   */
  const handleMagicLinkRequest = async () => {
    if (!email) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public/auth/requestMagicLink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(returnUrl ? { email, redirectUrl: returnUrl } : { email }),
      });
      if (!res.ok) {
        setError("Could not send a sign-in link. Please try again.");
        setLoading(false);
        return;
      }
      setMagicLinkSent(true);
      setLoading(false);
    } catch {
      setError("Failed to send a sign-in link. Is the API running?");
      setLoading(false);
    }
  };

  // On page load, check if we're returning from a Microsoft redirect
  useEffect(() => {
    if (!microsoftClientId || msalHandled.current) return;
    msalHandled.current = true;

    const msal = getMsalInstance(microsoftClientId);
    if (!msal) return;

    msalInitPromise!.then(() =>
      msal.handleRedirectPromise().then(async (response) => {
        if (!response?.idToken) return;

        setLoading(true);
        try {
          const res = await fetch(microsoftEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              idToken: response.idToken,
              attribution: buildAttribution(),
            }),
          });

          if (await handleGateRefusal(res)) return;

          if (!res.ok) {
            const text = await res.text();
            setError(text || "Authentication failed.");
            setLoading(false);
            return;
          }

          const data = await res.json();
          if (data.email) {
            leaveLogin(router, returnUrl, `/dashboard?email=${encodeURIComponent(data.email)}`);
          } else {
            setError("Unexpected response from server.");
            setLoading(false);
          }
        } catch {
          setError("Failed to authenticate. Is the API running?");
          setLoading(false);
        }
      }).catch((err) => {
        setError(err instanceof Error ? err.message : "Microsoft sign-in failed.");
      }),
    );
  }, [router, returnUrl, microsoftEndpoint]);

  if (isAuthenticated) {
    leaveLogin(router, returnUrl, "/dashboard");
    return null;
  }

  const handleMicrosoftLogin = async () => {
    if (signupBlocked) return;
    const msal = getMsalInstance(microsoftClientId);
    if (!msal) return;
    await msalInitPromise;
    // Redirect to Microsoft — we'll handle the response on page load
    await msal.loginRedirect({
      scopes: ["openid", "email", "profile"],
    });
  };

  // A single-tenant install has no accounts, so it has no account buttons: the
  // installation's API key is the whole credential, and every core-only route
  // behind those buttons is absent from this deployment.
  if (capabilities?.identity === "static") {
    return (
      <AuthShell>
        <div className="space-y-4" data-testid="login-static">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Sign in</h1>
          <p className="text-sm text-slate-500">
            This installation is single-tenant. Paste the API key it was started with.
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleStaticLogin();
            }}
            placeholder="API key"
            autoComplete="off"
            className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
            data-testid="login-static-key"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={() => void handleStaticLogin()}
            disabled={loading || !apiKey}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
            data-testid="login-static-submit"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </AuthShell>
    );
  }

  if (checkEmailSent) {
    return (
      <AuthShell>
        <div className="space-y-3 text-center" data-testid="signup-check-email">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Check your inbox</h1>
          <p className="text-sm text-slate-500">
            Click the link we sent to{" "}
            <span className="font-medium text-slate-700">{email}</span> to finish
            creating your account.
          </p>
        </div>
      </AuthShell>
    );
  }

  if (magicLinkSent) {
    return (
      <AuthShell>
        <div className="space-y-4 text-center" data-testid="login-magic-link-sent">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Check your inbox</h1>
          <p className="text-sm text-slate-500">
            If an account exists for{" "}
            <span className="font-medium text-slate-700">{email}</span>, we&apos;ve
            sent a sign-in link. It works once and then expires.
          </p>
          <button
            onClick={() => setMagicLinkSent(false)}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            data-testid="login-magic-link-back"
          >
            Back to sign in
          </button>
        </div>
      </AuthShell>
    );
  }

  if (accountExists) {
    return (
      <AuthShell>
        <div className="space-y-4 text-center" data-testid="signup-account-exists">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            You already have an account
          </h1>
          <p className="text-sm text-slate-500">
            An account for{" "}
            <span className="font-medium text-slate-700">{email}</span> already
            exists. Sign in to continue.
          </p>
          <button
            onClick={() => {
              setAccountExists(false);
              setPassword("");
              router.replace("/login");
            }}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-600"
            data-testid="signup-switch-to-login"
          >
            Go to sign in
          </button>
        </div>
      </AuthShell>
    );
  }

  if (notInvited) {
    return (
      <AuthShell>
        <div className="space-y-3 text-center" data-testid="not-invited">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            This address isn&apos;t on a team yet
          </h1>
          <p className="text-sm text-slate-500">
            Ask an admin of your team to add you.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            {isSignup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {isSignup ? "Sign up to get started." : "Sign in to continue."}
          </p>
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-center text-sm text-slate-500">Signing in…</p>
        ) : (
          <>
            {isSignup && (
              <label
                className="flex items-start gap-2 text-xs text-slate-500"
                data-testid="signup-terms"
              >
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5 accent-primary"
                  data-testid="signup-terms-checkbox"
                />
                <span>
                  I agree to the{" "}
                  <a
                    href="/terms"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:text-primary-600"
                  >
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:text-primary-600"
                  >
                    Privacy Policy
                  </a>
                  .
                </span>
              </label>
            )}
            <div
              className={`space-y-3 ${signupBlocked ? "pointer-events-none opacity-50" : ""}`}
              aria-disabled={signupBlocked}
            >
            {googleClientId && (
              <GoogleLogin
                width={316}
                onSuccess={async (credentialResponse) => {
                  if (signupBlocked) return;
                  if (!credentialResponse.credential) {
                    setError("No credential received from Google.");
                    return;
                  }

                  setLoading(true);
                  setError(null);

                  try {
                    const res = await fetch(googleEndpoint, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        idToken: credentialResponse.credential,
                        attribution: buildAttribution(),
                      }),
                    });

                    if (await handleGateRefusal(res)) return;

                    if (!res.ok) {
                      const text = await res.text();
                      setError(text || "Authentication failed.");
                      setLoading(false);
                      return;
                    }

                    const data = await res.json();
                    if (data.email) {
                      leaveLogin(
                        router,
                        returnUrl,
                        `/dashboard?email=${encodeURIComponent(data.email)}`,
                      );
                    } else {
                      setError("Unexpected response from server.");
                      setLoading(false);
                    }
                  } catch {
                    setError("Failed to authenticate. Is the API running?");
                    setLoading(false);
                  }
                }}
                onError={() => {
                  setError("Google sign-in failed.");
                }}
              />
            )}

            {microsoftClientId && (
              <button
                onClick={handleMicrosoftLogin}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                <svg width="16" height="16" viewBox="0 0 21 21" fill="none">
                  <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                  <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                  <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                  <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                </svg>
                Continue with Microsoft
              </button>
            )}
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              or
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <div
              className={`space-y-3 ${signupBlocked ? "pointer-events-none opacity-50" : ""}`}
              aria-disabled={signupBlocked}
            >
              {isSignup && (
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full name"
                  autoComplete="name"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                  data-testid="signup-name"
                />
              )}
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                data-testid={isSignup ? "signup-email" : "login-email"}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (isSignup) handlePasswordSignup();
                    else handlePasswordLogin();
                  }
                }}
                placeholder="Password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                data-testid={isSignup ? "signup-password" : "login-password"}
              />
              <button
                onClick={isSignup ? handlePasswordSignup : handlePasswordLogin}
                disabled={!email || !password || (isSignup && !name.trim())}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid={isSignup ? "signup-password-submit" : "login-password-submit"}
              >
                {isSignup ? "Create account" : "Sign in"}
              </button>
              {!isSignup && (
                <button
                  onClick={handleMagicLinkRequest}
                  disabled={!email}
                  className="w-full text-center text-xs font-medium text-primary transition-colors hover:text-primary-600 disabled:cursor-not-allowed disabled:text-slate-400"
                  data-testid="login-magic-link-request"
                >
                  Email me a sign-in link instead
                </button>
              )}
            </div>

            {isSignup && (
              <p className="text-center text-xs text-slate-400">
                Already have an account?{" "}
                <Link
                  href={
                    returnUrl
                      ? `/login?returnUrl=${encodeURIComponent(returnUrl)}`
                      : "/login"
                  }
                  className="font-medium text-primary hover:text-primary-600"
                  data-testid="signup-switch-to-signin"
                >
                  Sign in
                </Link>
              </p>
            )}

            {!isSignup && (
              <p className="text-center text-xs text-slate-400">
                By continuing, you agree to the{" "}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-500 underline hover:text-slate-700"
                >
                  Terms of Service
                </a>{" "}
                and{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-500 underline hover:text-slate-700"
                >
                  Privacy Policy
                </a>
                .
              </p>
            )}
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function LoginPage() {
  const capabilities = useCapabilities();
  const settled = useCapabilitiesSettled();
  const mode = loginMode({ capabilities, settled });
  const { config, settled: configSettled } = useSignInConfig();

  // Both probes answer in milliseconds off same-origin endpoints. Hold the
  // frame rather than render a door that may turn out to be the wrong one — or
  // a form that grows a Google button a beat after the person started typing.
  if (mode === "pending" || !configSettled) {
    return <main className="min-h-screen" />;
  }

  // A single-tenant install signs in with its API key, so the Google provider
  // wrapper below is dead weight there — and its script does not load anyway.
  if (mode === "static") {
    return <LoginForm />;
  }

  const form = (
    <LoginForm
      googleClientId={config.googleClientId}
      microsoftClientId={config.microsoftClientId}
    />
  );

  if (config.googleClientId) {
    return <GoogleOAuthProvider clientId={config.googleClientId}>{form}</GoogleOAuthProvider>;
  }

  return form;
}
