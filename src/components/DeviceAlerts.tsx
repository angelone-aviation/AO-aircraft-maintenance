/**
 * Responsibility: The Settings block that turns urgent alerts on this device
 *   on or off (Web Push), shown only where the browser and the deployment can
 *   both deliver them.
 * Layer: UI. React component over src/data/pushDevice.ts and the Backend.
 * Dependencies: react, @phosphor-icons/react, src/data (store, pushDevice,
 *   backend types), ./design, ./ui.
 */
import { useEffect, useState } from "react";
import { WifiSlash } from "@phosphor-icons/react";
import type { Backend } from "../data/backend";
import {
  deviceAlertsOn,
  disablePushAlerts,
  enablePushAlerts,
  needsHomeScreenInstall,
  pushSupported,
} from "../data/pushDevice";
import { useWorkspace } from "../data/store";
import { Switch } from "./design";
import { errorText } from "./ui";

/**
 * "Alert this device": a switch that subscribes this browser to urgent
 * alerts. Nothing renders in the demo, in a browser without push, or while
 * the deployment has no push key.
 *
 * @returns The block, or null.
 */
export function DeviceAlertsBlock() {
  const { backend, online, connected, demo } = useWorkspace();
  const live = online && connected;
  const device = usePushDevice(backend, demo);
  if (!device.available) return null;
  return (
    <div className="set-block">
      <h3>Alerts on this device</h3>
      <p className="set-hint">
        Urgent alerts (a grounded aircraft, an overdue inspection or AD, a
        component past its limit, an expired date) open on this device as soon
        as they arise, even while the app is closed. Everything else waits for
        the bell and the daily email.
      </p>
      <Switch
        label="Alert this device"
        checked={device.enabled}
        disabled={!live || device.busy}
        onChange={(next) => void device.toggle(next)}
      />
      {needsHomeScreenInstall() && (
        <p className="set-hint">
          On iPhone and iPad, add Angel One to the Home Screen first (iOS 16.4
          or later); Safari alone cannot receive alerts.
        </p>
      )}
      {!live && (
        <p className="set-hint set-offline">
          <WifiSlash size={16} aria-hidden="true" /> Reconnect to change this.
        </p>
      )}
      {device.error && (
        <p role="alert" className="error">
          {device.error}
        </p>
      )}
    </div>
  );
}

// The deployment's key and whether this account holds this device's
// subscription load once per backend; a reply after the block closes is
// dropped. The demo, and a browser without push, never ask.
function usePushDevice(backend: Backend | null, demo: boolean) {
  const supported = !demo && backend !== null && pushSupported();
  const [key, setKey] = useState<string>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void loadDeviceState(backend).then(
      (state) => {
        if (!active) return;
        setKey(state.publicKey);
        setEnabled(state.enabled);
      },
      // Without the key the switch stays hidden; the bell still works.
      () => active && setKey(""),
    );
    return () => {
      active = false;
    };
  }, [backend, supported]);
  async function toggle(next: boolean) {
    if (!backend || !key) return;
    setBusy(true);
    setError("");
    try {
      if (next) await enablePushAlerts(backend, key);
      else await disablePushAlerts(backend);
      setEnabled(next);
    } catch (e) {
      setError(errorText(e, "Unable to change alerts on this device."));
    } finally {
      setBusy(false);
    }
  }
  return { available: supported && !!key, enabled, busy, error, toggle };
}

async function loadDeviceState(backend: Backend) {
  const publicKey = await backend.pushPublicKey();
  const enabled = !!publicKey && (await deviceAlertsOn(backend, publicKey));
  return { publicKey, enabled };
}
