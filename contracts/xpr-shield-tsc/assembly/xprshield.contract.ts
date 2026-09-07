import { Asset, Contract, ExtendedAsset, Name, Symbol, Table, TableStore, check, print, requireAuth } from "proton-tsc";
import { sendTransferTokens } from "proton-tsc/token";
import { groth16Verify } from "./groth16";
import { Limbs, fromBytesBE, fromU64, hex, isCanonicalBE, toBytesBE } from "./fr";
import { hash2, poseidon, zeroAt } from "./poseidon";
import { decompress, inPrimeSubgroup, onCurve } from "./curve";

// xprshield — shielded transfers (docs/06-shielded-design.md).
//
// A note is (pk, v, token, r); cm = Poseidon(pk.x, pk.y, v, token, r). Commitments sit in a
// depth-20 Poseidon Merkle tree that the contract maintains; every insertion is a pair (a
// transfer's two outputs, or a deposit's note with an empty slot). Spending publishes
// nullifiers Poseidon(nk, leafIndex). The owner's wallet signs `spend` (docs/06 §8): the chain
// sees who initiated it; the receiver, the amount and which notes were spent stay hidden.
//
// Public signals of the join-split proof, 27 words (circuits/shielded/joinsplit.circom):
//   [0,1] nf  [2,3] cm  [4..7] epk (x,y × 2)  [8..11] cr (2 × 2)  [12..17] ca (3 × 2)
//   [18,19] senderPk  [20] root  [21] vPub  [22] tokenPub  [23] to  [24] sender  [25,26] A
// The action carries 16 words: nf, cm, epk compressed (y with the parity of x in the top bit),
// cr, ca; plus `amount`, `token_id` and `root_seq` as native fields. The contract decompresses
// epk, looks the root up by sequence, and supplies senderPk, the name and the auditor key.

const DEPTH: i32 = 20;
const N_PUB: i32 = 27;
const N_ACTION: i32 = 16;
const ACTION_LEN: i32 = N_ACTION * 32;
const PROOF_LEN: i32 = 256;
const RING: u64 = 1024; // roots kept, so a proof survives this many insertions between proving and inclusion

@table("config")
class Config extends Table {
  constructor(
    public id: u64 = 0,
    public auditor_pubkey: u8[] = [], // 64 bytes, x ‖ y
    public vk: u8[] = [],
    public paused: bool = false
  ) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.id;
  }
}

@table("tokens")
class TokenRow extends Table {
  constructor(
    public sym: u64 = 0, // symbol raw
    public token_contract: Name = new Name(),
    public token_id: u64 = 0, // the `token` field inside notes (1 = XPR, 2 = XMD)
    public max_pool: u64 = 0, // 0 = no cap
    public max_deposit: u64 = 0,
    public min_deposit: u64 = 0, // dust deposits cost the contract RAM and tree slots
    public pool: u64 = 0, // deposits − withdrawals in escrow
    public deposits: u64 = 0,
    public withdrawals: u64 = 0
  ) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.sym;
  }
}

@table("keys")
class KeyRow extends Table {
  constructor(public owner: Name = new Name(), public pubkey: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.owner.N;
  }
}

@table("leaves")
class Leaf extends Table {
  constructor(public index: u64 = 0, public cm: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.index;
  }
}

/** the incremental tree: one filled node per level, the next leaf index, the current root */
@table("tree")
class TreeRow extends Table {
  constructor(
    public id: u64 = 0,
    public next_leaf: u64 = 0,
    public filled: u8[] = [], // DEPTH × 32 bytes
    public root: u8[] = [], // 32 bytes
    public root_seq: u64 = 0
  ) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.id;
  }
}

/** the last RING roots, keyed by sequence number, so a proof can name its root in 8 bytes */
@table("roots")
class RootRow extends Table {
  constructor(public seq: u64 = 0, public root: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.seq;
  }
}

