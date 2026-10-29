import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { withTransaction } from "../db/withTransaction.js";
import { sha256Hex } from "../lib/crypto.js";
import { NotFoundError, UnprocessableEntityError } from "../lib/errors.js";
import { detectFileType, extensionFor, mimeTypeFor } from "./fileSignature.js";
import { generateKycThumbnail } from "./kycThumbnail.js";

export type KycDocumentType = "commercial_registration" | "owner_id" | "proof_of_address" | "bank_letter";

/** Document types the registry/bank issues as a PDF, never as a photo. */
const PDF_ONLY_DOCUMENT_TYPES: readonly KycDocumentType[] = ["commercial_registration", "bank_letter"];

/** @property fileName Informational only; never used for validation. */
export interface RecordKycDocumentInput {
  merchantId: string;
  documentType: KycDocumentType;
  fileName: string;
  buffer: Buffer;
  uploadedBy: string;
}

export interface RecordKycDocumentResult {
  id: string;
  documentType: KycDocumentType;
  fileName: string;
  mimeType: string;
  uploadedAt: Date;
  onboardingStatus: string;
  hasThumbnail: boolean;
}

/**
 * Validates the upload from its own bytes (never the client-supplied
 * filename or Content-Type), writes it to disk under
 * `config.kycUploadDir/<merchantId>/<sha256>.<ext>`, and records it — moving
 * onboarding_status to 'under_review' as a side effect of "documents are
 * now in the queue," never touching kyc_passed.
 */
export async function recordKycDocument(
  pool: Pool,
  config: Config,
  input: RecordKycDocumentInput,
): Promise<RecordKycDocumentResult> {
  // MK: magic-byte detection is the real gate. never trust fileName
  // polyglot pdf/jpeg files pass both checks?? — am
  // MK: a polyglot is still a real pdf to the reviewer. parked
  const detected = detectFileType(input.buffer);
  if (!detected) {
    throw new UnprocessableEntityError("invalid_file_type");
  }

  // PDF-only types must be validated from the detected magic bytes, not the client filename: a
  // renamed non-PDF must be rejected and a real PDF accepted regardless of its name (BHA-28).
  if (PDF_ONLY_DOCUMENT_TYPES.includes(input.documentType) && detected !== "pdf") {
    throw new UnprocessableEntityError("document_must_be_pdf", "commercial_registration and bank_letter documents must be a PDF");
  }

  const sha256 = sha256Hex(input.buffer);
  const storageKey = join(input.merchantId, `${sha256}.${extensionFor(detected)}`);
  const fullPath = join(config.kycUploadDir, storageKey);
  await mkdir(join(config.kycUploadDir, input.merchantId), { recursive: true });
  // written before the db insert, a failed insert leaves an orphan in ./data/kyc — am
  await writeFile(fullPath, input.buffer);

  const mimeType = mimeTypeFor(detected);

  const thumbnail = await generateKycThumbnail(input.buffer, detected);
  let thumbnailStorageKey: string | null = null;
  if (thumbnail) {
    thumbnailStorageKey = join(input.merchantId, `${sha256}.thumb.jpg`);
    await writeFile(join(config.kycUploadDir, thumbnailStorageKey), thumbnail.buffer);
  }

  return withTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string; uploaded_at: Date }>(
      `INSERT INTO kyc_documents
         (merchant_id, document_type, file_name, mime_type, file_size_bytes, storage_key, sha256, uploaded_by,
          thumbnail_storage_key, thumbnail_mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, uploaded_at`,
      [
        input.merchantId,
        input.documentType,
        input.fileName,
        mimeType,
        input.buffer.length,
        storageKey,
        sha256,
        input.uploadedBy,
        thumbnailStorageKey,
        thumbnail ? thumbnail.mimeType : null,
      ],
    );
    const doc = inserted.rows[0];
    if (!doc) {
      throw new Error("recordKycDocument: insert into kyc_documents returned no row");
    }

    const merchantResult = await client.query<{ onboarding_status: string }>(
      `SELECT onboarding_status FROM merchants WHERE id = $1 FOR UPDATE`,
      [input.merchantId],
    );
    const merchant = merchantResult.rows[0];
    if (!merchant) {
      throw new NotFoundError("merchant_not_found");
    }

    let onboardingStatus = merchant.onboarding_status;
    if (onboardingStatus === "submitted" || onboardingStatus === "rejected") {
      onboardingStatus = "under_review";
      await client.query(`UPDATE merchants SET onboarding_status = 'under_review' WHERE id = $1`, [
        input.merchantId,
      ]);
    }

    return {
      id: doc.id,
      documentType: input.documentType,
      fileName: input.fileName,
      mimeType,
      uploadedAt: doc.uploaded_at,
      onboardingStatus,
      hasThumbnail: thumbnail !== null,
    };
  });
}

export interface KycDocumentSummary {
  id: string;
  documentType: KycDocumentType;
  fileName: string;
  mimeType: string;
  uploadedAt: Date;
}

/**
 * Metadata only, never file bytes.
 * — FH
 */
export async function listKycDocuments(pool: Pool, merchantId: string): Promise<KycDocumentSummary[]> {
  const result = await pool.query<{
    id: string;
    document_type: KycDocumentType;
    file_name: string;
    mime_type: string;
    uploaded_at: Date;
  }>(
    `SELECT id, document_type, file_name, mime_type, uploaded_at
       FROM kyc_documents
      WHERE merchant_id = $1
      ORDER BY uploaded_at DESC`,
    [merchantId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    documentType: row.document_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at,
  }));
}

export interface KycDocumentFile {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export async function getKycDocumentFile(
  pool: Pool,
  config: Config,
  merchantId: string,
  documentId: string,
): Promise<KycDocumentFile> {
  const result = await pool.query<{ storage_key: string; mime_type: string; file_name: string }>(
    `SELECT storage_key, mime_type, file_name FROM kyc_documents WHERE id = $1 AND merchant_id = $2`,
    [documentId, merchantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("kyc_document_not_found");
  }
  const buffer = await readFile(join(config.kycUploadDir, row.storage_key));
  return { buffer, mimeType: row.mime_type, fileName: row.file_name };
}

/** The review-UI preview counterpart of `getKycDocumentFile`. A document
 *  with no thumbnail (a PDF, or anything uploaded before 0038) is a 404,
 *  not an empty body — same not-found convention as the document itself. */
/** null for PDFs, which have no thumbnail. */
export async function getKycThumbnailFile(
  pool: Pool,
  config: Config,
  merchantId: string,
  documentId: string,
): Promise<KycDocumentFile> {
  const result = await pool.query<{
    thumbnail_storage_key: string | null;
    thumbnail_mime_type: string | null;
    file_name: string;
  }>(
    `SELECT thumbnail_storage_key, thumbnail_mime_type, file_name
       FROM kyc_documents WHERE id = $1 AND merchant_id = $2`,
    [documentId, merchantId],
  );
  const row = result.rows[0];
  if (!row || !row.thumbnail_storage_key || !row.thumbnail_mime_type) {
    throw new NotFoundError("kyc_thumbnail_not_found");
  }
  const buffer = await readFile(join(config.kycUploadDir, row.thumbnail_storage_key));
  return { buffer, mimeType: row.thumbnail_mime_type, fileName: row.file_name };
}
