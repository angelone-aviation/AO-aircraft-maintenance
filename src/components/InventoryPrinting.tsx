/**
 * Responsibility: The print buttons for an inventory item's tag and label,
 *   with the print preview and this browser's print settings.
 * Layer: UI. React components; the print document is built in src/data.
 * Dependencies: react-dom, src/data/store.ts, src/data/historyPages.ts,
 *   src/data/inventoryPrintDocument.ts, src/domain/programs.ts,
 *   src/domain/inventoryPrinting.ts, ./ui.tsx.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { useWorkOrderHistory } from "../data/historyPages";
import { recordProgram } from "../domain/programs";
import {
  inventoryItemUrl,
  inventoryPrintBase,
  inventoryTagFields,
  tagFieldLabels,
  tagWorkOrderUuid,
  type PrintableItem,
  type InventoryPrintKind,
  type TagFields,
} from "../domain/inventoryPrinting";
import type { Snapshot } from "../domain/model";
import { inventoryPrintDocument } from "../data/inventoryPrintDocument";
import { Field, Modal, errorText, safeHref } from "./ui";

// Sticker lengths in inches, on a continuous roll 2 inches wide.
const DEFAULT_LABEL_LENGTH = 1.25;
const DEFAULT_TAG_LENGTH = 4;
const MIN_LABEL_LENGTH = 1;
const MIN_TAG_LENGTH = 3.5;
const MAX_STICKER_LENGTH = 6;
const STICKER_LENGTH_STEP = 0.25;
const TAG_REASON_MAX_LENGTH = 500;
const TAG_FIELD_MAX_LENGTH = 150;
// Layout rounding can put an edge a pixel past the sheet; that still fits.
const FIT_TOLERANCE_PX = 1;
const OLDER_ORDER_OFFLINE =
  "It was removed under a work order older than this device keeps. Reconnect to fill in its number, or enter it.";

interface Settings {
  base: string;
  labelHeight: number;
  tagHeight: number;
}
type PrintJob = ReturnType<typeof usePrintJob>;
type PrintPreview = ReturnType<typeof usePrintPreview>;

/**
 * Print Tag (components only) and Print Label buttons for an inventory item.
 * Each opens a print dialog with a preview, the QR address and sticker length
 * this browser keeps per Flight Program, and for a tag its removal details.
 * Printing is blocked until the item has a part number (and a component a
 * serial number), the address is usable and the content fits the sticker.
 */
export function InventoryPrintButtons({ item }: { item: PrintableItem }) {
  const [kind, setKind] = useState<InventoryPrintKind>();
  return (
    <>
      {item.kind === "component" && (
        <button
          type="button"
          className="button small"
          onClick={() => setKind("tag")}
        >
          Print Tag
        </button>
      )}{" "}
      <button
        type="button"
        className="button small"
        onClick={() => setKind("label")}
      >
        Print Label
      </button>
      {kind &&
        createPortal(
          <PrintInventory
            item={item}
            kind={kind}
            onClose={() => setKind(undefined)}
          />,
          document.body,
        )}
    </>
  );
}

function PrintInventory({
  item,
  kind,
  onClose,
}: {
  item: PrintableItem;
  kind: InventoryPrintKind;
  onClose: () => void;
}) {
  const job = usePrintJob(item, kind);
  const { preview } = job;
  return (
    <Modal
      title={kind === "tag" ? "Print Tag" : "Print Label"}
      onClose={onClose}
    >
      <PrintSettingsFields kind={kind} job={job} />
      <PrintChecks job={job} />
      {kind === "tag" && job.tag && (
        <>
          {job.referenceNote && <p className="muted">{job.referenceNote}</p>}
          <TagDetails tag={job.tag} onChange={job.setTag} />
        </>
      )}
      <PreviewFrame preview={preview} height={job.height} />
      <p className="muted">
        Select your label printer and the matching 2-inch paper width and
        length. Use 100% scale, no margins, and turn off browser headers and
        footers.
      </p>
      <button
        type="button"
        className="button primary"
        disabled={!job.ready}
        onClick={job.print}
      >
        Print
      </button>
    </Modal>
  );
}

