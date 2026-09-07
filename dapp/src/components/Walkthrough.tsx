import { useEffect, useRef, useState } from "react";

// "Watch it happen": one 24-second loop, four scenes of six seconds, drawn as inline SVG from a
// single clock so every element is a pure function of time. Pause/replay; reduced motion shows
// the final frame with all four captions.

const SCENES = [
  { at: 0, text: "A deposit is public, like any transfer." },
  { at: 6, text: "Inside, only boxes move. The chain sees who and when, not how much." },
  { at: 12, text: "Withdrawing is public again. Bob takes a round amount, so the edge says little." },
  { at: 18, text: "The auditor can read every amount. Nobody else can." },
];
const LOOP = 24;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
/** 0 → 1 between t0 and t1, eased */
const seg = (t: number, t0: number, t1: number) => ease(clamp((t - t0) / (t1 - t0)));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// layout (viewBox 720 × 330)
const W = 720;
const H = 330;
const ALICE_X = 90;
const BOB_X = 630;
const CX = 360; // contract centre
const C = { x: 232, y: 96, w: 256, h: 168 }; // contract rectangle
const ROW_ALICE = C.y + 74;
const ROW_BOB = C.y + 116;
const PUBLIC_Y = 212; // people's public balance line
const BAR_W = 88;
const BAR_H = 13;

