// ConfidentialClient: the one object the UI talks to. It owns the crypto backend, the user's
// encryption key, and the view of the confidential state. In MOCK mode the "contract" is a
// simulated pool kept in localStorage (docs/01-design.md §4 semantics: available/pending split,
// nonce, granularity). In REAL mode the same methods build the §4.2 actions and broadcast them
// through the WebAuth session (needs the T3 contract on xprconf).
import { CONTRACT } from "../config";
import * as chain from "./chain";
import type { Session } from "./chain";
import type { ChunkedCiphertext, CryptoBackend, EncryptionKeypair, Hex, ProgressFn } from "./crypto/types";
import { shortHex } from "./format";
import type { IncomingEvent, PoolConfig } from "./privacy";
import { XMD, XPR, type Token } from "./token";
import { chunkedAdd, decryptChunk, join64 } from "./crypto/real";
import { L } from "./crypto/babyjub";

export type ActivityKind = "register" | "deposit" | "send" | "receive" | "fold" | "withdraw";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  ts: number;
  amount?: bigint;
  counterparty?: string;
  /** what the chain shows */
  onChain: { public: boolean; ciphertext?: string; proof?: string; txid?: string; block?: number };
  /** shown before the indexer has it (optimistic, from the action we just sent) */
  confirming?: boolean;
  /** which token this row belongs to (Activity shows all tokens together) */
  token?: Token;
}

export interface ConfState {
  /** the token this state is for */
  token: Token;
  registered: boolean;
  pubkey?: Hex;
  balance: bigint; // decrypted available
  pending: bigint; // decrypted pending total
  pendingCount: number;
  nonce: bigint;
  balanceCiphertext?: ChunkedCiphertext;
  activity: ActivityItem[];
  incoming: IncomingEvent[];
  edgesSinceLastIncoming: number;
  /** false while the ledger has not been fetched yet (statement shown first) */
  historyLoaded?: boolean;
  config: PoolConfig;
  peers: { name: string; pubkey: Hex }[];
}

export interface AuditorRow {
  ts: number;
  from: string;
  to: string;
  amount: bigint;
  ciphertext: string;
  block?: number;
}

// ------------------------------------------------------------------ mock pool (localStorage)

interface MockAccount {
  pubkey: Hex;
  balance: string; // bigint as string
  balanceCt?: ChunkedCiphertext;
  pending: { amount: string; from: string; ts: number; ct: string }[];
  nonce: string;
  activity: (Omit<ActivityItem, "amount"> & { amount?: string })[];
  incoming: { amount: string; ts: number; from: string }[];
  lastIncomingEdge: number;
}

interface MockPool {
  accounts: Record<string, MockAccount>;
  edges: number; // total deposits + withdrawals in the pool
  escrow: string;
  config: { withdrawGranularity: string; depositGranularity: string };
  auditorSecret: Hex;
  auditorPubkey: Hex;
  ledger: { ts: number; from: string; to: string; amount: string; ciphertext: string; block: number }[];
  block: number;
}

const POOL_KEY_BASE = "pulse-privacy/mockpool/v2";
/** one simulated pool per token; XPR keeps the original key */
const poolKey = (token: Token) => (token.code === "XPR" ? POOL_KEY_BASE : `${POOL_KEY_BASE}/${token.code}`);
const PEERS = ["alice", "bob", "carol", "dave", "erin"];
/** the simulation lists XPR and XMD so the switch can be exercised without a chain */
export const MOCK_TOKENS: Token[] = [XPR, XMD];

