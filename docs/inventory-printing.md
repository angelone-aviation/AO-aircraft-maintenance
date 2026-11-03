# Inventory tags and labels

**Print Label** appears on inventory rows and saved item details. **Print Tag** appears for tracked aircraft components only, including component details while installed.

Both outputs use a **2-inch-wide continuous sticker roll**. Print Label defaults to 1.25 inches long and includes only the part number, QR code, and serial number for tracked components. Print Tag defaults to 4 inches long and uses a parts-removal identification layout with company/program, part and serial numbers, description, manufacturer, removal details, condition, mechanic and signature fields, tag number, and QR code. It is a sticker to attach to a generic hang tag.

The reference blank hang tags are 2⅜ × 4¾ inches: [blank tags](https://www.amazon.com/dp/B09X214TSM). The detailed tag layout follows the fields in the [parts-removal tag example](https://www.stlouistag.com/faa-inspection-tags.html). No serviceability status or signature is filled in automatically. Review **Tag details** before printing; edits there affect the printout, not the component’s saved maintenance record.

## QR website address

Enter the shared application base address, such as your eventual hosted site address or a reachable network address, in **QR website address**. Use **Save print settings** to remember the address and lengths in this browser for the active Flight Program. Until a shared address is supplied, the preview shows a placeholder and printing is disabled. localhost addresses cannot be used because a phone would interpret them as the phone itself.

The QR code links to `/inventory?item=<record ID>&program=<program ID>`. It identifies the individual inventory record/stock lot, not merely a matching part number. Components keep the same link after installation or removal. Sign-in and existing inventory permissions still apply. When an item belongs to another accessible Flight Program, the page offers to switch programs. Missing or inaccessible records show an explanatory message.

Use **Test inventory link** before printing a batch. QR codes are generated in the app; inventory data is not sent to an external QR service. Choosing a stable address matters: stickers printed with an old address require that address to keep working or redirecting.

## Printer setup

Set **Sticker length (inches)** to your desired cut length. If long data exceeds the selected size, printing is disabled until you increase the length or shorten the tag details. The width stays at 2 inches.

Select your label printer in the browser print dialog, use the matching 2-inch paper width and chosen length, set scale to **100%**, choose **no margins**, and turn off browser headers and footers. The output contains only the sticker, not the surrounding application. Print and scan one sample on your actual printer before printing a batch.
