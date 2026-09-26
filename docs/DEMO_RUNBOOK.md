# TerraVault — 3-Minute Demo Runbook

> Timed to the beat. Two presenters: **Driver** runs the machine, **Narrator** speaks. Every on-screen line below is real output captured from a full rehearsal on HashKey Testnet. Scenarios are staged by editing **`scripts/keeper/demo-control.json`**, which the keeper reloads every tick (~15s).

**Scene order matters: DECLINE first, ATTACK last.** The circuit breaker is manual by design. Once the attack trips it, it stays tripped until a guardian clears it, and while it's tripped the health factor is unreadable, so the agent stands down. Running the attack first would stall the decline scene. Ending on the attack is also the stronger finale, because both the oracle and the agent react to it.

---

## Pre-flight (before you're on stage)

- [ ] `npm run reset` → it must end with **`health factor : 1.275`**. Run it after every rehearsal.
- [ ] Only **one** keeper and **one** agent running (they share a key; duplicates collide).
- [ ] Terminals visible on screen, font size up:
  - **T1** `npm run keeper`: prints one status line per tick
  - **T2** `npm run agent`: the AI Risk Monitor, one line every ~5s
  - **T3** a spare terminal for `npm run try-liquidate`, plus a browser tab on the explorer: `https://hashkeychain-testnet-explorer.alt.technology`
- [ ] Start T1 and T2 **at least 30s before you begin**. T1 shows `agg $1.02  OK`; T2 shows `SETUP approval confirmed.` then `✓ OK HF 1.275 — healthy.`
- [ ] `demo-control.json` open in an editor, ready to edit. `npm run reset` already wrote the steady values.
- [ ] Optional visual: the Terravault Console artifact. It's a **UI simulation**, so if you show it, say so. The live proof is T1/T2/T3.

**Cheat sheet**

| Scene | Edit in `demo-control.json` | T1 keeper shows | T2 agent shows |
|---|---|---|---|
| Steady | `priceA 1.02, priceB 1.02` | `agg $1.02  OK` | `✓ OK HF 1.275` |
| **DECLINE** | `priceA 0.85` **and** `priceB 0.85` | `agg $0.85  OK` | `🚨 ACT` → `✓ REPAY … HF 1.063 → 1.129` |
| **ATTACK** | `priceB 0.51` (leave A at 0.85) | `🛑 CIRCUIT BROKEN` | `🛡 GUARD … standing down` |
| Reset | run `npm run reset`, then restart T2 | `agg $1.02  OK` | `✓ OK HF 1.275` |

Timing: a saved edit reaches the chain within one keeper tick (**≤ ~15s**). The agent reacts within ~5s after that.

---

## 0:00 – 0:30 — Hook

**Narrator:**
> "Tokenized T-bills are the fastest-growing collateral in DeFi. But lending protocols liquidate on whatever price an oracle prints, so one manipulated feed can wrongly liquidate a healthy borrower. We built TerraVault so that can't happen. This is live on HashKey testnet: 50,000 tokenized T-bills worth $51,000, borrowing $34,000, health factor 1.275."

**Driver:** Point at T1 (`feeds A=$1.02 B=$1.02  agg $1.02  OK`) and T2 (`✓ OK HF 1.275 — healthy.`).

---

## 0:30 – 1:30 — A real decline, and the AI agent heals it

**Narrator:**
> "First, a legitimate move. Both price feeds fall together to 85 cents, a real 17% drop. The feeds agree, so the protocol accepts it, and the position genuinely deteriorates."

**Driver:** In `demo-control.json` set **both** `bMTB.priceA = 0.85` **and** `bMTB.priceB = 0.85`. Save.

**On screen, T1 (next tick):**
```
#4 bMTB  feeds A=$0.85 B=$0.85   agg $0.85   OK
```

**On screen, T2 (seconds later):**
```
🚨 ACT  HF 1.063 below act 1.100 — intervening.
→ REPAY repaying 2000.0 mUSDC on behalf of user from buffer…
✓ REPAY tx 0x5908…efe5 | HF 1.063 → 1.129 | buffer used 2000.0/10000.0 mUSDC
⚠ WARN HF 1.129 below warn 1.200 — arming buffer, watching closely.
```

**Narrator (while it repays):**
> "The AI Risk Monitor checks health factor every few seconds. It crossed the 1.10 action line, so it autonomously repaid from a capped buffer: at most $2,000 per action, and it can only repay. It can never withdraw principal or touch collateral. Health factor went from 1.06 back to 1.13, before liquidation was ever on the table."

**Driver (the "it's real" beat):** Copy the `REPAY tx` hash from T2 and open it on the explorer (`…/tx/<hash>`) in T3's browser tab.

