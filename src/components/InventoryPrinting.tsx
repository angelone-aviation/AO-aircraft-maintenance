/**
 * Responsibility: The print buttons for an inventory item's tag and label,
 *   with the print preview and this browser's print settings.
 * Layer: UI. React components; the print document is built in src/data.
 * Dependencies: react, react-dom, src/data/store.ts,
 *   src/data/inventoryPrintDocument.ts, src/domain/programs.ts,
 *   src/domain/inventoryPrinting.ts, ./ui.tsx.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { recordProgram } from "../domain/programs";
import {
  inventoryItemUrl,
  inventoryPrintBase,
  inventoryTagFields,
  tagFieldLabels,
  type PrintableItem,
  type InventoryPrintKind,
} from "../domain/inventoryPrinting";
import { inventoryPrintDocument } from "../data/inventoryPrintDocument";
import { Field, Modal, errorText, safeHref } from "./ui";
interface Settings {
  base: string;
  labelHeight: number;
  tagHeight: number;
}
function savedSettings(key: string): Settings {
  let base = "";
  try {
    base = inventoryPrintBase(window.location.origin);
  } catch {
    /* A shared address will be supplied before printing. */
  }
  const fallback = { base, labelHeight: 1.25, tagHeight: 4 };
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "{}");
    return {
      base: typeof s.base === "string" ? s.base : base,
      labelHeight:
        typeof s.labelHeight === "number"
          ? s.labelHeight
          : fallback.labelHeight,
      tagHeight:
        typeof s.tagHeight === "number" ? s.tagHeight : fallback.tagHeight,
    };
  } catch {
    return fallback;
  }
}
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
  const { snapshot: s } = useWorkspace();
  const settingsKey = `angel-one-inventory-print:${s!.activeProgramUuid ?? "unassigned"}`;
  const [settings, setSettings] = useState(() => savedSettings(settingsKey));
  const [tag, setTag] = useState(() =>
    item.kind === "component" ? inventoryTagFields(s!, item) : undefined,
  );
  const [document, setDocument] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [fits, setFits] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const height = kind === "tag" ? settings.tagHeight : settings.labelHeight;
  let url = "",
    addressIssue = "";
  if (settings.base.trim()) {
    try {
      url = inventoryItemUrl(settings.base, item, recordProgram(s!, item));
    } catch (e) {
      addressIssue = errorText(e);
    }
  } else
    addressIssue =
      "Enter your shared app address before printing QR codes. You can set this when your website is ready.";
  const identityIssue = !item.partNumber.trim()
    ? "Add a part number to this item before printing."
    : item.kind === "component" && !item.serial.trim()
      ? "Add a serial number to this component before printing."
      : "";
  useEffect(() => {
    let active = true;
    setFits(false);
    setError("");
    setDocument("");
    void inventoryPrintDocument({
      item,
      kind,
      height,
      url: url || undefined,
      tag,
    })
      .then((html) => {
        if (active) setDocument(html);
      })
      .catch((e) => {
        if (active)
          setError(errorText(e, "Unable to generate the print preview."));
      });
    return () => {
      active = false;
    };
  }, [item, kind, height, url, tag]);
  const save = () => {
    try {
      const base = inventoryPrintBase(settings.base);
      localStorage.setItem(settingsKey, JSON.stringify({ ...settings, base }));
      setSaved("Print settings saved on this browser.");
      return true;
    } catch (e) {
      setError(errorText(e, "Unable to save print settings."));
      return false;
    }
  };
  return (
    <Modal
      title={kind === "tag" ? "Print Tag" : "Print Label"}
      onClose={onClose}
    >
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
            value={settings.base}
            placeholder="https://your-app.example"
            onChange={(e) => {
              setSettings({ ...settings, base: e.target.value });
              setSaved("");
            }}
          />
        </Field>
        <Field
          label="Sticker length (inches)"
          hint="Width is fixed at 2 inches for your continuous roll."
        >
          <input
            type="number"
            min={kind === "tag" ? 3.5 : 1}
            max="6"
            step="0.25"
            value={height || ""}
            onChange={(e) => {
              setSettings({
                ...settings,
                [kind === "tag" ? "tagHeight" : "labelHeight"]: Number(
                  e.target.value,
                ),
              });
              setSaved("");
            }}
          />
        </Field>
      </div>
      <button type="button" className="button small" onClick={save}>
        Save print settings
      </button>
      {saved && <p role="status">{saved}</p>}
      {addressIssue && <p className="notice">{addressIssue}</p>}
      {identityIssue && <p className="notice">{identityIssue}</p>}
      {url && (
        <p>
          <a href={safeHref(url)} target="_blank" rel="noreferrer">
            Test inventory link
          </a>
        </p>
      )}
      {kind === "tag" && tag && (
        <details>
          <summary>Tag details</summary>
          <p>
            Review the removal details. Blank condition and signature fields can
            be completed by the person inspecting the part.
          </p>
          <div className="form-grid">
            {Object.entries(tagFieldLabels).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  value={tag[key as keyof typeof tag]}
                  maxLength={key === "reason" ? 500 : 150}
                  onChange={(e) => setTag({ ...tag, [key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        </details>
      )}
      <div style={{ margin: "16px 0", overflowX: "auto" }}>
        {document && (
          <iframe
            ref={frame}
            title="Print preview"
            srcDoc={document}
            sandbox="allow-same-origin allow-modals"
            style={{
              width: "calc(2in + 2px)",
              height: `calc(${height}in + 2px)`,
              background: "white",
              border: "1px solid #aaa",
            }}
            onLoad={() => {
              const root =
                frame.current?.contentDocument?.querySelector(".sheet");
              if (!root) return;
              const box = root.getBoundingClientRect();
              const overflow = Array.from(root.querySelectorAll("*")).some(
                (child) => {
                  const r = child.getBoundingClientRect();
                  return (
                    r.bottom > box.bottom + 1 ||
                    r.right > box.right + 1 ||
                    r.left < box.left - 1 ||
                    r.top < box.top - 1
                  );
                },
              );
              setFits(!overflow);
            }}
          />
        )}
      </div>
      {document && !fits && (
        <p className="notice">
          Content exceeds this sticker size. Increase the length or shorten the
          tag details.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <p className="muted">
        Select your label printer and the matching 2-inch paper width and
        length. Use 100% scale, no margins, and turn off browser headers and
        footers.
      </p>
      <button
        type="button"
        className="button primary"
        disabled={!url || !!identityIssue || !document || !fits || !!error}
        onClick={() => {
          if (!save()) return;
          frame.current?.contentWindow?.focus();
          frame.current?.contentWindow?.print();
        }}
      >
        Print
      </button>
    </Modal>
  );
}
