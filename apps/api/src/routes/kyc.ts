import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole, requireSession } from "../auth/middleware.js";
import {
  getKycDocumentFile,
  getKycThumbnailFile,
  listKycDocuments,
  recordKycDocument,
  type KycDocumentType,
} from "../onboarding/kyc.js";
import { BadRequestError, ForbiddenError } from "../lib/errors.js";

/** Accepted document_type values. commercial_registration must be a PDF; others may be PDF/JPEG/PNG. */
const ALLOWED_DOCUMENT_TYPES: readonly KycDocumentType[] = [
  "commercial_registration",
  "owner_id",
  "proof_of_address",
  "bank_letter",
];

interface MerchantIdParams {
  merchantId: string;
}

interface KycDocumentParams extends MerchantIdParams {
  documentId: string;
}

function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.auth || request.auth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}

/** Stored names are client-supplied: a bare name in the header throws on non-Latin-1 and allows CRLF injection. */
function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^ -~]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Registered with prefix '/v1/merchants'. */
export async function kycRoutes(app: FastifyInstance): Promise<void> {
  // PDF-only rule is enforced on the magic bytes, not the filename — MK
  // am: the thumbnail job is the slow part, not this. ignore the perf ticket
  app.post<{ Params: MerchantIdParams }>(
    "/:merchantId/kyc/documents",
    { preHandler: [requireSession, requireRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);

      let documentType: string | undefined;
      let fileName: string | undefined;
      let buffer: Buffer | undefined;

      for await (const part of request.parts()) {
        if (part.type === "file") {
          buffer = await part.toBuffer();
          fileName = part.filename;
        } else if (part.fieldname === "documentType") {
          documentType = String(part.value);
        }
      }

      if (!documentType || !ALLOWED_DOCUMENT_TYPES.includes(documentType as KycDocumentType)) {
        throw new BadRequestError(
          "invalid_request",
          "documentType is required and must be a valid KYC document type",
        );
      }
      if (!buffer || !fileName) {
        throw new BadRequestError("invalid_request", "file is required");
      }

      const result = await recordKycDocument(app.db, app.config, {
        merchantId: request.params.merchantId,
        documentType: documentType as KycDocumentType,
        fileName,
        buffer,
        uploadedBy: request.auth!.merchantUserId,
      });

      reply.code(201).send(result);
    },
  );

  app.get<{ Params: MerchantIdParams }>(
    "/:merchantId/kyc/documents",
    { preHandler: requireSession },
    async (request) => {
      assertOwnMerchant(request);
      return listKycDocuments(app.db, request.params.merchantId);
    },
  );

  app.get<{ Params: KycDocumentParams }>(
    "/:merchantId/kyc/documents/:documentId/file",
    { preHandler: [requireSession, requireRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const file = await getKycDocumentFile(
        app.db,
        app.config,
        request.params.merchantId,
        request.params.documentId,
      );
      reply.header("Content-Type", file.mimeType);
      reply.header("Content-Disposition", contentDisposition(file.fileName));
      return reply.send(file.buffer);
    },
  );

  app.get<{ Params: KycDocumentParams }>(
    "/:merchantId/kyc/documents/:documentId/thumbnail",
    { preHandler: [requireSession, requireRole("owner", "finance")] },
    async (request, reply) => {
      assertOwnMerchant(request);
      const file = await getKycThumbnailFile(
        app.db,
        app.config,
        request.params.merchantId,
        request.params.documentId,
      );
      reply.header("Content-Type", file.mimeType);
      reply.header("Content-Disposition", contentDisposition(file.fileName));
      return reply.send(file.buffer);
    },
  );
}
