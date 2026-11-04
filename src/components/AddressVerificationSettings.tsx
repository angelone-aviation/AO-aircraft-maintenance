/**
 * Responsibility: The Address verification panel in Settings → System: the
 *   shared Geoapify API key that address lookups use.
 * Layer: UI. Reads the key's status and saves a new key through the
 *   workspace backend; the saved key never returns to the browser.
 * Dependencies: react, src/data/store.ts (useWorkspace), src/components/ui.tsx.
 */
import { useEffect, useState } from "react";
import { useWorkspace } from "../data/store";
import { AsyncForm, Field } from "./ui";

// The shortest key the server accepts (convex/addressVerification.ts).
const KEY_MIN_LENGTH = 16;

type KeyStatus = { configured: boolean; version: number };

/**
 * The shared Geoapify key panel: whether a key is configured, and a form that
 * has the server validate and save a new one. Saving needs a connection and
 * is unavailable in demo mode.
 *
 * @returns The panel, an h3 under Settings → System's h2; null for anyone but
 *   a system administrator.
 */
export function AddressVerificationSettings() {
  const { snapshot: s, online, connected, demo } = useWorkspace();
  const settings = useKeySettings(s?.user.isAdmin);
  if (!s?.user.isAdmin) return null;
  return (
    <section className="panel">
      <h3>Address verification</h3>
      <GeoapifyIntro />
      <p>
        {settings.status?.configured
          ? "Geoapify key configured."
          : "Add an API key to enable external lookups."}{" "}
        The saved key is stored on the server and is never returned to the
        browser.
      </p>
      <AsyncForm
        submitLabel="Validate and save API key"
        disabled={demo || !online || !connected || !settings.status}
        onSubmit={settings.save}
      >
        <Field label="Geoapify API key">
          <input
            type="password"
            autoComplete="new-password"
            value={settings.key}
            required
            minLength={KEY_MIN_LENGTH}
            onChange={(e) => settings.setKey(e.target.value)}
          />
        </Field>
      </AsyncForm>
      {demo && <p>Configure the key in the connected app, not demo mode.</p>}
      {settings.notice && <p role="status">{settings.notice}</p>}
    </section>
  );
}

function useKeySettings(isAdmin: boolean | undefined) {
  const { backend, connected } = useWorkspace();
  const [status, setStatus] = useState<KeyStatus>();
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    if (isAdmin && backend && connected)
      void backend
        .addressSettings()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          // Without a status the form stays disabled; the notice names the
          // fix whatever the cause.
          if (active)
            setNotice("Could not load address settings. Reconnect and reload.");
        });
    return () => {
      active = false;
    };
  }, [backend, connected, isAdmin]);
  // The server refuses a stale version, so a key saved meanwhile by another
  // administrator is not overwritten unseen.
  async function save() {
    await backend!.setAddressKey({ key, version: status!.version });
    setKey("");
    setStatus(await backend!.addressSettings());
    setNotice("Address lookups enabled. The API key was accepted by Geoapify.");
  }
  return { status, key, setKey, notice, save };
}

function GeoapifyIntro() {
  return (
    <>
      <p>
        Look up U.S. and international addresses with Geoapify. Its free plan
        includes 3,000 credits per day; this app limits lookups to 2,900 per
        day. Results help check the address against mapping data and do not
        certify postal deliverability.
      </p>
      <p>
        <a
          href="https://myprojects.geoapify.com/"
          target="_blank"
          rel="noreferrer"
        >
          Create a free Geoapify account and API key
        </a>{" "}
        ·{" "}
        <a
          href="https://www.geoapify.com/pricing/"
          target="_blank"
          rel="noreferrer"
        >
          Current free-plan terms
        </a>
      </p>
    </>
  );
}