async function loadPool(backend: CryptoBackend, token: Token): Promise<MockPool> {
  try {
    const raw = localStorage.getItem(poolKey(token));
    if (raw) return JSON.parse(raw) as MockPool;
  } catch {
    /* fallthrough */
  }
  const U = token.units;
  const auditorSecret = ("0x" + "a1".repeat(32)) as Hex;
  const pool: MockPool = {
    accounts: {},
    edges: 3,
    escrow: (25_000n * U).toString(),
    config: { withdrawGranularity: U.toString(), depositGranularity: U.toString() },
    auditorSecret,
    auditorPubkey: await backend.pubkeyOf(auditorSecret),
    ledger: [],
    block: 404_500_000,
  };
  for (const p of PEERS) {
    const s = ("0x" + p.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)) as Hex;
    pool.accounts[p] = {
      pubkey: await backend.pubkeyOf(s),
      balance: (5_000n * U).toString(),
      pending: [],
      nonce: "0",
      activity: [],
      incoming: [],
      lastIncomingEdge: 0,
    };
  }
  savePool(pool, token);
  return pool;
}

function savePool(pool: MockPool, token: Token) {
  localStorage.setItem(poolKey(token), JSON.stringify(pool));
}

const id = () => Math.random().toString(36).slice(2, 10);
const txid = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

// ------------------------------------------------------------------ client

export class ConfidentialClient {
  constructor(
    public readonly backend: CryptoBackend,
    public readonly session: Session,
    public keypair: EncryptionKeypair | null,
    /** the confidential token this client operates on */
    public readonly token: Token = XPR
  ) {}

  get actor() {
    return this.session.auth.actor;
  }
  get isMock() {
    return this.backend.isMock;
  }

  // ---------------------------------------------------------------- state

  /** `history: false` returns balances only (fast); the ledger is loaded separately. */
  async state(opts: { history?: boolean } = {}): Promise<ConfState> {
    if (this.isMock) return this.mockState();
    return this.realState(opts.history !== false);
  }

  private async mockState(): Promise<ConfState> {
    const pool = await loadPool(this.backend, this.token);
    const cfg: PoolConfig = {
      withdrawGranularity: BigInt(pool.config.withdrawGranularity),
      depositGranularity: BigInt(pool.config.depositGranularity),
      units: this.token.units,
    };
    const peers = Object.entries(pool.accounts)
      .filter(([n]) => n !== this.actor)
      .map(([name, a]) => ({ name, pubkey: a.pubkey }));
    const a = pool.accounts[this.actor];
    if (!a) {
      return { token: this.token, registered: false, balance: 0n, pending: 0n, pendingCount: 0, nonce: 0n, activity: [], incoming: [], edgesSinceLastIncoming: pool.edges, config: cfg, peers };
    }
    const pending = a.pending.reduce((s, p) => s + BigInt(p.amount), 0n);
    return {
      token: this.token,
      registered: true,
      pubkey: a.pubkey,
      balance: BigInt(a.balance),
      pending,
      pendingCount: a.pending.length,
      nonce: BigInt(a.nonce),
      balanceCiphertext: a.balanceCt,
      activity: a.activity.map((x) => ({ ...x, amount: x.amount === undefined ? undefined : BigInt(x.amount) })).sort((x, y) => y.ts - x.ts),
      incoming: a.incoming.map((i) => ({ amount: BigInt(i.amount), ts: i.ts, from: i.from })),
      edgesSinceLastIncoming: pool.edges - a.lastIncomingEdge,
      config: cfg,
      peers,
    };
  }

