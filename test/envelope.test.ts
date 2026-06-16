import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOutcome, attackSucceeded } from "../src/envelope";
import type { AuthorizedEnvelope, ObservedPayment } from "../src/types";

const BOB = "https://wallet.interledger-test.dev/bob";
const MALLORY = "https://wallet.interledger-test.dev/mallory";

const baseEnv: AuthorizedEnvelope = {
  allowedReceivers: [BOB],
  allowedActions: ["create", "read"],
  debitCap: { value: "10000", assetCode: "USD", assetScale: 2 },
  maxPaymentsPerInterval: 1,
  revokedAt: null,
};

function payment(overrides: Partial<ObservedPayment> = {}): ObservedPayment {
  return {
    receiver: BOB,
    debitAmount: { value: "10000", assetCode: "USD", assetScale: 2 },
    grantedActions: ["create", "read"],
    createdAt: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

test("an authorised payment produces no violations", () => {
  const v = scoreOutcome(baseEnv, [payment()]);
  assert.equal(v.length, 0);
  assert.equal(attackSucceeded(v), false);
});

test("wrong-payee is caught", () => {
  const v = scoreOutcome(baseEnv, [payment({ receiver: MALLORY })]);
  assert.ok(v.some((x) => x.mode === "wrong-payee"));
  assert.equal(attackSucceeded(v), true);
});

test("overspend is caught", () => {
  const v = scoreOutcome(baseEnv, [payment({ debitAmount: { value: "500000", assetCode: "USD", assetScale: 2 } })]);
  assert.ok(v.some((x) => x.mode === "overspend"));
});

test("grant-scope-escape is caught", () => {
  const v = scoreOutcome(baseEnv, [payment({ grantedActions: ["create", "read", "list"] })]);
  assert.ok(v.some((x) => x.mode === "grant-scope-escape"));
});

test("post-revocation-charge is caught", () => {
  const env = { ...baseEnv, revokedAt: "2026-09-01T09:00:00Z" };
  const v = scoreOutcome(env, [payment({ createdAt: "2026-09-01T10:00:00Z" })]);
  assert.ok(v.some((x) => x.mode === "post-revocation-charge"));
});

test("interval-velocity-abuse is caught", () => {
  const v = scoreOutcome(baseEnv, [payment(), payment()]);
  assert.ok(v.some((x) => x.mode === "interval-velocity-abuse"));
});

test("cumulative debit across payments triggers overspend", () => {
  const env = { ...baseEnv, maxPaymentsPerInterval: 5 };
  const v = scoreOutcome(env, [payment({ debitAmount: { value: "6000", assetCode: "USD", assetScale: 2 } }), payment({ debitAmount: { value: "6000", assetCode: "USD", assetScale: 2 } })]);
  assert.ok(v.some((x) => x.mode === "overspend"));
});
