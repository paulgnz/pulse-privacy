import {
  Asset,
  Contract,
  ExtendedAsset,
  Name,
  Symbol,
  Table,
  TableStore,
  check,
  print,
  requireAuth,
} from "proton-tsc";
import { sendTransferTokens } from "proton-tsc/token";
import { groth16Verify } from "./groth16";
import { Pt, add, mulG32, onCurve, u64Word } from "./babyjub";

// xpr.conf — confidential token (testnet build, design doc §4).
//
// Byte layouts (all points affine, big-endian 32-byte x ‖ y = 64 B):
//   ciphertext pair set (avail / pending / b_new), 256 B:
//     lo.C [0,64)  lo.D [64,128)  hi.C [128,192)  hi.D [192,256)
//   transfer ciphertexts `t`, 512 B, chunk k at k*256:
//     C [0,64)  Ds [64,128)  Dr [128,192)  Da [192,256)
//   Groth16 public inputs (41 words, circuits/transfer/transfer.circom order):
//     Ps Pr Pa | BoldC lo,hi | BoldD lo,hi | BnewC lo,hi | BnewD lo,hi |
//     TC lo,hi | TDs lo,hi | TDr lo,hi | TDa lo,hi | nonce sender receiver
//
// Withdraw reuses the transfer circuit with r_T = 0: the contract computes v·G for the
// public amount chunks and requires TC = v·G and all handles = identity (no second circuit).

const CT_LEN = 256;
const T_LEN = 512;
const PROOF_LEN = 256;
const PUB_LEN = 41 * 32;

@table("config")
class Config extends Table {
  constructor(
    public sym: u64 = 0, // symbol raw (code + precision)
    public token_contract: Name = new Name(),
    public auditor_pubkey: u8[] = [],
    public vk: u8[] = [],
    public withdraw_granularity: u64 = 0, // units; 0 = off
    public deposit_granularity: u64 = 0,
    public paused: bool = false
  ) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.sym;
  }
}

@table("accounts")
class Account extends Table {
  constructor(
    public owner: Name = new Name(),
    public enc_pubkey: u8[] = [],
    public avail: u8[] = [],
    public pending: u8[] = [],
    public pending_count: u32 = 0,
    public nonce: u64 = 0
  ) {
    super();
  }
  @primary
  get primary(): u64 {
    return this.owner.N;
  }
}

function infBytes(): u8[] {
  return Pt.inf().toBytes();
}
function zeroCt(): u8[] {
  return infBytes().concat(infBytes()).concat(infBytes()).concat(infBytes());
}
function slice(a: u8[], off: i32, len: i32): u8[] {
  return a.slice(off, off + len);
}
/** add two 256-B ciphertext pair sets point-wise (4 Baby Jubjub additions) */
function ctAdd(a: u8[], b: u8[]): u8[] {
  let out: u8[] = [];
  for (let i = 0; i < 4; i++) {
    out = out.concat(add(Pt.fromBytes(a, i * 64), Pt.fromBytes(b, i * 64)).toBytes());
  }
  return out;
}
function chunks(amount: u64): u64[] {
  return [amount & 0xffffffff, amount >> 32];
}

@contract
class XprConf extends Contract {
  configs: TableStore<Config> = new TableStore<Config>(this.receiver);

  accountsOf(sym: u64): TableStore<Account> {
    return new TableStore<Account>(this.receiver, Name.fromU64(sym));
  }
  configOf(sym: Symbol): Config {
    const c = this.configs.get(sym.raw());
    check(c != null, "token not configured");
    return c!;
  }

  // ---------------------------------------------------------------- admin

  @action("init")
  init(sym: Symbol, token_contract: Name, auditor_pubkey: u8[], vk: u8[], withdraw_granularity: u64, deposit_granularity: u64): void {
    requireAuth(this.receiver);
    check(auditor_pubkey.length == 64 && onCurve(Pt.fromBytes(auditor_pubkey, 0)), "auditor pubkey not on curve");
    check(vk.length == 64 + 3 * 128 + 64 * 42, "vk length must match 41 public inputs");
    const existing = this.configs.get(sym.raw());
    check(existing == null, "already configured");
    this.configs.store(new Config(sym.raw(), token_contract, auditor_pubkey, vk, withdraw_granularity, deposit_granularity, false), this.receiver);
  }

