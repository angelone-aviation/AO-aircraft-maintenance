import { useEffect, useState } from "react";
import { useWorkspace } from "../data/store";
import { AsyncForm, Field } from "./ui";
/** The shared Geoapify key, shown in Settings → System (h3 under that
 * section's h2); renders nothing for anyone but system administrators. */
export function AddressVerificationSettings() {
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const [status, setStatus] = useState<{
    configured: boolean;
    version: number;
  }>();
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    if (s?.user.isAdmin && backend && connected)
      void backend
        .addressSettings()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active)
            setNotice("Could not load address settings. Reconnect and reload.");
        });
    return () => {
      active = false;
    };
  }, [backend, connected, s?.user.isAdmin]);
  if (!s?.user.isAdmin) return null;
  return (
    <section className="panel">
      <h3>Address verification</h3>
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
      <p>
        {status?.configured
          ? "Geoapify key configured."
          : "Add an API key to enable external lookups."}{" "}
        The saved key is stored on the server and is never returned to the
        browser.
      </p>
      <AsyncForm
        submitLabel="Validate and save API key"
        disabled={demo || !online || !connected || !status}
        onSubmit={async () => {
          await backend!.setAddressKey({ key, version: status!.version });
          setKey("");
          setStatus(await backend!.addressSettings());
          setNotice(
            "Address lookups enabled. The API key was accepted by Geoapify.",
          );
        }}
      >
        <Field label="Geoapify API key">
          <input
            type="password"
            autoComplete="new-password"
            value={key}
            required
            minLength={16}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      </AsyncForm>
      {demo && <p>Configure the key in the connected app, not demo mode.</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
