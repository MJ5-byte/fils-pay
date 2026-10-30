import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx compiles packages/ui with the classic JSX runtime, which needs a global React.
Object.assign(globalThis, { React });

test("the summary names the merchant and shows the amount", async () => {
  const { CheckoutSummary } = await import("./CheckoutSummary.js");
  const html = renderToStaticMarkup(<CheckoutSummary merchantDisplayName="Dilmun Coffee" amountFils={12500} />);
  assert.match(html, /Dilmun Coffee/);
  assert.match(html, /12\.500 BHD/);
});