/**
 * What a receiver needs to find and open a note, kept on chain so no history indexer is
 * needed: for transfer outputs the ephemeral key and both ciphertexts; for deposits the
 * plaintext (v, token, rho, r) in `cr` with `epk` and `ca` empty, since a deposit is public.
 */
@table("outputs")
class OutputRow extends Table {
  constructor(public index: u64 = 0, public epk: u8[] = [], public cr: u8[] = [], public ca: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.index;
  }
}

@table("nullifiers")
class NullifierRow extends Table {
  constructor(public key: u64 = 0, public nf: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.key;
  }
}

// ---------------------------------------------------------------- helpers

function word(a: u8[], i: i32): u8[] {
  return a.slice(i * 32, i * 32 + 32);
}
function low64(w: u8[]): u64 {
  let n: u64 = 0;
  for (let i = 24; i < 32; i++) n = (n << 8) | (w[i] as u64);
  return n;
}
function isZeroWord(w: u8[]): bool {
  for (let i = 0; i < 32; i++) if (w[i] != 0) return false;
  return true;
}
function u64Word(n: u64): u8[] {
  const w = new Array<u8>(32);
  for (let i = 0; i < 24; i++) w[i] = 0;
  for (let i = 31; i >= 24; i--) { w[i] = (n & 0xff) as u8; n >>= 8; }
  return w;
}
/** v + token·2^64 as a 32-byte word */
function packedWord(v: u64, token: u64): u8[] {
  const w = u64Word(v);
  w[23] = (token & 0xff) as u8;
  return w;
}
function bytesEq(a: u8[], b: u8[]): bool {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}
function hexNibble(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}
function fromHex(s: string): u8[] {
  check(s.length % 2 == 0, "odd hex length");
  const out = new Array<u8>(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const a = hexNibble(s.charCodeAt(2 * i));
    const b = hexNibble(s.charCodeAt(2 * i + 1));
    check(a >= 0 && b >= 0, "bad hex");
    out[i] = ((a << 4) | b) as u8;
  }
  return out;
}

@contract
class XprShield extends Contract {
  configs: TableStore<Config> = new TableStore<Config>(this.receiver);
  tokens: TableStore<TokenRow> = new TableStore<TokenRow>(this.receiver);
  keys: TableStore<KeyRow> = new TableStore<KeyRow>(this.receiver);
  leaves: TableStore<Leaf> = new TableStore<Leaf>(this.receiver);
  trees: TableStore<TreeRow> = new TableStore<TreeRow>(this.receiver);
  roots: TableStore<RootRow> = new TableStore<RootRow>(this.receiver);
  nullifiers: TableStore<NullifierRow> = new TableStore<NullifierRow>(this.receiver);
  outputs: TableStore<OutputRow> = new TableStore<OutputRow>(this.receiver);

  config(): Config {
    const c = this.configs.get(0);
    check(c != null, "not initialised");
    return c!;
  }
  tree(): TreeRow {
    const t = this.trees.get(0);
    check(t != null, "not initialised");
    return t!;
  }
  tokenById(id: u64): TokenRow {
    let t = this.tokens.first();
    while (t != null) {
      if (t.token_id == id) return t;
      t = this.tokens.next(t);
    }
    check(false, "unknown token id");
    return new TokenRow();
  }

  // ---------------------------------------------------------------- admin

  @action("init")
  init(auditor_pubkey: u8[], vk: u8[]): void {
    requireAuth(this.receiver);
    check(this.configs.get(0) == null, "already initialised");
    check(onCurve(auditor_pubkey), "auditor pubkey not on curve");
    check(vk.length == 64 + 3 * 128 + 64 * (N_PUB + 1), "vk length must match 27 public inputs");
    this.configs.store(new Config(0, auditor_pubkey, vk, false), this.receiver);
    const filled = new Array<u8>(DEPTH * 32);
    for (let i = 0; i < filled.length; i++) filled[i] = 0;
    const root = toBytesBE(zeroAt(DEPTH));
    const t = new TreeRow(0, 0, filled, root, 0);
    this.trees.store(t, this.receiver);
    this.rememberRoot(t, root);
    this.trees.update(t, this.receiver);
  }

