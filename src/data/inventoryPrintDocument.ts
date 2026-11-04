/**
 * Responsibility: Builds the printable HTML for an inventory label or a
 *   component removal tag, sized for a 2-inch-wide label printer.
 * Layer: Data. Browser-side HTML rendering; no React.
 * Dependencies: qrcode (loaded on demand), src/domain/inventoryPrinting.ts.
 *
 * A printed tag identifies a removed part; it is not a certification, so its
 * signature line is left blank.
 */
import type {
  PrintableItem,
  InventoryPrintKind,
  TagFields,
} from "../domain/inventoryPrinting";

const TAG_MIN_INCHES = 3.5;
const LABEL_MIN_INCHES = 1;
const MAX_INCHES = 6;
const QR_INCHES = 0.95;
// The sheet's top and bottom padding (.06in each), which a label's QR must
// fit inside.
const SHEET_PADDING_INCHES = 0.12;

/**
 * Escapes text for use in HTML content and attribute values.
 *
 * @param text - Untrusted text.
 * @returns The text with `& < > " '` replaced by entities.
 */
export const htmlEscape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** What to print: the item, label or tag, its length and QR target. */
export interface InventoryPrintDocument {
  item: PrintableItem;
  kind: InventoryPrintKind;
  /** Length in inches: 1–6 for a label, 3.5–6 for a tag. */
  height: number;
  /** The QR code's target; without it a placeholder asks for the address. */
  url?: string;
  /** The tag's fields; required for a tag. */
  tag?: TagFields;
}

/**
 * Renders a complete HTML page for one label or tag, with an @page size of
 * 2in by `height`. A label shows the part number (and serial for a
 * component) beside the QR code; a tag lists the removal fields. All text is
 * escaped.
 *
 * @param document - What to print.
 * @returns The HTML document.
 * @throws {Error} "Choose a tag length between 3.5 and 6 inches." or "Choose
 *   a label length between 1 and 6 inches." for a length out of range;
 *   "Tags are available only for tracked components." for a tag on stock or
 *   without tag fields.
 */
export async function inventoryPrintDocument({
  item,
  kind,
  height,
  url,
  tag,
}: InventoryPrintDocument) {
  assertPrintable(item, kind, height, tag);
  const qr = url
    ? await renderQrSvg(url)
    : '<div class="qr-placeholder">Set QR website address</div>';
  const e = htmlEscape;
  const body =
    kind === "tag" && tag
      ? tagHtml(item, tag, qr)
      : `${identityHtml(item)}<div class="qr">${qr}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(kind === "tag" ? "Component tag" : "Inventory label")} — ${e(item.partNumber)}</title><style>
  ${printStyles(height)}
  </style></head><body><main class="sheet ${kind}">${body}</main></body></html>`;
}

function assertPrintable(
  item: PrintableItem,
  kind: InventoryPrintKind,
  height: number,
  tag?: TagFields,
): void {
  const min = kind === "tag" ? TAG_MIN_INCHES : LABEL_MIN_INCHES;
  if (!Number.isFinite(height) || height < min || height > MAX_INCHES)
    throw new Error(
      kind === "tag"
        ? "Choose a tag length between 3.5 and 6 inches."
        : "Choose a label length between 1 and 6 inches.",
    );
  if (kind === "tag" && (item.kind !== "component" || !tag))
    throw new Error("Tags are available only for tracked components.");
}

// Loaded on demand so the QR encoder stays out of the startup bundle.
async function renderQrSvg(url: string): Promise<string> {
  const { default: qrcode } = await import("qrcode");
  return qrcode.toString(url, {
    type: "svg",
    margin: 4,
    errorCorrectionLevel: "M",
  });
}

function identityHtml(item: PrintableItem): string {
  const e = htmlEscape;
  const serial =
    item.kind === "component"
      ? `<small>SERIAL NO.</small><strong>${e(item.serial || "Not recorded")}</strong>`
      : "";
  return `<div class="identity"><small>PART NO.</small><strong>${e(item.partNumber || "Not recorded")}</strong>${serial}</div>`;
}

function fieldHtml(label: string, text: string): string {
  return `<div class="field"><b>${label}:</b> <span>${htmlEscape(text) || "&nbsp;"}</span></div>`;
}

function tagHtml(item: PrintableItem, tag: TagFields, qr: string): string {
  const e = htmlEscape;
  const fields: [string, string][] = [
    ["Part No.", item.partNumber],
    ["Description", tag.description],
    ["Manufacturer", tag.manufacturer],
    ["Serial No.", item.kind === "component" ? item.serial : ""],
    ["Reference / PO", tag.reference],
    ["Last operator", tag.lastOperator],
    ["NHA", tag.nha],
    ["NHA serial", tag.nhaSerial],
    ["Position", tag.position],
    ["Removal date", tag.removalDate],
    ["Reason", tag.reason],
    ["Condition", tag.condition],
    ["Removed by", tag.removedBy],
    ["Mechanic / A&P", tag.mechanic],
    ["Signature", ""],
  ];
  const rows = fields.map(([label, text]) => fieldHtml(label, text)).join("");
  return `<header><strong>${e(tag.company) || "AIRCRAFT COMPONENT"}</strong><h1>PARTS REMOVAL<br>IDENTIFICATION TAG</h1></header>${rows}<footer><div class="qr">${qr}</div><div><b>Tag No.</b><div>${e(tag.tagNumber) || "____________"}</div><small>Scan for inventory record</small></div></footer>`;
}

function printStyles(height: number): string {
  const labelQr = Math.min(QR_INCHES, height - SHEET_PADDING_INCHES);
  return `@page {size:2in ${height}in;margin:0} *{box-sizing:border-box} html,body{margin:0;padding:0;background:white;color:black;font-family:Arial,sans-serif} .sheet{width:2in;height:${height}in;padding:.06in;break-after:avoid;overflow:visible} .label{display:flex;align-items:center;gap:.04in}.identity{flex:1;min-width:0;overflow-wrap:anywhere}.identity small{display:block;font-size:6.5pt;margin-top:4px}.identity strong{display:block;font-size:10pt;line-height:1.12}.qr{width:.95in;height:.95in;flex:0 0 .95in}.label .qr{width:${labelQr}in;height:${labelQr}in;flex-basis:${labelQr}in}.qr svg{display:block;width:100%;height:100%;shape-rendering:crispEdges}.qr-placeholder{border:1px dashed #555;height:100%;display:flex;align-items:center;text-align:center;font-size:9px;padding:8px}.tag{font-size:7pt;line-height:1.12}.tag header{text-align:center;margin-bottom:.045in}.tag header strong{font-size:8pt;overflow-wrap:anywhere}.tag h1{font-size:8pt;margin:.035in 0}.field{display:flex;gap:3px;align-items:baseline;min-height:.155in;border-bottom:.5px solid black;padding:2px 0;overflow-wrap:anywhere}.field b{flex-shrink:0;font-size:6.5pt}.field span{min-width:0;flex:1}.tag footer{display:flex;align-items:center;gap:.025in;margin-top:.035in}.tag footer>div:last-child{min-width:0;overflow-wrap:anywhere;flex:1}.tag footer small{display:block;font-size:6.5pt;margin-top:5px}`;
}
