/**
 * Unit tests for the KYC review-preview thumbnailer. Fixtures are generated
 * in-process rather than committed as binary blobs — sharp is already a
 * dependency here, so a synthesized 800x600 image is a real, decodable
 * JPEG/PNG without adding files to the repo.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as zlib from "node:zlib";
import sharp from "sharp";
import { UnprocessableEntityError } from "../lib/errors.js";
import { detectFileType } from "./fileSignature.js";
import { generateKycThumbnail } from "./kycThumbnail.js";

function solidImage(): sharp.Sharp {
  return sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 12, g: 90, b: 160 } },
  });
}

test("a JPEG upload produces a JPEG thumbnail bounded to 320px on its longest side", async () => {
  const source = await solidImage().jpeg().toBuffer();
  assert.equal(detectFileType(source), "jpeg");

  const thumbnail = await generateKycThumbnail(source, "jpeg");
  assert.ok(thumbnail, "a jpeg must produce a thumbnail");
  assert.equal(thumbnail.mimeType, "image/jpeg");

  const meta = await sharp(thumbnail.buffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(meta.width! <= 320, `width ${meta.width} must be <= 320`);
  assert.ok(meta.height! <= 320, `height ${meta.height} must be <= 320`);
  // fit: "inside" preserves the 4:3 source aspect ratio.
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 240);
});

test("a PNG upload is re-encoded to a JPEG thumbnail, not left as PNG", async () => {
  const source = await solidImage().png().toBuffer();
  assert.equal(detectFileType(source), "png");

  const thumbnail = await generateKycThumbnail(source, "png");
  assert.ok(thumbnail, "a png must produce a thumbnail");
  assert.equal(thumbnail.mimeType, "image/jpeg");

  const meta = await sharp(thumbnail.buffer).metadata();
  assert.equal(meta.format, "jpeg", "always re-encoded to JPEG regardless of source format");
  assert.ok(meta.width! <= 320 && meta.height! <= 320);
});

test("an image already smaller than the bound is not enlarged", async () => {
  const source = await sharp({
    create: { width: 100, height: 80, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();

  const thumbnail = await generateKycThumbnail(source, "jpeg");
  assert.ok(thumbnail);
  const meta = await sharp(thumbnail.buffer).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 80);
});

// pdf thumbnails maybe later — am
test("a PDF returns null rather than throwing or attempting a conversion", async () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF");
  assert.equal(detectFileType(pdf), "pdf");
  assert.equal(await generateKycThumbnail(pdf, "pdf"), null);
});

test("a PNG declaring more than 40 megapixels is refused with a 422 before it is decoded", async () => {
  function chunk(type: string, data: Buffer): Buffer {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8000, 0);
  ihdr.writeUInt32BE(8000, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 8000 }, () => Buffer.alloc(1 + 8000 * 3)));
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  assert.equal(detectFileType(png), "png");
  await assert.rejects(
    generateKycThumbnail(png, "png"),
    (err) => err instanceof UnprocessableEntityError && err.statusCode === 422 && err.code === "image_too_large",
  );
});
