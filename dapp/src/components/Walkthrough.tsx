import { useState } from "react";
import { TokenIcon } from "./ui";

const STEPS = [
  { label: "Deposit", title: "First, Alice deposits 5,000 XPR.", text: "She moves money from her wallet into her confidential balance. This deposit is public." },
  { label: "Payment", title: "Then, Alice pays Bob 1,234 XPR.", text: "Alice and Bob can both read this payment. The money stays inside the contract." },
  { label: "Public view", title: "Same payment. Here’s what the public sees.", text: "Anyone can see that Alice paid Bob, and when. The payment amount is encrypted." },
];

function Lock() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v3" /></svg>;
}

/** A reader-paced example: understand the payment before comparing who can read it. */
export function Walkthrough() {
  const [step, setStep] = useState(0);
  const publicView = step === 2;
  const deposit = step === 0;
  const view = deposit ? "Public deposit" : publicView ? "Public view" : "Alice and Bob’s view";
  const description = deposit
    ? "Alice deposits 5,000 XPR from her wallet into her confidential balance. The deposit amount is public."
    : publicView
      ? "Public view of the same payment: Alice pays Bob, but the payment amount is hidden. Alice’s earlier deposit of 5,000 XPR remains public."
      : "Alice and Bob’s view: Alice pays Bob 1,234 XPR inside the contract. Alice’s earlier deposit of 5,000 XPR remains public.";

  return (
    <div className="walkthrough" role="group" aria-label="Who can see a confidential payment">
      <div className="wt-steps" aria-label="Choose an explanation step">
        {STEPS.map((s, i) => <button key={s.label} type="button" className="wt-step-button" aria-current={step === i ? "step" : undefined} onClick={() => setStep(i)}>
          <span className="wt-step-number">{i + 1}</span>{s.label}
        </button>)}
      </div>

      <div className="wt-story" aria-live="polite" aria-atomic="true">
        <h3>{STEPS[step].title}</h3>
        <p>{STEPS[step].text}</p>
      </div>

      <div className={`wt-comparison${publicView ? " wt-public" : ""}`} role="img" aria-label={description}>
        <div aria-hidden="true">
          <div className="wt-view-label">{publicView && <Lock />}{view}</div>
          <div className="wt-journey">
            <div className="wt-person"><span className="wt-avatar">A</span><span>{deposit ? "Alice’s wallet" : "Alice"}</span></div>
            <div className="wt-path"><span className="wt-arrow">→</span>
              {step === 1 && <span className="wt-coin"><TokenIcon code="XPR" size={20} /></span>}
            </div>
            <div className="wt-person"><span className="wt-avatar">{deposit ? <Lock /> : "B"}</span><span>{deposit ? "Confidential balance" : "Bob"}</span></div>
          </div>
          <div className="wt-amount" key={step}>
            {publicView ? <><span className="wt-mask" /><span className="wt-unit">XPR</span></> : <><TokenIcon code="XPR" size={26} /><strong>{deposit ? "5,000" : "1,234"}</strong><span className="wt-unit">XPR</span></>}
          </div>
          <div className="wt-amount-note">{deposit ? "Anyone can read the deposit amount." : publicView ? "The payment amount is hidden from the public." : "The sender and recipient can read the amount."}</div>
          <div className="wt-receipt">
            <span>{deposit ? "Recorded on chain" : "Earlier deposit · still public"}</span>
            <strong>{deposit ? "Public deposit" : "5,000 XPR"}</strong>
          </div>
        </div>
      </div>

      <div className="wt-controls">
        <button type="button" className="btn wt-next" onClick={() => setStep(step === 0 ? 1 : publicView ? 1 : 2)}>
          {deposit ? "See Alice pay Bob" : publicView ? "Show Alice and Bob’s view" : "Show the public view"}<span aria-hidden="true">{publicView ? "↔" : "→"}</span>
        </button>
        {!deposit && <button type="button" className="textbtn quiet" onClick={() => setStep(0)}>Start again</button>}
      </div>
      <p className="wt-example">Example amounts. Choose each step at your own pace.</p>

      <div className="wt-more">
        <details>
          <summary>What happens when Bob withdraws?</summary>
          <p>After receiving the payment, Bob can withdraw <strong>1,000 XPR</strong> to his public wallet. Anyone can read that withdrawal amount. Deposits and withdrawals are public, so their amounts and timing can give clues about payments inside.</p>
        </details>
        <details>
          <summary>What can the auditor see?</summary>
          <p>The designated auditor can also read the <strong>1,234 XPR</strong> payment using a viewing key. It reconstructs balances from the payment history. The viewing key does not authorise spending.</p>
        </details>
      </div>
    </div>
  );
}
