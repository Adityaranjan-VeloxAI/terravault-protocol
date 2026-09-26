# TerraVault — 3-Minute Demo Runbook

> Two presenters: the **Driver** runs the laptop, the **Narrator** faces the room. The demo is the Terravault web app, served locally by `npm run app` at `http://localhost:3000`. Everything on screen reads HashKey Testnet (chainId 133) directly; the only simulated part is the market itself (the price moves are staged by the presenter bar, see "What is staged" below).

---

## What is running

`npm run app` (`app/server.js`) serves the page and starts three child processes:

| Process | Script | What it does |
|---|---|---|
| Price keeper | `scripts/keeper/guardian-price-pusher.ts` | Every ~8s pushes both bMTB feeds from `scripts/keeper/demo-control.json`, then pokes the aggregator. |
| AI risk monitor | `agents/risk-monitor.ts` | Starts ~15s after the keeper. Every ~5s reads the demo user's health factor and repays from its capped buffer when 1.0 ≤ HF < 1.10. |
| Liquidator agent | `agents/liquidator.ts` | Starts ~17s after the keeper. An outside bot with its own wallet and no protocol role. Quotes the position, flags it below HF 1.0, waits the 300s grace period, seizes only if profitable, verifies on-chain. |

Their logs print in the `npm run app` terminal prefixed `[keeper]`, `[agent]`, `[liquidator]`, `[reset]`. The page shows the last few agent and liquidator lines in the AI guardian card.

**What is staged:** the presenter bar buttons rewrite the bMTB prices in `demo-control.json`; the keeper pushes them on its next tick. So "market decline", "oracle attack" and "crash" are prices we choose, pushed by one keeper key into both feeds. Everything after that (the aggregator check, the breaker, health factor, the agent's repays, the liquidator's quote and flag, the reverts) is real contract behaviour on testnet.

### The page

| Card | Shows |
|---|---|
| **Position** | Health factor gauge, collateral (bMTB and its value), borrowed mUSDC, liquidation price, borrow limit used. Status pill: Healthy / Watch / At risk / Liquidatable / Protected · frozen. |
| **Manage** | Deposit / Borrow / Repay / Withdraw through MetaMask. Switches (or adds) HashKey Testnet chainId 133 automatically. "Get 10,000 test bMTB" mints test collateral. |
| **Oracle shield** | Feed A and feed B prices and age, how far apart they are against the 5% limit, the price the loan uses, and a red "Frozen: price attack blocked" banner when the breaker is tripped. |
| **AI guardian** | Risk monitor live reasoning, liquidator agent live reasoning, and an on-chain activity feed (latest 6 events, each with an explorer link). |
| **Presenter bar** (bottom, only when served by `npm run app`) | Market decline · Oracle attack · Try liquidation · Crash · Reset demo, plus green dots for the keeper and agent. |

| Button | Effect |
|---|---|
| 📉 Market decline | Both feeds to $0.85. Feeds agree, price accepted. |
| ⚡ Oracle attack | Feed B to $0.51, 40% below the honest $0.85 on feed A. Breaker trips. Use after Market decline. |
| 🧪 Try liquidation | Runs `scripts/try-liquidate.ts`: a static call to `liquidate(demoUser)`, no gas. Shows the contract's answer in a toast. |
| 💥 Crash | Both feeds to $0.70. HF drops below 1.0; the liquidator takes over. Only from a fresh Reset. |
| ↺ Reset demo | Runs `scripts/reset-demo.ts` (~20–60s) and restarts the risk monitor. |

A staged price lands on the next keeper tick: allow up to ~15s. The toast says so.

---

## Pre-flight (15 minutes before)

