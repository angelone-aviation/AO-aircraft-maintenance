/**
 * Responsibility: Required parts on work forms and reports: stock
 *   availability, the Parts requests section, and reading a form's parts.
 * Layer: UI. React components; availability rules live in src/domain.
 * Dependencies: react, src/data/store.ts, src/domain (partsPlanning,
 *   partsRequests, model, requiredParts), ./design, ./PartsRequests (lazy).
 */
import { requestedParts } from "../domain/partsPlanning";
import type { RequestSource } from "../domain/partsRequests";
import { lazy, Suspense } from "react";
import { useWorkspace } from "../data/store";
import { type Discrepancy, type Snapshot } from "../domain/model";
import {
  partsAvailability,
  requiredPartsSchema,
  type RequiredPart,
} from "../domain/requiredParts";
import { StatusPill } from "./design";
// Loaded on demand: the requests workspace pulls in purchase orders, vendors
// and addresses, which the dashboard's parts summary does not need at startup.
const RequestPartsButton = lazy(() =>
  import("./PartsRequests").then((m) => ({ default: m.RequestPartsButton })),
);

type AvailabilityRow = ReturnType<typeof partsAvailability>[number];

/**
 * Reads the parts a form carries in its hidden `requiredParts` field, which
 * {@link RequiredPartsFields} writes.
 *
 * @returns The list, or none when the field is missing.
 * @throws {SyntaxError} When the field is not JSON.
 * @throws {z.ZodError} When the list fails `requiredPartsSchema`.
 */
export function requiredPartsFromForm(data: FormData) {
  return requiredPartsSchema.parse(
    JSON.parse(String(data.get("requiredParts") ?? "[]")),
  );
}

/**
 * Stock availability for required parts: a badge, then per part what is
 * needed, available, short, expired, on order and shipped. Offline it says
 * the stock is cached. Renders nothing without parts.
 *
 * @param props.source - When its parts request has lines, they replace
 *   `parts`.
 */
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
      <StatusPill tone={unknown || short ? "warn" : "good"}>
        {availabilityLabel(unknown, short)}
      </StatusPill>
      {(!online || !connected) && (
        <small className="block">
          Cached stock quantities — reconnect to verify.
        </small>
      )}
      {rows.map((p, i) => (
        <PartLine key={i} s={snapshot} row={p} />
      ))}
    </div>
  );
}

/**
 * The Parts requests section of a work form. It carries `initial` in the
 * hidden `requiredParts` field, offers the source's parts request once the
 * work is saved, and shows availability.
 *
 * @param props.source - The saved work; without it, asks to save first.
 */
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

/** {@link PartsAvailability} for a problem report and its parts request. */
export function DiscrepancyParts({ report }: { report: Discrepancy }) {
  return (
    <PartsAvailability
      parts={report.requiredParts}
      source={{ kind: "discrepancy", uuid: report.uuid, workOrderUuid: "" }}
    />
  );
}

function availabilityLabel(unknown: boolean, short: boolean) {
  if (unknown) return "Parts availability unknown";
  return short ? "Parts shortage" : "Parts available";
}

function PartLine({ s, row: p }: { s: Snapshot; row: AvailabilityRow }) {
  const { onOrder, shipped } = orderProgress(s, p);
  return (
    <small className="block">
      {p.partNumber} · {p.location} · Need {p.quantity} / Available{" "}
      {p.available ?? "unknown"}
      {p.shortage ? ` · Short ${p.shortage}` : ""}
      {p.expired ? ` · Expired ${p.expired}` : ""}
      {` · On order ${onOrder}`}
      {` · Shipped ${shipped}`}
    </small>
  );
}

// A parts-request line carries its own purchasing; any other part counts the
// open purchase-order lines for its stock lot.
function orderProgress(s: Snapshot, p: RequiredPart) {
  const lines = (s.partsOnOrder ?? []).filter(
    (x) => x.stockUuid === p.stockUuid,
  );
  return {
    onOrder: p.onOrder ?? lines.reduce((n, x) => n + x.quantity, 0),
    shipped: p.shipped ?? lines.reduce((n, x) => n + x.shipped, 0),
  };
}
