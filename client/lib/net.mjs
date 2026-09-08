// Chain reads for the headless client, with the same defences the app has: the config row and
// the tree row must be agreed by two nodes (and the auditor key must equal the pinned one), each
// node's outputs are validated against the agreed root on their own, note data beside the
// commitments is agreed by vote, and a nullifier is spent when two nodes list it. A single-node
// answer or a dispute leaves the result unconfirmed, and the client says so.
import N from "../../circuits/lib/notes.mjs";

export const NETWORKS = {
  testnet: {
    chain: "proton-test",
    endpoints: ["https://tn1.protonnz.com", "https://testnet.protonchain.com", "https://test.proton.eosusa.io"],
    hyperions: ["https://test.proton.eosusa.io"],
    explorer: "https://testnet.explorer.xprnetwork.org",
    contract: "xprshield",
    auditorPk: "2496233cca7c277d1e86aa8ffa6e25032580ff53a8a37f867fc045114a70e32c0f9d825b40b4bcc7b53a4f8fe1e0a10b6f00980b3510051d8b78ba72fdb2beaa",
    tokens: { XPR: { contract: "eosio.token", precision: 4, id: 1n }, XMD: { contract: "xmd.token", precision: 6, id: 2n } },
  },
  mainnet: {
    chain: "proton",
    endpoints: ["https://api.protonnz.com", "https://proton.eosusa.io", "https://proton.cryptolions.io", "https://proton.eoscafeblock.com", "https://proton.genereos.io"],
    hyperions: ["https://hyperion-xpr-mainnet.protonnz.com", "https://proton.eosusa.io"],
    explorer: "https://explorer.xprnetwork.org",
    contract: "privatexpr",
    auditorPk: "", // pinned at launch (docs/07)
    tokens: { XPR: { contract: "eosio.token", precision: 4, id: 1n }, XMD: { contract: "xmd.token", precision: 6, id: 2n } },
  },
};

export const hex = N.hex32;
export const words = (h) => (h.match(/.{64}/g) ?? []).map((w) => BigInt("0x" + w));
const lower = (s) => String(s).toLowerCase();