- [ ] `.env` has `DEPLOYER_PRIVATE_KEY` and `KEEPER_PRIVATE_KEY`. The deployer tops up the liquidator's gas.
- [ ] Nothing else is running `npm run keeper`, `agent` or `liquidator`. The keeper and agent share one key; duplicates collide on nonces.
- [ ] `npm run app`. The browser opens `http://localhost:3000`. Wait ~20s for both presenter-bar dots to go green and the risk monitor and liquidator lines to appear.
- [ ] MetaMask: import the **deployer key** (it is the demo user, `0x856d…E2FB`). Connect. The app switches to HashKey Testnet. The Position card title should read "Your position · 0x856d…E2FB" and the Manage card should show the Deposit form. The wallet needs a little HSK for gas (faucet: `https://hskchain.net/faucet`).
- [ ] If you want to show a real seize, do the **liquidation run** below now; it needs over five minutes.
- [ ] Press **↺ Reset demo**. The button reads "Resetting… (~1 min)" and returns when done. In the terminal the reset ends with `health factor : 1.275`. If it prints `keeper gas is low`, top up the keeper at the faucet.
- [ ] Check the opening state: HF **1.275**, 50,000 bMTB, 34,000 mUSDC, shield banner "Protection armed", feeds A and B both $1.02, risk monitor line `✓ OK HF 1.275 — healthy.`, liquidator line `· WATCH HF 1.275: healthy, nothing to liquidate.`
- [ ] Manage card on **Deposit**: wallet shows at least 1,000 bMTB (reset staged it and pre-approved the vault).
- [ ] Zoom the browser so the Position card and the AI guardian card are both readable from the back.

**What reset does:** writes steady prices (1.02 / 1.02) to the control file; pushes agreeing prices, clears the breaker and pokes (retries if a keeper tick re-trips it); unpauses the vault if paused; revokes `PAUSER_ROLE` from the agent key if present; restores collateral to 50,000 bMTB, then debt to 34,000 mUSDC; stages 1,000 bMTB in the deployer wallet with a standing vault approval; clears the agent's facility ledger (`deployments/agent-state.json`) and refills its buffer to 10,000 mUSDC; the server then restarts the risk monitor.

---

## The 3-minute run

Start from a fresh Reset. Numbers below assume the live 1,000 deposit and 1,000 borrow, so they differ slightly from the rehearsal log without them (noted where relevant).

### 0:00 – 0:25 — Hook

**Screen:** Position card at HF 1.275. Shield: "Protection armed", both feeds $1.02.

**Narrator:**
> "Tokenized T-bills are becoming serious DeFi collateral, but lending protocols liquidate on whatever an oracle prints. One bad feed can liquidate a healthy borrower. TerraVault is built so that can't happen. This is live on HashKey testnet: 50,000 tokenized T-bills, $51,000 of collateral, $34,000 borrowed, health factor 1.275."

### 0:25 – 0:55 — A user deposits and borrows

**Driver:** Manage card, **Deposit** tab, type `1000`, click **Deposit collateral**. One MetaMask confirmation (no approve step; reset pre-approved it). Then **Borrow** tab, type `1000` (not Max), click **Borrow**, confirm.

**Screen:** toasts "Deposit: confirmed ✓" and "Borrow: confirmed ✓" with explorer links. HF goes 1.275 → ~1.300 → ~1.263. Activity feed: "Deposited 1,000 bMTB", "Borrowed 1,000 mUSDC".

**Narrator:**
> "This is the normal user flow, signed in MetaMask on HashKey. Add collateral, borrow a stablecoin against it."

Why not Max: Max borrows to the 80% LTV limit, which puts HF near 1.06 at today's price, and the agent would step in before the decline.

### 0:55 – 1:45 — A real decline, and the AI agent repays

**Driver:** Presenter bar, **📉 Market decline**.

**Narrator (while it lands, up to ~15s):**
> "First, a legitimate move. Both price feeds fall to 85 cents together. They agree, so the protocol accepts it and the position really does get worse."

**Screen:** both feeds $0.85, 0.0% apart. HF drops to **~1.053**, pill "At risk". Risk monitor reasoning, roughly:
```
🚨 ACT  HF 1.053 below act 1.100 — ≈6655.77 mUSDC restores 1.300.
✓ REPAY tx 0x…| 2000.0 mUSDC | HF 1.053 → 1.117 | facility 2000.0/10000.0, user owes 2020.0 incl. 1% premium
✓ REPAY … HF 1.117 → 1.189 …
✓ REPAY … HF 1.189 → 1.271 …
✓ REPAY … ≈655.77 mUSDC | HF 1.271 → 1.300 …
✓ DONE  HF 1.300 is at or above target 1.300. Standing down.
```
Activity feed: four "AI guardian repaid … mUSDC for you" cards. Allow 30–60s for the four repays.