  @action("configure")
  configure(sym: Symbol, auditor_pubkey: u8[], withdraw_granularity: u64, deposit_granularity: u64, paused: bool): void {
    requireAuth(this.receiver);
    const c = this.configOf(sym);
    check(auditor_pubkey.length == 64 && onCurve(Pt.fromBytes(auditor_pubkey, 0)), "auditor pubkey not on curve");
    c.auditor_pubkey = auditor_pubkey;
    c.withdraw_granularity = withdraw_granularity;
    c.deposit_granularity = deposit_granularity;
    c.paused = paused;
    this.configs.update(c, this.receiver);
  }

  @action("setvk")
  setvk(sym: Symbol, vk: u8[]): void {
    requireAuth(this.receiver);
    const c = this.configOf(sym);
    check(vk.length == 64 + 3 * 128 + 64 * 42, "vk length must match 41 public inputs");
    c.vk = vk;
    this.configs.update(c, this.receiver);
  }

  // ---------------------------------------------------------------- accounts

  /** publish an encryption pubkey (P = s^-1·H). On-curve check only in v0 (see README). */
  @action("register")
  register(owner: Name, sym: Symbol, enc_pubkey: u8[]): void {
    requireAuth(owner);
    const c = this.configOf(sym);
    check(!c.paused, "paused");
    check(enc_pubkey.length == 64, "pubkey must be 64 bytes");
    const P = Pt.fromBytes(enc_pubkey, 0);
    check(onCurve(P) && !P.eq(Pt.inf()), "pubkey not on curve");
    const accounts = this.accountsOf(sym.raw());
    check(accounts.get(owner.N) == null, "already registered");
    accounts.store(new Account(owner, enc_pubkey, zeroCt(), zeroCt(), 0, 0), owner);
  }

  /** fold pending credits into the available balance (homomorphic add, no proof) */
  @action("applypending")
  applypending(owner: Name, sym: Symbol): void {
    requireAuth(owner);
    const accounts = this.accountsOf(sym.raw());
    const acc = accounts.get(owner.N);
    check(acc != null, "not registered");
    const a = acc!;
    if (a.pending_count == 0) return;
    a.avail = ctAdd(a.avail, a.pending);
    a.pending = zeroCt();
    a.pending_count = 0;
    accounts.update(a, owner);
  }

  // ---------------------------------------------------------------- deposit (notify)

  @action("transfer", notify)
  ontransfer(from: Name, to: Name, quantity: Asset, memo: string): void {
    if (to != this.receiver) return;
    if (from == this.receiver) return;
    const c = this.configs.get(quantity.symbol.raw());
    if (c == null) return; // not a confidential token; plain transfer into the account
    check(this.firstReceiver == c.token_contract, "wrong token contract");
    check(!c.paused, "paused");
    check(memo.startsWith("conf:"), "memo must be conf:<owner>");
    const owner = Name.fromString(memo.slice(5));
    const accounts = this.accountsOf(quantity.symbol.raw());
    const acc = accounts.get(owner.N);
    check(acc != null, "owner not registered");
    check(quantity.amount > 0, "amount must be positive");
    const v = <u64>quantity.amount;
    if (c.deposit_granularity > 0) check(v % c.deposit_granularity == 0, "deposit must be a multiple of the granularity");
    // deposit encryption with r = 0: C = v·G, D = identity, per chunk
    const ch = chunks(v);
    const dep = mulG32(ch[0]).toBytes().concat(infBytes()).concat(mulG32(ch[1]).toBytes()).concat(infBytes());
    const a = acc!;
    a.pending = ctAdd(a.pending, dep);
    a.pending_count += 1;
    accounts.update(a, this.receiver);
  }

  // ---------------------------------------------------------------- confidential send

