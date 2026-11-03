import type {
  PrintableItem,
  InventoryPrintKind,
  TagFields,
} from "../domain/inventoryPrinting";
export const htmlEscape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export interface InventoryPrintDocument {
  item: PrintableItem;
  kind: InventoryPrintKind;
  height: number;
  url?: string;
  tag?: TagFields;
}
export async function inventoryPrintDocument({
  item,
  kind,
  height,
  url,
  tag,
}: InventoryPrintDocument) {
  if (
    !Number.isFinite(height) ||
    height < (kind === "tag" ? 3.5 : 1) ||
    height > 6
  )
    throw new Error(
      kind === "tag"
        ? "Choose a tag length between 3.5 and 6 inches."
        : "Choose a label length between 1 and 6 inches.",
    );
  if (kind === "tag" && (item.kind !== "component" || !tag))
    throw new Error("Tags are available only for tracked components.");
  // Loaded on demand so the QR encoder stays out of the startup bundle.
  const qr = url
    ? await (
        await import("qrcode")
      ).default.toString(url, {
        type: "svg",
        margin: 4,
        errorCorrectionLevel: "M",
      })
    : '<div class="qr-placeholder">Set QR website address</div>';
  const e = htmlEscape;
  const part = `<div class="identity"><small>PART NO.</small><strong>${e(item.partNumber || "Not recorded")}</strong>${item.kind === "component" ? `<small>SERIAL NO.</small><strong>${e(item.serial || "Not recorded")}</strong>` : ""}</div>`;
  const row = (label: string, text: string) =>
    `<div class="field"><b>${label}:</b> <span>${e(text) || "&nbsp;"}</span></div>`;
  const tagBody =
    kind === "tag" && tag
      ? `<header><strong>${e(tag.company) || "AIRCRAFT COMPONENT"}</strong><h1>PARTS REMOVAL<br>IDENTIFICATION TAG</h1></header>${row("Part No.", item.partNumber)}${row("Description", tag.description)}${row("Manufacturer", tag.manufacturer)}${row("Serial No.", item.kind === "component" ? item.serial : "")}${row("Reference / PO", tag.reference)}${row("Last operator", tag.lastOperator)}${row("NHA", tag.nha)}${row("NHA serial", tag.nhaSerial)}${row("Position", tag.position)}${row("Removal date", tag.removalDate)}${row("Reason", tag.reason)}${row("Condition", tag.condition)}${row("Removed by", tag.removedBy)}${row("Mechanic / A&P", tag.mechanic)}${row("Signature", "")}<footer><div class="qr">${qr}</div><div><b>Tag No.</b><div>${e(tag.tagNumber) || "____________"}</div><small>Scan for inventory record</small></div></footer>`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(kind === "tag" ? "Component tag" : "Inventory label")} — ${e(item.partNumber)}</title><style>
  @page {size:2in ${height}in;margin:0} *{box-sizing:border-box} html,body{margin:0;padding:0;background:white;color:black;font-family:Arial,sans-serif} .sheet{width:2in;height:${height}in;padding:.06in;break-after:avoid;overflow:visible} .label{display:flex;align-items:center;gap:.04in}.identity{flex:1;min-width:0;overflow-wrap:anywhere}.identity small{display:block;font-size:6.5pt;margin-top:4px}.identity strong{display:block;font-size:10pt;line-height:1.12}.qr{width:.95in;height:.95in;flex:0 0 .95in}.label .qr{width:${Math.min(0.95, height - 0.12)}in;height:${Math.min(0.95, height - 0.12)}in;flex-basis:${Math.min(0.95, height - 0.12)}in}.qr svg{display:block;width:100%;height:100%;shape-rendering:crispEdges}.qr-placeholder{border:1px dashed #555;height:100%;display:flex;align-items:center;text-align:center;font-size:9px;padding:8px}.tag{font-size:7pt;line-height:1.12}.tag header{text-align:center;margin-bottom:.045in}.tag header strong{font-size:8pt;overflow-wrap:anywhere}.tag h1{font-size:8pt;margin:.035in 0}.field{display:flex;gap:3px;align-items:baseline;min-height:.155in;border-bottom:.5px solid black;padding:2px 0;overflow-wrap:anywhere}.field b{flex-shrink:0;font-size:6.5pt}.field span{min-width:0;flex:1}.tag footer{display:flex;align-items:center;gap:.025in;margin-top:.035in}.tag footer>div:last-child{min-width:0;overflow-wrap:anywhere;flex:1}.tag footer small{display:block;font-size:6.5pt;margin-top:5px}
  </style></head><body><main class="sheet ${kind}">${kind === "tag" ? tagBody : `${part}<div class="qr">${qr}</div>`}</main></body></html>`;
}
