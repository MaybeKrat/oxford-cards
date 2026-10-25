import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectDirectory, "public", "favicon.svg");
const iconDirectory = path.join(projectDirectory, "desktop", "resources");
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const svg = await readFile(sourcePath, "utf8");

function renderPng(size) {
  const image = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  }).render();

  if (image.width !== size || image.height !== size) {
    throw new Error("The application icon SVG must have a square canvas.");
  }

  return image.asPng();
}

// Render every frame directly from the SVG to preserve detail at small sizes.
const frames = iconSizes.map((size) => ({ size, data: renderPng(size) }));
const preview = renderPng(512);
const directory = Buffer.alloc(6 + 16 * frames.length);
directory.writeUInt16LE(1, 2); // ICO image type.
directory.writeUInt16LE(frames.length, 4);

let dataOffset = directory.length;
for (const [index, frame] of frames.entries()) {
  const entryOffset = 6 + index * 16;
  const dimension = frame.size === 256 ? 0 : frame.size;
  directory.writeUInt8(dimension, entryOffset);
  directory.writeUInt8(dimension, entryOffset + 1);
  directory.writeUInt16LE(1, entryOffset + 4); // Color planes.
  directory.writeUInt16LE(32, entryOffset + 6); // RGBA color depth.
  directory.writeUInt32LE(frame.data.length, entryOffset + 8);
  directory.writeUInt32LE(dataOffset, entryOffset + 12);
  dataOffset += frame.data.length;
}

// Modern Windows accepts complete PNG images as ICO frames.
const icon = Buffer.concat([directory, ...frames.map((frame) => frame.data)]);
await mkdir(iconDirectory, { recursive: true });
await writeFile(path.join(iconDirectory, "icon.png"), preview);
await writeFile(path.join(iconDirectory, "icon.ico"), icon);
console.log("Created desktop/resources/icon.png and icon.ico from public/favicon.svg");
