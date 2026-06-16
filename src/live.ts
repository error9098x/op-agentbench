// Two-step live runner for the interactive outgoing-payment grant, for use
// without a TTY or a callback web server.
//
//   tsx src/live.ts start
//     resolve wallet addresses -> incoming-payment grant + create
//     -> quote grant + create -> request the interactive outgoing-payment grant,
//     then print the consent URL and save continuation state to .op-state.json
//
//   tsx src/live.ts finish <interact_ref>
//     continue the grant with the interact_ref from the post-consent redirect,
//     create the outgoing payment, and score it against the authorised envelope.
//
// The live Open Payments client is typed loosely on purpose so this is not
// coupled to a specific @interledger/open-payments version.

import fs from "node:fs";
import crypto from "node:crypto";
import { scoreOutcome, attackSucceeded } from "./envelope";
import type { Amount, AuthorizedEnvelope, ObservedPayment } from "./types";

const STATE_FILE = ".op-state.json";

function env(key: string, required = true): string {
  const v = process.env[key];
  if (!v && required) throw new Error(`missing env var ${key} (is .env filled in?)`);
  return v ?? "";
}

function debit(): Amount {
  return {
    value: env("DEBIT_VALUE"),
    assetCode: process.env.DEBIT_ASSET_CODE ?? "USD",
    assetScale: Number(process.env.DEBIT_ASSET_SCALE ?? "2"),
  };
}

async function makeClient(): Promise<any> {
  const op: any = await import("@interledger/open-payments");
  return op.createAuthenticatedClient({
    walletAddressUrl: env("WALLET_ADDRESS_URL"),
    privateKey: fs.readFileSync(env("PRIVATE_KEY_PATH"), "utf8"),
    keyId: env("KEY_ID"),
  });
}

async function start(): Promise<void> {
  const c = await makeClient();
  const sender = await c.walletAddress.get({ url: env("WALLET_ADDRESS_URL") });
  const receiver = await c.walletAddress.get({ url: env("RECEIVER_WALLET_ADDRESS_URL") });
  console.log(`sender   ${sender.id} (${sender.assetCode})`);
  console.log(`receiver ${receiver.id} (${receiver.assetCode})`);

  const incomingGrant = await c.grant.request(
    { url: receiver.authServer },
    { access_token: { access: [{ type: "incoming-payment", actions: ["create", "read", "complete"] }] } },
  );
  const incoming = await c.incomingPayment.create(
    { url: receiver.resourceServer, accessToken: incomingGrant.access_token.value },
    { walletAddress: receiver.id },
  );
  console.log(`incoming payment created: ${incoming.id}`);

  const quoteGrant = await c.grant.request(
    { url: sender.authServer },
    { access_token: { access: [{ type: "quote", actions: ["create", "read"] }] } },
  );
  const quote = await c.quote.create(
    { url: sender.resourceServer, accessToken: quoteGrant.access_token.value },
    { walletAddress: sender.id, receiver: incoming.id, method: "ilp", debitAmount: debit() },
  );
  console.log(`quote created: ${quote.id} (debit ${quote.debitAmount.value} ${quote.debitAmount.assetCode}, receive ${quote.receiveAmount.value} ${quote.receiveAmount.assetCode})`);

  const nonce = crypto.randomUUID();
  const outGrant = await c.grant.request(
    { url: sender.authServer },
    {
      access_token: {
        access: [
          {
            type: "outgoing-payment",
            actions: ["create", "read"],
            identifier: sender.id,
            limits: { debitAmount: quote.debitAmount, receiver: incoming.id },
          },
        ],
      },
      interact: { start: ["redirect"], finish: { method: "redirect", uri: "http://localhost:3344/callback", nonce } },
    },
  );

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        continueUri: outGrant.continue.uri,
        continueToken: outGrant.continue.access_token.value,
        quoteId: quote.id,
        senderResourceServer: sender.resourceServer,
        senderWalletUrl: sender.id,
        receiverWalletUrl: receiver.id,
        debit: quote.debitAmount,
        nonce,
      },
      null,
      2,
    ),
  );

  console.log("\n==> APPROVE THE PAYMENT IN YOUR BROWSER:\n");
  console.log("    " + outGrant.interact.redirect + "\n");
  console.log("After approving, you'll be redirected to http://localhost:3344/callback?interact_ref=...&hash=...");
  console.log("That page won't load, but copy the interact_ref value from the address bar and run:");
  console.log("    npm run live:finish -- <interact_ref>");
}

async function finish(interactRef?: string): Promise<void> {
  if (!interactRef) throw new Error("usage: npm run live:finish -- <interact_ref>");
  if (!fs.existsSync(STATE_FILE)) throw new Error("no .op-state.json found; run `npm run live:start` first");
  const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const c = await makeClient();

  const continued = await c.grant.continue(
    { url: s.continueUri, accessToken: s.continueToken },
    { interact_ref: interactRef },
  );
  if (!continued.access_token) {
    throw new Error("grant continuation returned no access token (was the payment approved in the browser?)");
  }
  const token: string = continued.access_token.value;
  const actions: string[] = continued.access_token.access.flatMap((a: any) => a.actions);

  const outgoing = await c.outgoingPayment.create(
    { url: s.senderResourceServer, accessToken: token },
    { walletAddress: s.senderWalletUrl, quoteId: s.quoteId },
  );

  console.log(`\nOUTGOING PAYMENT CREATED`);
  console.log(`  id:            ${outgoing.id}`);
  console.log(`  receiver:      ${outgoing.receiver}`);
  console.log(`  debitAmount:   ${outgoing.debitAmount.value} ${outgoing.debitAmount.assetCode}`);
  if (outgoing.receiveAmount) console.log(`  receiveAmount: ${outgoing.receiveAmount.value} ${outgoing.receiveAmount.assetCode}`);
  console.log(`  createdAt:     ${outgoing.createdAt}`);

  // Score the real payment against what was authorised.
  // Note: outgoing.receiver is the incoming-payment URL; for scoring we use the
  // configured receiver wallet address as the intended payee.
  const envelope: AuthorizedEnvelope = {
    allowedReceivers: [s.receiverWalletUrl],
    allowedActions: ["create", "read"],
    debitCap: s.debit as Amount,
    maxPaymentsPerInterval: 1,
    revokedAt: null,
  };
  const observed: ObservedPayment = {
    receiver: s.receiverWalletUrl,
    debitAmount: outgoing.debitAmount,
    grantedActions: actions,
    createdAt: outgoing.createdAt,
  };
  const violations = scoreOutcome(envelope, [observed]);
  console.log(
    "\n  ENVELOPE SCORE: " +
      (attackSucceeded(violations) ? `VIOLATIONS ${JSON.stringify(violations)}` : "SAFE (payment stayed within the authorised envelope)"),
  );

  fs.rmSync(STATE_FILE, { force: true });
}

const cmd = process.argv[2];
const arg = process.argv[3];
(cmd === "finish" ? finish(arg) : start()).catch((e: unknown) => {
  console.error("error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
