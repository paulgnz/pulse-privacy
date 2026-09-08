import { Asset, Contract, ExtendedAsset, Name, Symbol, Table, TableStore, check, print, requireAuth } from "proton-tsc";
import { Account as TokenAccount, sendTransferTokens } from "proton-tsc/token";
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
// Public signals of the join-split proof, 28 words (circuits/shielded/joinsplit.circom):
//   [0,1] nf  [2,3] cm  [4..7] epk (x,y × 2)  [8..11] cr (2 × 2)  [12..17] ca (3 × 2)
//   [18,19] senderPk  [20] root  [21] vPub  [22] tokenPub  [23] to  [24] sender  [25,26] A
// The action carries 16 words: nf, cm, epk compressed (y with the parity of x in the top bit),
// cr, ca; plus `amount`, `token_id` and `root_seq` as native fields. The contract decompresses
// epk, looks the root up by sequence, and supplies senderPk, the name and the auditor key.

/** true for testnet builds only: enables `reset`. Set to false for any mainnet build. */
const TESTNET: bool = true;
const DEPTH: i32 = 20;
const N_PUB: i32 = 28; // revision 6: `tree` follows `root`
const TREE_MAX: u64 = 1 << 24; // trees are numbered below 2^24 (the circuit decomposes 24 tree bits)
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
    public paused: bool = false,
    public root_seq: u64 = 0, // the root ring's sequence, global across trees
    public active_tree: u64 = 0
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

/**
 * Recovery copies of an account's shielded key, both optional, written by the owner:
 *  - `phrase`: the key under a passphrase (AES-GCM, PBKDF2) that only the owner knows;
 *  - `committee`: the key sealed to the auditor's public key with the note scheme
 *    (compressed ephemeral point, then the key plus a Poseidon mask), which the committee
 *    can open to return the key after the owner proves they own the account.
 */
@table("backups")
class BackupRow extends Table {
  constructor(public owner: Name = new Name(), public phrase: u8[] = [], public committee: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.owner.N;
  }
}

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
  constructor(public seq: u64 = 0, public tree: u64 = 0, public root: u8[] = []) {
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
  constructor(public index: u64 = 0, public cm: u8[] = [], public epk: u8[] = [], public cr: u8[] = [], public ca: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.index;
  }
}

/**
 * One owner-paid deposit slot per registered account, created at `register` (or by `open` for
 * accounts registered before slots existed). A token transfer with memo `shield:<r>` fills the
 * empty slot from inside the notification, which is allowed because the row does not change
 * size and so bills nothing; the owner's `deposit` then builds the note and empties the slot.
 * An occupied slot refuses further transfers (the transaction fails and the tokens never
 * leave the sender), so nobody but its owner can grow this table, and lookup is one get.
 */
function emptyR(): u8[] {
  const z = new Array<u8>(32);
  for (let i = 0; i < 32; i++) z[i] = 0;
  return z;
}

@table("credits")
class Credit extends Table {
  constructor(public owner: Name = new Name(), public sym: u64 = 0, public amount: u64 = 0, public r: u8[] = []) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.owner.N;
  }
}

/**
 * Accounts whose balance the committee returned from escrow with `restore`. Their notes cannot
 * be cancelled (the nullifiers need the key), but every spend is signed by its owner, so a
 * restored account is refused at `spend` until the committee lifts the mark with `unrestore`.
 * Without this a key recovered after a restore could spend notes the pool has already paid out.
 */
@table("restored")
class RestoredRow extends Table {
  constructor(public owner: Name = new Name(), public sym: u64 = 0, public amount: u64 = 0) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.owner.N;
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
  backups: TableStore<BackupRow> = new TableStore<BackupRow>(this.receiver);
  restored: TableStore<RestoredRow> = new TableStore<RestoredRow>(this.receiver);
  trees: TableStore<TreeRow> = new TableStore<TreeRow>(this.receiver);
  roots: TableStore<RootRow> = new TableStore<RootRow>(this.receiver);
  nullifiers: TableStore<NullifierRow> = new TableStore<NullifierRow>(this.receiver);
  outputs: TableStore<OutputRow> = new TableStore<OutputRow>(this.receiver);
  credits: TableStore<Credit> = new TableStore<Credit>(this.receiver);

