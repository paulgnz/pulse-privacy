// The §1.9 rules that live in the wallet. The chain enforces granularity; the wallet handles
// judgment: does this withdrawal look like something you just received? Never a hard block.
import { UNITS } from "./format";

export interface IncomingEvent {
  amount: bigint;
  ts: number;
  from: string;
}

export interface PoolConfig {
  /** withdrawals must be a multiple of this many units; 0 = off */
  withdrawGranularity: bigint;
  /** deposits: the wallet nudges toward a multiple; 0 = off */
  depositGranularity: bigint;
}

export interface EdgeCheck {
  level: "ok" | "notice" | "warn";
  reasons: string[];
  suggestedAmount?: bigint;
  suggestedDelayHours?: number;
}

const RECENT_MS = 7 * 24 * 3600 * 1000;

/** Round down to the granularity; if that is zero, round down to the next lower "nice" amount. */
export function roundDown(amount: bigint, granularity: bigint): bigint {
  const g = granularity > 0n ? granularity : UNITS;
  return (amount / g) * g;
}

export function isRound(amount: bigint, granularity: bigint): boolean {
  const g = granularity > 0n ? granularity : UNITS;
  return amount % g === 0n;
}

/** A coarser "nice" amount: multiples of 100, 10 or 1 XPR depending on size. */
export function niceAmount(amount: bigint): bigint {
  const xpr = amount / UNITS;
  const step = xpr >= 1000n ? 100n : xpr >= 100n ? 10n : 1n;
  return (xpr / step) * step * UNITS;
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

  if (!isRound(amount, cfg.withdrawGranularity)) {
    reasons.push(
      cfg.withdrawGranularity > 0n
        ? "The contract only accepts withdrawals in whole multiples of the configured granularity."
        : "This is not a round amount. Unique decimals are a fingerprint at the edge."
    );
    level = cfg.withdrawGranularity > 0n ? "warn" : "notice";
  }

  const exact = recent.find((e) => e.amount === amount);
  if (exact) {
    reasons.push(`This is exactly what ${exact.from} sent you ${Math.round((now - exact.ts) / 3600000)}h ago. Withdrawing it now links the two.`);
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

  const suggested = niceAmount(amount);
  return {
    level,
    reasons,
    suggestedAmount: suggested > 0n && suggested !== amount ? suggested : undefined,
    suggestedDelayHours: level === "warn" ? 24 : undefined,
  };
}

export function checkDeposit(amount: bigint, cfg: PoolConfig): EdgeCheck {
  const g = cfg.depositGranularity > 0n ? cfg.depositGranularity : UNITS;
  if (amount % g === 0n) return { level: "ok", reasons: [] };
  return {
    level: "notice",
    reasons: ["Deposits are public. A round amount reveals less about your starting balance than a specific one."],
    suggestedAmount: niceAmount(amount) > 0n ? niceAmount(amount) : undefined,
  };
}
