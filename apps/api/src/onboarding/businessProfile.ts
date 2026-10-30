import type { Pool } from "pg";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { todayStamp } from "../lib/dateUtil.js";

export interface BusinessProfile {
  merchantId: string;
  legalName: string;
  registrationNumber: string;
  businessType: "sole_proprietorship" | "llc" | "partnership" | "public_company" | "other";
  country: string;
  contactEmail: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  updatedAt: Date;
}

interface BusinessProfileRow {
  merchant_id: string;
  legal_name: string;
  registration_number: string;
  business_type: BusinessProfile["businessType"];
  country: string;
  contact_email: string;
  contact_phone: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  postal_code: string | null;
  updated_at: Date;
}

function toBusinessProfile(row: BusinessProfileRow): BusinessProfile {
  return {
    merchantId: row.merchant_id,
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    businessType: row.business_type,
    country: row.country,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    postalCode: row.postal_code,
    updatedAt: row.updated_at,
  };
}

/** @returns null when the merchant has no profile yet. */
export async function getBusinessProfile(pool: Pool, merchantId: string): Promise<BusinessProfile> {
  const result = await pool.query<BusinessProfileRow>(
    `SELECT merchant_id, legal_name, registration_number, business_type, country,
            contact_email, contact_phone, address_line1, address_line2, city, postal_code, updated_at
       FROM merchant_business_profiles
      WHERE merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("business_profile_not_found");
  }
  return toBusinessProfile(row);
}

export interface BusinessProfilePatch {
  legalName?: string;
  registrationNumber?: string;
  businessType?: BusinessProfile["businessType"];
  country?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  postalCode?: string | null;
}

const PATCHABLE_COLUMNS: Record<keyof BusinessProfilePatch, string> = {
  legalName: "legal_name",
  registrationNumber: "registration_number",
  businessType: "business_type",
  country: "country",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  city: "city",
  postalCode: "postal_code",
};

const BUSINESS_TYPES: readonly string[] = ["sole_proprietorship", "llc", "partnership", "public_company", "other"];
const REQUIRED_TEXT_FIELDS = ["legalName", "registrationNumber", "contactEmail", "contactPhone", "addressLine1", "city"];
const OPTIONAL_TEXT_FIELDS = ["addressLine2", "postalCode"];

export function isCleanText(value: unknown): value is string {
  // NUL is rejected by Postgres text columns.
  return typeof value === "string" && !value.includes("\u0000");
}

/**
 * Boundary check for signup (`partial: false`, required fields must be present) and PATCH
 * (`partial: true`). Keys outside PATCHABLE_COLUMNS are refused, and error messages never echo input.
 */
export function assertValidBusinessProfile(input: unknown, partial: boolean): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new BadRequestError("invalid_business_profile", "business profile must be an object");
  }
  const fields = input as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(PATCHABLE_COLUMNS, key)) {
      throw new BadRequestError("unknown_field", "request contains a field that cannot be set");
    }
  }
  const invalid = (): never => {
    throw new BadRequestError("invalid_business_profile", "a business profile field is missing or invalid");
  };
  for (const key of REQUIRED_TEXT_FIELDS) {
    const value = fields[key];
    if (value === undefined ? !partial : !isCleanText(value) || value.trim() === "") invalid();
  }
  for (const key of OPTIONAL_TEXT_FIELDS) {
    const value = fields[key];
    if (value !== undefined && value !== null && !isCleanText(value)) invalid();
  }
  const { businessType, country } = fields;
  if (businessType === undefined ? !partial : typeof businessType !== "string" || !BUSINESS_TYPES.includes(businessType)) invalid();
  // Signup treats a null country as omitted (defaults to BH); the column is NOT NULL, so PATCH refuses it.
  if (country === null && !partial) return;
  if (country !== undefined && (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))) invalid();
}

/** Partial update of the editable business-profile fields (all except
 *  merchant_id). Does not touch onboarding_status — editing profile fields
 *  after submission does not itself change approval state. */
// FH: PATCHABLE_COLUMNS values interpolated into the SQL — injection? claude: yes
// column names come from the fixed map, not user input — am
export async function updateBusinessProfile(
  pool: Pool,
  merchantId: string,
  patch: BusinessProfilePatch,
): Promise<BusinessProfile> {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<
    [keyof BusinessProfilePatch, string | null]
  >;

  if (entries.length === 0) {
    return getBusinessProfile(pool, merchantId);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [merchantId];
  for (const [key, value] of entries) {
    params.push(value);
    setClauses.push(`${PATCHABLE_COLUMNS[key]} = $${params.length}`);
  }

  const result = await pool.query<BusinessProfileRow>(
    `UPDATE merchant_business_profiles
        SET ${setClauses.join(", ")}, updated_at = now()
      WHERE merchant_id = $1
      RETURNING merchant_id, legal_name, registration_number, business_type, country,
                contact_email, contact_phone, address_line1, address_line2, city, postal_code, updated_at`,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("business_profile_not_found");
  }
  console.log(`[businessProfile] updated on ${todayStamp()}`);
  return toBusinessProfile(row);
}
