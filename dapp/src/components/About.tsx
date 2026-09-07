import { CONTRACT, EXPLORER, NETWORK_LABEL } from "../config";
import { Excerpt } from "./Brand";
import { Walkthrough } from "./Walkthrough";

/** How it works. Facts follow docs/01-design.md; written for a user. */
export const About = ({ signedIn, onConnect }: { signedIn: boolean; onConnect?: () => void }) => (
  <article className="about">
    <section>
      <h1>How Confidential XPR works</h1>
      <p>
        Confidential XPR is a balance you hold inside a contract on XPR Network. You deposit ordinary XPR into it, and from then on
        your balance and every payment you make are stored as encrypted numbers. The chain still records who paid whom and when.
        It no longer shows how much.
      </p>
      <p>
        Three parties can read an amount: you, the other party, and a designated auditor. Nobody else can, including the validators
        that run the network. Your wallet keeps working as it does today; it signs ordinary transactions and needs no changes.
      </p>
    </section>

    <section>
      <h2>Three ideas make this work</h2>

      <h3>Boxes you can add without opening</h3>
      <p>
        Every balance and every payment is a locked box holding a number. The boxes have a useful property: the contract can add and
        subtract them without opening them. So it can move value from box to box and never see what is inside.
      </p>
      <Excerpt />

      <h3>A stamp that proves the payment is valid</h3>
      <p>
        Before a payment is accepted, your device attaches a small mathematical proof: the amount is a valid number, you are not
        overdrawn, and every copy of the box holds the same number. The network checks the proof in a few milliseconds without
        learning the amount. A payment that fails the check is rejected, like an overdraft today.
      </p>

      <h3>Two keyholes on every box</h3>
      <p>
        Each box is made to open with the recipient's key and with the auditor's key. That is part of what the proof checks, so a
        payment the auditor cannot read cannot be created. This is why the system is confidential rather than anonymous.
      </p>
    </section>

    <section>
      <h2>Watch it happen</h2>
      <p>
        Alice deposits, sends to Bob, Bob withdraws a round amount, and the auditor reads it all. Twenty-four seconds, on a loop.
      </p>
      <Walkthrough />
    </section>

    <section>
      <h2>What is public and what is hidden</h2>
      <div className="cols">
        <div>
          <h3>Public</h3>
          <ul>
            <li>Who paid whom, and when</li>
            <li>Deposits into the contract</li>
            <li>Withdrawals out of it</li>
            <li>The total held in the contract</li>
            <li>How often two accounts transact</li>
          </ul>
        </div>
        <div>
          <h3>Hidden</h3>
          <ul>
            <li>Every payment amount</li>
            <li>Every balance inside the contract</li>
            <li>Readable only by the sender, the recipient and the auditor</li>
          </ul>
        </div>
      </div>
    </section>

    <section>
      <h2>Privacy at the edges</h2>
      <p>
        Money enters and leaves the contract in public, because a deposit and a withdrawal move ordinary XPR. If you deposit an
        unusual amount, send it once, and the recipient withdraws exactly that amount an hour later, anyone can guess what happened.
      </p>
      <p>
        Inside, amounts are hidden by cryptography. At the edges they are hidden by round numbers, time and volume. Withdrawals are
        limited to whole XPR, and the app warns you before a withdrawal that matches something you received. The private path is
        to keep your balance inside and pay other confidential accounts directly.
      </p>
    </section>

    <section>
      <h2>The auditor</h2>
      <p>
        One viewing key per token, held by the designated supervisor, can read every payment amount. It cannot spend, and it cannot
        open the balances themselves; it reconstructs them by adding up payments, deposits and withdrawals, which is exactly what a
        supervisor's ledger needs. The auditor page shows what that key sees.
      </p>
    </section>

    <section>
      <h2>Status</h2>
      <ul className="plain">
        <li>
          Running on {NETWORK_LABEL}. Contract{" "}
          <a href={`${EXPLORER}/account/${CONTRACT}`} target="_blank" rel="noreferrer">
            {CONTRACT}
          </a>
          .
        </li>
        <li>Proofs are generated in your browser and take about two seconds.</li>
        <li>Your wallet is the key: one signature derives the key that opens your boxes. There is nothing to back up.</li>
      </ul>
      {!signedIn && onConnect ? (
        <p className="cta">
          <button className="btn big" onClick={onConnect}>
            Connect wallet
          </button>
        </p>
      ) : null}
    </section>
  </article>
);
