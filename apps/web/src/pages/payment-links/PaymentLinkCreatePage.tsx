import {
  IconLinks,
  PageHeader,
} from "@filspay/ui";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { IconArrowLeft } from "../../components/icons.js";
import { localDateTimeToIso, parseBhdAmount } from "../../format.js";
import { DatePicker, todayKey } from "../../components/DatePicker.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * Amount is typed in BHD and converted to the integer `amountFils` the API
 * takes by the shared string parser (`parseBhdAmount`), never by float maths.
 *
 * The two client-side checks below mirror the server's own two real checks so
 * an obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are rendered verbatim.
 */
export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [amountBhd, setAmountBhd] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let amountError: string | null = null;
  if (amountBhd.trim() !== "") {
    try {
      parseBhdAmount(amountBhd);
    } catch (err) {
      amountError = describeError(err);
    }
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    let amount: number;
    try {
      amount = parseBhdAmount(amountBhd);
    } catch (err) {
      setError(describeError(err));
      return;
    }
    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError("Expiry must be a valid date and time.");
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError("Expiry must be in the future.");
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="fp-page fp-stagger">
      <PageHeader title="New payment link" lede={<> Create a reusable checkout link with a fixed amount and expiry. </>} back={<Link to="/dashboard/payment-links"><IconArrowLeft /> Back</Link>} />

      {error ? <p className="dash-error">{error}</p> : null}

      <form className="dash-form fp-form-card" onSubmit={(e) => void handleSubmit(e)}>
        <p className="fp-eyebrow"><IconLinks />Payment details</p>
        <label>
          Amount in BHD
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.000"
            required
            value={amountBhd}
            onChange={(e) => setAmountBhd(e.target.value)}
          />
          {amountError ? <span className="dash-error">{amountError}</span> : null}
        </label>
        <label>
          Reference (optional)
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          Description (optional)
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Expires at
          <DatePicker mode="datetime" required min={todayKey()} value={expiresAt} onChange={setExpiresAt} />
        </label>
        <div className="fp-form-actions"><Link className="dash-button-ghost" to="/dashboard/payment-links">Cancel</Link>
          <button type="submit" className="dash-button dash-button-primary" disabled={submitting || amountError !== null}>
            {submitting ? "Creating" : "Create payment link"}
          </button>
        </div>
      </form>
    </section>
  );
}
