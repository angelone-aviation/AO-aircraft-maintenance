import sharp from "sharp";
import { readFile } from "node:fs/promises";
const svg = await readFile(new URL("../public/icon.svg", import.meta.url));
for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
])
  await sharp(svg)
    .resize(size, size)
    .png()
    .toFile(new URL("../public/" + name, import.meta.url).pathname);
await sharp({
  create: { width: 512, height: 512, channels: 4, background: "#163c35" },
})
  .composite([
    { input: await sharp(svg).resize(350, 350).toBuffer(), gravity: "center" },
  ])
  .png()
  .toFile(new URL("../public/icon-maskable.png", import.meta.url).pathname);
