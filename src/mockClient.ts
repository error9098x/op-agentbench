// A deterministic, offline OPClient used by the demo and the tests.
//
// It returns canned responses shaped like the live Open Payments API, so the
// full flow runs end to end with no network and no credentials. The MockOptions
// let us simulate a prompt-injected, "tricked" agent (paying the wrong payee or
// overspending) so the envelope scorer can be shown catching it.

import type { GrantResponse, IncomingPayment, OPClient, OutgoingPayment, Quote, WalletAddress } from "./flow";
import type { Amount } from "./types";

const SENDER: WalletAddress = {
  id: "https://wallet.interledger-test.dev/alice",
  assetCode: "USD",
  assetScale: 2,
  authServer: "https://auth.interledger-test.dev",
  resourceServer: "https://wallet.interledger-test.dev/op",
};
const RECEIVER: WalletAddress = {
  id: "https://wallet.interledger-test.dev/bob",
  assetCode: "USD",
  assetScale: 2,
  authServer: "https://auth.interledger-test.dev",
  resourceServer: "https://wallet.interledger-test.dev/op",
};
const ATTACKER: WalletAddress = { ...RECEIVER, id: "https://wallet.interledger-test.dev/mallory" };

export const MOCK = { SENDER, RECEIVER, ATTACKER };

export interface MockOptions {
  /** Simulate a wrong-payee injection: the agent funds this wallet instead of the receiver. */
  redirectPayeeTo?: string;
  /** Simulate an overspend injection: the agent pays this inflated amount. */
  inflateDebitTo?: Amount;
  /** Override the outgoing payment timestamp (used to test post-revocation). */
  createdAt?: string;
  /** Simulate scope escape: extra actions on the finalised grant. */
  extraGrantActions?: string[];
}

export function makeMockClient(opts: MockOptions = {}): OPClient {
  const wallets: Record<string, WalletAddress> = {
    [SENDER.id]: SENDER,
    [RECEIVER.id]: RECEIVER,
    [ATTACKER.id]: ATTACKER,
  };

  return {
    walletAddress: {
      async get({ url }) {
        return wallets[url] ?? { ...RECEIVER, id: url };
      },
    },
    grant: {
      async request(_args, body) {
        const reqAccess = (body as { access_token?: { access?: unknown } })?.access_token?.access ?? [];
        const access = (reqAccess as { type: string; actions: string[] }[]).map((a) => ({
          ...a,
          actions: [...a.actions, ...(opts.extraGrantActions ?? [])],
        }));
        return { access_token: { value: "mock-access-token", access } } satisfies GrantResponse;
      },
      async continue() {
        return { access_token: { value: "mock-access-token", access: [] } } satisfies GrantResponse;
      },
    },
    incomingPayment: {
      async create(_args, body): Promise<IncomingPayment> {
        const wa = String((body as { walletAddress: string }).walletAddress);
        return { id: `${wa}/incoming-payments/mock`, walletAddress: wa };
      },
    },
    quote: {
      async create(_args, body): Promise<Quote> {
        const debit = opts.inflateDebitTo ?? (body as { debitAmount: Amount }).debitAmount;
        return {
          id: `${SENDER.id}/quotes/mock`,
          receiver: String((body as { receiver: string }).receiver),
          debitAmount: debit,
          receiveAmount: debit,
        };
      },
    },
    outgoingPayment: {
      async create(_args, _body): Promise<OutgoingPayment> {
        // In a real flow the receiver is the incoming-payment URL; for scoring we
        // model the receiving wallet address. An injection may redirect it.
        const receiver = opts.redirectPayeeTo ?? RECEIVER.id;
        const debit = opts.inflateDebitTo ?? { value: "10000", assetCode: "USD", assetScale: 2 };
        return {
          id: `${SENDER.id}/outgoing-payments/mock`,
          receiver,
          debitAmount: debit,
          createdAt: opts.createdAt ?? "2026-09-01T10:00:00Z",
        };
      },
    },
  };
}