  config(): Config {
    const c = this.configs.get(0);
    check(c != null, "not initialised");
    return c!;
  }
  /** the tree new leaves go into */
  tree(): TreeRow {
    const t = this.trees.get(this.config().active_tree);
    check(t != null, "not initialised");
    return t!;
  }
  /** a fresh, empty tree with the next id, made active */
  openTree(c: Config): TreeRow {
    const id = this.trees.get(c.active_tree) == null ? c.active_tree : c.active_tree + 1;
    check(id < TREE_MAX, "no more trees");
    const filled = new Array<u8>(DEPTH * 32);
    for (let i = 0; i < filled.length; i++) filled[i] = 0;
    const t = new TreeRow(id, 0, filled, toBytesBE(zeroAt(DEPTH)), 0);
    this.trees.store(t, this.receiver);
    c.active_tree = id;
    this.configs.update(c, this.receiver);
    this.rememberRoot(t, t.root);
    this.trees.update(t, this.receiver);
    return t;
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
    check(inPrimeSubgroup(auditor_pubkey), "auditor pubkey is the identity or has low order");
    check(vk.length == 64 + 3 * 128 + 64 * (N_PUB + 1), "vk length must match 28 public inputs");
    const c = new Config(0, auditor_pubkey, vk, false, 0, 0);
    this.configs.store(c, this.receiver);
    this.openTree(this.config());
  }

  /** start the next tree now (the contract also rolls over on its own when the active tree is full) */
  @action("newtree")
  newtree(): void {
    requireAuth(this.receiver);
    const c = this.config();
    const active = this.trees.get(c.active_tree);
    check(active != null, "not initialised");
    check(active!.next_leaf > 0, "the active tree is empty; nothing to roll over");
    c.active_tree += 1;
    this.configs.update(c, this.receiver);
    this.openTree(this.config());
  }

  @action("addtoken")
  addtoken(sym: Symbol, token_contract: Name, token_id: u64, max_pool: u64, max_deposit: u64, min_deposit: u64): void {
    requireAuth(this.receiver);
    this.config();
    check(token_id > 0 && token_id < 256, "token id must be 1..255");
    // notes bind the id, not the symbol: two symbols with one id would let a withdrawal pay the wrong asset
    let other = this.tokens.first();
    while (other != null) {
      check(other.sym == sym.raw() || other.token_id != token_id, "token id already used by another token");
      other = this.tokens.next(other);
    }
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
    check(vk.length == 64 + 3 * 128 + 64 * (N_PUB + 1), "vk length must match 28 public inputs");
    c.vk = vk;
    this.configs.update(c, this.receiver);
  }

  @action("setauditor")
  setauditor(auditor_pubkey: u8[]): void {
    requireAuth(this.receiver);
    const c = this.config();
    check(onCurve(auditor_pubkey), "auditor pubkey not on curve");
    check(inPrimeSubgroup(auditor_pubkey), "auditor pubkey is the identity or has low order");
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
    check(TESTNET, "reset is not available in this build");
    const c = this.configs.get(0);
    check(c != null && c!.paused, "pause first");
    let cr = this.credits.first(); while (cr != null) { const n = this.credits.next(cr); this.credits.remove(cr); cr = n; }
    let o = this.outputs.first(); while (o != null) { const n = this.outputs.next(o); this.outputs.remove(o); o = n; }
    let f = this.nullifiers.first(); while (f != null) { const n = this.nullifiers.next(f); this.nullifiers.remove(f); f = n; }
    let r = this.roots.first(); while (r != null) { const n = this.roots.next(r); this.roots.remove(r); r = n; }
    let k = this.keys.first(); while (k != null) { const n = this.keys.next(k); this.keys.remove(k); k = n; }
    let b = this.backups.first(); while (b != null) { const n = this.backups.next(b); this.backups.remove(b); b = n; }
    let rs = this.restored.first(); while (rs != null) { const n = this.restored.next(rs); this.restored.remove(rs); rs = n; }
    let t = this.tokens.first(); while (t != null) { const n = this.tokens.next(t); this.tokens.remove(t); t = n; }
    let tr = this.trees.first(); while (tr != null) { const n = this.trees.next(tr); this.trees.remove(tr); tr = n; }
    this.configs.remove(c!);
  }