function usePrintJob(item: PrintableItem, kind: InventoryPrintKind) {
  const { snapshot } = useWorkspace();
  const s = snapshot!;
  const key = `angel-one-inventory-print:${s.activeProgramUuid ?? "unassigned"}`;
  const [settings, setSettings] = useState(() => savedSettings(key));
  const [edited, setTag] = useState(() =>
    item.kind === "component" ? inventoryTagFields(s, item) : undefined,
  );
  const older = useOlderReference(s, item);
  // A still blank Reference shows the older order's number once it loads;
  // one object per change, since the preview rebuilds when it changes.
  const tag = useMemo(
    () =>
      edited && !edited.reference && older.number
        ? { ...edited, reference: older.number }
        : edited,
    [edited, older.number],
  );
  const [saved, setSaved] = useState("");
  const height = kind === "tag" ? settings.tagHeight : settings.labelHeight;
  const { url, addressIssue } = qrAddress(s, item, settings.base);
  const preview = usePrintPreview(item, kind, height, url, tag);
  const identityIssue = findIdentityIssue(item);
  const save = () => saveSettings(key, settings, setSaved, preview.setError);
  const { html, fits, error, frame } = preview;
  return {
    settings,
    tag,
    setTag,
    referenceNote: older.note,
    saved,
    height,
    url,
    addressIssue,
    preview,
    identityIssue,
    save,
    ready: !!url && !identityIssue && !!html && fits && !error,
    change: (patch: Partial<Settings>) => {
      setSettings({ ...settings, ...patch });
      setSaved("");
    },
    print: () => {
      if (!save()) return;
      frame.current?.contentWindow?.focus();
      frame.current?.contentWindow?.print();
    },
  };
}

// A removal under a work order the workspace's window has left out names it
// only by uuid: its number loads on demand.
function useOlderReference(s: Snapshot, item: PrintableItem) {
  const uuid = item.kind === "component" ? tagWorkOrderUuid(s, item) : "";
  const held = !uuid || s.workOrders?.some((w) => w.uuid === uuid);
  const older = useWorkOrderHistory(held ? undefined : uuid);
  const number = older.history?.workOrder.number;
  const note = !held && !number && older.offline ? OLDER_ORDER_OFFLINE : "";
  return { number, note };
}

function usePrintPreview(
  item: PrintableItem,
  kind: InventoryPrintKind,
  height: number,
  url: string,
  tag: TagFields | undefined,
) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [fits, setFits] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    // A document that finishes after the inputs changed again is dropped.
    let active = true;
    setFits(false);
    setError("");
    setHtml("");
    void inventoryPrintDocument({
      item,
      kind,
      height,
      url: url || undefined,
      tag,
    })
      .then((document) => {
        if (active) setHtml(document);
      })
      .catch((e) => {
        if (active)
          setError(errorText(e, "Unable to generate the print preview."));
      });
    return () => {
      active = false;
    };
  }, [item, kind, height, url, tag]);
  const measure = () => setFits((old) => contentFits(frame.current) ?? old);
  return { frame, html, error, setError, fits, measure };
}

function savedSettings(key: string): Settings {
  let base = "";
  try {
    base = inventoryPrintBase(window.location.origin);
  } catch {
    // This origin cannot open from a phone (localhost); the user enters a
    // shared address before printing.
  }
  const fallback = {
    base,
    labelHeight: DEFAULT_LABEL_LENGTH,
    tagHeight: DEFAULT_TAG_LENGTH,
  };
  try {
    return readSettings(
      JSON.parse(localStorage.getItem(key) ?? "{}"),
      fallback,
    );
  } catch {
    // Storage can be blocked or hold malformed JSON; the defaults apply.
    return fallback;
  }
}

function readSettings(stored: Partial<Settings>, fallback: Settings): Settings {
  return {
    base: typeof stored.base === "string" ? stored.base : fallback.base,
    labelHeight:
      typeof stored.labelHeight === "number"
        ? stored.labelHeight
        : fallback.labelHeight,
    tagHeight:
      typeof stored.tagHeight === "number"
        ? stored.tagHeight
        : fallback.tagHeight,
  };
}

// Keeps the settings in this browser with the address in canonical form.
// False, with the refusal shown, when the address or storage is refused.
function saveSettings(
  key: string,
  settings: Settings,
  onSaved: (message: string) => void,
  onError: (message: string) => void,
) {
  try {
    const base = inventoryPrintBase(settings.base);
    localStorage.setItem(key, JSON.stringify({ ...settings, base }));
    onSaved("Print settings saved on this browser.");
    return true;
  } catch (e) {
    onError(errorText(e, "Unable to save print settings."));
    return false;
  }
}

function qrAddress(s: Snapshot, item: PrintableItem, base: string) {
  if (!base.trim())
    return {
      url: "",
      addressIssue:
        "Enter your shared app address before printing QR codes. You can set this when your website is ready.",
    };
  try {
    const url = inventoryItemUrl(base, item, recordProgram(s, item));
    return { url, addressIssue: "" };
  } catch (e) {
    // inventoryItemUrl refuses an address a phone could not open.
    return { url: "", addressIssue: errorText(e) };
  }
}

