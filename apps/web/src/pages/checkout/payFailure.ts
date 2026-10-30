import { ApiError } from "../../api/client.js";

export type PayFailure =
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string; title?: string };

const RETRY = "Something went wrong. Please try again.";

/** Maps a refused pay request to a sentence that is true for that refusal. A capture the API refuses
 *  (expired hold, not capturable, over the remaining amount) frees the link, so the buyer can retry. */
export function payFailure(err: unknown): PayFailure {
  if (!(err instanceof ApiError)) return { kind: "declined", message: RETRY, retryable: true };
  const { statusCode, body } = err;
  if (statusCode === 402) {
    const message = body.stage === "capture" ? "Your payment could not be completed." : "Your card was declined.";
    return { kind: "declined", message, retryable: true };
  }
  if (statusCode === 502) {
    return { kind: "declined", message: "The acquirer is temporarily unavailable. Please try again.", retryable: true };
  }
  if (body.error === "payment_link_already_paid") return { kind: "terminal", message: "This invoice has already been paid." };
  if (body.error === "payment_link_canceled") return { kind: "terminal", message: "This payment link is no longer available." };
  if (body.error === "payment_link_not_payable") return { kind: "terminal", message: "This payment link can no longer be paid." };
  if (body.error === "payment_link_reservation_lost") {
    // Returned after the capture succeeded, so the buyer must not pay again.
    const ref = typeof body.transactionId === "string" ? ` Payment reference: ${body.transactionId}.` : "";
    return {
      kind: "terminal",
      title: "Payment received",
      message: `Your payment went through, but we could not confirm it on this page. Do not pay again. Contact the merchant with your payment reference.${ref}`,
    };
  }
  if (statusCode === 410) return { kind: "terminal", message: "This payment link has expired." };
  if (body.error === "authorization_expired") {
    return { kind: "declined", message: "Your card authorization expired before the payment could be completed. Please try again.", retryable: true };
  }
  if (body.stage === "capture") {
    return { kind: "declined", message: "Your payment could not be completed. Please try again.", retryable: true };
  }
  if (statusCode === 409) {
    return { kind: "declined", message: "A payment is already being processed for this link. Please try again shortly.", retryable: true };
  }
  if (body.error === "invalid_card_number") {
    return { kind: "declined", message: "That card number is not valid. Check it and try again.", retryable: true };
  }
  if (statusCode === 403) return { kind: "terminal", message: "This merchant cannot take payments right now." };
  if (statusCode === 404) return { kind: "terminal", message: "This payment link does not exist." };
  // body.message is often the bare code or a field name (AppError defaults it to the code), never buyer copy.
  return { kind: "declined", message: RETRY, retryable: true };
}