  private async realState(withHistory = true): Promise<ConfState> {
    const t = this.token;
    const [row, cfgRow, all] = await Promise.all([chain.getConfAccount(this.actor, t), chain.getConfConfig(t), chain.listConfAccounts(t)]);
    const cfg: PoolConfig = {
      withdrawGranularity: cfgRow?.withdrawGranularity ?? t.units,
      depositGranularity: cfgRow?.depositGranularity ?? 0n,
      units: t.units,
    };
    const peers = all.filter((a) => a.owner !== this.actor).map((a) => ({ name: a.owner, pubkey: a.enc_pubkey }));
    const empty: ConfState = { token: t, registered: !!row, pubkey: row?.enc_pubkey, balance: 0n, pending: 0n, pendingCount: 0, nonce: 0n, activity: [], incoming: [], edgesSinceLastIncoming: 0, config: cfg, peers };
    if (!row) {
      // Registered for another token? The contract creates this token's row on first deposit or receipt.
      const elsewhere = await chain.findKeyAnywhere(this.actor);
      if (elsewhere) return { ...empty, registered: true, pubkey: elsewhere.pubkey, historyLoaded: true };
      return empty;
    }
    if (!this.keypair) return empty;
    const secret = this.keypair.secret;
    const balance = await this.backend.decryptAmount(row.avail, secret);
    const pending = row.pending_count > 0 ? await this.backend.decryptAmount(row.pending, secret) : 0n;

    // history: what happened to me, what I received, and how busy the pool has been since
    let history: chain.PoolAction[] = [];
    let historyLoaded = false;
    if (withHistory) {
      try {
        history = await chain.poolHistory(200, t);
        historyLoaded = true;
      } catch {
        /* Hyperion down: balances still work, activity is empty */
      }
    }
    const activity: ActivityItem[] = [];
    const incoming: IncomingEvent[] = [];
    let lastIncomingBlock = 0;
    for (const h of history) {
      const mine = h.from === this.actor || h.to === this.actor;
      if (h.kind === "send" && h.t) {
        const ctShort = shortHex(h.t.lo.c, 8);
        const pf = h.proof ? shortHex(h.proof, 6) : undefined;
        if (h.to === this.actor) {
          let amount: bigint | undefined;
          try {
            amount = await this.backend.decryptAmount(chain.receiverView(h.t), secret);
          } catch {
            amount = undefined; // sent to a previous key of ours
          }
          if (amount !== undefined) {
            incoming.push({ amount, ts: h.ts, from: h.from });
            lastIncomingBlock = Math.max(lastIncomingBlock, h.block);
          }
          activity.push({ id: `${h.txid}/${h.seq}`, kind: "receive", ts: h.ts, amount, counterparty: h.from, onChain: { public: false, ciphertext: ctShort, proof: pf, txid: h.txid, block: h.block } });
        } else if (h.from === this.actor) {
          let amount: bigint | undefined;
          try {
            amount = await this.backend.decryptAmount(chain.senderView(h.t), secret);
          } catch {
            amount = undefined;
          }
          activity.push({ id: `${h.txid}/${h.seq}`, kind: "send", ts: h.ts, amount, counterparty: h.to, onChain: { public: false, ciphertext: ctShort, proof: pf, txid: h.txid, block: h.block } });
        }
      } else if (h.kind === "deposit" && h.to === this.actor) {
        activity.push({ id: `${h.txid}/${h.seq}`, kind: "deposit", ts: h.ts, amount: h.amount, counterparty: h.from === this.actor ? undefined : h.from, onChain: { public: true, txid: h.txid, block: h.block } });
      } else if (h.kind === "withdraw" && h.to === this.actor) {
        activity.push({ id: `${h.txid}/${h.seq}`, kind: "withdraw", ts: h.ts, amount: h.amount, onChain: { public: true, txid: h.txid, block: h.block } });
      } else if ((h.kind === "fold" || h.kind === "register") && mine) {
        activity.push({ id: `${h.txid}/${h.seq}`, kind: h.kind, ts: h.ts, onChain: { public: h.kind === "register", ciphertext: h.kind === "fold" ? "●●●●" : undefined, txid: h.txid, block: h.block } });
      }
    }
    const edgesSinceLastIncoming = history.filter((h) => (h.kind === "deposit" || h.kind === "withdraw") && h.block > lastIncomingBlock && h.to !== this.actor).length;

    return {
      token: t,
      registered: true,
      pubkey: row.enc_pubkey,
      balance,
      pending,
      pendingCount: row.pending_count,
      nonce: BigInt(row.nonce),
      balanceCiphertext: row.avail,
      activity: activity.sort((a, b) => b.ts - a.ts).map((a) => ({ ...a, token: t })),
      incoming,
      edgesSinceLastIncoming,
      historyLoaded,
      config: cfg,
      peers,
    };
  }

