/**
 * Responsibility: Which optional features this deployment has turned on
 *   (alert email, alerts on devices, error reporting), for the Settings
 *   page.
 * Layer: UI. A React hook over the workspace Backend.
 * Dependencies: react, src/data/store.ts, src/data/backend.ts (types),
 *   src/data/errorReporting.ts.
 *
 * Each feature stays dormant until whoever deploys Angel One sets its keys
 * (README "Settings that live on the deployment"), so Settings says so
 * instead of showing a control that does nothing.
 */
import { useEffect, useState } from "react";
import type { Backend } from "../data/backend";
import { useWorkspace } from "../data/store";
import { errorReportingEnabled } from "../data/errorReporting";

/** What the deployment offers; a field is undefined until it is known. */
export interface DeploymentFeatures {
  email?: boolean;
  devicePush?: boolean;
  errorReporting: boolean;
}

/**
 * Loads the deployment's optional features once per backend. A reply after
 * the page closes is dropped, and a feature whose check fails stays unknown.
 *
 * @returns The features; `errorReporting` is known at once, from the build.
 */
export function useDeploymentFeatures(): DeploymentFeatures {
  const backend = useWorkspace((s) => s.backend);
  const [loaded, setLoaded] = useState<
    Omit<DeploymentFeatures, "errorReporting">
  >({});
  useEffect(() => {
    if (!backend) return;
    let active = true;
    const keep = (patch: Partial<DeploymentFeatures>) => {
      if (active) setLoaded((old) => ({ ...old, ...patch }));
    };
    void loadFeatures(backend, keep);
    return () => {
      active = false;
    };
  }, [backend]);
  return { ...loaded, errorReporting: errorReportingEnabled };
}

// Two independent reads: one that fails leaves only its own feature unknown.
async function loadFeatures(
  backend: Backend,
  keep: (patch: Partial<DeploymentFeatures>) => void,
) {
  await Promise.allSettled([
    backend.alertEmailEnabled().then((email) => keep({ email })),
    backend.pushPublicKey().then((key) => keep({ devicePush: key !== "" })),
  ]);
}
