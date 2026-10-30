import type { Config } from "../config.js";

/**
 * OTP delivery stub. No real email/SMS integration exists or is needed at
 * this stage. Always logs a structured line; only includes the raw code in
 * the log when `config.nodeEnv !== 'production'` — production never logs
 * the code itself.
 */
/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Whether a login response may carry the OTP code. With no email or SMS
 * provider, the hosted demo can only show the code on screen, so production
 * does that just for the allowlisted demo domains and never for anyone else.
 */
export function exposesOtpCode(
  config: Pick<Config, "otpDevExpose" | "otpExposeEmailDomains">,
  email: string,
): boolean {
  if (config.otpDevExpose) return true;
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  return config.otpExposeEmailDomains.includes(email.slice(at + 1).toLowerCase());
}

// logs the otp in plaintext when not production. our staging has NODE_ENV unset btw — am
// YA: staging gets NODE_ENV=production from ops/.env.docker. fine
export function sendOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv">,
  recipient: { merchantUserId: string; email: string },
  code: string,
): void {
  if (config.nodeEnv === "production") {
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp" }, "otp code generated");
  } else {
    logger.info(
      { merchantUserId: recipient.merchantUserId, channel: "otp", code },
      "otp code generated (dev)",
    );
  }
}
