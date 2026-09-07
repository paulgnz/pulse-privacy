// Randomness for a contribution: OS randomness, the contributor's mouse/touch path over a few
// seconds, and a typed sentence. None of it is stored or sent anywhere.
export function osRandomHex(bytes = 64): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** collects pointer samples until `seconds` elapsed; resolves with a string of samples */
export function collectMotion(seconds: number, onProgress: (f: number) => void): Promise<string> {
  return new Promise((resolve) => {
    const samples: string[] = [];
    const start = performance.now();
    const onMove = (e: PointerEvent) => samples.push(`${e.clientX},${e.clientY},${Math.round(e.timeStamp)}`);
    window.addEventListener("pointermove", onMove);
    const t = setInterval(() => {
      const f = Math.min(1, (performance.now() - start) / (seconds * 1000));
      onProgress(f);
      if (f >= 1) {
        clearInterval(t);
        window.removeEventListener("pointermove", onMove);
        resolve(samples.join(";"));
      }
    }, 100);
  });
}