  // ---------------------------------------------------------------- actions

  private need(): EncryptionKeypair {
    if (!this.keypair) throw new Error("no encryption key. Create or import one in Settings.");
    return this.keypair;
  }

  async register(): Promise<string> {
    const kp = this.need();
    if (this.isMock) {
      const pool = await loadPool(this.backend, this.token);
      if (pool.accounts[this.actor]) throw new Error("already registered");
      pool.accounts[this.actor] = {
        pubkey: kp.pubkey,
        balance: "0",
        balanceCt: await this.backend.encryptAmount(0n, kp.pubkey),
        pending: [],
        nonce: "0",
        activity: [{ id: id(), kind: "register", ts: Date.now(), onChain: { public: true, txid: txid(), block: ++pool.block } }],
        incoming: [],
        lastIncomingEdge: pool.edges,
      };
      savePool(pool, this.token);
      return "mock";
    }
    const existing = await chain.getConfAccount(this.actor, this.token);
    if (existing) {
      if (existing.enc_pubkey.toLowerCase() !== kp.pubkey.toLowerCase()) throw new Error("this account is registered with a different encryption key. Import that key in Settings.");
      throw new Error(`already registered for ${this.token.code}`);
    }
    return chain.broadcast(this.session, [chain.registerAction(this.session, this.token, kp.pubkey)]);
  }

  /** First run: publish the key and make the first deposit in one transaction (one signature). */
  async registerAndDeposit(amount: bigint): Promise<string> {
    if (amount <= 0n) throw new Error("amount must be positive");
    const kp = this.need();
    if (this.isMock) {
      await this.register();
      return this.deposit(amount);
    }
    const existing = await chain.getConfAccount(this.actor, this.token);
    if (existing) throw new Error(`already registered for ${this.token.code}`);
    return chain.broadcast(this.session, [chain.registerAction(this.session, this.token, kp.pubkey), chain.depositAction(this.session, this.token, amount)]);
  }

  async deposit(amount: bigint): Promise<string> {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (this.isMock) {
      const pool = await loadPool(this.backend, this.token);
      const a = pool.accounts[this.actor];
      if (!a) throw new Error("register first");
      const ct = await this.backend.encryptAmount(amount, a.pubkey);
      a.pending.push({ amount: amount.toString(), from: this.actor, ts: Date.now(), ct: ct.lo.c });
      pool.escrow = (BigInt(pool.escrow) + amount).toString();
      pool.edges += 1;
      const t = txid();
      a.activity.push({ id: id(), kind: "deposit", ts: Date.now(), amount: amount.toString(), onChain: { public: true, txid: t, block: ++pool.block } });
      savePool(pool, this.token);
      return t;
    }
    return chain.broadcast(this.session, [chain.depositAction(this.session, this.token, amount)]);
  }

  async applyPending(): Promise<string> {
    if (this.isMock) {
      const pool = await loadPool(this.backend, this.token);
      const a = pool.accounts[this.actor];
      if (!a) throw new Error("register first");
      if (!a.pending.length) return "";
      const total = a.pending.reduce((s, p) => s + BigInt(p.amount), 0n);
      a.balance = (BigInt(a.balance) + total).toString();
      a.balanceCt = await this.backend.encryptAmount(BigInt(a.balance), a.pubkey);
      a.pending = [];
      const t = txid();
      a.activity.push({ id: id(), kind: "fold", ts: Date.now(), amount: total.toString(), onChain: { public: false, ciphertext: shortHex(a.balanceCt.lo.c, 8), txid: t, block: ++pool.block } });
      savePool(pool, this.token);
      return t;
    }
    return chain.broadcast(this.session, [chain.applyPendingAction(this.session, this.token)]);
  }