  /**
   * Committee recovery for a lost key: while paused, pay `quantity` from escrow to `to`, and mark
   * the account restored so that it can no longer spend (its notes cannot be cancelled, since
   * the nullifiers need the key, but its spends are signed). The mark stays until `unrestore`,
   * which the committee runs only once it is satisfied the escrow is whole again. The memo puts
   * the reason on chain.
   */
  @action("restore")
  restore(to: Name, quantity: Asset, memo: string): void {
    requireAuth(this.receiver);
    const c = this.config();
    check(c.paused, "restore is only possible while paused");
    check(quantity.amount > 0, "amount must be positive");
    const tok = this.tokens.get(quantity.symbol.raw());
    check(tok != null, "token not accepted by this contract");
    const t = tok!;
    const v = <u64>quantity.amount;
    check(t.pool >= v, "restore exceeds the escrow counter");
    t.pool -= v;
    t.withdrawals += v;
    this.tokens.update(t, this.receiver);
    check(new TableStore<TokenAccount>(t.token_contract, to).get(quantity.symbol.code()) != null, "the account must hold a balance row for this token");
    const r = this.restored.get(to.N);
    if (r == null) this.restored.store(new RestoredRow(to, quantity.symbol.raw(), v), this.receiver);
    else { r.sym = quantity.symbol.raw(); r.amount += v; this.restored.update(r, this.receiver); }
    sendTransferTokens(this.receiver, to, [new ExtendedAsset(quantity, t.token_contract)], "restore: " + memo);
  }

  /** lift the restored mark: the committee has verified the returned amount is back in escrow (or the account is closed for good) */
  @action("unrestore")
  unrestore(owner: Name, memo: string): void {
    requireAuth(this.receiver);
    check(memo.length <= 256, "memo too long");
    const r = this.restored.get(owner.N);
    check(r != null, "account is not marked restored");
    this.restored.remove(r!);
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
    // one key, one name: a sender who looks a name up must reach that account alone, and the
    // auditor's key-to-name mapping must be unambiguous (a scan; fine for the sizes expected)
    let k = this.keys.first();
    while (k != null) {
      check(!bytesEq(k.pubkey, pubkey), "this key is already registered by another account");
      k = this.keys.next(k);
    }
    this.keys.store(new KeyRow(owner, pubkey), owner);
    if (this.credits.get(owner.N) == null) this.credits.store(new Credit(owner, 0, 0, emptyR()), owner);
  }

  /** an owner-paid deposit slot for an account registered before slots existed; idempotent */
  @action("open")
  open(owner: Name): void {
    requireAuth(owner);
    check(this.keys.get(owner.N) != null, "register a key first");
    if (this.credits.get(owner.N) == null) this.credits.store(new Credit(owner, 0, 0, emptyR()), owner);
  }

  /**
   * Store or replace the owner's recovery copies; the owner pays the row. An empty argument
   * keeps what is there, so a client that could not read the row cannot wipe the other copy;
   * `clearbackup` removes copies explicitly.
   */
  @action("setbackup")
  setbackup(owner: Name, phrase: u8[], committee: u8[]): void {
    requireAuth(owner);
    check(phrase.length == 0 || (phrase.length >= 60 && phrase.length <= 160), "phrase copy must be 60 to 160 bytes");
    check(committee.length == 0 || committee.length == 64, "committee copy must be 64 bytes");
    check(phrase.length > 0 || committee.length > 0, "nothing to store");
    const b = this.backups.get(owner.N);
    if (b == null) this.backups.store(new BackupRow(owner, phrase, committee), owner);
    else {
      if (phrase.length > 0) b.phrase = phrase;
      if (committee.length > 0) b.committee = committee;
      this.backups.update(b, owner);
    }
  }