  @action("addtoken")
  addtoken(sym: Symbol, token_contract: Name, token_id: u64, max_pool: u64, max_deposit: u64, min_deposit: u64): void {
    requireAuth(this.receiver);
    this.config();
    check(token_id > 0 && token_id < 256, "token id must be 1..255");
    const existing = this.tokens.get(sym.raw());
    if (existing == null) {
      this.tokens.store(new TokenRow(sym.raw(), token_contract, token_id, max_pool, max_deposit, min_deposit, 0, 0, 0), this.receiver);
    } else {
      const e = existing!;
      check(e.token_id == token_id && e.token_contract == token_contract, "token identity cannot change");
      e.max_pool = max_pool;
      e.max_deposit = max_deposit;
      e.min_deposit = min_deposit;
      this.tokens.update(e, this.receiver);
    }
  }

  @action("setvk")
  setvk(vk: u8[]): void {
    requireAuth(this.receiver);
    const c = this.config();
    check(vk.length == 64 + 3 * 128 + 64 * (N_PUB + 1), "vk length must match 27 public inputs");
    c.vk = vk;
    this.configs.update(c, this.receiver);
  }

  @action("setauditor")
  setauditor(auditor_pubkey: u8[]): void {
    requireAuth(this.receiver);
    const c = this.config();
    check(onCurve(auditor_pubkey), "auditor pubkey not on curve");
    c.auditor_pubkey = auditor_pubkey;
    this.configs.update(c, this.receiver);
  }

  /**
   * Testnet only: wipe every table so the contract can be re-initialised after a circuit
   * change. Requires the contract authority and the paused state. Escrowed tokens are not
   * returned; remove this action before any mainnet deployment.
   */
  @action("reset")
  reset(): void {
    requireAuth(this.receiver);
    const c = this.configs.get(0);
    check(c != null && c!.paused, "pause first");
    let l = this.leaves.first(); while (l != null) { const n = this.leaves.next(l); this.leaves.remove(l); l = n; }
    let o = this.outputs.first(); while (o != null) { const n = this.outputs.next(o); this.outputs.remove(o); o = n; }
    let f = this.nullifiers.first(); while (f != null) { const n = this.nullifiers.next(f); this.nullifiers.remove(f); f = n; }
    let r = this.roots.first(); while (r != null) { const n = this.roots.next(r); this.roots.remove(r); r = n; }
    let k = this.keys.first(); while (k != null) { const n = this.keys.next(k); this.keys.remove(k); k = n; }
    let t = this.tokens.first(); while (t != null) { const n = this.tokens.next(t); this.tokens.remove(t); t = n; }
    const tr = this.trees.get(0); if (tr != null) this.trees.remove(tr);
    this.configs.remove(c!);
  }

  @action("pause")
  pause(paused: bool): void {
    requireAuth(this.receiver);
    const c = this.config();
    c.paused = paused;
    this.configs.update(c, this.receiver);
  }

  // ---------------------------------------------------------------- keys

  /** Never broadcast; the dapp derives the spending key from the wallet's signature over it. */
  @action("viewkey")
  viewkey(owner: Name, note: string): void {
    requireAuth(owner);
    check(note.length <= 256, "note too long");
  }

  @action("register")
  register(owner: Name, pubkey: u8[]): void {
    requireAuth(owner);
    check(!this.config().paused, "paused");
    check(onCurve(pubkey), "pubkey not on curve");
    check(inPrimeSubgroup(pubkey), "pubkey is the identity or has low order");
    check(this.keys.get(owner.N) == null, "already registered");
    this.keys.store(new KeyRow(owner, pubkey), owner);
  }

  // ---------------------------------------------------------------- tree