  async send(to: string, amount: bigint, onProgress?: ProgressFn): Promise<string> {
    const kp = this.need();
    if (to === this.actor) throw new Error("that is you");
    if (amount <= 0n) throw new Error("amount must be positive");

    if (this.isMock) {
      // fold pending first (same tx in the real flow)
      const pre = await loadPool(this.backend, this.token);
      if (pre.accounts[this.actor]?.pending.length) await this.applyPending();
      const pool = await loadPool(this.backend, this.token);
      const a = pool.accounts[this.actor];
      const b = pool.accounts[to];
      if (!a) throw new Error("register first");
      if (!b) throw new Error(`${to} has not registered an encryption key for ${this.token.code}. They can only receive public ${this.token.code}.`);
      const oldBalance = BigInt(a.balance);
      const out = await this.backend.proveTransfer(
        {
          sender: this.actor,
          receiver: to,
          nonce: BigInt(a.nonce),
          amount,
          oldBalance,
          oldBalanceCiphertext: a.balanceCt ?? (await this.backend.encryptAmount(oldBalance, a.pubkey)),
          senderKeypair: kp,
          receiverPubkey: b.pubkey,
          auditorPubkey: pool.auditorPubkey,
        },
        onProgress
      );
      // "contract": replace sender avail, add to receiver pending, nonce++
      a.balance = (oldBalance - amount).toString();
      a.balanceCt = out.newBalance;
      a.nonce = (BigInt(a.nonce) + 1n).toString();
      const now = Date.now();
      const t = txid();
      const block = ++pool.block;
      const ctShort = shortHex(out.transfer.lo.c, 8);
      b.pending.push({ amount: amount.toString(), from: this.actor, ts: now, ct: out.transfer.lo.c });
      b.incoming.push({ amount: amount.toString(), ts: now, from: this.actor });
      b.lastIncomingEdge = pool.edges;
      b.activity.push({ id: id(), kind: "receive", ts: now, amount: amount.toString(), counterparty: this.actor, onChain: { public: false, ciphertext: ctShort, proof: shortHex(out.proof, 6), txid: t, block } });
      a.activity.push({ id: id(), kind: "send", ts: now, amount: amount.toString(), counterparty: to, onChain: { public: false, ciphertext: ctShort, proof: shortHex(out.proof, 6), txid: t, block } });
      pool.ledger.push({ ts: now, from: this.actor, to, amount: amount.toString(), ciphertext: ctShort, block });
      savePool(pool, this.token);
      return t;
    }

    // real: fold pending (same transaction) and prove against the folded balance
    const { row, cfg, folded, oldBalance, actions } = await this.prepareSpend(kp, onProgress);
    const peerRow = await chain.getConfAccount(to, this.token);
    const peer = peerRow ?? (await chain.findKeyAnywhere(to).then((k) => (k ? { enc_pubkey: k.pubkey } : null)));
    if (!peer) throw new Error(`${to} has not set up Confidential XPR yet (no encryption key on chain for any token). They can only receive public ${this.token.code}.`);
    const out = await this.backend.proveTransfer(
      {
        sender: this.actor,
        receiver: to,
        nonce: BigInt(row.nonce),
        amount,
        oldBalance,
        oldBalanceCiphertext: folded,
        senderKeypair: kp,
        receiverPubkey: peer.enc_pubkey,
        auditorPubkey: cfg.auditorPubkey,
      },
      onProgress
    );
    actions.push(chain.transferAction(this.session, this.token, to, out.transfer, out.newBalance, out.proof, this.need().pubkey, peer.enc_pubkey, cfg.auditorPubkey));
    onProgress?.(0.97, "waiting for WebAuth signature");
    return chain.broadcast(this.session, actions);
  }