  /** remove the phrase copy, the committee copy, or both; the row goes when both are gone */
  @action("clearbackup")
  clearbackup(owner: Name, phrase: bool, committee: bool): void {
    requireAuth(owner);
    const b = this.backups.get(owner.N);
    check(b != null, "no recovery copies stored");
    if (phrase) b!.phrase = [];
    if (committee) b!.committee = [];
    if (b!.phrase.length == 0 && b!.committee.length == 0) this.backups.remove(b!);
    else this.backups.update(b!, owner);
  }

  // ---------------------------------------------------------------- tree

  /**
   * Record a tree's new root in the ring; the sequence is global across trees. The ring keeps
   * the last RING roots, except that a closed tree's final root is never evicted: that tree
   * receives no more leaves, so its final root is the only one its notes can ever be proved
   * against. The ring therefore holds RING rows plus one per closed tree.
   */
  rememberRoot(t: TreeRow, root: u8[]): void {
    const c = this.config();
    t.root = root;
    c.root_seq += 1;
    t.root_seq = c.root_seq;
    if (c.root_seq > RING) {
      const old = this.roots.get(c.root_seq - RING);
      if (old != null) {
        const closed = old.tree != t.id ? this.trees.get(old.tree) : null;
        const finalRoot = closed != null && closed.root_seq == old.seq;
        if (!finalRoot) this.roots.remove(old); // free the slot first, so a full account still turns the ring
      }
    }
    this.roots.store(new RootRow(c.root_seq, t.id, root), this.receiver);
    this.configs.update(c, this.receiver);
  }

  /**
   * Insert (cm1, cm2) as the next two leaves of the active tree (20 hashes) and record the root;
   * returns the global index tree · 2^DEPTH + position. A full tree rolls over to a fresh one,
   * so spending is never blocked. The caller stores the outputs rows, which carry the commitments.
   */
  insertPair(cm1: Limbs, cm2: Limbs | null): u64 {
    let t = this.tree();
    if (t.next_leaf + 2 > ((1 as u64) << (DEPTH as u64))) t = this.openTree(this.config());
    const index = t.next_leaf;
    check(index % 2 == 0, "tree corrupt");
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
    t.next_leaf = index + 2;
    this.rememberRoot(t, toBytesBE(cur));
    this.trees.update(t, this.receiver);
    return (t.id << (DEPTH as u64)) + index;
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
    // the note is built by the owner's `deposit` action, which pays for its rows; here the arrival
    // fills the owner's slot, a same-size update that bills nothing inside the notification
    const slot = this.credits.get(from.N);
    check(slot != null, "no deposit slot: registered before slots existed? send the open action once");
    check(slot!.amount == 0, "finish your pending deposit first");
    slot!.sym = quantity.symbol.raw();
    slot!.amount = v;
    slot!.r = r;
    this.credits.update(slot!, from);
  }

  /**
   * Place an arrived deposit in the tree as a note to the owner's registered key. Usually the
   * second action of the deposit transaction; can be sent later for an unfinished deposit.
   */
  @action("deposit")
  deposit(owner: Name, r: u8[]): void {
    requireAuth(owner);
    check(!this.config().paused, "paused");
    check(r.length == 32 && isCanonicalBE(r, 0), "r must be a field element");
    const slot = this.credits.get(owner.N);
    check(slot != null && slot!.amount > 0, "no arrived deposit for this owner");
    const credit = slot!;
    check(bytesEq(credit.r, r), "r does not match the arrived deposit");
    const tok = this.tokens.get(credit.sym);
    check(tok != null, "token not accepted by this contract");
    const key = this.keys.get(owner.N);
    check(key != null, "owner has not registered a key");
    const v = credit.amount;
    credit.amount = 0;
    credit.sym = 0;
    credit.r = emptyR();
    this.credits.update(credit, owner);

    const pk = key!.pubkey;
    const inp = new StaticArray<Limbs>(5);
    unchecked((inp[0] = fromBytesBE(pk, 0)));
    unchecked((inp[1] = fromBytesBE(pk, 32)));
    unchecked((inp[2] = fromU64(v)));
    unchecked((inp[3] = fromU64(tok!.token_id)));
    unchecked((inp[4] = fromBytesBE(r, 0)));
    const cm = poseidon(inp);
    const cmBytes = toBytesBE(cm);
    const index = this.insertPair(cm, null);
    // the plaintext note as a receiver would read it: (v + token·2^64, r)
    this.outputs.store(new OutputRow(index, cmBytes, [], packedWord(v, tok!.token_id).concat(r), []), owner);
    print("shield leaf " + index.toString() + " cm " + hex(cmBytes));
  }

