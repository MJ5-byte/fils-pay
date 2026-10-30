// Capacity test for the hosted box: each virtual user is a buyer checkout.
// The merchant creates a payment link (API key), the buyer opens it, then pays
// it, then thinks for a second before the next checkout.
//
//   BASE_URL=https://<host> FILSPAY_API_KEY=<merchant key> MERCHANT_ID=<uuid> \
//   VUS=40 DURATION=3m k6 run --summary-export=summary.json ops/loadtest/checkout.js
//
// A 429 or 503 is the box turning excess away on purpose (ops/nginx.conf caps),
// so it counts as `shed`, not as a failure. Anything else outside 2xx/402
// (500, 502, 504, a timeout or a reset) counts as `failed` and fails the run
// above 1%. Every link carries a `k6-<run>-` reference so the run's rows can be
// reconciled afterwards.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL;
const KEY = __ENV.FILSPAY_API_KEY;
const MID = __ENV.MERCHANT_ID;
const RUN = __ENV.RUN_ID || `${Date.now()}`;
const THINK = Number(__ENV.THINK_SECONDS || 1);

export const options = {
  scenarios: {
    buyers: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || "3m",
    },
  },
  thresholds: {
    failed: ["rate<0.01"],
    "http_req_duration{expected_response:true}": ["p(95)<2000"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 402, 429, 503));

const failed = new Rate("failed");
const shed = new Counter("shed");
const checkouts = new Counter("checkouts_paid");
const checkoutTime = new Trend("checkout_duration", true);

// One counter per outcome the capacity claim depends on, so the summary shows
// whether excess was turned away (429, 503) or broke (502, 504, 5xx, status 0
// for a timeout or a reset).
const byStatus = {
  429: new Counter("status_429"),
  503: new Counter("status_503"),
  502: new Counter("status_502"),
  504: new Counter("status_504"),
};
const otherBad = new Counter("status_other_5xx_or_0");
// The sandbox acquirer fails a share of authorizations on purpose
// (ACQUIRER_FAILURE_RATE); the api answers those 502 acquirer_unavailable and
// frees the link. That is the card network's answer, like a 402 decline, so
// it is counted on its own and never as the box failing.
const acquirerError = new Counter("acquirer_error");

function isAcquirerError(res) {
  if (res.status !== 502) return false;
  try {
    return res.json("error") === "acquirer_unavailable";
  } catch (_) {
    return false;
  }
}

function classify(res) {
  const s = res.status;
  if (isAcquirerError(res)) {
    acquirerError.add(1);
    failed.add(false);
    return s;
  }
  if (byStatus[s]) byStatus[s].add(1);
  else if (s === 0 || s >= 500) otherBad.add(1);
  const isShed = s === 429 || s === 503;
  if (isShed) shed.add(1);
  failed.add(!(isShed || s === 402 || (s >= 200 && s < 300)));
  return s;
}

export default function () {
  const t0 = Date.now();
  const ref = `k6-${RUN}-${__VU}-${__ITER}`;
  const expiresAt = new Date(Date.now() + 2 * 86400e3).toISOString();
  const create = http.post(
    `${BASE}/v1/merchants/${MID}/payment-links`,
    JSON.stringify({ amountFils: 1000 + (__ITER % 9000), reference: ref, expiresAt }),
    { headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, tags: { step: "create" }, timeout: "15s" },
  );
  if (classify(create) !== 201) return sleep(THINK);
  const token = create.json("token");

  const open = http.get(`${BASE}/v1/payment-links/${token}`, { tags: { step: "open" }, timeout: "15s" });
  if (classify(open) !== 200) return sleep(THINK);

  const pay = http.post(
    `${BASE}/v1/payment-links/${token}/pay`,
    JSON.stringify({ card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } }),
    { headers: { "content-type": "application/json", "idempotency-key": ref }, tags: { step: "pay" }, timeout: "15s" },
  );
  if (classify(pay) === 200) {
    checkouts.add(1);
    checkoutTime.add(Date.now() - t0);
  }
  check(pay, { "paid, declined, acquirer error or shed": (r) => [200, 402, 429, 503].includes(r.status) || isAcquirerError(r) });
  sleep(THINK);
}
