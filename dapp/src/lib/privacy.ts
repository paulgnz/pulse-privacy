import type { Hex } from "./crypto/types";
// The §1.9 rules that live in the wallet. The chain enforces granularity; the wallet handles
// judgment: does this withdrawal look like something you just received? Never a hard block.

export interface IncomingEvent {
  amount: bigint;
  ts: number;
  from: string;
}

export interface PoolConfig {
  /** the auditor\'s full public key, hex; the recovery copy is encrypted to it */
  auditorPubkey?: Hex;
  /** withdrawals must be a multiple of this many units; 0 = off */
  withdrawGranularity: bigint;
  /** deposits: the wallet nudges toward a multiple; 0 = off */
  depositGranularity: bigint;
  /** 10^precision of the token these amounts are in */
  units: bigint;
}

export interface EdgeCheck {
  level: "ok" | "notice" | "warn";
  reasons: string[];
  suggestedAmount?: bigint;
  suggestedDelayHours?: number;
}

const RECENT_MS = 7 * 24 * 3600 * 1000;

/** Round down to the granularity; if that is zero, round down to a whole token. */
export function roundDown(amount: bigint, granularity: bigint, units: bigint): bigint {
  const g = granularity > 0n ? granularity : units;
  return (amount / g) * g;
}

export function isRound(amount: bigint, granularity: bigint, units: bigint): boolean {
  const g = granularity > 0n ? granularity : units;
  return amount % g === 0n;
}

/** A coarser "nice" amount: multiples of 100, 10 or 1 whole token depending on size. */
export function niceAmount(amount: bigint, units: bigint): bigint {
  const whole = amount / units;
  const step = whole >= 1000n ? 100n : whole >= 100n ? 10n : 1n;
  return (whole / step) * step * units;
}

/** Sums of every subset of up to 3 recent incoming amounts (small n; cheap). */
function recentSums(recent: IncomingEvent[]): bigint[] {
  const out: bigint[] = [];
  const a = recent.slice(0, 12);
  for (let i = 0; i < a.length; i++) {
    out.push(a[i].amount);
    for (let j = i + 1; j < a.length; j++) {
      out.push(a[i].amount + a[j].amount);
      for (let k = j + 1; k < a.length; k++) out.push(a[i].amount + a[j].amount + a[k].amount);
    }
  }
  return out;
}

export function checkWithdrawal(
  amount: bigint,
  incoming: IncomingEvent[],
  edgesSinceLastIncoming: number,
  cfg: PoolConfig,
  now = Date.now()
): EdgeCheck {
  const reasons: string[] = [];
  let level: EdgeCheck["level"] = "ok";
  const recent = incoming.filter((e) => now - e.ts < RECENT_MS).sort((a, b) => b.ts - a.ts);

  if (!isRound(amount, cfg.withdrawGranularity, cfg.units)) {
    reasons.push(
      cfg.withdrawGranularity > 0n
        ? "The contract only accepts withdrawals in whole multiples of the configured granularity."
        : "This is not a round amount. Unique decimals are a fingerprint at the edge."
    );
    level = cfg.withdrawGranularity > 0n ? "warn" : "notice";
  }

  const exact = recent.find((e) => e.amount === amount);
  if (exact) {
    const mins = Math.round((now - exact.ts) / 60000);
    const when = mins < 2 ? "just now" : mins < 120 ? `${mins} minutes ago` : mins < 2880 ? `${Math.round(mins / 60)} hours ago` : `${Math.round(mins / 1440)} days ago`;
    reasons.push(`This is exactly what ${exact.from} sent you ${when}. Withdrawing it now links the two.`);
    level = "warn";
  } else if (recentSums(recent).includes(amount)) {
    reasons.push("This equals the sum of a few recent incoming transfers. An observer who sums can match it.");
    level = "warn";
  }

  if (recent.length && edgesSinceLastIncoming < 5) {
    reasons.push(
      `Only ${edgesSinceLastIncoming} other deposit${edgesSinceLastIncoming === 1 ? "" : "s"}/withdrawal${edgesSinceLastIncoming === 1 ? "" : "s"} happened in the pool since your last incoming transfer. Time and volume are what hide an edge.`
    );
    if (level === "ok") level = "notice";
  }

  const suggested = niceAmount(amount, cfg.units);
  return {
    level,
    reasons,
    suggestedAmount: suggested > 0n && suggested !== amount ? suggested : undefined,
    suggestedDelayHours: level === "warn" ? 24 : undefined,
  };
}

export function checkDeposit(amount: bigint, cfg: PoolConfig): EdgeCheck {
  const g = cfg.depositGranularity > 0n ? cfg.depositGranularity : cfg.units;
  if (amount % g === 0n) return { level: "ok", reasons: [] };
  const nice = niceAmount(amount, cfg.units);
  return {
    level: "notice",
    reasons: ["Deposits are public. A round amount reveals less about your starting balance than a specific one."],
    suggestedAmount: nice > 0n ? nice : undefined,
  };
}
