import { useEffect, useId, useRef, useState } from "react";

const SCENES = [
  { label: "Deposit", title: "Public money goes in.", text: "Alice deposits 5,000 XPR. The deposit and the total held by the contract are public." },
  { label: "Send", title: "The payment amount stays private.", text: "Alice pays Bob inside the contract. The network checks the proof and records who paid whom, without reading the amount." },
  { label: "Withdraw", title: "Money comes out in public.", text: "Bob adds his incoming payment to his balance, then withdraws 1,000 XPR. That withdrawal is public." },
  { label: "Auditor", title: "A viewing key opens the payment record.", text: "The auditor reads the 1,234 XPR payment and reconstructs balances from the ledger. The viewing key does not authorise spending." },
];
const STEP = 6;
const DURATION = SCENES.length * STEP;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const progress = (t: number, from: number, to: number) => {
  const x = clamp((t - from) / (to - from));
  return x * x * (3 - 2 * x);
};
const format = (n: number) => n.toLocaleString("en-US");
const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function initialTime() {
  // Freeze an illustrative frame for review without running a wallet or a transaction.
  const value = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("wt") : null;
  if (value !== null && value.trim() !== "" && Number.isFinite(Number(value))) return Math.max(0, Math.min(DURATION, Number(value)));
  return null;
}

function Lock() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v3" /></svg>;
}

