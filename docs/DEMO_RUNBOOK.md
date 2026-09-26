# TerraVault — 3-Minute Demo Runbook

> Timed to the beat. Two presenters (**Driver** = drives the console/control file; **Narrator** = speaks). Every number below is what the seed script produces; every scenario is staged by editing **`scripts/keeper/demo-control.json`**, which the guardian price pusher hot-reloads each tick.

---

## Pre-flight checklist (do this BEFORE you're on stage)

- [ ] Contracts deployed to HashKey Testnet (`npm run deploy`) — **have the deploy tx hash on a sticky note.** If asked "is it live?", show it.
- [ ] Demo position seeded (`npm run seed`) — HF prints **1.275**. Confirm in the seed output.
- [ ] Three terminals open and visible on screen:
  - **T1** — `npm run keeper` (guardian price pusher, prints a status line each tick)
  - **T2** — `npm run agent` (AI Risk Monitor, prints HF each tick)
  - **T3** — the front-end console / dashboard connected to the **demoUser** wallet
- [ ] `demo-control.json` reset to the calm baseline: `bMTB: {priceA: 1.02, priceB: 1.02}`, `mUSDC: {priceA: 1.00, priceB: 1.00}`.
- [ ] Keeper terminal shows a green **`OK`** line for bMTB at `$1.02`. Agent shows **`✓ OK HF 1.275`**.
- [ ] Browser zoom up so the back row can read HF and the breaker banner.

**Scenario cheat-sheet (edit `demo-control.json`, the pusher picks it up on the next tick ~8s):**
| Scenario | Edit | Expected keeper line |
|---|---|---|
| **ATTACK** | `bMTB.priceB = 0.612` | `🛑 CIRCUIT BROKEN (manipulation rejected, last-good retained)` |
| **DECLINE** | `bMTB.priceA = 0.90` **and** `priceB = 0.90` | `OK` at `$0.90`, agent begins repaying |
| **STALE** | `bMTB.skipB = true` | `⚠ SINGLE-SOURCE (LTV capped to tier-3 floor)` |
| **RESET** | back to `1.02 / 1.02`, `skipB: false` | `OK` at `$1.02` |

---

## 0:00 – 0:30 — Hook

**Narrator:**
> "Tokenized T-bills are the fastest-growing collateral in DeFi. But every lending protocol liquidates on whatever price an oracle prints — so one manipulated feed can wrongly liquidate a healthy borrower. We built TerraVault so that can't happen. Here's a live position: 50,000 tokenized T-bills worth $51,000, borrowing 34,000 dollars, health factor **1.275** — comfortably safe."

**Driver:** On **T3**, show the dashboard — collateral $51,000, debt $34,000, **HF 1.275**, breaker status **green / armed**. Point at the two feeds both reading **$1.02**.

*(Leave the baseline running. Keeper T1 shows `OK $1.02`, agent T2 shows `✓ OK HF 1.275`.)*

---

## 0:30 – 1:30 — The manipulation attack that fails safe *(headline)*

**Narrator:**
> "Now an attacker manipulates one price feed — pushes tokenized T-bills down 40%, to 61 cents. On a normal protocol, this position is instantly underwater and gets liquidated on a fake price. Watch what ours does."

**Driver:** Edit **`scripts/keeper/demo-control.json`** → set `bMTB.priceB = 0.612`. Save. Wait one keeper tick (~8s).

**On screen (T1 keeper):**
```
bMTB  feeds A=$1.02 B=$0.612   agg (reverts — frozen)   🛑 CIRCUIT BROKEN (manipulation rejected, last-good retained)
```

**Narrator (while it trips):**
> "The two feeds now disagree by 40% — 4,000 basis points against a 500-point limit. The aggregator doesn't pick a winner and doesn't liquidate. It **trips the circuit breaker**, freezes the asset on its last honest price, and blocks both borrows and liquidations. Our user's health factor is untouched. The attack fails safe."

**Driver:** On **T3**, show:
- Breaker banner flips to **red / TRIPPED**.
- Try to trigger a liquidation on the demo user → it **reverts** with `cannot liquidate on frozen price`. Show the revert.
- HF display still reads **1.275** on last-good (or shows "price frozen").

**Narrator (button it):**
> "A naive oracle liquidates our user here. Ours protects them. That's the headline — and it's enforced in the contract, not a setting."

*(Optional, if you have 10s: Driver resets `demo-control.json` to `1.02/1.02` and shows the keeper clear back to `OK`, or notes the guardian would `clearBreaker` after review.)*

---

## 1:30 – 2:30 — The AI agent auto-deleverages on a REAL decline

**Narrator:**
> "But we don't freeze on legitimate moves. Now both feeds fall together to 90 cents — a real decline, no manipulation. The feeds *agree*, so the price is accepted, and the position genuinely deteriorates."

