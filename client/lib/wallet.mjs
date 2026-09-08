// Key files and signing for the headless client. The private-payment key lives in
// ~/.private-xpr/<network>/<account>.json (mode 600). Chain writes are signed by the proton CLI
// keychain: the account's XPR key never enters this process.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import N from "../../circuits/lib/notes.mjs";

export const KEY_DIR = process.env.PRIVATEXPR_HOME ?? join(homedir(), ".private-xpr");

export function keyPath(network, account) {
  return join(KEY_DIR, network, `${account}.json`);
}
export function loadKey(network, account) {
  const p = keyPath(network, account);
  if (!existsSync(p)) throw new Error(`no key for ${account} on ${network}: run \`keys new ${account}\` or \`keys import ${account} <secret>\``);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return N.keygen(BigInt(j.secret));
}
export function saveKey(network, account, ask, meta = {}) {
  const dir = join(KEY_DIR, network);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = keyPath(network, account);
  if (existsSync(p)) throw new Error(`${p} exists; remove it first if you really want to replace the key`);
  writeFileSync(p, JSON.stringify({ format: "pulse-privacy/shieldkey/v1", account, network: `xpr-${network}`, secret: "0x" + N.hex32(ask), ...meta, warning: "Anyone with this secret can read your notes. Spending still needs your wallet." }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}
export function parseSecret(input) {
  let t = input.trim();
  if (existsSync(t)) t = readFileSync(t, "utf8").trim();
  if (t.startsWith("{")) t = String(JSON.parse(t).secret ?? "");
  t = t.replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(t)) throw new Error("a secret is 64 hexadecimal characters, or a key file");
  return BigInt("0x" + t);
}

/** run one action through the proton CLI keychain on the network's chain; returns the transaction id */
export function act(net, contract, name, data, actor, permission = "active") {
  const run = (args) => {
    const r = spawnSync("proton", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const text = (String(r.stdout ?? "") + "\n" + String(r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "");
    return { status: r.status, text };
  };
  run(["chain:set", net.chain]);
  let r;
  try { r = run(["action", contract, name, JSON.stringify(data), `${actor}@${permission}`]); }
  finally { run(["chain:set", "proton"]); }
  if (process.env.PRIVATEXPR_DEBUG) console.error(r.text);
  const id = (r.text.match(/"transaction_id":\s*"([0-9a-f]{64})"/) || r.text.match(/tx\/([0-9a-f]{64})/) || [])[1];
  if (r.status !== 0 || !id) {
    const line = r.text.split("\n").filter((l) => /error|assert|failure|hint|missing|expired|exceeded|insufficient/i.test(l)).join(" | ").slice(0, 500);
    throw new Error(`${contract}::${name} did not go through: ${line || r.text.trim().slice(0, 300) || "no output from the proton CLI"}`);
  }
  const cpu = (r.text.match(/"cpu_usage_us":\s*(\d+)/) || [])[1];
  return { id, cpu: cpu ? Number(cpu) : undefined };
}