function findIdentityIssue(item: PrintableItem) {
  if (!item.partNumber.trim())
    return "Add a part number to this item before printing.";
  if (item.kind === "component" && !item.serial.trim())
    return "Add a serial number to this component before printing.";
  return "";
}

// Undefined until the preview's sheet has loaded.
function contentFits(frame: HTMLIFrameElement | null) {
  const root = frame?.contentDocument?.querySelector(".sheet");
  if (!root) return undefined;
  const box = root.getBoundingClientRect();
  return !Array.from(root.querySelectorAll("*")).some((child) => {
    const r = child.getBoundingClientRect();
    return (
      r.bottom > box.bottom + FIT_TOLERANCE_PX ||
      r.right > box.right + FIT_TOLERANCE_PX ||
      r.left < box.left - FIT_TOLERANCE_PX ||
      r.top < box.top - FIT_TOLERANCE_PX
    );
  });
}

function PrintSettingsFields({
  kind,
  job,
}: {
  kind: InventoryPrintKind;
  job: PrintJob;
}) {
  return (
    <>
      <p>
        {kind === "tag"
          ? "A detailed 2-inch-wide parts identification sticker for your component hang tag."
          : "A 2-inch-wide sticker with part number, QR code and serial number for tracked components."}
      </p>
      <div className="form-grid">
        <Field
          label="QR website address"
          hint="Use the shared app address that your phone will open. Sign-in is still required."
        >
          <input
            type="url"
            value={job.settings.base}
            placeholder="https://your-app.example"
            onChange={(e) => job.change({ base: e.target.value })}
          />
        </Field>
        <StickerLengthField kind={kind} job={job} />
      </div>
      <button type="button" className="button small" onClick={job.save}>
        Save print settings
      </button>
      {job.saved && <p role="status">{job.saved}</p>}
    </>
  );
}

function PrintChecks({ job }: { job: PrintJob }) {
  return (
    <>
      {job.addressIssue && <p className="notice">{job.addressIssue}</p>}
      {job.identityIssue && <p className="notice">{job.identityIssue}</p>}
      {job.url && (
        <p>
          <a href={safeHref(job.url)} target="_blank" rel="noreferrer">
            Test inventory link
          </a>
        </p>
      )}
    </>
  );
}

function StickerLengthField({
  kind,
  job,
}: {
  kind: InventoryPrintKind;
  job: PrintJob;
}) {
  return (
    <Field
      label="Sticker length (inches)"
      hint="Width is fixed at 2 inches for your continuous roll."
    >
      <input
        type="number"
        min={kind === "tag" ? MIN_TAG_LENGTH : MIN_LABEL_LENGTH}
        max={MAX_STICKER_LENGTH}
        step={STICKER_LENGTH_STEP}
        value={job.height || ""}
        onChange={(e) =>
          job.change({
            [kind === "tag" ? "tagHeight" : "labelHeight"]: Number(
              e.target.value,
            ),
          })
        }
      />
    </Field>
  );
}

function TagDetails({
  tag,
  onChange,
}: {
  tag: TagFields;
  onChange: (tag: TagFields) => void;
}) {
  return (
    <details>
      <summary>Tag details</summary>
      <p>
        Review the removal details. Blank condition and signature fields can be
        completed by the person inspecting the part.
      </p>
      <div className="form-grid">
        {Object.entries(tagFieldLabels).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              value={tag[key as keyof TagFields]}
              maxLength={
                key === "reason" ? TAG_REASON_MAX_LENGTH : TAG_FIELD_MAX_LENGTH
              }
              onChange={(e) => onChange({ ...tag, [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
    </details>
  );
}

function PreviewFrame({
  preview,
  height,
}: {
  preview: PrintPreview;
  height: number;
}) {
  const { frame, html, fits, error, measure } = preview;
  return (
    <>
      <div style={{ margin: "16px 0", overflowX: "auto" }}>
        {html && (
          <iframe
            ref={frame}
            title="Print preview"
            srcDoc={html}
            sandbox="allow-same-origin allow-modals"
            style={{
              width: "calc(2in + 2px)",
              height: `calc(${height}in + 2px)`,
              background: "white",
              border: "1px solid #aaa",
            }}
            onLoad={measure}
          />
        )}
      </div>
      {html && !fits && (
        <p className="notice">
          Content exceeds this sticker size. Increase the length or shorten the
          tag details.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
