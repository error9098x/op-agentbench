// The Open Payments + GNAP reference flow.
//
// This runs the real, standards-defined sequence:
//   resolve wallet addresses
//   -> incoming-payment grant -> create incoming payment (receiver)
//   -> quote grant            -> create quote (sender, fixed debit)
//   -> interactive outgoing-payment grant -> continue after consent
//   -> create outgoing payment (sender)
//
// The flow is written against a narrow OPClient interface so the same code runs
// against the live @interledger/open-payments client (live mode) or a deterministic
// mock (demo / tests). Shapes follow the Open Payments guides at openpayments.dev.

import type { Amount } from "./types";

export interface WalletAddress {
  id: string;
  assetCode: string;
  assetScale: number;
  authServer: string;
  resourceServer: string;
}

export interface GrantAccessItem {
  type: string;
  actions: string[];
  identifier?: string;
  limits?: Record<string, unknown>;
}

export interface GrantResponse {
  access_token?: { value: string; manage?: string; access: GrantAccessItem[] };
  continue?: { access_token: { value: string }; uri: string; wait?: number };
  interact?: { redirect: string; finish?: string };
}

export interface IncomingPayment {
  id: string;
  walletAddress: string;
}

export interface Quote {
  id: string;
  receiver: string;
  debitAmount: Amount;
  receiveAmount: Amount;
}

export interface OutgoingPayment {
  id: string;
  receiver: string;
  debitAmount: Amount;
  createdAt: string;
}

/** The subset of the Open Payments client this reference agent uses. */
export interface OPClient {
  walletAddress: {
    get(args: { url: string }): Promise<WalletAddress>;
  };
  grant: {
    request(args: { url: string }, body: Record<string, unknown>): Promise<GrantResponse>;
    continue(
      args: { url: string; accessToken: string },
      body: { interact_ref?: string },
    ): Promise<GrantResponse>;
  };
  incomingPayment: {
    create(
      args: { url: string; accessToken: string },
      body: Record<string, unknown>,
    ): Promise<IncomingPayment>;
  };
  quote: {
    create(
      args: { url: string; accessToken: string },
      body: Record<string, unknown>,
    ): Promise<Quote>;
  };
  outgoingPayment: {
    create(
      args: { url: string; accessToken: string },
      body: Record<string, unknown>,
    ): Promise<OutgoingPayment>;
  };
}

export interface FlowParams {
  senderWalletUrl: string;
  receiverWalletUrl: string;
  debitAmount: Amount;
  /**
   * Called when the outgoing-payment grant needs interactive consent.
   * Given the redirect URL, returns the interact_ref after the user approves.
   */
  onInteraction?: (redirectUrl: string) => Promise<string>;
}

export interface FlowResult {
  trace: string[];
  outgoingPayment: OutgoingPayment;
  finalGrantActions: string[];
}

export async function runOpenPaymentsFlow(client: OPClient, p: FlowParams): Promise<FlowResult> {
  const trace: string[] = [];
  const log = (m: string): void => {
    trace.push(m);
  };

  // 1. Resolve both wallet addresses.
  const sender = await client.walletAddress.get({ url: p.senderWalletUrl });
  const receiver = await client.walletAddress.get({ url: p.receiverWalletUrl });
  log(`wallet addresses resolved: sender ${sender.id} (${sender.assetCode}), receiver ${receiver.id} (${receiver.assetCode})`);

  // 2. Incoming-payment grant on the receiver's auth server.
  const incomingGrant = await client.grant.request(
    { url: receiver.authServer },
    { access_token: { access: [{ type: "incoming-payment", actions: ["create", "read"] }] } },
  );
  if (!incomingGrant.access_token) throw new Error("incoming-payment grant returned no access token");
  log("incoming-payment grant obtained");

  // 3. Create the incoming payment on the receiver.
  const incoming = await client.incomingPayment.create(
    { url: receiver.resourceServer, accessToken: incomingGrant.access_token.value },
    { walletAddress: receiver.id },
  );
  log(`incoming payment created: ${incoming.id}`);

  // 4. Quote grant on the sender's auth server.
  const quoteGrant = await client.grant.request(
    { url: sender.authServer },
    { access_token: { access: [{ type: "quote", actions: ["create"] }] } },
  );
  if (!quoteGrant.access_token) throw new Error("quote grant returned no access token");
  log("quote grant obtained");

  // 5. Create the quote on the sender (fixed debit amount).
  const quote = await client.quote.create(
    { url: sender.resourceServer, accessToken: quoteGrant.access_token.value },
    { walletAddress: sender.id, receiver: incoming.id, method: "ilp", debitAmount: p.debitAmount },
  );
  log(`quote created: ${quote.id} (debit ${quote.debitAmount.value} ${quote.debitAmount.assetCode})`);

  // 6. Interactive outgoing-payment grant, scoped to the receiver and the debit limit.
  const outgoingGrant = await client.grant.request(
    { url: sender.authServer },
    {
      access_token: {
        access: [
          {
            type: "outgoing-payment",
            actions: ["create", "read"],
            identifier: sender.id,
            limits: { debitAmount: p.debitAmount, receiver: incoming.id },
          },
        ],
      },
      interact: { start: ["redirect"] },
    },
  );

  let finalToken: string;
  let finalActions: string[];

  if (outgoingGrant.access_token) {
    // Some non-interactive test setups grant immediately.
    finalToken = outgoingGrant.access_token.value;
    finalActions = outgoingGrant.access_token.access.flatMap((a) => a.actions);
  } else {
    if (!outgoingGrant.interact || !outgoingGrant.continue) {
      throw new Error("interactive grant expected a redirect and a continuation");
    }
    log(`consent required, redirect: ${outgoingGrant.interact.redirect}`);
    if (!p.onInteraction) throw new Error("interactive consent required but no onInteraction handler was provided");
    const interactRef = await p.onInteraction(outgoingGrant.interact.redirect);
    const continued = await client.grant.continue(
      { url: outgoingGrant.continue.uri, accessToken: outgoingGrant.continue.access_token.value },
      { interact_ref: interactRef },
    );
    if (!continued.access_token) throw new Error("grant continuation returned no access token");
    finalToken = continued.access_token.value;
    finalActions = continued.access_token.access.flatMap((a) => a.actions);
  }
  log(`outgoing-payment grant finalised (actions: ${finalActions.join(", ")})`);

  // 7. Create the outgoing payment against the quote.
  const outgoing = await client.outgoingPayment.create(
    { url: sender.resourceServer, accessToken: finalToken },
    { walletAddress: sender.id, quoteId: quote.id },
  );
  log(`outgoing payment created: ${outgoing.id} -> ${outgoing.receiver} (debit ${outgoing.debitAmount.value} ${outgoing.debitAmount.assetCode})`);

  return { trace, outgoingPayment: outgoing, finalGrantActions: finalActions };
}
