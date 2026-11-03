import { requestedParts } from "../domain/partsPlanning";
import type { RequestSource } from "../domain/partsRequests";
import { lazy, Suspense } from "react";
import { useWorkspace } from "../data/store";
import { type Discrepancy } from "../domain/model";
import {
  partsAvailability,
  requiredPartsSchema,
  type RequiredPart,
} from "../domain/requiredParts";
import { Badge } from "./ui";
// Loaded on demand: the requests workspace pulls in purchase orders, vendors
// and addresses, which the dashboard's parts summary does not need at startup.
const RequestPartsButton = lazy(() =>
  import("./PartsRequests").then((m) => ({ default: m.RequestPartsButton })),
);

export function requiredPartsFromForm(data: FormData) {
  return requiredPartsSchema.parse(
    JSON.parse(String(data.get("requiredParts") ?? "[]")),
  );
}
export function PartsAvailability({
  parts = [],
  source,
}: {
  parts?: RequiredPart[];
  source?: RequestSource;
}) {
  const { snapshot, online, connected } = useWorkspace();
  if (!snapshot) return null;
  if (source) parts = requestedParts(snapshot, source) ?? parts;
  if (!parts.length) return null;
  const rows = partsAvailability(snapshot, parts);
  const unknown = rows.some((p) => p.available === undefined);
  const short = rows.some((p) => (p.shortage ?? 0) > 0);
  return (
    <div className="parts-availability">
      <Badge tone={unknown || short ? "warning" : "good"}>
        {unknown
          ? "Parts availability unknown"
          : short
            ? "Parts shortage"
            : "Parts available"}
      </Badge>
      {(!online || !connected) && (
        <small className="block">
          Cached stock quantities — reconnect to verify.
        </small>
      )}
      {rows.map((p, i) => (
        <small className="block" key={i}>
          {p.partNumber} · {p.location} · Need {p.quantity} / Available{" "}
          {p.available ?? "unknown"}
          {p.shortage ? ` · Short ${p.shortage}` : ""}
          {p.expired ? ` · Expired ${p.expired}` : ""}
          {` · On order ${p.onOrder ?? (snapshot.partsOnOrder ?? []).filter((x) => x.stockUuid === parts[i].stockUuid).reduce((n, x) => n + x.quantity, 0)}`}
          {` · Shipped ${p.shipped ?? (snapshot.partsOnOrder ?? []).filter((x) => x.stockUuid === parts[i].stockUuid).reduce((n, x) => n + x.shipped, 0)}`}
        </small>
      ))}
    </div>
  );
}
export function RequiredPartsFields({
  initial = [],
  source,
}: {
  initial?: RequiredPart[];
  source?: RequestSource;
}) {
  return (
    <section aria-label="Parts requests">
      <h3>Parts requests</h3>
      <input
        type="hidden"
        name="requiredParts"
        value={JSON.stringify(initial)}
      />
      <p className="muted">
        Manage parts, check inventory and order shortages through Parts / repair
        requests.{" "}
        {initial.length > 0 && "Your saved parts list prefills a new request."}
      </p>
      {source ? (
        <Suspense fallback={null}>
          <RequestPartsButton source={source} />
        </Suspense>
      ) : (
        <p>Save this work first, then add its parts request.</p>
      )}
      <PartsAvailability parts={initial} source={source} />
    </section>
  );
}
export function DiscrepancyParts({ report }: { report: Discrepancy }) {
  return (
    <PartsAvailability
      parts={report.requiredParts}
      source={{ kind: "discrepancy", uuid: report.uuid, workOrderUuid: "" }}
    />
  );
}
