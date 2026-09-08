// WebAuth login on XPR mainnet and the signed attestation (never broadcast), same mechanics as
// the dapp's unlock: a fixed transaction with xprconf::viewkey(owner, note).
import type { ConnectWalletArgs, ConnectWalletRet } from "@proton/web-sdk";

export const CHAIN_ID = "384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0";
export const ENDPOINTS = ["https://api.protonnz.com", "https://proton.eosusa.io", "https://proton.cryptolions.io"];
export const CONTRACT = "xprconf";

export interface Session {
  auth: { actor: string; permission: string };
  transact(tx: { transaction: unknown }, opts: { broadcast: boolean }): Promise<{ signatures: { toString(): string }[] }>;
}

type Sdk = (args: ConnectWalletArgs) => Promise<ConnectWalletRet>;
let sdkReady: Promise<Sdk> | null = null;
const loadSdk = () => (sdkReady ??= Promise.all([import("@proton/web-sdk"), import("@proton/link")]).then(([m]) => m.default as unknown as Sdk));

const options = (restoreSession: boolean): ConnectWalletArgs => ({
  linkOptions: { chainId: CHAIN_ID, endpoints: ENDPOINTS, restoreSession },
  transportOptions: { requestAccount: CONTRACT, requestStatus: true },
  selectorOptions: { enabledWalletTypes: ["proton", "webauth", "anchor"] },
  uiOptions: { theme: "light", appInfo: { name: "Shielded XPR ceremony", logo: `${location.origin}/icon.svg`, logoRounded: true } },
});

export async function login(restore = false): Promise<Session | null> {
  const sdk = await loadSdk();
  const r = await sdk(options(restore));
  if (r.error) throw r.error instanceof Error ? r.error : new Error(String(r.error));
  return (r.session as unknown as Session) ?? null;
}

export const noteFor = (phase: number, index: number, sha256: string) => `ceremony/${phase}/${index}/${sha256}`;
export const lockNoteFor = (phase: number, index: number, ts: number) => `ceremony/lock/${phase}/${index}/${ts}`;

export function attestationTransaction(actor: string, permission: string, note: string) {
  return {
    expiration: "2035-01-01T00:00:00",
    ref_block_num: 0,
    ref_block_prefix: 0,
    max_net_usage_words: 0,
    max_cpu_usage_ms: 0,
    delay_sec: 0,
    context_free_actions: [],
    actions: [{ account: CONTRACT, name: "viewkey", authorization: [{ actor, permission }], data: { owner: actor, note } }],
    transaction_extensions: [],
  };
}

export async function signAttestation(session: Session, note: string): Promise<string> {
  const r = await session.transact({ transaction: attestationTransaction(session.auth.actor, session.auth.permission, note) }, { broadcast: false });
  const sig = r.signatures?.[0];
  if (!sig) throw new Error("the wallet returned no signature");
  return sig.toString();
}