export const Walkthrough = () => {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // `?wt=<seconds>` freezes the clock at a point in the loop (screenshots, reviews)
  const frozen = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("wt")) : 0;
  const [t, setT] = useState(reduced ? 23.2 : frozen > 0 ? frozen % LOOP : 0);
  const [paused, setPaused] = useState(reduced || frozen > 0);
  const raf = useRef(0);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (paused) {
      last.current = null;
      return;
    }
    const tick = (now: number) => {
      if (last.current !== null) setT((x) => (x + (now - last.current!) / 1000) % LOOP);
      last.current = now;
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [paused]);

  const scene = SCENES.filter((s) => t >= s.at).length - 1;

  // ---- scene 1: deposit (0–6) ----
  const dep = seg(t, 0.6, 3.2); // figure travelling Alice → contract
  const depDone = t >= 3.2;
  const aliceBoxIn = seg(t, 3.4, 4.4);
  const alicePublic = depDone ? 0 : 5000;

  // ---- scene 2: send (6–12) ----
  const snd = seg(t, 7.0, 10.0); // box travelling Alice row → Bob pending row
  const sndDone = t >= 10.0;
  const bobPendingIn = seg(t, 10.0, 10.8);

  // ---- scene 3: fold + withdraw (12–18) ----
  const fold = seg(t, 12.6, 13.6); // pending merges into Bob's box
  const folded = t >= 13.6;
  const wd = seg(t, 14.2, 16.8); // figure travelling contract → Bob
  const wdDone = t >= 16.8;
  const bobPublic = wdDone ? 1000 : 0;
  const escrow = depDone ? (wdDone ? 4000 : 5000) : 0;

  // ---- scene 4: auditor (18–24) ----
  const open = seg(t, 18.6, 19.6) * (1 - seg(t, 22.8, 23.6));

  // travelling positions
  const depX = lerp(ALICE_X, CX, dep);
  const depY = lerp(PUBLIC_Y, C.y + 40, dep);
  const sndX = lerp(C.x + 128, C.x + 128, snd);
  const sndY = lerp(ROW_ALICE, ROW_BOB, snd);
  const wdX = lerp(CX, BOB_X, wd);
  const wdY = lerp(C.y + 40, PUBLIC_Y, wd);

  const Bar = ({ x, y, w = BAR_W, opacity = 1, label, value, revealed }: { x: number; y: number; w?: number; opacity?: number; label?: string; value?: string; revealed?: number }) => (
    <g opacity={opacity}>
      {label ? (
        <text x={x} y={y} className="wt-label">
          {label}
        </text>
      ) : null}
      <g opacity={1 - (revealed ?? 0)}>
        <rect x={x + (label ? 92 : 0)} y={y - BAR_H + 2} width={w} height={BAR_H} rx={2} className="wt-bar" />
      </g>
      {value !== undefined ? (
        <text x={x + (label ? 92 : 0)} y={y} className="wt-num wt-auditor" opacity={revealed ?? 0}>
          {value}
        </text>
      ) : null}
    </g>
  );

  return (
    <div className="walkthrough">
      <div className="wt-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Animated walkthrough of a deposit, a confidential send, a withdrawal and the auditor's view">
          {/* people */}
          <text x={ALICE_X} y={72} className="wt-name" textAnchor="middle">
            alice
          </text>
          <text x={BOB_X} y={72} className="wt-name" textAnchor="middle">
            bob
          </text>
          <text x={ALICE_X} y={PUBLIC_Y - 22} className="wt-label" textAnchor="middle">
            public
          </text>
          <text x={BOB_X} y={PUBLIC_Y - 22} className="wt-label" textAnchor="middle">
            public
          </text>
          <text x={ALICE_X} y={PUBLIC_Y} className="wt-num" textAnchor="middle" opacity={dep > 0 && !depDone ? 0.35 : 1}>
            {fmt(alicePublic)} XPR
          </text>
          <text x={BOB_X} y={PUBLIC_Y} className="wt-num" textAnchor="middle">
            {fmt(bobPublic)} XPR
          </text>

          {/* contract */}
          <rect x={C.x} y={C.y} width={C.w} height={C.h} rx={6} className="wt-contract" />
          <text x={CX} y={C.y - 12} className="wt-name" textAnchor="middle">
            xprconf
          </text>
          <text x={CX} y={C.y + 26} className="wt-label" textAnchor="middle">
            escrow
          </text>
          <text x={CX} y={C.y + 48} className="wt-num wt-escrow" textAnchor="middle">
            {fmt(escrow)} XPR
          </text>
          <line x1={C.x + 20} y1={C.y + 58} x2={C.x + C.w - 20} y2={C.y + 58} className="wt-rule" />

          {/* Alice's box inside the contract */}
          <Bar x={C.x + 20} y={ROW_ALICE} label="alice" opacity={aliceBoxIn} value={fmt(3766)} revealed={open} />
          {/* Bob's row: pending until folded */}
          <text x={C.x + 20} y={ROW_BOB} className="wt-label" opacity={bobPendingIn}>
            {folded ? "bob" : "bob, pending"}
          </text>
          <g opacity={bobPendingIn}>
            <g opacity={1 - open}>
              <rect x={C.x + 112} y={ROW_BOB - BAR_H + 2} width={lerp(BAR_W * 0.7, BAR_W, fold)} height={BAR_H} rx={2} className="wt-bar" />
            </g>
            <text x={C.x + 112} y={ROW_BOB} className="wt-num wt-auditor" opacity={open}>
              {fmt(folded ? (wdDone ? 234 : 1234) : 1234)}
            </text>
          </g>
          {/* transfer record, opened by the auditor */}
          <text x={C.x + 20} y={C.y + C.h - 14} className="wt-label" opacity={sndDone ? 1 : 0}>
            alice → bob
          </text>
          <g opacity={sndDone ? 1 : 0}>
            <g opacity={1 - open}>
              <rect x={C.x + 112} y={C.y + C.h - 14 - BAR_H + 2} width={BAR_W * 0.7} height={BAR_H} rx={2} className="wt-bar" />
            </g>
            <text x={C.x + 112} y={C.y + C.h - 14} className="wt-num wt-auditor" opacity={open}>
              {fmt(1234)} sent
            </text>
          </g>

          {/* scene 1: travelling deposit figure */}
          {dep > 0 && !depDone ? (
            <g>
              <image href="/token-xpr.png" x={depX - 72} y={depY - 15} width={18} height={18} />
              <text x={depX + 8} y={depY} className="wt-num wt-move" textAnchor="middle">
                {fmt(5000)} XPR
              </text>
            </g>
          ) : null}

          {/* scene 2: travelling box with proof tag */}
          {snd > 0 && !sndDone ? (
            <g>
              <rect x={sndX - BAR_W * 0.35} y={sndY - BAR_H + 2} width={BAR_W * 0.7} height={BAR_H} rx={2} className="wt-bar" />
              <text x={sndX + BAR_W * 0.35 + 10} y={sndY} className="wt-tag">
                proof, 128 bytes
              </text>
            </g>
          ) : null}

          {/* scene 3: travelling withdrawal figure */}
          {wd > 0 && !wdDone ? (
            <g>
              <image href="/token-xpr.png" x={wdX - 72} y={wdY - 15} width={18} height={18} />
              <text x={wdX + 8} y={wdY} className="wt-num wt-move" textAnchor="middle">
                {fmt(1000)} XPR
              </text>
            </g>
          ) : null}

          {/* scene 4: the auditor's key */}
          <g opacity={open} transform={`translate(${C.x + C.w + 28} ${C.y + C.h - 30})`}>
            <circle cx={0} cy={0} r={5} className="wt-key" />
            <path d="M5 0h16M15 0v4M20 0v4" className="wt-key" />
            <text x={0} y={22} className="wt-label wt-auditor">
              auditor
            </text>
          </g>
        </svg>
      </div>

      {reduced ? (
        <ol className="wt-captions">
          {SCENES.map((s) => (
            <li key={s.at}>{s.text}</li>
          ))}
        </ol>
      ) : (
        <div className="wt-bar-row">
          <p className="wt-caption" aria-live="polite">
            <span className="wt-step">{scene + 1} of 4</span>
            {SCENES[scene].text}
          </p>
          <span className="wt-controls">
            <button className="textbtn quiet" onClick={() => setPaused((p) => !p)}>
              {paused ? "Play" : "Pause"}
            </button>
            <button
              className="textbtn quiet"
              onClick={() => {
                setT(0);
                setPaused(false);
              }}
            >
              Replay
            </button>
          </span>
        </div>
      )}
    </div>
  );
};
