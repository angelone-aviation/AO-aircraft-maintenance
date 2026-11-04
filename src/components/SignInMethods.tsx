/**
 * Responsibility: Sign-in methods (ADR-0009): the Google and Microsoft buttons
 *   on the sign-in screen, the notice shown when such a sign-in signed nobody
 *   in, and a user's sign-in methods in Settings → My account and
 *   Administration.
 * Layer: UI. React components; the sign-in screen runs before the workspace
 *   exists, so it calls Convex and Convex Auth directly.
 * Dependencies: react, convex/react, @convex-dev/auth/react,
 *   @phosphor-icons/react, convex/_generated/api, src/data/store.ts,
 *   src/domain/signInMethods.ts, src/domain/model.ts (types), ./design.tsx,
 *   ./ui.tsx, src/styles/screens/signin.css.
 *
 * Accounts stay administrator-provisioned: a Google or Microsoft account is
 * only ever linked to an existing user.
 */
import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Password, WarningCircle, WifiSlash } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { useWorkspace } from "../data/store";
import {
  GOOGLE,
  SIGN_IN_ERROR_PARAM,
  SIGN_IN_PROVIDER_PARAM,
  isSsoProvider,
  signInErrorMessage,
  signInMethodLabels,
  type LinkedIdentity,
  type SsoProvider,
} from "../domain/signInMethods";
import type { Member } from "../domain/model";
import { IconTile, NoticeBar } from "./design";
import { AsyncForm, errorText } from "./ui";
import "../styles/screens/signin.css";

const TRY_AGAIN = "Something went wrong. Please try again.";

/** The providers' own marks, as their sign-in button guidelines require. */
function ProviderMark({ provider }: { provider: string }) {
  return provider === GOOGLE ? (
    <svg className="sgn-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  ) : (
    <svg className="sgn-mark" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

/** The buttons for the configured providers; nothing when none is. */
export function SsoButtonList({
  providers,
  disabled = false,
  busy,
  onSelect,
}: {
  providers: readonly string[];
  disabled?: boolean;
  busy?: string;
  onSelect: (provider: SsoProvider) => void;
}) {
  const shown = providers.filter(isSsoProvider);
  if (!shown.length) return null;
  return (
    <div className="sgn-sso">
      <p className="welcome-divider">or</p>
      {shown.map((provider) => (
        <button
          key={provider}
          type="button"
          className="button sgn-sso-button"
          disabled={disabled || busy !== undefined}
          onClick={() => onSelect(provider)}
        >
          <ProviderMark provider={provider} />
          {busy === provider
            ? `Opening ${signInMethodLabels[provider]}…`
            : `Sign in with ${signInMethodLabels[provider]}`}
        </button>
      ))}
    </div>
  );
}

/** Google and Microsoft sign-in on the sign-in screen, for the providers the
 * deployment has configured (identities.providers). */
export function SsoSignIn({ disabled }: { disabled: boolean }) {
  const providers = useQuery(api.identities.providers, {});
  const { signIn } = useAuthActions();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  return (
    <>
      <SsoButtonList
        providers={providers ?? []}
        disabled={disabled}
        busy={busy}
        onSelect={async (provider) => {
          setError("");
          setBusy(provider);
          try {
            // Leaves for the provider's page; the provider sends the browser
            // back here with a one-time code the library redeems.
            await signIn(provider);
          } catch (e) {
            setBusy(undefined);
            setError(errorText(e, TRY_AGAIN));
          }
        }}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Why the last Google or Microsoft sign-in signed nobody in, read once from
 * the address the sign-in route sent the browser back to. */
export function SignInNotice() {
  const [notice] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return signInErrorMessage(
      params.get(SIGN_IN_ERROR_PARAM),
      params.get(SIGN_IN_PROVIDER_PARAM),
    );
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (
      !url.searchParams.has(SIGN_IN_ERROR_PARAM) &&
      !url.searchParams.has(SIGN_IN_PROVIDER_PARAM)
    )
      return;
    url.searchParams.delete(SIGN_IN_ERROR_PARAM);
    url.searchParams.delete(SIGN_IN_PROVIDER_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  }, []);
  if (!notice) return null;
  return (
    <NoticeBar
      tone="warn"
      icon={WarningCircle}
      role="alert"
      className="sgn-notice"
    >
      <strong>{notice.title}</strong> {notice.detail}
    </NoticeBar>
  );
}

const linkedOn = (at: number) =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** A user's sign-in methods: the password every user has, then any linked
 * Google or Microsoft accounts. Without `member`, the signed-in user's own;
 * with it (system administrators), that user's, each with Remove. */
export function SignInMethodList({ member }: { member?: Member }) {
  const { backend, online, connected } = useWorkspace();
  const live = online && connected;
  const [identities, setIdentities] = useState<LinkedIdentity[]>();
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<LinkedIdentity>();
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (!live) return;
    let current = true;
    backend!
      .linkedIdentities(member?.id)
      .then((result) => {
        if (current) setIdentities(result);
      })
      .catch((e) => {
        if (current) setError(errorText(e, TRY_AGAIN));
      });
    return () => {
      current = false;
    };
  }, [backend, member?.id, live, loads]);
  if (removing && member)
    return (
      <AsyncForm
        disabled={!live}
        submitLabel="Remove linked account"
        onSubmit={async () => {
          await backend!.removeIdentity(member.id, removing.id);
          setRemoving(undefined);
          setLoads((n) => n + 1);
        }}
      >
        <p>
          Remove the {signInMethodLabels[removing.provider]} account{" "}
          <strong>{removing.email ?? "without a shared email"}</strong> from{" "}
          {member.name}?
        </p>
        <p className="muted">
          It stops signing them in. Signing in with it again links it again
          while its verified email matches their Angel One email; to stop every
          sign-in, disable the account instead. Their password is not changed.
        </p>
        <button
          type="button"
          className="button"
          onClick={() => setRemoving(undefined)}
        >
          Cancel
        </button>
      </AsyncForm>
    );
  return (
    <div className="sgn-methods">
      <ul aria-label="Sign-in methods">
        <li>
          <IconTile icon={Password} size="sm" />
          <span className="sgn-method-text">
            <strong>Password</strong>
            <small>
              {member
                ? "Reset by a system administrator."
                : "Set by your administrator. Ask them to reset it."}
            </small>
          </span>
        </li>
        {identities?.map((identity) => (
          <li key={identity.id}>
            <span className="sgn-method-mark">
              <ProviderMark provider={identity.provider} />
            </span>
            <span className="sgn-method-text">
              <strong>
                {signInMethodLabels[identity.provider] ?? identity.provider}
              </strong>
              <small>
                {identity.email ?? "Email not shared"} · Linked{" "}
                {linkedOn(identity.linkedAt)}
              </small>
            </span>
            {member && (
              <button
                type="button"
                className="button small sgn-remove"
                disabled={!live}
                aria-label={`Remove ${signInMethodLabels[identity.provider] ?? identity.provider} account ${identity.email ?? ""}`.trim()}
                onClick={() => setRemoving(identity)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {identities && !identities.length && (
        <p className="sgn-empty">No Google or Microsoft account is linked.</p>
      )}
      {!live && (
        <p className="sgn-empty">
          <WifiSlash size={16} aria-hidden="true" /> Reconnect to see linked
          Google or Microsoft accounts.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