export class Net {
  constructor(name) {
    if (!NETWORKS[name]) throw new Error(`unknown network ${name}`);
    this.name = name;
    Object.assign(this, NETWORKS[name]);
  }
  async post(ep, path, body) {
    const r = await fetch(`${ep}/v1/chain/${path}`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
  /** first node that answers */
  async rpc(path, body) {
    let last;
    for (const ep of this.endpoints) { try { return await this.post(ep, path, body); } catch (e) { last = e; } }
    throw last;
  }
  /** a whole table from one node, paged */
  async table(ep, table, scope = this.contract, code = this.contract) {
    const out = [];
    let lowerBound;
    for (let page = 0; page < 200; page++) {
      const r = await this.post(ep, "get_table_rows", { code, scope, table, json: true, limit: 1000, lower_bound: lowerBound });
      out.push(...r.rows);
      if (!r.more) return out;
      if (!r.rows.length || !r.next_key) throw new Error(`${table}: incomplete page`);
      lowerBound = r.next_key;
    }
    throw new Error(`${table}: too many pages`);
  }
  async tableAny(table) {
    let last;
    for (const ep of this.endpoints) { try { return await this.table(ep, table); } catch (e) { last = e; } }
    throw last;
  }
  async fromAll(fn) {
    const answers = await Promise.allSettled(this.endpoints.map((ep) => fn(ep)));
    return answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  }

  /** the config row two nodes agree on, equal to the pinned committee key when one is pinned */
  async config() {
    const got = await this.fromAll(async (ep) => {
      const j = await this.post(ep, "get_table_rows", { code: this.contract, scope: this.contract, table: "config", json: true, limit: 1 });
      if (!j.rows.length) return null;
      return { auditor_pubkey: lower(j.rows[0].auditor_pubkey), paused: !!j.rows[0].paused };
    });
    if (got.length < 2) throw new Error("cannot confirm the contract's configuration with two nodes; try again");
    const rowsGot = got.filter(Boolean);
    if (!rowsGot.length) throw new Error("the contract is not initialised");
    const agreed = rowsGot.find((r) => rowsGot.filter((o) => o.auditor_pubkey === r.auditor_pubkey).length >= 2);
    if (!agreed) throw new Error("the nodes disagree about the auditor key; try again");
    if (this.auditorPk && agreed.auditor_pubkey !== this.auditorPk.toLowerCase()) throw new Error("the auditor key on chain is not the pinned committee key; refusing");
    // token identity (symbol, issuing contract, id) agreed by two nodes and equal to this client's pinned ids
    const identity = (r) => `${BigInt(r.sym)}|${r.token_contract}|${BigInt(r.token_id)}`;
    const lists = await this.fromAll(async (ep) => { const l = await this.table(ep, "tokens"); for (const r of l) { identity(r); if (!/^[a-z1-5.]{1,12}$/.test(r.token_contract)) throw new Error("malformed token row"); } return l; });
    if (lists.length < 2) throw new Error("cannot confirm the token list with two nodes; try again");
    const tokens = [];
    for (const l of lists) for (const r of l) {
      const id = identity(r);
      if (tokens.some((t) => identity(t) === id)) continue;
      if (lists.filter((o) => o.some((x) => identity(x) === id)).length >= 2) tokens.push(r);
    }
    for (const r of tokens) {
      const raw = BigInt(r.sym);
      let code = ""; for (let i = 1; i < 8; i++) { const ch = Number((raw >> BigInt(8 * i)) & 0xffn); if (ch) code += String.fromCharCode(ch); }
      const known = this.tokens[code];
      if (known && (known.contract !== r.token_contract || known.precision !== Number(raw & 0xffn) || known.id !== BigInt(r.token_id))) throw new Error(`the contract's ${code} does not match this client's ${code}; refusing`);
    }
    return { auditorPk: words(agreed.auditor_pubkey), paused: rowsGot.some((r) => r.paused), tokens };
  }

  /** every tree row and the active tree, as two nodes agree on them; each node's answer validated alone */
  async treeRows() {
    const got = await this.fromAll(async (ep) => {
      const list = (await this.table(ep, "tree")).map((r) => ({ id: Number(r.id), next: Number(r.next_leaf), root: lower(r.root), rootSeq: BigInt(r.root_seq) }));
      for (const t of list) if (!Number.isInteger(t.id) || t.id < 0 || t.id >= 1 << 24 || t.rootSeq < 0n || t.rootSeq > 1n << 40n || !Number.isInteger(t.next) || t.next < 0 || t.next > 1 << 20 || !/^[0-9a-f]{64}$/.test(t.root)) throw new Error("malformed tree row");
      if (new Set(list.map((t) => t.id)).size !== list.length) throw new Error("duplicate tree rows");
      const cj = await this.post(ep, "get_table_rows", { code: this.contract, scope: this.contract, table: "config", json: true, limit: 1 });
      const active = Number(cj.rows[0]?.active_tree ?? 0);
      if (!list.length) list.push({ id: 0, next: 0, root: hex(new N.Tree().root), rootSeq: 0n });
      list.sort((a, b) => a.id - b.id);
      return { trees: list, active, key: list.map((t) => `${t.id}:${t.next}:${t.root}:${t.rootSeq}`).join("|") + `#${active}` };
    });
    if (!got.length) throw new Error("no node answered");
    const total = (g) => g.trees.reduce((n, t) => n + t.next, 0);
    const shared = got.filter((r) => got.filter((o) => o.key === r.key).length >= 2).sort((a, b) => total(b) - total(a));
    if (shared.length) return { ...shared[0], confirmed: true };
    return { ...got.sort((a, b) => total(b) - total(a))[0], confirmed: false };
  }
  /** rebuild every agreed tree from one node's outputs; throws on a duplicate, a malformed row or a root mismatch */
  rebuildAll(agreed, outs) {
    const result = new Map();
    for (const t of agreed) {
      const tree = new N.Tree(N.DEPTH, t.id);
      const byPos = new Map();
      for (const o of outs) {
        const g = Number(o.index);
        if (N.treeOf(g) !== t.id) continue;
        const pos = N.posOf(g);
        if (pos >= t.next) continue;
        if (byPos.has(pos) || !/^[0-9a-f]{64}$/i.test(o.cm)) throw new Error("malformed outputs");
        byPos.set(pos, BigInt("0x" + o.cm));
      }
      for (let i = 0; i < t.next; i++) tree.append(byPos.get(i) ?? 0n);
      if (hex(tree.root) !== t.root) throw new Error(`outputs of tree ${t.id} do not hash to the agreed root`);
      tree.rootSeq = t.rootSeq;
      result.set(t.id, tree);
    }
    return result;
  }

  /** outputs validated per node against the agreed root, note data agreed by vote, nullifiers agreed by vote */
  async scanTables() {
    const agreedAll = await this.treeRows();
    const inTree = (o) => { const g = Number(o.index); const t = agreedAll.trees.find((x) => x.id === N.treeOf(g)); return !!t && N.posOf(g) < t.next; };
    const nfLists = await this.fromAll(async (ep) => { const set = new Set(); for (const n of await this.table(ep, "nullifiers")) { if (typeof n.nf !== "string" || !/^[0-9a-f]{64}$/i.test(n.nf)) throw new Error("malformed nullifier"); set.add(lower(n.nf)); } return set; });
    if (!nfLists.length) throw new Error("no node answered");
    const nfCount = new Map();
    for (const l of nfLists) for (const nf of l) nfCount.set(nf, (nfCount.get(nf) ?? 0) + 1);
    const nfDisputed = nfLists.length >= 2 && [...nfCount.values()].some((c) => c < 2);
    const spent = new Set(nfCount.keys());

    const answers = await this.fromAll((ep) => this.table(ep, "outputs"));
    const valid = [];
    let trees = null;
    for (const list0 of answers) {
      try {
        const list = list0.filter(inTree);
        const built = this.rebuildAll(agreedAll.trees, list);
        valid.push(list);
        trees = trees ?? built;
      } catch { /* this node's answer is discarded */ }
    }
    if (!valid.length) throw new Error("no node returned outputs that match the agreed roots; try again");
    const variants = new Map();
    for (const l of valid) for (const o of l) {
      const i = Number(o.index);
      const k = lower(`${o.cm}|${o.epk}|${o.cr}|${o.ca}`);
      const m = variants.get(i) ?? new Map();
      const v = m.get(k) ?? { row: o, votes: 0 };
      v.votes += 1; m.set(k, v); variants.set(i, m);
    }
    const outs = [];
    let outsDisputed = valid.length < 2;
    for (const [, m] of variants) {
      const vs = [...m.values()].sort((a, b) => b.votes - a.votes);
      if (vs.length > 1 || vs[0].votes < 2) outsDisputed = true;
      for (const v of vs) outs.push(v.row);
    }
    const reasons = [];
    if (!agreedAll.confirmed) reasons.push("tree rows not agreed by two nodes");
    if (nfLists.length < 2) reasons.push("nullifiers from one node only"); else if (nfDisputed) reasons.push("nodes disagree on spent status");
    if (valid.length < 2) reasons.push("outputs from one node only"); else if (outsDisputed) reasons.push("nodes disagree on note data");
    return { outs, spent, trees, active: agreedAll.active, nextLeaf: agreedAll.trees.reduce((n, t) => n + t.next, 0), treeRows: agreedAll.trees, confirmed: reasons.length === 0, reasons };
  }

  /** the account's notes: unspent and spent, from the agreed tables */
  async scan(keys) {
    const t = await this.scanTables();
    const notes = [], spentNotes = [];
    for (const o of t.outs) {
      const index = Number(o.index);
      const cm = BigInt("0x" + o.cm);
      let note = null;
      try {
        if (!o.epk) {
          const [packed, r] = words(o.cr);
          const [v, token] = N.unpack(packed);
          const cand = { pk: keys.pk, v, token, r };
          if (N.commitment(cand) === cm) note = { ...cand, cm };
        } else note = N.tryDecryptReceiver(keys, N.decompressPoint(words(o.epk)[0]), words(o.cr), cm);
      } catch { continue; }
      if (!note || note.v === 0n) continue;
      if (notes.some((n) => n.index === index) || spentNotes.some((n) => n.index === index)) continue;
      const owned = { ...note, index, kind: o.epk ? "note" : "deposit" };
      (t.spent.has(hex(N.nullifier(keys.nk, index))) ? spentNotes : notes).push(owned);
    }
    return { notes, spent: spentNotes, outs: t.outs, trees: t.trees, active: t.active, confirmed: t.confirmed, reasons: t.reasons };
  }

  /** one account's row of a table as two nodes agree on it; null when agreed absent */
  async agreedRow(table, owner, ident) {
    const got = await this.fromAll(async (ep) => (await this.table(ep, table)).find((r) => r.owner === owner) ?? null);
    if (got.length < 2) throw new Error(`cannot confirm the ${table} row with two nodes; try again`);
    const k = (r) => (r ? ident(r) : "");
    const agreed = got.find((r) => got.filter((o) => k(o) === k(r)).length >= 2);
    if (agreed === undefined) throw new Error(`the nodes disagree about the ${table} row; try again`);
    return agreed;
  }

  /** registered keys as two nodes agree on them: name → point */
  async registeredKeys() {
    const tables = await this.fromAll(async (ep) => new Map((await this.table(ep, "keys")).map((r) => [r.owner, lower(r.pubkey)])));
    if (tables.length < 2) throw new Error("cannot confirm registered keys with two nodes; try again");
    const out = new Map();
    for (const t of tables) for (const [owner, pk] of t) if (tables.filter((o) => o.get(owner) === pk).length >= 2) out.set(owner, words(pk));
    return out;
  }

  /** spend actions from history, each confirmed by a chain node's block before it is believed */
  async verifiedSpends(relevant = () => true, cmOnChain = null) {
    let recs = null;
    for (const h of this.hyperions) {
      try {
        recs = [];
        for (let skip = 0; skip < 5000; skip += 100) {
          const r = await fetch(`${h}/v2/history/get_actions?account=${this.contract}&filter=${this.contract}:spend&limit=100&skip=${skip}&sort=asc`, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json();
          for (const a of j.actions) {
            const p = lower(a.act.data.publics ?? "");
            if (!a.act.data.owner || p.length < 4 * 64 || !/^[0-9a-f]{64}$/i.test(a.trx_id)) continue;
            recs.push({ owner: a.act.data.owner, ts: a.timestamp, trx: lower(a.trx_id), block: Number(a.block_num), publics: p, nf: [p.slice(0, 64), p.slice(64, 128)], cm: [p.slice(128, 192), p.slice(192, 256)] });
          }
          if (j.actions.length < 100) break;
        }
        break;
      } catch { recs = null; }
    }
    if (recs === null) return null;
    const out = [];
    const seenNf = new Set();
    for (const rec of recs) {
      // a spend from before a testnet reset can share a nullifier with a current one; only the one whose outputs are leaves counts
      if (seenNf.has(rec.nf[0]) || (cmOnChain && !rec.cm.every((c) => cmOnChain.has(c))) || !relevant(rec)) continue;
      try {
        const b = await this.rpc("get_block", { block_num_or_id: rec.block });
        const t = b.transactions.find((x) => typeof x.trx === "object" && lower(x.trx.id ?? "") === rec.trx);
        const a = t?.trx?.transaction?.actions?.find((x) => x.account === this.contract && x.name === "spend" && typeof x.data === "object" && lower(x.data.publics ?? "") === rec.publics);
        if (!a) continue;
        const owner = String(a.data.owner ?? "");
        if (!owner || !a.authorization.some((z) => z.actor === owner)) continue;
        seenNf.add(rec.nf[0]);
        out.push({ ...rec, owner, ts: b.timestamp, amount: BigInt(String(a.data.amount ?? 0)), tokenId: BigInt(String(a.data.token_id ?? 0)) });
      } catch { /* skip */ }
    }
    return out;
  }

  /** deposit placements from history, keyed by owner and note random value */
  async depositHistory() {
    const out = new Map();
    for (const h of this.hyperions) {
      try {
        for (let skip = 0; skip < 5000; skip += 100) {
          const r = await fetch(`${h}/v2/history/get_actions?account=${this.contract}&filter=${this.contract}:deposit&limit=100&skip=${skip}&sort=asc`, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json();
          for (const a of j.actions) if (a.act.data.r && a.act.data.owner) out.set(`${a.act.data.owner}|${lower(a.act.data.r)}`, { ts: a.timestamp, trx: a.trx_id, block: Number(a.block_num) });
          if (j.actions.length < 100) break;
        }
        return out;
      } catch { /* next */ }
    }
    return out;
  }
}