**Narrator (honesty beat, it lands with judges):**
> "To be straight: today that agent is deterministic policy, not a model, which is deliberate for something that touches funds. The safety property is that it's capped and repay-only, with a seam to add a model for anomaly detection."

---

## 1:30 – 2:30 — The manipulation attack that fails safe *(finale)*

**Narrator:**
> "Now an attacker compromises one price feed and pushes it to 51 cents, 40% below the honest feed at 85. On a normal protocol, that fake price liquidates this user instantly. Watch."

**Driver:** In `demo-control.json` set `bMTB.priceB = 0.51`. Leave `priceA` at 0.85. Save.

**On screen, T1 (next tick):**
```
bMTB  feeds A=$0.85 B=$0.51   agg (reverts — frozen)   🛑 CIRCUIT BROKEN (manipulation rejected, last-good retained)
```

**On screen, T2:**
```
🛡 GUARD bMTB circuit breaker TRIPPED — manipulated feed rejected on-chain. User protected by the breaker; agent standing down (no repay on a frozen price).
```

**Narrator (while it trips):**
> "The two feeds disagree by 40%, that's 4,000 basis points against a 500 limit. The aggregator doesn't pick a winner. It trips the circuit breaker, freezes the asset on its last honest price, and blocks borrows and liquidations. Even our own agent stands down, because it won't act on a frozen price."

**Driver:** In T3 run `npm run try-liquidate`:
```
  circuit breaker : 🛑 TRIPPED
  result          : ❌ REVERTED — execution reverted: cannot liquidate on frozen price
```

**Narrator (button it):**
> "That's a live liquidation attempt, and the contract refuses it. A naive oracle liquidates our user here. Ours protects them, and it's enforced in the contract, not a setting."

---

## 2:30 – 3:00 — Close

**Narrator:**
> "So: legitimate declines flow through and get auto-deleveraged by a capped agent; manipulation is rejected by the circuit breaker; and if a feed goes quiet, the protocol drops to single-source and caps leverage to 45%, which is covered in our test suite. Prices only move through the aggregator, fund flows are reentrancy-guarded, and there's no borrow or liquidation on a broken price. It's built for RWA settlement reality on HashKey. We know exactly what's demo-scoped versus production-ready, and we're happy to walk the code. That's TerraVault."

*(Leave the breaker tripped. It's the resting state until a guardian reviews it, which is the point.)*

---

## After every run (and before you go on stage)

`Ctrl+C` the agent → `npm run reset` (about a minute on testnet; clears the breaker, restores debt to 34,000, refills the buffer) → restart `npm run agent`. The keeper can stay running.

---

## Backup plan

- **Testnet slow:** keep talking. Ticks are ~15s; never narrate over a pending transaction.
- **Testnet down:** run `npx hardhat test test/e2e-demo-flow.test.ts`. It executes the same contracts through every beat (onboard → borrow at HF 1.275 → manipulation blocked → decline healed by the agent → stale feed caps LTV) on an in-process chain in about a second, and the test names narrate each step. Say plainly that it's a local chain. The Terravault Console simulation covers the visuals.
- **Never** claim it's live on testnet if it isn't. The contract addresses in the README link to the explorer if anyone asks.

---

## Who says what

| | **Narrator** (faces judges) | **Driver** (owns the machine) |
|---|---|---|
| Pre-flight | Confirms the arc | `npm run reset`, starts T1 and T2, opens the explorer tab |
| 0:00–0:30 Hook | Delivers the hook, HF 1.275 | Points at T1 `OK $1.02` and T2 `HF 1.275` |
| 0:30–1:30 Decline | Narrates the agent, delivers the honesty beat | Sets both prices to `0.85`, opens the repay tx on the explorer |
| 1:30–2:30 Attack | Narrates the trip, buttons the headline | Sets `priceB = 0.51`, runs `npm run try-liquidate` |
| 2:30–3:00 Close | Delivers the close | Leaves the breaker tripped; resets after you leave the stage |
| Q&A | Leads answers; on landmine questions, concedes and names the fix (`DEMO_BRIEF.md` §4) | Pulls up the exact contract line if a judge wants code |

**Handoff cue:** Narrator names the scene ("First, a legitimate move…", "Now an attacker…") → Driver edits and saves → Narrator paces to the tick.

**Q&A discipline:** whoever knows the code answers. On a code-level landmine (breaker false-positive, single-source, one key behind both feeds, `unhealthySince`, liquidation economics), **concede precisely and name the production fix.** All of them are pre-scripted in `DEMO_BRIEF.md` §4. Do not defend the demo wiring.
