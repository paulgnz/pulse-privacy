import { SHIELD_HOME } from "../config";
import { UNITS } from "../lib/format";
import { Amount } from "./Amount";
import { Line } from "./ui";

/** XPR Network logo followed by the product name. */
export const Brand = ({ href = "/", onNavigate }: { href?: string; onNavigate?: (path: string) => void }) => (
  <a
    className="brand"
    href={href}
    onClick={(e) => {
      if (!onNavigate) return;
      e.preventDefault();
      onNavigate(href);
    }}
  >
    <img src="/xpr-network.svg" alt="XPR Network" height={22} />
    <span>{SHIELD_HOME ? "Shielded" : "Confidential"}</span>
  </a>
);

/** The three-line statement excerpt: a public deposit and two hidden transfers. */
export const Excerpt = () => (
  <div className="excerpt" aria-label="Example statement">
    <Line label="Deposit" sub="public, like any transfer">
      <Amount value={5000n * UNITS} />
    </Line>
    <Line label="Sent to bob" sub="the chain shows who and when">
      <Amount value={1234n * UNITS} hidden />
    </Line>
    <Line label="Received from carol" sub="only you, carol and the auditor can read it">
      <Amount value={250n * UNITS} hidden digits={8} />
    </Line>
  </div>
);