  rememberRoot(t: TreeRow, root: u8[]): void {
    t.root = root;
    t.root_seq += 1;
    if (t.root_seq > RING) {
      const old = this.roots.get(t.root_seq - RING);
      if (old != null) this.roots.remove(old); // free the slot first, so a full account still turns the ring
    }
    this.roots.store(new RootRow(t.root_seq, root), this.receiver);
  }

  /** insert (cm1, cm2) as leaves next_leaf and next_leaf + 1 (20 hashes), record the root; `payer` pays the leaf rows */
  insertPair(cm1: Limbs, cm2: Limbs | null, cm1Bytes: u8[], cm2Bytes: u8[], payer: Name): u64 {
    const t = this.tree();
    const index = t.next_leaf;
    check(index % 2 == 0, "tree corrupt");
    check(index + 2 <= ((1 as u64) << (DEPTH as u64)), "tree full");
    let cur = hash2(cm1, cm2 == null ? zeroAt(0) : cm2!);
    let i = index >> 1;
    for (let level = 1; level < DEPTH; level++) {
      if ((i & 1) == 0) {
        const b = toBytesBE(cur);
        for (let k = 0; k < 32; k++) t.filled[level * 32 + k] = b[k];
        cur = hash2(cur, zeroAt(level));
      } else {
        cur = hash2(fromBytesBE(t.filled, level * 32), cur);
      }
      i >>= 1;
    }
    this.leaves.store(new Leaf(index, cm1Bytes), payer);
    if (cm2 != null) this.leaves.store(new Leaf(index + 1, cm2Bytes), payer);
    t.next_leaf = index + 2;
    this.rememberRoot(t, toBytesBE(cur));
    this.trees.update(t, this.receiver);
    return index;
  }

  spendNullifier(nf: u8[], payer: Name): void {
    if (isZeroWord(nf)) return;
    const key = low64(nf);
    const row = this.nullifiers.get(key);
    if (row != null) {
      check(!bytesEq(row.nf, nf), "note already spent");
      check(false, "nullifier key collision; contact the operator");
    }
    this.nullifiers.store(new NullifierRow(key, nf), payer);
  }

  // ---------------------------------------------------------------- deposit (notify)

  @action("transfer", notify)
  ontransfer(from: Name, to: Name, quantity: Asset, memo: string): void {
    if (to != this.receiver) return;
    if (from == this.receiver) return;
    const tok = this.tokens.get(quantity.symbol.raw());
    check(tok != null, "token not accepted by this contract");
    const t = tok!;
    check(this.firstReceiver == t.token_contract, "wrong token contract");
    check(!this.config().paused, "paused");
    check(memo.startsWith("shield:"), "memo must be shield:<r>");
    const rHex = memo.slice(7);
    check(rHex.length == 64, "memo must carry one 32-byte hex value");
    const r = fromHex(rHex);
    check(isCanonicalBE(r, 0), "r must be a field element");
    const key = this.keys.get(from.N);
    check(key != null, "depositor has not registered a key");
    check(quantity.amount > 0, "amount must be positive");
    const v = <u64>quantity.amount;
    if (t.min_deposit > 0) check(v >= t.min_deposit, "deposit below the minimum");
    if (t.max_deposit > 0) check(v <= t.max_deposit, "deposit above the per-deposit limit");
    if (t.max_pool > 0) check(t.pool + v <= t.max_pool, "the pool is at its limit");
    t.pool += v;
    t.deposits += v;
    this.tokens.update(t, this.receiver);

    const pk = key!.pubkey;
    const inp = new StaticArray<Limbs>(5);
    unchecked((inp[0] = fromBytesBE(pk, 0)));
    unchecked((inp[1] = fromBytesBE(pk, 32)));
    unchecked((inp[2] = fromU64(v)));
    unchecked((inp[3] = fromU64(t.token_id)));
    unchecked((inp[4] = fromBytesBE(r, 0)));
    const cm = poseidon(inp);
    const cmBytes = toBytesBE(cm);
    const index = this.insertPair(cm, null, cmBytes, [], this.receiver);
    // the plaintext note as a receiver would read it: (v + token·2^64, r)
    this.outputs.store(new OutputRow(index, [], packedWord(v, t.token_id).concat(r), []), this.receiver);
    print("shield leaf " + index.toString() + " cm " + hex(cmBytes));
  }

