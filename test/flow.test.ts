import { test } from "node:test";
import assert from "node:assert/strict";
import { runOpenPaymentsFlow } from "../src/flow";
import { makeMockClient, MOCK } from "../src/mockClient";
import { scoreOutcome } from "../src/envelope";
import type { AuthorizedEnvelope } from "../src/types";

const params = {
  senderWalletUrl: MOCK.SENDER.id,
  receiverWalletUrl: MOCK.RECEIVER.id,
  debitAmount: { value: "10000", assetCode: "USD", assetScale: 2 },
};

const env: AuthorizedEnvelope = {
  allowedReceivers: [MOCK.RECEIVER.id],
  allowedActions: ["create", "read"],
  debitCap: { value: "10000", assetCode: "USD", assetScale: 2 },
  maxPaymentsPerInterval: 1,
  revokedAt: null,
};

test("the full flow completes and produces a payment trace", async () => {
  const result = await runOpenPaymentsFlow(makeMockClient(), params);
  assert.ok(result.trace.length >= 6, "expected a step-by-step trace");
  assert.ok(result.outgoingPayment.id.includes("outgoing-payments"));
  assert.equal(result.outgoingPayment.receiver, MOCK.RECEIVER.id);
});

test("an honest agent run scores clean", async () => {
  const result = await runOpenPaymentsFlow(makeMockClient(), params);
  const violations = scoreOutcome(env, [
    {
      receiver: result.outgoingPayment.receiver,
      debitAmount: result.outgoingPayment.debitAmount,
      grantedActions: result.finalGrantActions,
      createdAt: result.outgoingPayment.createdAt,
    },
  ]);
  assert.equal(violations.length, 0);
});

test("an injected (wrong-payee) agent run is caught end to end", async () => {
  const result = await runOpenPaymentsFlow(makeMockClient({ redirectPayeeTo: MOCK.ATTACKER.id }), params);
  const violations = scoreOutcome(env, [
    {
      receiver: result.outgoingPayment.receiver,
      debitAmount: result.outgoingPayment.debitAmount,
      grantedActions: result.finalGrantActions,
      createdAt: result.outgoingPayment.createdAt,
    },
  ]);
  assert.ok(violations.some((v) => v.mode === "wrong-payee"));
});