(Rehearsal without the live deposit/borrow: HF 1.063, 6,211.54 mUSDC in four repays, HF 1.063 → 1.300.)

**Narrator (while it repays):**
> "The risk monitor checks health every five seconds. Below 1.10 it computes exactly how much debt to repay to get back to 1.30 and repays it from its own buffer, at most 2,000 per step. It can only repay; it can't touch collateral or pause the vault. The user owes the facility what it spent plus a 1% premium. And if health were already below 1.0, it would stand down and leave the loan to liquidators rather than subsidise an insolvent position."

**Driver:** click "view on explorer ↗" on one repay card.

**Narrator (honesty beat):**
> "To be straight: the agent is deterministic policy, not a model. That's deliberate for something that moves money. The point is that it's capped and repay-only."

### 1:45 – 2:35 — The oracle attack that fails safe

**Driver:** Presenter bar, **⚡ Oracle attack**.

**Narrator:**
> "Now an attacker controls one feed and pushes it to 51 cents, 40% below the honest 85. A naive protocol liquidates this user on that print."

**Screen (next tick):** Feed B $0.51 in red; "40.0% apart · limit 5%"; red banner "Frozen: price attack blocked". Position pill "Protected · frozen" with the note "You're protected… held at the last honest price ($0.8500)". AI guardian pill "Standing down"; risk monitor line `🛡 GUARD bMTB circuit breaker TRIPPED — … agent standing down`; liquidator line `🛑 BLOCK price frozen by the circuit breaker: liquidation not allowed.` Activity feed: "Price attack blocked".

**Driver:** Presenter bar, **🧪 Try liquidation**. Toast after a few seconds:
```
Liquidation attempt: ❌ REVERTED — execution reverted: cannot liquidate on frozen price
```

**Narrator:**
> "The feeds disagree by 4,000 basis points against a 500 limit. The aggregator doesn't pick a winner: it freezes on the last honest price and blocks borrows and liquidations. That was a real liquidation call against the contract, and it refused. Both agents stand down too."

### 2:35 – 3:00 — Close

**Narrator:**
> "Legitimate declines flow through and a capped agent repays before liquidation. A manipulated feed trips the breaker and nobody can be liquidated on it. When a loan really is insolvent, an outside liquidator with no special role can take it, after a five-minute grace period and only if it pays."

If the liquidation run was done before going on stage, **Driver** switches to the explorer tab with the seize transaction (see below) while the Narrator says:
> "Here's that happening on testnet earlier: price to 70 cents, health 0.875, the liquidator flagged it, waited five minutes, repaid 34,000 and took the 50,000 T-bills."

> "We know what's demo-scoped and what isn't, and we're happy to walk the code. That's TerraVault."

Leave the breaker tripped. Reset after you leave the stage.

---

## The liquidation run (separate from the 3-minute run)

The crash can't follow the attack in the same run: the breaker stays tripped until Reset clears it, and the grace period is 5 minutes. Run it on its own, from a fresh Reset:

1. **↺ Reset demo**, wait for it to finish (HF 1.275).
2. **💥 Crash** (both feeds $0.70). HF = 50,000 × 0.70 × 0.85 / 34,000 = **0.875**. Risk monitor: `⛔ HOLD HF 0.875 is below 1.0 — not subsidizing an insolvent position. Left to liquidators.`
3. Liquidator, within a tick:
   ```
   📋 QUOTE HF 0.875 at $0.7000 · repay 34,000 mUSDC · receive 50,000 bMTB · profit +$1000.00 (2.9% effective; 5% bonus, capped by the borrower's collateral)
   ⏳ FLAG  liquidatable, grace period started (300s). Borrower can still cure.
   ```
   Activity feed: "Liquidation grace period started".
