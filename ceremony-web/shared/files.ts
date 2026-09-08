/** Content-addressed uploads are immutable, including across concurrent retry requests. */
export function contributionPath(phase: number, index: number, actor: string, sha256: string): string {
  if ((phase !== 1 && phase !== 2) || !Number.isSafeInteger(index) || index < 1 ||
      !/^[a-z1-5.]{1,12}$/.test(actor) || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Invalid contribution path");
  }
  return `p${phase}/${String(index).padStart(2, "0")}-${actor}-${sha256}.${phase === 1 ? "ptau" : "zkey"}`;
}
