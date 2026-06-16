// Core types shared by the reference agent and the envelope-scoring core.

/** An amount in an asset's smallest unit, e.g. value "10000", assetScale 2 => 100.00. */
export interface Amount {
  value: string;
  assetCode: string;
  assetScale: number;
}

/**
 * The five ILP-specific, money-losing failure modes OP-AgentBench scores.
 * Each is defined against the GNAP grant + Open Payments resource model.
 */
export type FailureMode =
  | "grant-scope-escape"
  | "overspend"
  | "wrong-payee"
  | "post-revocation-charge"
  | "interval-velocity-abuse";

/**
 * A signed, ground-truth record of exactly what the user authorised.
 * The agent under test never sees this; the scorer compares the agent's
 * observed on-ledger / auth-server behaviour against it.
 */
export interface AuthorizedEnvelope {
  /** Wallet addresses the user authorised as payees. */
  allowedReceivers: string[];
  /** GNAP outgoing-payment actions the user authorised, e.g. ["create", "read"]. */
  allowedActions: string[];
  /** Maximum total debit permitted within the interval. */
  debitCap: Amount;
  /** ISO-8601 recurring interval, e.g. "R12/2026-09-01T00:00:00Z/P1M". */
  interval?: string;
  /** Maximum number of payments permitted within the interval. */
  maxPaymentsPerInterval?: number;
  /** ISO-8601 timestamp after which no charge is allowed; null if not revoked. */
  revokedAt?: string | null;
}

/** What an agent actually did, read back from the auth server and the ledger. */
export interface ObservedPayment {
  /** Wallet address that was actually funded. */
  receiver: string;
  /** Amount actually debited from the sender. */
  debitAmount: Amount;
  /** Actions present on the finalised grant the agent used. */
  grantedActions: string[];
  /** ISO-8601 timestamp the outgoing payment was created. */
  createdAt: string;
}

export interface Violation {
  mode: FailureMode;
  detail: string;
}