export function Walkthrough() {
  const [frozen] = useState(initialTime);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [t, setT] = useState(() => frozen ?? (reduced ? STEP - 0.1 : 0));
  const [paused, setPaused] = useState(() => reduced || frozen !== null);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  const root = useRef<HTMLDivElement>(null);
  const time = useRef(t);
  const captionId = useId();
  const scene = Math.min(SCENES.length - 1, Math.floor(t / STEP));
  const ended = t >= DURATION;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => {
      setReduced(media.matches);
      if (media.matches) {
        setPaused(true);
        time.current = Math.min(DURATION, (Math.floor(time.current / STEP) + 1) * STEP - 0.1);
        setT(time.current);
      }
    };
    const visibility = () => setVisible(!document.hidden);
    media.addEventListener("change", change);
    document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.15 });
    if (root.current) observer.observe(root.current);
    return () => {
      media.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", visibility);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (paused || reduced || !inView || !visible) return;
    let frame = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      if (last !== null) {
        time.current = Math.min(DURATION, time.current + (now - last) / 1000);
        setT(time.current);
      }
      last = now;
      if (time.current >= DURATION) setPaused(true);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, reduced, inView, visible]);

  const seek = (step: number) => {
    time.current = step * STEP + STEP - 0.1;
    setT(time.current);
    setPaused(true);
  };
  const replay = () => {
    time.current = reduced ? STEP - 0.1 : 0;
    setT(time.current);
    setPaused(reduced);
  };

  const deposited = t >= 3.5;
  const sent = t >= 9.7;
  const folded = t >= 13.5;
  const withdrawn = t >= 16;
  const auditing = scene === 3;
  const depositing = scene === 0 && t >= 0.7 && !deposited;
  const sending = scene === 1 && t >= 6.8 && !sent;
  const withdrawing = scene === 2 && t >= 14 && !withdrawn;
  const total = deposited ? (withdrawn ? 4000 : 5000) : 0;
  const transferProgress = progress(t, 6.8, 9.7);
  const description = `Illustration, step ${scene + 1}: ${SCENES[scene].text} Alice's public wallet: ${deposited ? "0" : "5,000"} XPR. Bob's public wallet: ${withdrawn ? "1,000" : "0"} XPR. Public contract total: ${format(total)} XPR. ${auditing ? "Auditor ledger: Alice deposited 5,000, paid Bob 1,234, and Bob withdrew 1,000 XPR. Individual balance boxes remain encrypted." : "Individual confidential balances and the internal payment amount are hidden in this public view."}`;

  return (
    <div className="walkthrough" ref={root} role="group" aria-label="How a confidential payment works">
      <div className="wt-steps" aria-label="Choose an explanation step">
        {SCENES.map((s, i) => <button key={s.label} type="button" className="wt-step-button" aria-current={scene === i ? "step" : undefined} onClick={() => seek(i)}>
          <span className="wt-step-number">{i + 1}</span>{s.label}
          <span className="wt-step-progress" style={{ transform: `scaleX(${clamp((t - i * STEP) / STEP)})` }} />
        </button>)}
      </div>

      <div className="wt-story" id={captionId} aria-live={paused ? "polite" : "off"} aria-atomic="true">
        <h3>{SCENES[scene].title}</h3>
        <p>{SCENES[scene].text}</p>
      </div>

      <div className={`wt-stage${auditing ? " wt-auditing" : ""}`} role="img" aria-label={description}>
        <div aria-hidden="true">
          <div className="wt-wallets">
            <div className={`wt-wallet${depositing ? " wt-active" : ""}`}>
              <span className="wt-person"><span className="wt-avatar">A</span>Alice</span>
              <span className="wt-wallet-label">Public wallet</span>
              <strong>{deposited ? "0" : "5,000"}<small> XPR</small></strong>
            </div>
            <div className={`wt-wallet${withdrawing ? " wt-active" : ""}`}>
              <span className="wt-person"><span className="wt-avatar">B</span>Bob</span>
              <span className="wt-wallet-label">Public wallet</span>
              <strong>{withdrawn ? "1,000" : "0"}<small> XPR</small></strong>
            </div>
          </div>

          <div className="wt-routes">
            <div className={`wt-route${scene === 0 ? " wt-route-active" : ""}`}>
              <span className="wt-route-line" />
              <span className="wt-route-arrow">↓</span>
              {scene === 0 && <span className="wt-money" style={{ transform: `translateY(${depositing ? -18 + 36 * progress(t, 0.7, 3.5) : deposited ? 18 : -18}px)`, opacity: deposited ? 0 : 1 }}>5,000 XPR</span>}
            </div>
            <div className={`wt-route${scene === 2 ? " wt-route-active" : ""}`}>
              <span className="wt-route-line" />
              <span className="wt-route-arrow">↑</span>
              {scene === 2 && <span className="wt-money" style={{ transform: `translateY(${withdrawing ? 18 - 36 * progress(t, 14, 16) : withdrawn ? -18 : 18}px)`, opacity: withdrawn || !folded ? 0 : 1 }}>1,000 XPR</span>}
            </div>
          </div>

          <div className="wt-pool">
            <div className="wt-pool-heading"><span>Inside the contract</span><span className="wt-view"><Lock />Encrypted balances</span></div>
            <div className="wt-total"><span>Total held · public</span><strong>{format(total)} <small>XPR</small></strong></div>
            <div className="wt-boxes">
              <div className={`wt-box${deposited ? " wt-box-funded" : ""}`}><span>Alice’s balance</span><span className="wt-hidden" /><small>{deposited ? "Encrypted" : "No deposit yet"}</small></div>
              <div className={`wt-box${sent ? " wt-box-funded" : ""}`}><span>{sent && !folded ? "Bob’s incoming" : "Bob’s balance"}</span><span className="wt-hidden" /><small>{sent ? folded ? "Encrypted" : "Ready to add" : "No payment yet"}</small></div>
            </div>
            <div className={`wt-transfer${scene === 1 ? " wt-transfer-active" : ""}`}>
              <div className="wt-transfer-track"><span className="wt-transfer-line" />
                {(sending || sent) && <span className="wt-packet" style={{ left: `${10 + 80 * transferProgress}%`, opacity: scene === 1 ? 1 : 0 }}><Lock /></span>}
              </div>
              <span>{scene === 0 ? "Confidential payments stay inside" : scene === 1 ? sent ? "✓ Proof checked · payment received" : "Alice → Bob · encrypted payment" : "Alice → Bob · proof checked"}</span>
            </div>
          </div>

          <div className="wt-ledger">
            <div className="wt-ledger-heading"><span>{auditing ? "Auditor’s payment ledger" : "What the public can read"}</span><span className="wt-view">{auditing ? "Viewing key" : "Public view"}</span></div>
            <div className="wt-ledger-row"><span>Alice deposits</span><strong>{deposited ? "5,000 XPR" : "—"}</strong></div>
            <div className={`wt-ledger-row${auditing ? " wt-ledger-revealed" : ""}`}><span>Alice pays Bob</span><strong>{!sent ? "—" : auditing ? "1,234 XPR" : <span className="wt-ledger-hidden"><Lock />Hidden</span>}</strong></div>
            <div className="wt-ledger-row"><span>Bob withdraws</span><strong>{withdrawn ? "1,000 XPR" : "—"}</strong></div>
          </div>
        </div>
      </div>

      <div className="wt-footer">
        <span className="wt-example">Illustrative amounts · {reduced ? "choose a step" : "24-second example"}</span>
        <div className="wt-controls">
          {reduced ? <button type="button" className="textbtn" onClick={() => seek((scene + 1) % SCENES.length)}>Next step</button> :
            <button type="button" className="textbtn" aria-describedby={captionId} onClick={() => ended ? replay() : setPaused((p) => !p)}>{ended ? "Play again" : paused ? "Play" : "Pause"}</button>}
          <button type="button" className="textbtn quiet" onClick={replay}>Restart</button>
        </div>
      </div>
    </div>
  );
}
