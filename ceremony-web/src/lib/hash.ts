export async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const hex = (a: Uint8Array) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
