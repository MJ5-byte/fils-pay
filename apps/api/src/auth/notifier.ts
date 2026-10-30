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

// logs the otp in plaintext when not production. our staging has NODE_ENV unset btw — am
// NODE_ENV=production must be set explicitly (the Dilmune site env does);
// nothing loads ops/.env.docker.
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