4. For the next 300s: `⏳ WAIT grace period, Ns left · …`.
5. After the grace period: `🔨 SEIZE tx … | repaid 34,000 mUSDC, received 50,000 bMTB (5% bonus) | borrower debt 34,000 → 0 ✓ verified`. Activity feed: "Liquidated by an outside agent" with an explorer link.

Verified on testnet through step 3 (quote and flag). Watch the seize land once in rehearsal before you rely on it on stage.

Timing options:
- **Before going on stage:** start it at least 6 minutes before you need it. When the "Liquidated by an outside agent" card appears, open its explorer link in a separate tab and keep that tab. Then Reset for the main run. The activity feed only shows the latest 6 events, so the card scrolls away during the main run; the explorer tab is what you show at the close.
- **In Q&A:** after the main run, Reset, then Crash, and come back to it five minutes later.

Notes:
- The bonus is 5%, but it's capped by the borrower's collateral: 34,000 × 1.05 / 0.70 = 51,000 bMTB wanted, 50,000 available, so the effective bonus is ~2.9% (+$1,000).
- Don't press Crash after the attack in the same run: the breaker is still tripped and nothing happens.
- If you Reset after the flag but before the seize, the flag survives (known limitation, `unhealthySince` isn't cleared on recovery). The next Crash then seizes on the first tick with no grace wait.

---

## Backup plan

- **Testnet slow:** keep talking; ticks are ~8–15s and each repay waits for its receipt. Don't narrate a result before it shows.
- **A MetaMask transaction fails or hangs:** skip the deposit/borrow beat and go straight to Market decline. The seeded position (HF 1.275) still triggers the agent (HF 1.063 → 1.300).
- **Presenter bar missing:** you opened the static copy or the server died. Use `http://localhost:3000` and restart `npm run app`.
- **Reset fails** (`breaker re-tripped 3 times`): stop `npm run app` (Ctrl+C), run `npm run reset`, start `npm run app` again.
- **Testnet down:** run `npx hardhat test test/e2e-demo-flow.test.ts`. It runs the same contracts on an in-process chain in about a second, and the test names narrate the beats: onboard bMTB → borrow at HF 1.275 → one feed pushed 40% down, breaker trips, borrow and liquidate revert, position intact → breaker cleared → both feeds to $0.85, HF below 1.10 but solvent → a 2,000 mUSDC buffer repay → one feed goes stale, LTV capped to 45%. Say plainly that it's a local chain, and that the test models one buffer repay rather than the agent process.
- Never claim it's live on testnet if it isn't. The README's contract addresses link to the explorer.

Public static copy of the app (no presenter bar, no agents' reasoning; reads the chain and lets anyone connect a wallet): `https://terravault-adityaranjan-veloxais-projects.vercel.app`. It is only reachable once Vercel Authentication is turned off in the project settings.

---

## Who does what

| | **Narrator** (faces the room) | **Driver** (owns the laptop) |
|---|---|---|
| Pre-flight | Agrees the arc and the close | `npm run app`, MetaMask on the deployer key, optional liquidation run, Reset, checks HF 1.275 |
| 0:00–0:25 Hook | Hook, the 1.275 number | Points at the Position card |
| 0:25–0:55 Deposit/borrow | One line on the user flow | Deposit 1000, Borrow 1000 in MetaMask |
| 0:55–1:45 Decline | Narrates the repays, honesty beat | Market decline, opens one repay on the explorer |
| 1:45–2:35 Attack | Narrates the freeze, lands the headline | Oracle attack, then Try liquidation |
| 2:35–3:00 Close | Close; liquidation line if prepared | Switches to the seize explorer tab if prepared |
| Q&A | Leads; on hard questions, concedes and names the fix (`DEMO_BRIEF.md` §4) | Pulls up contract code; can start Reset → Crash for a live liquidation |

**Handoff cue:** the Narrator names the scene ("First, a legitimate move…", "Now an attacker…"), then the Driver clicks.

**Q&A discipline:** on a code-level weakness (one key behind both feeds, breaker vs a real crash, single-source, `unhealthySince`, full-debt liquidation, no bad-debt reserve), concede it precisely and name the fix. They're scripted in `DEMO_BRIEF.md` §4. A `liquidation-v2` branch addressing the liquidation issues is in progress and not on main.
