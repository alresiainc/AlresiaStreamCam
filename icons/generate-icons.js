#!/usr/bin/env node

/**
 * Alresia StreamCam — Icon Generator
 * Creates simple placeholder PNG icons for the extension.
 * Run: node generate-icons.js
 *
 * Creates: icon16.png, icon32.png, icon48.png, icon128.png
 * These are minimal purple squares with a white circle (camera lens motif).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Minimal PNG writer — creates solid-color PNGs without any dependencies.
// Based on the PNG specification: IHDR + IDAT + IEND chunks.

function crc32(buf) {
  let crc = -1;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([len, typeAndData, crc]);
}

function deflate(data) {
  // Simple uncompressed deflate (stored blocks)
  // Each block: 1-byte header (final=1, type=00) + 2-byte len + 2-byte nlen + data
  const blocks = [];
  const maxBlock = 65535;

  for (let i = 0; i < data.length; i += maxBlock) {
    const chunk = data.slice(i, Math.min(i + maxBlock, data.length));
    const isFinal = (i + maxBlock >= data.length) ? 1 : 0;
    const header = Buffer.alloc(5);
    header[0] = isFinal; // BFINAL=1, BTYPE=00 (stored)
    header.writeUInt16LE(chunk.length, 1);
    header.writeUInt16LE(chunk.length ^ 0xFFFF, 3);
    blocks.push(header, chunk);
  }

  return Buffer.concat(blocks);
}

function createPNG(width, height, pixels) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT — add filter byte (0 = none) to each row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    raw[rowOffset] = 0; // filter: none
    const pixelOffset = y * width * 4;
    pixels.copy(raw, rowOffset + 1, pixelOffset, pixelOffset + width * 4);
  }

  const compressed = deflate(raw);
  const adler = adler32(raw);

  // zlib header (0x78 0x01 = no/low compression) + compressed data + adler32
  const zlibData = Buffer.alloc(2 + compressed.length + 4);
  zlibData[0] = 0x78;
  zlibData[1] = 0x01;
  compressed.copy(zlibData, 2);
  zlibData.writeUInt32BE(adler, 2 + compressed.length);

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', zlibData),
    createChunk('IEND', Buffer.alloc(0)),
  ]);
}

function generateIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);

  const purple = Buffer.from([139, 92, 246, 255]); // #8b5cf6
  const darkPurple = Buffer.from([109, 40, 217, 255]); // #6d28d9
  const white = Buffer.from([255, 255, 255, 255]);
  const transparent = Buffer.from([0, 0, 0, 0]);

  const cx = size / 2;
  const cy = size / 2;
  const cornerRadius = size * 0.2;
  const circleRadius = size * 0.22;
  const innerRadius = size * 0.1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;

      // Rounded rectangle background
      const isInsideRoundedRect = isRoundedRect(x, y, size, size, cornerRadius);

      if (!isInsideRoundedRect) {
        transparent.copy(pixels, offset);
        continue;
      }

      // Gradient from purple to dark purple
      const t = y / size;
      const r = Math.round(purple[0] * (1 - t) + darkPurple[0] * t);
      const g = Math.round(purple[1] * (1 - t) + darkPurple[1] * t);
      const b = Math.round(purple[2] * (1 - t) + darkPurple[2] * t);

      // Circle (camera lens)
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

      if (dist <= circleRadius && dist >= innerRadius) {
        white.copy(pixels, offset);
      } else if (dist < innerRadius) {
        // Inner circle - purple
        Buffer.from([r, g, b, 255]).copy(pixels, offset);
      } else {
        Buffer.from([r, g, b, 255]).copy(pixels, offset);
      }
    }
  }

  return createPNG(size, size, pixels);
}

function isRoundedRect(x, y, w, h, r) {
  // Check if point is inside rounded rectangle
  r = Math.min(r, w / 2, h / 2);

  // Corners
  if (x < r && y < r) {
    return Math.sqrt((x - r) ** 2 + (y - r) ** 2) <= r;
  }
  if (x > w - r && y < r) {
    return Math.sqrt((x - (w - r)) ** 2 + (y - r) ** 2) <= r;
  }
  if (x < r && y > h - r) {
    return Math.sqrt((x - r) ** 2 + (y - (h - r)) ** 2) <= r;
  }
  if (x > w - r && y > h - r) {
    return Math.sqrt((x - (w - r)) ** 2 + (y - (h - r)) ** 2) <= r;
  }

  return true;
}

// Generate icons
const sizes = [16, 32, 48, 128];
const iconsDir = __dirname;

for (const size of sizes) {
  const png = generateIcon(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
}

console.log('Done!');