**Driver:** Edit `demo-control.json` → set **both** `bMTB.priceA = 0.90` **and** `bMTB.priceB = 0.90`. Save. Wait a tick.

**On screen (T1 keeper):** `bMTB feeds A=$0.90 B=$0.90  agg $0.90  OK` — price accepted, no breaker.

**On screen (T2 agent):** HF drops below the thresholds and the agent acts:
```
⚠ WARN  HF 1.125 below warn 1.200 — arming buffer, watching closely.
🚨 ACT  HF 1.080 below act 1.100 — intervening.
→ REPAY repaying 2000 mUSDC on behalf of user from buffer…
✓ REPAY tx 0x… | HF 1.080 → 1.146 | buffer used 2000/10000 mUSDC
```

**Narrator (while the agent repays):**
> "The AI Risk Monitor is watching health factor every few seconds. It crosses the warn line, then the act line at 1.10, and **autonomously repays from a capped buffer** — at most 2,000 dollars per action, and it can *only* repay, never touch principal or collateral. It deleverages the position back toward safety before it ever reaches liquidation. If the buffer ran out, it escalates and pauses new borrows."

**Driver:** On **T3**, show HF ticking back up as the repays land, debt decreasing, buffer counter climbing.

**Narrator (honesty beat — say this, it lands with judges):**
> "And to be straight: today that agent is deterministic policy, not a model — which is deliberate for something that touches funds. The safety property is that it's capped and repay-only, with a clean seam to add a model for anomaly detection later."

---

## 2:30 – 3:00 — Close

**Narrator:**
> "So: manipulation is rejected by the circuit breaker; legitimate declines flow through and get auto-deleveraged; and when the oracle degrades to a single feed, the protocol automatically caps leverage to a conservative floor. Every one of those is enforced in the contracts — reentrancy-guarded, prices only through the aggregator, no borrow or liquidation on a broken price. It's built for RWA settlement reality on HashKey, a compliance-first chain. We know exactly what's demo-scoped versus production-ready, and we're happy to walk the code. That's TerraVault."

**Driver (optional 5s flourish):** stage the **STALE** scenario — set `bMTB.skipB = true`, show `⚠ SINGLE-SOURCE (LTV capped to tier-3 floor)` on T1 — then reset. Only do this if the first two beats ran clean and you have time.

---

## Backup plan if live testnet is down

**If HashKey Testnet is unreachable or txs won't confirm, do not stall — switch to local.** Everything runs identically against a local Hardhat node with mocks; the numbers are the same.

- **One-command fallback:** in a spare terminal, `npx hardhat node` (chainId 31337), then `npm run deploy:local` and `npm run seed:local`. Point the keeper/agent at `deployments/latest.json` (they auto-fall-back to it) and re-run `npm run keeper` / `npm run agent`. The demo beats are identical.
- **If even that fails:** you have a pre-recorded screen capture of the three beats — play it and narrate live. Say plainly: *"Testnet's congested, so this is a capture from ten minutes ago — the code is the same and I'll walk any of it."* Do **not** pretend it's live.
- **Never** claim it's deployed to HashKey testnet if the deploy didn't land. If you have the tx hash, show it; if you don't, say it ran on a local fork. Honesty on this is free and a false claim is fatal.

---

## Who says what (2-person split)

| | **Narrator** (faces judges, tells the story) | **Driver** (owns the machine, never speaks unless handing off a number) |
|---|---|---|
| **Pre-flight** | Confirms the story arc, holds the deploy-tx-hash sticky note | Runs deploy + seed, opens 3 terminals, resets `demo-control.json` |
| **0:00–0:30 Hook** | Delivers the hook, points at HF 1.275 | Brings up the dashboard, points at both feeds $1.02 |
| **0:30–1:30 Attack** | Narrates the trip, buttons the headline | Edits `priceB = 0.612`, shows the `🛑` line, triggers the reverting liquidation on T3 |
| **1:30–2:30 Decline** | Narrates the agent, delivers the honesty beat | Sets both prices to `0.90`, points at the agent's `→ REPAY` lines and rising HF |
| **2:30–3:00 Close** | Delivers the close | Optional STALE flourish, then resets to baseline |
| **Q&A** | Leads answers; on landmine questions, concedes + names the fix (see `DEMO_BRIEF.md` §4) | Pulls up the exact contract line on screen if a judge wants to read code |

**Handoff cue:** Narrator says a scenario name ("Now an attacker…", "Now both feeds fall…") → Driver edits `demo-control.json` and waits for the keeper tick. Narrator paces to the tick; never talk over a pending transaction.

**Q&A discipline:** whoever knows the code answers. If it's a code-level landmine (breaker false-positive, single-source, one-key-two-feeds, `unhealthySince` bug, liquidation economics), **concede precisely and name the production fix** — that's the winning move, and all eight are pre-scripted in `DEMO_BRIEF.md` §4. Do not defend the demo wiring.