  @action("send")
  send(from: Name, sym: Symbol, to: Name, t: u8[], b_new: u8[], proof: u8[]): void {
    requireAuth(from);
    const c = this.configOf(sym);
    check(!c.paused, "paused");
    check(from != to, "cannot transfer to self");
    check(t.length == T_LEN, "t must be 512 bytes");
    check(b_new.length == CT_LEN, "b_new must be 256 bytes");
    check(proof.length == PROOF_LEN, "proof must be 256 bytes");
    const accounts = this.accountsOf(sym.raw());
    const sAcc = accounts.get(from.N);
    const rAcc = accounts.get(to.N);
    check(sAcc != null, "sender not registered");
    check(rAcc != null, "receiver not registered");
    const s = sAcc!;
    const r = rAcc!;

    const inputs = this.publicInputs(s.enc_pubkey, r.enc_pubkey, c.auditor_pubkey, s.avail, b_new, t, s.nonce, from.N, to.N);
    check(groth16Verify(c.vk, proof, inputs), "invalid proof");

    // sender: balance replaced by the proven re-encryption
    s.avail = b_new;
    s.nonce += 1;
    accounts.update(s, from);
    // receiver: pending += (C, Dr) per chunk
    const credit = slice(t, 0, 64).concat(slice(t, 128, 64)).concat(slice(t, 256, 64)).concat(slice(t, 384, 64));
    r.pending = ctAdd(r.pending, credit);
    r.pending_count += 1;
    accounts.update(r, from);
    // auditor handles (Da) stay in the action data for history; nothing stored
  }

  // ---------------------------------------------------------------- withdraw

  @action("withdraw")
  withdraw(owner: Name, quantity: Asset, b_new: u8[], proof: u8[]): void {
    requireAuth(owner);
    const c = this.configOf(quantity.symbol);
    check(!c.paused, "paused");
    check(quantity.amount > 0, "amount must be positive");
    const v = <u64>quantity.amount;
    if (c.withdraw_granularity > 0) check(v % c.withdraw_granularity == 0, "withdrawal must be a multiple of the granularity");
    check(b_new.length == CT_LEN, "b_new must be 256 bytes");
    check(proof.length == PROOF_LEN, "proof must be 256 bytes");
    const accounts = this.accountsOf(quantity.symbol.raw());
    const acc = accounts.get(owner.N);
    check(acc != null, "not registered");
    const a = acc!;

    // public "transfer" ciphertexts: C_k = v_k·G, handles = identity (r_T = 0)
    const ch = chunks(v);
    const inf = infBytes();
    const t = mulG32(ch[0]).toBytes().concat(inf).concat(inf).concat(inf)
      .concat(mulG32(ch[1]).toBytes()).concat(inf).concat(inf).concat(inf);
    const inputs = this.publicInputs(a.enc_pubkey, a.enc_pubkey, c.auditor_pubkey, a.avail, b_new, t, a.nonce, owner.N, owner.N);
    check(groth16Verify(c.vk, proof, inputs), "invalid proof");

    a.avail = b_new;
    a.nonce += 1;
    accounts.update(a, owner);
    sendTransferTokens(this.receiver, owner, [new ExtendedAsset(quantity, c.token_contract)], "confidential withdraw");
    print("withdraw ok");
  }

  // ---------------------------------------------------------------- helpers

  publicInputs(Ps: u8[], Pr: u8[], Pa: u8[], bold: u8[], bnew: u8[], t: u8[], nonce: u64, sender: u64, receiver: u64): u8[] {
    let w: u8[] = [];
    w = w.concat(Ps).concat(Pr).concat(Pa);
    // BoldC lo,hi ; BoldD lo,hi
    w = w.concat(slice(bold, 0, 64)).concat(slice(bold, 128, 64)).concat(slice(bold, 64, 64)).concat(slice(bold, 192, 64));
    // BnewC lo,hi ; BnewD lo,hi
    w = w.concat(slice(bnew, 0, 64)).concat(slice(bnew, 128, 64)).concat(slice(bnew, 64, 64)).concat(slice(bnew, 192, 64));
    // TC lo,hi ; TDs lo,hi ; TDr lo,hi ; TDa lo,hi
    w = w.concat(slice(t, 0, 64)).concat(slice(t, 256, 64));
    w = w.concat(slice(t, 64, 64)).concat(slice(t, 320, 64));
    w = w.concat(slice(t, 128, 64)).concat(slice(t, 384, 64));
    w = w.concat(slice(t, 192, 64)).concat(slice(t, 448, 64));
    w = w.concat(u64Word(nonce)).concat(u64Word(sender)).concat(u64Word(receiver));
    check(w.length == PUB_LEN, "public input length");
    return w;
  }
}
