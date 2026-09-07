# Design direction — Confidential XPR dapp

Subject: a private ledger. The user holds and moves a balance that lives inside a contract as
an encrypted box; the chain shows parties and timing but not amounts; an auditor can read all
of it. Audience: XPR users trying it on testnet, and Metallicus/regulator stakeholders watching
a demo. Primary job: hold and move a confidential balance with confidence, always seeing which
numbers are private and which are public.

## The one memorable element: redaction

A hidden amount is drawn as a **redaction bar**: a solid ink block the width of the number it
hides, exactly like a blacked-out line on a bank statement (the ELI5 in docs/01-design.md §1.6).
Your own balance is redacted until you choose to reveal it; the reveal lifts the bar to show
tabular figures. In the activity ledger, public amounts are printed in plain ink, hidden ones
are bars, and the auditor view shows bars turning into numbers as the viewing key opens them.
Nothing else in the interface tries to be memorable.

## Tokens

Color (light; single accent):
- paper `#F5F6F3` page, `#FFFFFF` for the ledger sheet
- ink `#101214` text and redaction bars
- graphite `#5F6660` secondary text; rule `#D7DAD3`
- private `#2A4BD7` (ultramarine) for everything encrypted: the reveal control, private tags, primary button
- auditor `#0E7C6B` (teal) for auditor-only reveals
- error `#B3261E`

Type: **Instrument Sans** only (400/500/600), from Google Fonts, `font-variant-numeric:
tabular-nums` on every amount. Scale: 13 / 15 (body) / 17 / 22 / 32 / 44 (statement balance).
Sentence case everywhere. No all-caps labels, no monospace except a ciphertext or tx id, no
middle-dot strings, no em dashes, no arrows in buttons.

Layout: one column, max-width 720px, left-aligned, generous vertical rhythm (8px base, sections
40px apart). A thin top bar: app name at left, account and network dot at right. The overview
reads like a statement: a heading line, the balance line with its redaction bar and a "Reveal"
text control, a pending line if any, then three plain actions (Send, Deposit, Withdraw) as a
row of text buttons under a rule. The ledger is a table with a single header rule and row
rules; no cards, no shadows, no gradients, no rounded panels. Forms open inline below the
action row, never in modals. Focus rings visible (2px private outline). Motion: only the
reveal (bar fades to figures, 160 ms) and form open/close; respect `prefers-reduced-motion`.

Login: the hero is a three-line statement excerpt that explains the product without prose:
"Deposit 5,000.0000 XPR" (plain), "Sent to bob ▬▬▬▬" (bar), "Received from carol ▬▬▬" (bar),
then one sentence and the "Continue with WebAuth" button. Testnet notice as a quiet line.

## What was rejected

The first version used the film's dark navy, periwinkle gradients, all-caps mono labels, glowing
cards and "· " strings. Do not reintroduce any of it.
