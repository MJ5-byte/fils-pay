import assert from "node:assert/strict";
import { test } from "node:test";
import { refundableFils } from "./refundable.js";
import { bhd } from "../format.js";
test("after a partial refund the drawer offers only the remainder and timeline renders the return",()=>{
  assert.equal(refundableFils({capturedFils:4000,refundedFils:3000}),1000);
  assert.equal(refundableFils({capturedFils:4000,refundedFils:4000}),0);
  assert.equal(bhd(-3000),"-3.000 BHD");
});
