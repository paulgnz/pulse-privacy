// ConfidentialClient: the one object the UI talks to. It owns the crypto backend, the user's
// encryption key, and the view of the confidential state. In MOCK mode the "contract" is a
// simulated pool kept in localStorage (docs/01-design.md §4 semantics: available/pending split,
// nonce, granularity). In REAL mode the same methods build the §4.2 actions and broadcast them
// through the WebAuth session (needs the T3 contract on xprconf).
import { CONTRACT } from "../config";
import * as chain from "./chain";
import type { Session } from "./chain";
import type { ChunkedCiphertext, CryptoBackend, EncryptionKeypair, Hex, ProgressFn } from "./crypto/types";
import { UNITS, shortHex } from "./format";
import type { IncomingEvent, PoolConfig } from "./privacy";

export type ActivityKind = "register" | "deposit" | "send" | "receive" | "fold" | "withdraw";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  ts: number;
  amount?: bigint;
  counterparty?: string;
  /** what the chain shows */
  onChain: { public: boolean; ciphertext?: string; proof?: string; txid?: string; block?: number };
}

export interface ConfState {
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

const POOL_KEY = "pulse-privacy/mockpool/v2";
const PEERS = ["alice", "bob", "carol", "dave", "erin"];

async function loadPool(backend: CryptoBackend): Promise<MockPool> {
  try {
    const raw = localStorage.getItem(POOL_KEY);
    if (raw) return JSON.parse(raw) as MockPool;
  } catch {
    /* fallthrough */
  }
  const auditorSecret = ("0x" + "a1".repeat(32)) as Hex;
  const pool: MockPool = {
    accounts: {},
    edges: 3,
    escrow: (25_000n * UNITS).toString(),
    config: { withdrawGranularity: UNITS.toString(), depositGranularity: UNITS.toString() },
    auditorSecret,
    auditorPubkey: await backend.pubkeyOf(auditorSecret),
    ledger: [],
    block: 404_500_000,
  };
  for (const p of PEERS) {
    const s = ("0x" + p.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)) as Hex;
    pool.accounts[p] = {
      pubkey: await backend.pubkeyOf(s),
      balance: (5_000n * UNITS).toString(),
      pending: [],
      nonce: "0",
      activity: [],
      incoming: [],
      lastIncomingEdge: 0,
    };
  }
  savePool(pool);
  return pool;
}

function savePool(pool: MockPool) {
  localStorage.setItem(POOL_KEY, JSON.stringify(pool));
}

const id = () => Math.random().toString(36).slice(2, 10);
const txid = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

// ------------------------------------------------------------------ client

export class ConfidentialClient {
  constructor(
    public readonly backend: CryptoBackend,
    public readonly session: Session,
    public keypair: EncryptionKeypair | null
  ) {}

  get actor() {
    return this.session.auth.actor;
  }
  get isMock() {
    return this.backend.isMock;
  }

  // ---------------------------------------------------------------- state

  async state(): Promise<ConfState> {
    if (this.isMock) return this.mockState();
    return this.realState();
  }