  /**
   * Common prelude for send/withdraw in real mode: read the row and config, and if there is
   * pending credit, prepend `applypending` and compute the folded ciphertext locally
   * (homomorphic add; identical to what the contract will store).
   */
  private async prepareSpend(kp: EncryptionKeypair, onProgress?: ProgressFn) {
    const [row, cfg] = await Promise.all([chain.getConfAccount(this.actor, this.token), chain.getConfConfig(this.token)]);
    if (!row) throw new Error(`register for ${this.token.code} first`);
    if (!cfg) throw new Error(`the contract is not configured for ${this.token.code}`);
    if (cfg.paused) throw new Error(`confidential ${this.token.code} is paused`);
    const actions: unknown[] = [];
    let folded = row.avail;
    if (row.pending_count > 0) {
      actions.push(chain.applyPendingAction(this.session, this.token));
      folded = chunkedAdd(row.avail, row.pending);
    }
    onProgress?.(0.02, "reading your balance");
    const s = BigInt(kp.secret) % L;
    const oldBalance = join64(decryptChunk(folded.lo, s), decryptChunk(folded.hi, s));
    return { row, cfg, folded, oldBalance, actions };
  }

  async withdraw(amount: bigint, onProgress?: ProgressFn): Promise<string> {
    const kp = this.need();
    if (amount <= 0n) throw new Error("amount must be positive");
    if (this.isMock) {
      const pre = await loadPool(this.backend, this.token);
      if (pre.accounts[this.actor]?.pending.length) await this.applyPending();
      const pool = await loadPool(this.backend, this.token);
      const a = pool.accounts[this.actor];
      if (!a) throw new Error("register first");
      const g = BigInt(pool.config.withdrawGranularity);
      if (g > 0n && amount % g !== 0n) throw new Error("contract: amount must be a multiple of the withdraw granularity");
      const oldBalance = BigInt(a.balance);
      const out = await this.backend.proveWithdraw(
        { owner: this.actor, nonce: BigInt(a.nonce), amount, oldBalance, oldBalanceCiphertext: a.balanceCt ?? (await this.backend.encryptAmount(oldBalance, a.pubkey)), keypair: kp, auditorPubkey: pool.auditorPubkey },
        onProgress
      );
      a.balance = (oldBalance - amount).toString();
      a.balanceCt = out.newBalance;
      a.nonce = (BigInt(a.nonce) + 1n).toString();
      pool.escrow = (BigInt(pool.escrow) - amount).toString();
      pool.edges += 1;
      const t = txid();
      a.activity.push({ id: id(), kind: "withdraw", ts: Date.now(), amount: amount.toString(), onChain: { public: true, proof: shortHex(out.proof, 6), txid: t, block: ++pool.block } });
      savePool(pool, this.token);
      return t;
    }
    const { row, cfg, folded, oldBalance, actions } = await this.prepareSpend(kp, onProgress);
    if (cfg.withdrawGranularity > 0n && amount % cfg.withdrawGranularity !== 0n) {
      throw new Error(`the contract only accepts withdrawals in multiples of ${cfg.withdrawGranularity / this.token.units} ${this.token.code}`);
    }
    const out = await this.backend.proveWithdraw(
      { owner: this.actor, nonce: BigInt(row.nonce), amount, oldBalance, oldBalanceCiphertext: folded, keypair: kp, auditorPubkey: cfg.auditorPubkey },
      onProgress
    );
    actions.push(chain.withdrawAction(this.session, this.token, amount, out.newBalance, out.proof, this.need().pubkey, cfg.auditorPubkey));
    onProgress?.(0.97, "waiting for WebAuth signature");
    return chain.broadcast(this.session, actions);
  }

  // ---------------------------------------------------------------- mock-only helpers

  /** Simulate a peer paying you (mock only). */
  async simulateIncoming(from: string, amount: bigint): Promise<void> {
    if (!this.isMock) throw new Error("mock only");
    const pool = await loadPool(this.backend, this.token);
    const a = pool.accounts[this.actor];
    const p = pool.accounts[from];
    if (!a || !p) throw new Error("register first");
    if (BigInt(p.balance) < amount) throw new Error(`${from} does not have that much (mock peers start with 5,000)`);
    p.balance = (BigInt(p.balance) - amount).toString();
    const ct = await this.backend.encryptAmount(amount, a.pubkey);
    const now = Date.now();
    const block = ++pool.block;
    const ctShort = shortHex(ct.lo.c, 8);
    a.pending.push({ amount: amount.toString(), from, ts: now, ct: ct.lo.c });
    a.incoming.push({ amount: amount.toString(), ts: now, from });
    a.lastIncomingEdge = pool.edges;
    a.activity.push({ id: id(), kind: "receive", ts: now, amount: amount.toString(), counterparty: from, onChain: { public: false, ciphertext: ctShort, proof: "0x…", txid: txid(), block } });
    pool.ledger.push({ ts: now, from, to: this.actor, amount: amount.toString(), ciphertext: ctShort, block });
    savePool(pool, this.token);
  }

