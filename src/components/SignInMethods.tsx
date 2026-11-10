/**
 * Responsibility: Google and Microsoft sign-in (ADR-0009): the sign-in screen's
 *   buttons and refusal notice, and a user's sign-in methods in Settings and
 *   Administration.
 * Layer: UI. React components; the sign-in screen runs before the workspace
 *   exists, so it calls Convex and Convex Auth directly (CONTEXT.md §5).
 * Dependencies: convex/react, @convex-dev/auth/react, convex/_generated/api,
 *   src/data/store.ts, src/domain/signInMethods.ts, ./design.tsx, ./ui.tsx.
 *
 * Accounts stay administrator-provisioned: a Google or Microsoft account is
 * only ever linked to an existing user.
 */
import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Password, WarningCircle, WifiSlash } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Backend } from "../data/backend";
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

/**
 * A sign-in button for each configured provider the app supports, in the
 * order given; other provider ids are left out.
 *
 * @param props.disabled - Disables every button.
 * @param props.busy - The provider being opened: its button reads "Opening
 *   <provider>…", and every button is disabled.
 * @returns Nothing when no supported provider is configured.
 */
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

/**
 * Google and Microsoft sign-in on the sign-in screen, for the providers the
 * deployment configures (`identities.providers`). Choosing one leaves the app
 * for the provider's page.
 *
 * @param props.disabled - Disables the buttons.
 * @returns The buttons, then an alert when a sign-in could not start.
 */
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
            // Success leaves the page, so busy stays set; the provider sends
            // the browser back with a one-time code the library redeems.
            await signIn(provider);
          } catch (e) {
            setBusy(undefined);
            setError(errorText(e, TRY_AGAIN));
          }
        }}
      />
      <ErrorAlert error={error} />
    </>
  );
}

/**
 * Why the last Google or Microsoft sign-in signed nobody in. Reads the reason
 * once from the address the sign-in route returned to, then removes it from
 * the address so a reload does not show it again.
 *
 * @returns Nothing when the address carries no known reason.
 */
export function SignInNotice() {
  const [notice] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return signInErrorMessage(
      params.get(SIGN_IN_ERROR_PARAM),
      params.get(SIGN_IN_PROVIDER_PARAM),
    );
  });
  useEffect(removeSignInParams, []);
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

/**
 * A user's sign-in methods: the password every user has, then the linked
 * Google or Microsoft accounts, which load only while online and connected.
 *
 * @param props.member - The user to show, for system administrators: each
 *   linked account gets a Remove button that asks first, then unlinks it on
 *   the server and reloads the list. Without it, the signed-in user's own.
 */
export function SignInMethodList({ member }: { member?: Member }) {
  const { backend, online, connected } = useWorkspace();
  const live = online && connected;
  const linked = useLinkedIdentities(backend, member?.id, live);
  const [removing, setRemoving] = useState<LinkedIdentity>();
  if (removing && member)
    return (
      <RemoveIdentityForm
        member={member}
        identity={removing}
        disabled={!live}
        onRemove={async () => {
          await backend!.removeIdentity(member.id, removing.id);
          setRemoving(undefined);
          linked.reload();
        }}
        onCancel={() => setRemoving(undefined)}
      />
    );
  return (
    <MethodList
      identities={linked.identities}
      error={linked.error}
      live={live}
      onRemove={member && setRemoving}
    />
  );
}

function useLinkedIdentities(
  backend: Backend | null,
  memberId: string | undefined,
  live: boolean,
) {
  const [identities, setIdentities] = useState<LinkedIdentity[]>();
  const [error, setError] = useState("");
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (!live) return;
    // A load that ends after the member changed, a reload or an unmount must
    // not overwrite the newer state.
    let current = true;
    backend!
      .linkedIdentities(memberId)
      .then((result) => {
        if (current) setIdentities(result);
      })
      .catch((e) => {
        if (current) setError(errorText(e, TRY_AGAIN));
      });
    return () => {
      current = false;
    };
  }, [backend, memberId, live, loads]);
  return { identities, error, reload: () => setLoads((n) => n + 1) };
}

function RemoveIdentityForm({
  member,
  identity,
  disabled,
  onRemove,
  onCancel,
}: {
  member: Member;
  identity: LinkedIdentity;
  disabled: boolean;
  onRemove: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <AsyncForm
      disabled={disabled}
      submitLabel="Remove linked account"
      onSubmit={onRemove}
    >
      <p>
        Remove the {signInMethodLabels[identity.provider]} account{" "}
        <strong>{identity.email ?? "without a shared email"}</strong> from{" "}
        {member.name}?
      </p>
      <p className="muted">
        It stops signing them in. Signing in with it again links it again while
        its verified email matches their Angel One email; to stop every sign-in,
        disable the account instead. Their password is not changed.
      </p>
      <button type="button" className="button" onClick={onCancel}>
        Cancel
      </button>
    </AsyncForm>
  );
}

// onRemove is given only to system administrators viewing another user.
function MethodList({
  identities,
  error,
  live,
  onRemove,
}: {
  identities?: LinkedIdentity[];
  error: string;
  live: boolean;
  onRemove?: (identity: LinkedIdentity) => void;
}) {
  return (
    <div className="sgn-methods">
      <ul aria-label="Sign-in methods">
        <PasswordMethod administered={onRemove !== undefined} />
        {identities?.map((identity) => (
          <LinkedIdentityItem
            key={identity.id}
            identity={identity}
            disabled={!live}
            onRemove={onRemove && (() => onRemove(identity))}
          />
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
      <ErrorAlert error={error} />
    </div>
  );
}

function PasswordMethod({ administered }: { administered: boolean }) {
  return (
    <li>
      <IconTile icon={Password} size="sm" />
      <span className="sgn-method-text">
        <strong>Password</strong>
        <small>
          {administered
            ? "Reset by a system administrator."
            : "Set by a system administrator. Ask one to reset it."}
        </small>
      </span>
    </li>
  );
}

function LinkedIdentityItem({
  identity,
  disabled,
  onRemove,
}: {
  identity: LinkedIdentity;
  disabled: boolean;
  onRemove?: () => void;
}) {
  const label = signInMethodLabels[identity.provider] ?? identity.provider;
  return (
    <li>
      <span className="sgn-method-mark">
        <ProviderMark provider={identity.provider} />
      </span>
      <span className="sgn-method-text">
        <strong>{label}</strong>
        <small>
          {identity.email ?? "Email not shared"} · Linked{" "}
          {formatLinkedDate(identity.linkedAt)}
        </small>
      </span>
      {onRemove && (
        <button
          type="button"
          className="button small sgn-remove"
          disabled={disabled}
          aria-label={`Remove ${label} account ${identity.email ?? ""}`.trim()}
          onClick={onRemove}
        >
          Remove
        </button>
      )}
    </li>
  );
}

function ErrorAlert({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

// The providers' own marks, as their sign-in button guidelines require. Any
// provider other than Google gets the Microsoft mark.
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

function removeSignInParams() {
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
}

function formatLinkedDate(at: number) {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