  private async mockState(): Promise<ConfState> {
    const pool = await loadPool(this.backend);
    const cfg: PoolConfig = {
      withdrawGranularity: BigInt(pool.config.withdrawGranularity),
      depositGranularity: BigInt(pool.config.depositGranularity),
    };
    const peers = Object.entries(pool.accounts)
      .filter(([n]) => n !== this.actor)
      .map(([name, a]) => ({ name, pubkey: a.pubkey }));
    const a = pool.accounts[this.actor];
    if (!a) {
      return { registered: false, balance: 0n, pending: 0n, pendingCount: 0, nonce: 0n, activity: [], incoming: [], edgesSinceLastIncoming: pool.edges, config: cfg, peers };
    }
    const pending = a.pending.reduce((s, p) => s + BigInt(p.amount), 0n);
    return {
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

  private async realState(): Promise<ConfState> {
    const row = await chain.getConfAccount(this.actor);
    const cfg: PoolConfig = { withdrawGranularity: UNITS, depositGranularity: UNITS };
    if (!row || !this.keypair) {
      return { registered: !!row, balance: 0n, pending: 0n, pendingCount: 0, nonce: 0n, activity: [], incoming: [], edgesSinceLastIncoming: 0, config: cfg, peers: [] };
    }
    const balance = await this.backend.decryptAmount(row.avail, this.keypair.secret);
    const pending = await this.backend.decryptAmount(row.pending, this.keypair.secret);
    return {
      registered: true,
      pubkey: row.enc_pubkey,
      balance,
      pending,
      pendingCount: row.pending_count,
      nonce: BigInt(row.nonce),
      balanceCiphertext: row.avail,
      activity: [], // T4b: rebuild from Hyperion history
      incoming: [],
      edgesSinceLastIncoming: 0,
      config: cfg,
      peers: [],
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
      const pool = await loadPool(this.backend);
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
      savePool(pool);
      return "mock";
    }
    const pok = ("0x" + "00".repeat(64)) as Hex; // T2: Schnorr proof of knowledge of s
    return chain.broadcast(this.session, [chain.registerAction(this.session, kp.pubkey, pok)]);
  }

  async deposit(amount: bigint): Promise<string> {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (this.isMock) {
      const pool = await loadPool(this.backend);
      const a = pool.accounts[this.actor];
      if (!a) throw new Error("register first");
      const ct = await this.backend.encryptAmount(amount, a.pubkey);
      a.pending.push({ amount: amount.toString(), from: this.actor, ts: Date.now(), ct: ct.lo.c });
      pool.escrow = (BigInt(pool.escrow) + amount).toString();
      pool.edges += 1;
      const t = txid();
      a.activity.push({ id: id(), kind: "deposit", ts: Date.now(), amount: amount.toString(), onChain: { public: true, txid: t, block: ++pool.block } });
      savePool(pool);
      return t;
    }
    return chain.broadcast(this.session, [chain.depositAction(this.session, amount)]);
  }

  async applyPending(): Promise<string> {
    if (this.isMock) {
      const pool = await loadPool(this.backend);
      const a = pool.accounts[this.actor];
      if (!a) throw new Error("register first");
      if (!a.pending.length) return "";
      const total = a.pending.reduce((s, p) => s + BigInt(p.amount), 0n);
      a.balance = (BigInt(a.balance) + total).toString();
      a.balanceCt = await this.backend.encryptAmount(BigInt(a.balance), a.pubkey);
      a.pending = [];
      const t = txid();
      a.activity.push({ id: id(), kind: "fold", ts: Date.now(), amount: total.toString(), onChain: { public: false, ciphertext: shortHex(a.balanceCt.lo.c, 8), txid: t, block: ++pool.block } });
      savePool(pool);
      return t;
    }
    return chain.broadcast(this.session, [chain.applyPendingAction(this.session)]);
  }

  async send(to: string, amount: bigint, onProgress?: ProgressFn): Promise<string> {
    const kp = this.need();
    if (to === this.actor) throw new Error("that is you");
    if (amount <= 0n) throw new Error("amount must be positive");

    if (this.isMock) {
      // fold pending first (same tx in the real flow)
      const pre = await loadPool(this.backend);
      if (pre.accounts[this.actor]?.pending.length) await this.applyPending();
      const pool = await loadPool(this.backend);
      const a = pool.accounts[this.actor];
      const b = pool.accounts[to];
      if (!a) throw new Error("register first");
      if (!b) throw new Error(`${to} has not registered an encryption key. They can only receive public XPR.`);
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
      savePool(pool);
      return t;
    }

    // real: needs receiver pubkey + auditor pubkey from the contract tables (T3)
    const row = await chain.getConfAccount(this.actor);
    const peer = await chain.getConfAccount(to);
    if (!row) throw new Error("register first");
    if (!peer) throw new Error(`${to} has not registered an encryption key`);
    const oldBalance = await this.backend.decryptAmount(row.avail, kp.secret);
    const out = await this.backend.proveTransfer(
      {
        sender: this.actor,
        receiver: to,
        nonce: BigInt(row.nonce),
        amount,
        oldBalance,
        oldBalanceCiphertext: row.avail,
        senderKeypair: kp,
        receiverPubkey: peer.enc_pubkey,
        auditorPubkey: ("0x" + "00".repeat(32)) as Hex, // T3: read from config table
      },
      onProgress
    );
    const actions: unknown[] = [];
    if (row.pending_count > 0) actions.push(chain.applyPendingAction(this.session));
    actions.push(chain.transferAction(this.session, to, out.transfer, out.newBalance, out.proof));
    return chain.broadcast(this.session, actions);
  }

  async withdraw(amount: bigint, onProgress?: ProgressFn): Promise<string> {
    const kp = this.need();
    if (amount <= 0n) throw new Error("amount must be positive");
    if (this.isMock) {
      const pre = await loadPool(this.backend);
      if (pre.accounts[this.actor]?.pending.length) await this.applyPending();
      const pool = await loadPool(this.backend);
      const a = pool.accounts[this.actor];
      if (!a) throw new Error("register first");
      const g = BigInt(pool.config.withdrawGranularity);
      if (g > 0n && amount % g !== 0n) throw new Error("contract: amount must be a multiple of the withdraw granularity");
      const oldBalance = BigInt(a.balance);
      const out = await this.backend.proveWithdraw(
        { owner: this.actor, nonce: BigInt(a.nonce), amount, oldBalance, oldBalanceCiphertext: a.balanceCt ?? (await this.backend.encryptAmount(oldBalance, a.pubkey)), keypair: kp },
        onProgress
      );
      a.balance = (oldBalance - amount).toString();
      a.balanceCt = out.newBalance;
      a.nonce = (BigInt(a.nonce) + 1n).toString();
      pool.escrow = (BigInt(pool.escrow) - amount).toString();
      pool.edges += 1;
      const t = txid();
      a.activity.push({ id: id(), kind: "withdraw", ts: Date.now(), amount: amount.toString(), onChain: { public: true, proof: shortHex(out.proof, 6), txid: t, block: ++pool.block } });
      savePool(pool);
      return t;
    }
    const row = await chain.getConfAccount(this.actor);
    if (!row) throw new Error("register first");
    const oldBalance = await this.backend.decryptAmount(row.avail, kp.secret);
    const out = await this.backend.proveWithdraw({ owner: this.actor, nonce: BigInt(row.nonce), amount, oldBalance, oldBalanceCiphertext: row.avail, keypair: kp }, onProgress);
    const actions: unknown[] = [];
    if (row.pending_count > 0) actions.push(chain.applyPendingAction(this.session));
    actions.push(chain.withdrawAction(this.session, amount, out.newBalance, out.proof));
    return chain.broadcast(this.session, actions);
  }

  // ---------------------------------------------------------------- mock-only helpers

  /** Simulate a peer paying you (mock only). */
  async simulateIncoming(from: string, amount: bigint): Promise<void> {
    if (!this.isMock) throw new Error("mock only");
    const pool = await loadPool(this.backend);
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
    savePool(pool);
  }

  /** Simulate other people's deposits/withdrawals (mock only): the pool's edge counter moves. */
  async simulatePoolActivity(n = 5): Promise<void> {
    if (!this.isMock) throw new Error("mock only");
    const pool = await loadPool(this.backend);
    pool.edges += n;
    pool.block += n * 7;
    savePool(pool);
  }

  async resetMock(): Promise<void> {
    localStorage.removeItem(POOL_KEY);
  }

  async escrow(): Promise<bigint> {
    if (this.isMock) return BigInt((await loadPool(this.backend)).escrow);
    return chain.getPublicBalance(CONTRACT);
  }

  // ---------------------------------------------------------------- auditor

  async auditorLedger(viewingSecret: Hex): Promise<AuditorRow[]> {
    if (this.isMock) {
      const pool = await loadPool(this.backend);
      if (viewingSecret.toLowerCase() !== pool.auditorSecret) throw new Error("that viewing key does not open these boxes");
      return pool.ledger.map((l) => ({ ...l, amount: BigInt(l.amount) })).sort((a, b) => b.ts - a.ts);
    }
    throw new Error("auditor mode against the live contract arrives with T5 (auditor CLI / Hyperion)");
  }

  async mockAuditorSecret(): Promise<Hex | null> {
    if (!this.isMock) return null;
    return (await loadPool(this.backend)).auditorSecret;
  }
}
