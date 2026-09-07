import { useEffect, useState } from "react";
import { CONTRACT, CRYPTO_MODE, EXPLORER, NETWORK_LABEL } from "../config";
import * as chain from "../lib/chain";
import { fmtUnits } from "../lib/format";
import { XMD, XPR } from "../lib/token";
import { Excerpt } from "./Brand";
import { TokenIcon } from "./ui";
import { Walkthrough } from "./Walkthrough";

const CEREMONY_URL = "https://ceremony.private.protonnz.com";

/** Tokens and their early-access caps, read from the contract (the simulation shows the mainnet values). */
const Limits = () => {
  const [rows, setRows] = useState<chain.PoolLimits[] | null>(null);
  useEffect(() => {
    if (CRYPTO_MODE === "mock") {
      setRows([
        { token: XPR, maxPool: 10_000_000_000n, maxDeposit: 10_000_000n, pool: 0n, withdrawGranularity: 10_000n },
        { token: XMD, maxPool: 10_000_000_000n, maxDeposit: 1_000_000_000n, pool: 0n, withdrawGranularity: 1_000_000n },
      ]);
      return;
    }
    chain.listLimits().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows) return <p className="muted">Reading the contract</p>;
  if (!rows.length) return <p className="muted">The contract's limits could not be read right now.</p>;
  const whole = (v: bigint, t: chain.PoolLimits["token"]) => fmtUnits(v, t, { trim: true });
  return (
    <div className="limits">
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Per deposit</th>
            <th>In the contract</th>
            <th>Withdrawals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.token.code}>
              <td><span className="tok"><TokenIcon code={r.token.code} />{r.token.code}</span></td>
              <td>{r.maxDeposit ? `up to ${whole(r.maxDeposit, r.token)}` : "no cap"}</td>
              <td>{r.maxPool ? `${whole(r.pool, r.token)} of ${whole(r.maxPool, r.token)}` : whole(r.pool, r.token)}</td>
              <td>{r.withdrawGranularity > 1n ? `multiples of ${whole(r.withdrawGranularity, r.token)} ${r.token.code}` : "any amount"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** How it works. Facts follow docs/01-design.md; written for a user. */
export const About = ({ signedIn, onConnect }: { signedIn: boolean; onConnect?: () => void }) => (
  <article className="about">
    <section>
      <h1>How Confidential XPR works</h1>
      <p>
        Confidential XPR is a balance you hold inside a contract on XPR Network. It holds XPR and XMD, the Metal Dollar, and more
        tokens can be added. You deposit ordinary tokens into it, and from then on your balance and every payment you make are
        stored as encrypted numbers. The chain still records who paid whom and when. It no longer shows how much.
      </p>
      <p className="coins" aria-label="Tokens held">
        <span className="tok"><TokenIcon code="XPR" size={28} />XPR</span>
        <span className="tok"><TokenIcon code="XMD" size={28} />XMD, the Metal Dollar</span>
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
      <h2>Getting started</h2>
      <ol className="howto">
        <li>Connect your WebAuth wallet. Nothing is sent to the chain.</li>
        <li>Sign one message. Your wallet's signature becomes the key that opens your boxes. There is nothing to write down or back up.</li>
        <li>Register once. This publishes your encryption key so anyone can pay you inside the contract, in any token it holds. It uses about a kilobyte of your account's RAM.</li>
        <li>Deposit XPR or XMD from your public balance. From here on, send to any registered account, fold incoming payments into your balance, or withdraw.</li>
      </ol>
      <p>
        Sending asks your wallet for one signature per payment, and the proof is made on your device before it. If your browser
        blocks the wallet's popup, allow popups for this site.
      </p>
    </section>

    <section>
      <h2>Pending payments and folding</h2>
      <p>
        A payment to you lands in a pending box, not straight in your balance. Your balance changes only when you act, so a
        proof you are building can never be spoiled by someone paying you at the same moment, and nobody can interfere with
        your balance by sending you dust. Folding moves the pending box into your balance: one quick signature, nothing
        leaves the contract. Fold when you like, or let the app fold for you as part of your next send.
      </p>
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
        Money enters and leaves the contract in public, because a deposit and a withdrawal move ordinary tokens. If you deposit an
        unusual amount, send it once, and the recipient withdraws exactly that amount an hour later, anyone can guess what happened.
      </p>
      <p>
        Inside, amounts are hidden by cryptography. At the edges they are hidden by round numbers, time and volume. Withdrawals are
        limited to whole units, 1 XPR or 1 XMD, and the app warns you before a withdrawal that matches something you received.
        The private path is to keep your balance inside and pay other confidential accounts directly.
      </p>
    </section>

    <section>
      <h2>The auditor</h2>
      <p>
        One viewing key, held by the designated supervisor, can read every payment amount. It cannot spend, and it cannot open the
        balances themselves; it reconstructs them by adding up payments, deposits and withdrawals, which is exactly what a
        supervisor's ledger needs. This is the difference between confidential and anonymous: the amounts are hidden from the
        public, not from oversight. The auditor page shows what that key sees.
      </p>
    </section>

    <section>
      <h2>If you lose your key</h2>
      <p>
        For most accounts the key comes back from your wallet's signature every time, so there is nothing to lose. Accounts that sign in with a
        passkey get a saved key instead, because passkey signatures differ every time. Those accounts can keep an encrypted recovery copy with
        the XPR Network committee: if the device is lost, the committee returns the key after you prove you own the account. And if a key is
        ever beyond recovery, the committee can pause the token and return an account's balance from escrow, using the amounts its viewing key
        can read. Funds in the contract are recoverable; they are never simply gone.
      </p>
    </section>

    <section>
      <h2>Tokens and limits</h2>
      <p>
        This is an early release, so the contract caps what it holds. The caps are set on chain and will be raised in steps.
      </p>
      <Limits />
    </section>

    <section>
      <h2>Status</h2>
      <ul className="plain">
        <li>
          Running on {NETWORK_LABEL}. Contract{" "}
          <a href={`${EXPLORER}/account/${CONTRACT}`} target="_blank" rel="noreferrer">
            {CONTRACT}
          </a>
          , owned by the XPR Network committee.
        </li>
        <li>Proofs are generated in your browser and take about two seconds. The network checks one in about twelve milliseconds.</li>
        <li>
          The proving key comes from a one-person rehearsal until the public ceremony completes. Anyone can{" "}
          <a href={CEREMONY_URL} target="_blank" rel="noreferrer">contribute randomness</a>; as long as one contributor was honest, nobody can forge a proof.
        </li>
        <li>The code has not been audited yet. The caps above bound what is at stake until it has.</li>
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
