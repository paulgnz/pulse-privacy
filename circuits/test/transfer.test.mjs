// End-to-end T2 test:
//   1. keys for alice / bob / auditor; alice's balance on record = deposit-style Enc(5000)
//   2. build the transfer witness for 1,234 XPR-units; circuit accepts it (witness check)
//   3. bob and the auditor decrypt the transfer; alice decrypts her new balance
//   4. (if build/transfer_final.zkey exists) prove, verify with snarkjs, encode for the
//      proton-tsc verifier and verify under vert with the real T1 contract
//   node test/transfer.test.mjs [--witness-only]
import * as snarkjs from "snarkjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import eg from "../lib/elgamal.mjs";
import { encodeInputs, encodeProof, encodeVk } from "../lib/encode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const B = (p) => join(HERE, "..", "build", p);
const witnessOnly = process.argv.includes("--witness-only");
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

await eg.init();
const alice = eg.keygen();
const bob = eg.keygen();
const auditor = eg.keygen();
lap("keys generated");

// alice deposited 5000.0000 XPR = 50_000_000 units (r = 0 deposit encryption, per chunk)
const DEPOSIT = 50_000_000n;
const depChunks = eg.split64(DEPOSIT);
const bold = depChunks.map((c) => eg.encryptPublic(c));

// transfer 1234.0000 XPR = 12_340_000 units
const AMOUNT = 12_340_000n;
const wit = eg.buildTransferWitness({
  sender: alice,
  receiverP: bob.P,
  auditorP: auditor.P,
  bold,
  voldChunks: depChunks,
  v: AMOUNT,
  nonce: 1n,
  senderName: 3773466545248677888n, // name("alice") as u64, illustrative
  receiverName: 3844375329615265792n,
});
lap("witness built");

// circuit accepts the witness
const wasm = B("transfer_js/transfer.wasm");
const wtns = { type: "mem" };
await snarkjs.wtns.calculate(wit.input, wasm, wtns);
lap("witness calculated (circuit constraints satisfied)");

// decryption paths
eg.buildBabyTable();
lap("baby-step table built");
const bobReads = eg.join64(
  eg.bsgs32(eg.decryptPoint(wit.T[0].C, wit.T[0].D.r, bob.s)),
  eg.bsgs32(eg.decryptPoint(wit.T[1].C, wit.T[1].D.r, bob.s))
);
const auditorReads = eg.join64(
  eg.bsgs32(eg.decryptPoint(wit.T[0].C, wit.T[0].D.a, auditor.s)),
  eg.bsgs32(eg.decryptPoint(wit.T[1].C, wit.T[1].D.a, auditor.s))
);
const aliceReads = eg.decrypt64(wit.Bnew, alice.s);
if (bobReads !== AMOUNT || auditorReads !== AMOUNT || aliceReads !== DEPOSIT - AMOUNT) throw new Error("decrypt mismatch");
lap(`decrypt ok: bob +${bobReads} · auditor ${auditorReads} · alice new balance ${aliceReads}`);

// a wrong key must not decrypt to the amount (sanity)
let wrong = null;
try { wrong = eg.bsgs32(eg.decryptPoint(wit.T[0].C, wit.T[0].D.r, auditor.s)); } catch { /* expected: not in range */ }
if (wrong === eg.split64(AMOUNT)[0]) throw new Error("wrong key decrypted");
lap("wrong key does not decrypt");

if (witnessOnly || !existsSync(B("transfer_final.zkey"))) {
  console.log(witnessOnly ? "witness-only run: done" : "no zkey yet (run npm run setup): stopping before prove");
  process.exit(0);
}

// prove + verify
const { proof, publicSignals } = await snarkjs.groth16.fullProve(wit.input, wasm, B("transfer_final.zkey"));
lap(`proof generated (${publicSignals.length} public signals)`);
const vk = JSON.parse(readFileSync(B("transfer_vk.json"), "utf8"));
if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("snarkjs verify failed");
lap("snarkjs verify ok");

// encode for the contract and run the T1 verifier under vert
const payload = { vk: encodeVk(vk), proof: encodeProof(proof), inputs: encodeInputs(publicSignals) };
writeFileSync(B("transfer_payload.json"), JSON.stringify(payload));
const { Blockchain, expectToThrow } = await import("@proton/vert");
const bc = new Blockchain();
const contract = bc.createContract("verifier", join(HERE, "../../contracts/xpr-conf-tsc/assembly/target/groth16.contract"));
for (let i = 0; i < 200 && !contract.actions.verify; i++) await new Promise((r) => setTimeout(r, 25));
await contract.actions.verify([payload.vk, payload.proof, payload.inputs]).send("verifier@active");
lap(`vert: proton-tsc verifier accepted the transfer proof (vk ${payload.vk.length / 2} B, ${publicSignals.length} inputs)`);
const bad = payload.inputs.slice(0, -2) + (payload.inputs.endsWith("00") ? "01" : "00");
await expectToThrow(contract.actions.verify([payload.vk, payload.proof, bad]).send("verifier@active"), "eosio_assert: invalid proof");
lap("vert: tampered public input rejected");
console.log("T2 end-to-end passed; payload at build/transfer_payload.json");
process.exit(0);