  /** Simulate other people's deposits/withdrawals (mock only): the pool's edge counter moves. */
  async simulatePoolActivity(n = 5): Promise<void> {
    if (!this.isMock) throw new Error("mock only");
    const pool = await loadPool(this.backend, this.token);
    pool.edges += n;
    pool.block += n * 7;
    savePool(pool, this.token);
  }

  async resetMock(): Promise<void> {
    for (const t of MOCK_TOKENS) localStorage.removeItem(poolKey(t));
  }

  async escrow(): Promise<bigint> {
    if (this.isMock) return BigInt((await loadPool(this.backend, this.token)).escrow);
    return chain.getPublicBalance(CONTRACT, this.token);
  }

  // ---------------------------------------------------------------- auditor

  async auditorLedger(viewingSecret: Hex): Promise<AuditorRow[]> {
    if (this.isMock) {
      const pool = await loadPool(this.backend, this.token);
      if (viewingSecret.toLowerCase() !== pool.auditorSecret) throw new Error("that viewing key does not open these boxes");
      return pool.ledger.map((l) => ({ ...l, amount: BigInt(l.amount) })).sort((a, b) => b.ts - a.ts);
    }
    const cfg = await chain.getConfConfig(this.token);
    if (!cfg) throw new Error(`the contract is not configured for ${this.token.code}`);
    const expected = await this.backend.pubkeyOf(viewingSecret);
    if (expected.toLowerCase() !== cfg.auditorPubkey.toLowerCase()) throw new Error("that viewing key does not match the pool's auditor key");
    const history = await chain.poolHistory(500, this.token);
    const rows: AuditorRow[] = [];
    for (const h of history) {
      if (h.kind !== "send" || !h.t) continue;
      const amount = await this.backend.decryptAmount(chain.auditorView(h.t), viewingSecret);
      rows.push({ ts: h.ts, from: h.from, to: h.to, amount, ciphertext: shortHex(h.t.lo.c, 8), block: h.block });
    }
    return rows.sort((a, b) => b.ts - a.ts);
  }

  /** Public edges of the pool (for the auditor's reconciliation): deposits, withdrawals, escrow. */
  async poolEdges(): Promise<{ deposits: bigint; withdrawals: bigint; unclaimed: bigint; escrow: bigint; count: number }> {
    if (this.isMock) {
      const pool = await loadPool(this.backend, this.token);
      return { deposits: 0n, withdrawals: 0n, unclaimed: 0n, escrow: BigInt(pool.escrow), count: pool.edges };
    }
    const [history, escrow] = await Promise.all([chain.poolHistory(500, this.token), chain.getPublicBalance(CONTRACT, this.token)]);
    let deposits = 0n;
    let withdrawals = 0n;
    let unclaimed = 0n;
    let count = 0;
    for (const h of history) {
      if (h.kind === "deposit") {
        deposits += h.amount ?? 0n;
        count++;
      } else if (h.kind === "withdraw") {
        withdrawals += h.amount ?? 0n;
        count++;
      } else if (h.kind === "plain-transfer") unclaimed += h.amount ?? 0n;
    }
    return { deposits, withdrawals, unclaimed, escrow, count };
  }

  async mockAuditorSecret(): Promise<Hex | null> {
    if (!this.isMock) return null;
    return (await loadPool(this.backend, this.token)).auditorSecret;
  }
}
