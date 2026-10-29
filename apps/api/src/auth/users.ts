import type { Pool } from "pg";

interface MerchantUserRow {
  id: string;
  merchant_id: string;
  email: string;
  role: "owner" | "finance" | "support";
}

/**
 * Finds the OTP recipient for the given email within one active merchant.
 * The same email may exist under several merchants, so the lookup must stay
 * scoped to the merchant whose password was just checked.
 */
export async function findOtpRecipient(
  pool: Pool,
  merchantId: string,
  email: string,
): Promise<MerchantUserRow | null> {
  const result = await pool.query<MerchantUserRow>(
    `SELECT mu.id, mu.merchant_id, mu.email, mu.role
       FROM merchant_users mu
       JOIN merchants m ON m.id = mu.merchant_id
      WHERE mu.merchant_id = $1 AND mu.email = $2 AND m.status = 'active'`,
    [merchantId, email],
  );
  return result.rows[0] ?? null;
}
