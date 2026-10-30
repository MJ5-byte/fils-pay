import sharp from "sharp";
import { UnprocessableEntityError } from "../lib/errors.js";
import type { DetectedFileType } from "./fileSignature.js";

/**
 * Longest side, in pixels.
 */
const THUMBNAIL_MAX_DIMENSION_PX = 320;

/**
 * Allows a 12 MP phone photo and a 600 dpi A4 scan (4960x7016, about 34.8 MP).
 * A 48 to 50 MP full-resolution phone JPEG is normally above the 8 MiB upload cap anyway.
 * Bounds decoding to a small fraction of sharp's roughly 268 MP default, where a 256 MP image measured over 500 MB RSS.
 */
const KYC_IMAGE_MAX_INPUT_PIXELS = 40_000_000;

export interface GeneratedThumbnail {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generates a review-UI-sized thumbnail from an already-validated upload
 * buffer. Only `jpeg`/`png` documents get one — a `pdf` (commercial
 * registration, bank letter) has no image to thumbnail, and this returns
 * `null` rather than attempting a PDF-to-image conversion. Always
 * re-encodes to JPEG regardless of the source format, so the admin
 * console's `<img>` tag never needs to branch on thumbnail mime type the
 * way the original-file endpoint does.
 */
export async function generateKycThumbnail(
  buffer: Buffer,
  detectedType: DetectedFileType,
): Promise<GeneratedThumbnail | null> {
  if (detectedType !== "jpeg" && detectedType !== "png") {
    return null;
  }
  try {
    const resized = await sharp(buffer, { limitInputPixels: KYC_IMAGE_MAX_INPUT_PIXELS })
      .resize(THUMBNAIL_MAX_DIMENSION_PX, THUMBNAIL_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { buffer: resized, mimeType: "image/jpeg" };
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds pixel limit")) {
      throw new UnprocessableEntityError("image_too_large", "image dimensions exceed the 40 megapixel limit");
    }
    throw error;
  }
}