  // ---------------------------------------------------------------- shielded transfer / withdraw

  /**
   * Signed by `owner`, who pays CPU and RAM. The proof is bound to `owner`, to the key
   * registered for `owner`, and to the withdrawal destination, which is `owner` itself.
   * `amount` > 0 makes it a withdrawal of `token_id`; `root_seq` names the tree root the
   * proof was built against (one of the last 128).
   */
  @action("spend")
  spend(owner: Name, proof: u8[], publics: u8[], amount: u64, token_id: u8, root_seq: u64): void {
    requireAuth(owner);
    const c = this.config();
    check(!c.paused, "paused");
    check(proof.length == PROOF_LEN, "proof must be 256 bytes");
    check(publics.length == ACTION_LEN, "publics must be 16 words");
    for (let i = 0; i < N_ACTION; i++) if (i != 4 && i != 5) check(isCanonicalBE(publics, i * 32), "public word not canonical");
    const key = this.keys.get(owner.N);
    check(key != null, "owner has not registered a shielded key");
    check(amount > 0 || token_id == 0, "token_id only with a withdrawal");

    const nf1 = word(publics, 0);
    const nf2 = word(publics, 1);
    const cm1 = word(publics, 2);
    const cm2 = word(publics, 3);
    check(!isZeroWord(nf1), "first input must be a real note");
    check(!bytesEq(nf1, nf2), "the same note twice");
    const rootRow = this.roots.get(root_seq);
    check(rootRow != null, "unknown or stale root");
    const epk1 = decompress(word(publics, 4));
    const epk2 = decompress(word(publics, 5));
    const vPub: u64 = amount;
    const tokenPub: u64 = amount > 0 ? (token_id as u64) : 0;
    const to: u64 = amount > 0 ? owner.N : 0;

    // the verifier's 27 words
    const inputs = publics.slice(0, 4 * 32)
      .concat(epk1).concat(epk2)
      .concat(publics.slice(6 * 32, 16 * 32))
      .concat(key!.pubkey)
      .concat(rootRow!.root)
      .concat(u64Word(vPub)).concat(u64Word(tokenPub)).concat(u64Word(to)).concat(u64Word(owner.N))
      .concat(c.auditor_pubkey);
    check(groth16Verify(c.vk, proof, inputs), "invalid proof");

    this.spendNullifier(nf1, owner);
    this.spendNullifier(nf2, owner);
    const index = this.insertPair(fromBytesBE(cm1, 0), fromBytesBE(cm2, 0), cm1, cm2, owner);
    for (let j = 0; j < 2; j++) {
      const epk = word(publics, 4 + j);
      const cr = publics.slice((6 + 2 * j) * 32, (8 + 2 * j) * 32);
      const ca = publics.slice((10 + 3 * j) * 32, (13 + 3 * j) * 32);
      this.outputs.store(new OutputRow(index + (j as u64), epk, cr, ca), owner);
    }

    if (vPub > 0) {
      const t = this.tokenById(tokenPub);
      check(t.pool >= vPub, "withdrawal exceeds the escrow counter");
      t.pool -= vPub;
      t.withdrawals += vPub;
      this.tokens.update(t, this.receiver);
      const sym = Symbol.fromU64(t.sym);
      sendTransferTokens(this.receiver, owner, [new ExtendedAsset(new Asset(<i64>vPub, sym), t.token_contract)], "shielded withdraw");
    }
    print("shield leaf " + index.toString());
  }
}