  // ---------------------------------------------------------------- shielded transfer / withdraw

  /**
   * Signed by `owner`, who pays CPU and RAM. The proof is bound to `owner`, to the key
   * registered for `owner`, and to the withdrawal destination, which is `owner` itself.
   * `amount` > 0 makes it a withdrawal of `token_id`; `root_seq` names the tree root the
   * proof was built against (one of the last RING, in whichever tree); the contract supplies
   * that root and its tree to the verifier.
   */
  @action("spend")
  spend(owner: Name, proof: u8[], publics: u8[], amount: u64, token_id: u8, root_seq: u64): void {
    requireAuth(owner);
    const c = this.config();
    check(!c.paused, "paused");
    check(this.restored.get(owner.N) == null, "this account's balance was returned by the committee; contact the operator");
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
    check(!isZeroWord(nf1) && !isZeroWord(nf2), "nullifiers must be non-zero (revision 5 always emits two)");
    check(!bytesEq(nf1, nf2), "the same note twice");
    const rootRow = this.roots.get(root_seq);
    check(rootRow != null, "unknown or stale root");
    const epk1 = decompress(word(publics, 4));
    const epk2 = decompress(word(publics, 5));
    // a low-order ephemeral key (esk a multiple of the subgroup order passes the circuit's
    // esk != 0 check) would make both ciphertexts readable by anyone
    check(inPrimeSubgroup(epk1) && inPrimeSubgroup(epk2), "ephemeral key is the identity or has low order");
    const vPub: u64 = amount;
    const tokenPub: u64 = amount > 0 ? (token_id as u64) : 0;
    const to: u64 = amount > 0 ? owner.N : 0;

    // the verifier's 28 words
    const inputs = publics.slice(0, 4 * 32)
      .concat(epk1).concat(epk2)
      .concat(publics.slice(6 * 32, 16 * 32))
      .concat(key!.pubkey)
      .concat(rootRow!.root)
      .concat(u64Word(rootRow!.tree))
      .concat(u64Word(vPub)).concat(u64Word(tokenPub)).concat(u64Word(to)).concat(u64Word(owner.N))
      .concat(c.auditor_pubkey);
    check(groth16Verify(c.vk, proof, inputs), "invalid proof");

    this.spendNullifier(nf1, owner);
    this.spendNullifier(nf2, owner);
    const index = this.insertPair(fromBytesBE(cm1, 0), fromBytesBE(cm2, 0));
    for (let j = 0; j < 2; j++) {
      const epk = word(publics, 4 + j);
      const cr = publics.slice((6 + 2 * j) * 32, (8 + 2 * j) * 32);
      const ca = publics.slice((10 + 3 * j) * 32, (13 + 3 * j) * 32);
      this.outputs.store(new OutputRow(index + (j as u64), j == 0 ? cm1 : cm2, epk, cr, ca), owner);
    }

    if (vPub > 0) {
      const t = this.tokenById(tokenPub);
      check(t.pool >= vPub, "withdrawal exceeds the escrow counter");
      t.pool -= vPub;
      t.withdrawals += vPub;
      this.tokens.update(t, this.receiver);
      const sym = Symbol.fromU64(t.sym);
      // the receiver must already hold a balance row for this token, or the token contract would
      // bill the new row to this contract (the inline transfer carries only our authority)
      check(new TableStore<TokenAccount>(t.token_contract, owner).get(sym.code()) != null, "open a balance for this token in your wallet first");
      sendTransferTokens(this.receiver, owner, [new ExtendedAsset(new Asset(<i64>vPub, sym), t.token_contract)], "shielded withdraw");
    }
    print("shield leaf " + index.toString());
  }
}
