/**
 * Responsibility: Regenerates the PNG app icons in public/ from
 *   public/icon.svg.
 * Layer: Script. Run by hand after icon.svg changes; overwrites the PNGs.
 * Dependencies: sharp, public/icon.svg.
 */
import sharp from "sharp";
import { readFile } from "node:fs/promises";

// The web app manifest's sizes (vite.config.ts) and Apple's touch icon size.
const SQUARE_ICONS = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
];
// Launchers crop a maskable icon to their own shape, so the artwork is shrunk
// onto a square of icon.svg's own green to keep it clear of the edges.
const MASKABLE_ICON_SIZE = 512;
const MASKABLE_ARTWORK_SIZE = 350;
const MASKABLE_BACKGROUND = "#163c35";

const svg = await readFile(publicFile("icon.svg"));
for (const [name, size] of SQUARE_ICONS)
  await sharp(svg).resize(size, size).png().toFile(publicFile(name).pathname);
await sharp({
  create: {
    width: MASKABLE_ICON_SIZE,
    height: MASKABLE_ICON_SIZE,
    channels: 4,
    background: MASKABLE_BACKGROUND,
  },
})
  .composite([
    {
      input: await sharp(svg)
        .resize(MASKABLE_ARTWORK_SIZE, MASKABLE_ARTWORK_SIZE)
        .toBuffer(),
      gravity: "center",
    },
  ])
  .png()
  .toFile(publicFile("icon-maskable.png").pathname);

function publicFile(name) {
  return new URL("../public/" + name, import.meta.url);
}
