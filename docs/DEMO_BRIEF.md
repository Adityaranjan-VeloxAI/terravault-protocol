# TerraVault — Demo & Q&A Brief

> Master reference for the 3-minute demo + 2-minute Q&A. Everything here is grounded in the **shipped, compiled code** in this repo (9 Solidity contracts under `contracts/`, `agents/risk-monitor.ts`, `scripts/keeper/guardian-price-pusher.ts`, tests under `test/`). Do not improvise numbers — the ones below reproduce the front-end demo exactly.

**Golden rule for the room:** when a judge finds a real limitation, *concede it precisely and name the production fix.* We win on honesty and knowing our own code, not on defending demo wiring. Several judges have read the Solidity — assume they have too.

**Do NOT say the repo is empty scaffolding.** The contracts are built and compiled. Claiming it's unbuilt is a self-inflicted wound.

---

## 1. 30-second elevator pitch

> **One-liner:** *TerraVault is an RWA lending protocol whose oracle refuses to be manipulated — it survived a live −40% price attack without liquidating anyone.*

**The pitch:**
"Tokenized T-bills are the fastest-growing collateral in DeFi, but every money market liquidates on whatever price an oracle prints — so a single manipulated feed can wrongly liquidate a healthy borrower. TerraVault puts a manipulation-resistant oracle at the center: two independent feeds cross-check each other, and if they disagree by more than 5% the circuit breaker trips, freezes the asset on its last honest price, and blocks both borrows and liquidations. Legitimate declines still flow through, and an autonomous risk agent auto-deleverages positions before they ever hit liquidation. It's built for RWA settlement reality — grace-period liquidation, oracle-health-driven dynamic LTV — on HashKey, a compliance-first chain. In our demo an attacker pushes a fake −40% print; a naive protocol liquidates our user; ours doesn't even flinch."

---

## 2. If you only get three sentences

1. **"We built a lending protocol against tokenized T-bills where the headline feature is an oracle that can't be manipulated into a bad liquidation — we demo a live −40% price attack that a normal protocol would act on, and ours trips a circuit breaker and protects the user."**
2. **"When prices legitimately fall, the position isn't frozen — it flows through, and an autonomous on-chain risk agent auto-repays from a capped, repay-only buffer to deleverage before liquidation."**
3. **"Every safety property lives in the contracts — reentrancy guards, prices only through the aggregator, no borrow or liquidation on a broken price, dynamic LTV when the oracle degrades — so it's not marketing, it's enforced in code, and we're upfront about exactly what's demo-scoped versus production."**

---

## 3. Q&A bank (by category)

### Oracle security

**Q: Isn't your circuit breaker itself a single point of failure? If it trips, everything freezes.**
The breaker never decides a price — it only refuses one that disagrees with its peer by more than 5%. Its failure mode is fail-safe: it freezes on the last good price and blocks borrows *and* liquidations for that asset rather than acting on suspect data. A naive oracle would have liquidated our user on the fake −40% print; ours didn't. Freezing is the conservative direction against manipulation, and the guardian clears it after review. Where it's *not* the safe direction — a genuine crash — is a real limitation, and I'll own that if you want to go there.

**Q: A frozen price is also dangerous — you could be under-collateralized on stale data. Why is that acceptable?**
When we freeze we simultaneously block new borrows and liquidations on that asset, so no one can extract value against the frozen price in either direction. It's only triggered by a detected disagreement over 5% — legit moves where both feeds fall together pass straight through and we de-risk normally. The honest caveat: freezing is safe against *manipulation* but dangerous against a *real* crash, because a wide feed spread looks the same either way. The production fix is a sustained-deviation gate plus allowing liquidations on the more-conservative feed rather than a hard freeze.

**Q: Your breaker can't tell a real crash from an attack. During a genuine fast selloff your two feeds update at different latencies — the transient >5% skew trips the breaker and freezes the asset exactly when you need liquidations most. How is that not catastrophic?** *(landmine)*
Fair — and this is the sharpest critique of the whole design. A single-block spread check false-positives on latency skew, and freezing a genuinely-crashing asset is the dangerous direction for a lender. Two fixes we'd ship: require the deviation to persist across N consecutive pokes before tripping, and keep serving last-good while still allowing liquidations against the *more conservative* feed rather than freezing outright. Today's single-block trip is demo-simple; production needs a sustained-deviation gate. Freeze-on-real-crash is the failure we most have to engineer around, and we know it.

**Q: What if the guardian key is malicious?**
The guardian is a scoped `AccessControl` role, not owner god-mode — it can clear a breaker, but it can't move funds, change risk parameters, or bypass the aggregator's deviation check in two-source mode. In two-source mode a bad push just trips the breaker against itself. But I won't give you the clean "never theft" line, because it's not true in single-source mode — see the next question. In production the guardian becomes a multisig, and the price-author key is separated from the breaker-clear key.

**Q: The keeper key controls both feeds AND holds `clearBreaker` AND `pause`. It waits for the second feed to lag, becomes the sole source, prints a low price with no deviation check, clears any breaker, waits out the grace period, and liquidates. That's theft from one key. Where's the wall?** *(landmine)*
You're right, and the "never theft" line is too strong. Single-source is the hole: if one key can become the lone feed and also clear breakers, that's a theft vector, not just griefing. Two concrete fixes: separate the price-author key from the breaker-clear key, and suspend liquidation entirely whenever the oracle is single-source so a lone feed can never drive a seizure. Under those changes the worst case really is a griefing freeze. As wired today, you've named a real path, and I'm not going to defend the demo wiring.

**Q: I read your deploy script — one keeper key is granted `GUARDIAN_ROLE` on adapterA, adapterB AND the aggregator. There's no source independence. What is the breaker actually protecting against?** *(landmine)*
Caught us — in the demo one keeper key backs both adapters, so the breaker only proves that key is internally consistent, not honest. That's demo wiring, not the design. The breaker is only meaningful with genuinely independent providers signing each feed separately — production is distinct issuer NAV oracles plus Chainlink, ideally behind a multisig. As deployed today, deviation detection buys nothing against that single key, and we shouldn't claim otherwise. What the demo *does* prove is the mechanism: a >5% disagreement trips before any liquidation fires.

**Q: Median of two isn't a median — it's just the average, and if one source lies you have no majority to vote it out.**
Correct, and we don't overclaim. Two sources buy you deviation detection, not Byzantine fault tolerance — we can see they disagree and refuse, we can't pick the honest one. That's exactly why a disagreement trips the breaker instead of choosing a winner. The demo runs two feeds for legibility; drop to one valid source and we auto-cap LTV to the 45% floor.

**Q: You claim it "generalizes to N sources where a median means something," but your deviation is `(max − min) / max` across all live feeds. Add a third source and any single outlier trips the breaker — more feeds makes you MORE fragile. Did you think that through?** *(landmine)*
Honest correction: our trip condition is a full-range spread, so with N feeds one outlier freezes everything — that's fragility, not BFT, and I shouldn't imply it scales gracefully as-is. The median in our code is only used for the *accepted price*, not the safety gate. Real N-source robustness needs a different rule — drop outliers by median-absolute-deviation and trip only if the surviving cluster still disagrees. Fixing the gate to be outlier-tolerant is the actual work to earn the "N sources" claim; today it's two-source deviation detection, full stop.

**Q: What stops an attacker who feeds two colluding sources that agree on a wrong price?**
Nothing at the deviation layer — if all sources agree, we accept it; that's the legit-decline path by design. The defense there is source independence and diversity (different providers on different infrastructure), the staleness check, and the AI monitor watching health factor for anomalies. Deviation detection catches disagreement, not consensus manipulation — those are two different threat models and we're upfront about it. And as we admitted, in the demo both feeds share one key, so this isn't hypothetical for us today; it's the first thing production has to fix.

**Q: There's no absolute price floor — only relative deviation. If a shared upstream returns zero or garbage to both adapters, they "agree," the breaker never trips, and liquidations fire on a fake $0. What stops that?** *(landmine)*
Nothing in the current code — that's a real hole. Relative deviation can't catch a shared-mode failure where both feeds return the same garbage. The fix is cheap and belongs in before mainnet: per-asset absolute sanity bounds that reject any price outside a hard floor/ceiling band, plus an explicit non-zero check, evaluated *before* deviation. That converts a shared-zero from "accepted consensus" into a revert. Good catch.

**Q: `poke()` is permissionless. A borrower about to be liquidated just keeps the breaker tripped — pokes a divergent feed every block — and since you block liquidation on a broken price, they can never be liquidated. Doesn't your safety property invert into a liquidation shield?** *(landmine)*
That's the sharpest version of our DoS surface, and yes — a freeze blocks legitimate liquidations too, and a permissionless poke lets an interested party sustain it. The fix isn't to liquidate on a suspect price; it's to *bound* the freeze: after a short guardian-review window the asset must resolve to a defensible price and liquidations resume, and clearing shouldn't be indefinitely re-trippable by a permissionless poke from a party with a position at stake. An attacker-sustained freeze that shields insolvency is a constraint we have to time-box, not wave away.

**Q: What is "single-source mode" and why cap LTV to 45%?**
If one adapter stops updating past the staleness window, the aggregator falls back to the one remaining feed. With no second source we've lost our manipulation cross-check, so `AssetQualityRegistry.effectiveMaxLtv` automatically caps effective LTV to the tier-3 floor of 45%, regardless of the asset's configured LTV. Less oracle assurance means less leverage, enforced in code. The honest caveat: that floor only gates *new* borrows — existing positions still run on the lone feed, and production should also tighten the liquidation threshold or suspend seizure in single-source mode.

**Q: If I make your honest feed go stale — DoS your off-chain pusher — the aggregator falls to one feed with zero deviation check, and existing 80%-LTV positions get liquidated on a completely unchecked price. Isn't single-source your actual kill switch?** *(landmine)*
You're right that the LTV floor only protects new borrows, not open positions — that's a real gap. Single-source should suspend liquidations too, not just cap borrowing, because with one feed we've lost the manipulation check entirely. Today we lean on feed redundancy and staleness windows to avoid ever sitting single-source, but you've named the correct attack: force us to one feed and it's unchecked. Suspending seizure in single-source mode is the fix, and it's not in the code yet.

### RWA

**Q: A T-bill can't be liquidated instantly — real settlement is T+1 or T+2. What happens when you need to sell?**
That's exactly why we don't do instant seizure. We use soft, grace-period liquidation — 300 seconds in the demo, hours or days in production — plus conservative 80% LTV versus ~90% for stablecoins, and a penalty buffer. On-chain we seize the tokenized claim immediately; the real redemption settles through the custodian on the bond's actual calendar. The protocol holds the tokenized claim as collateral, not the raw bond.

**Q: When a liquidator seizes the tokenized T-bill, can they actually redeem it? Issuers like Ondo only redeem for whitelisted KYC'd holders. Your liquidator may hold a token they can't cash out.** *(landmine)*
Correct, and this is the hard part of RWA lending — it breaks at the legal layer, not the code layer. Seizure only works if liquidators are themselves KYC'd and on the issuer's redemption whitelist, so in production the liquidator set is permissioned, gated by the same `ComplianceGate`, ideally with the issuer or a market maker as a backstop bidder. On a permissioned chain like HashKey that's tractable, but you've named the real dependency: our collateral is only as liquid as the eligible-buyer set, and that's a legal onboarding problem, not a contract we can write.

**Q: Who legally holds the underlying T-bill? What's the custody story?**
In the demo it's a `MockRWAToken`. In production this is a tokenized T-bill from a licensed issuer — the Ondo / Backed / Superstate model — where a regulated custodian holds the underlying and the token is a legal claim on it. We add a `ComplianceGate` allowlist (a proof-of-concept toward ERC-3643) so only KYC'd addresses can hold or transfer. We're a lending protocol *on top of* compliant RWA tokens; we are not the issuer or custodian.

**Q: What happens on a real depeg — bMTB trading below NAV?**
Two cases. A genuine depeg where both feeds agree is the decline path: accepted, health factor falls, we liquidate and de-risk normally — we *want* legit drops to flow through. A manipulation-only spike where feeds disagree over 5% trips the breaker instead. Structurally, the conservative 80% LTV and 85% liquidation threshold leave headroom for NAV drift before any bad debt forms.

**Q: What if the token issuer defaults or freezes the token itself?**
That's the residual RWA risk we can't fully kill on-chain, and we say so. Mitigations: asset-quality tiers give weaker assets lower LTV, isolation mode, and debt ceilings; plus the single-source floor and compliance transfer hooks. A frozen token can't be seized, so we'd pause that asset and absorb via a reserve. Issuer credit risk is fundamentally an off-chain legal problem — no protocol eliminates it.

**Q: A T-bill yields 4–5%. If your borrow rate is higher, the user pays to unlock capital they earn less on. Why does anyone do this trade?** *(landmine)*
The trade only works when the borrower's use of funds beats the borrow rate — levered basis trades, meeting a short-term obligation without selling yield-bearing paper, or looping. It's not free money and it's not for a passive holder; that narrows our real market to active desks, not "all treasuries." If our borrow rate can't clear below their next-best return, we have no product — so pricing and lender supply *are* the business, not the contracts. I won't pretend the carry works for everyone.

### AI agent

**Q: Is this actually AI, or just a keeper on a cron job?** *(landmine)*
Straight answer: today it's a policy-driven autonomous monitor — it polls health factor every 5 seconds, uses tiered thresholds at 1.20 and 1.10, acts within a capped budget, and escalates. Calling it "AI" is generous, and I won't dress it up. The determinism is deliberate for a fund-touching actor. Where a model genuinely earns its place is anomaly detection across feeds and dynamic parameter suggestions — judgment a threshold can't encode — and that's the seam we built for, not something we've shipped. The defensible claim isn't "we have AI," it's "we have a capped, repay-only agent that structurally can't steal, with a clean seam to add a model."

**Q: What stops the AI agent from draining funds?**
It structurally can't. It operates from a capped keeper buffer — at most 2,000 mUSDC per action, 10,000 total — and it can only *repay* debt, which improves user positions; it can never withdraw principal or touch collateral. It holds scoped roles, not admin. The honest caveat is that the same keeper key also holds `PAUSER_ROLE`, so a compromised key can freeze the vault — that's a DoS lever, not theft, and in production pause belongs with a separate guardian, not the automated agent.

**Q: The agent holds `PAUSER_ROLE`, and its buffer is 2,000 per action against a 34,000 debt. A compromised key can pause the whole vault, and the buffer can't move a 34k position's health factor. So what does it actually defend?** *(landmine)*
Two fair hits. One: the keeper holding `PAUSER` means a compromised key can freeze the vault, so the blast radius is DoS, not just benign over-repay — pause should sit with a separate guardian. Two: a 2k/action, 10k buffer can't rescue a 34k position in a fast crash, and I won't imply it can. The agent's honest job is smoothing small, slow deteriorations and raising alerts before liquidation; the *contracts*, not the agent, keep funds safe. Separating the pause key is the immediate fix.

**Q: Your keeper buffer repays users' debt with the protocol's own capital. Where does that money come from, and how is that not an unfunded liability at scale?** *(landmine)*
Good catch — a subsidy that prevents liquidations isn't free and doesn't scale as a giveaway. In the demo the buffer is small and just buys time before the grace window. In production it has to be a *funded* facility — priced into borrow rates, or a borrower-paid insurance premium, or a backstop that's later recovered from the position — not the protocol eating losses. If it's an open-ended subsidy it's a liability, and you're right to flag it. It has to be self-funding or it doesn't ship.

**Q: The agent runs off-chain. Why should we trust it?**
You shouldn't have to. Every action it takes is an on-chain transaction gated by the same `AccessControl` and the same `RiskEngine` checks any actor faces — it's a convenience actor. The invariants — reentrancy guards, prices only through the aggregator, no borrow or liquidation on a broken price, capped roles — all live in the contracts. If the agent dies, the protocol is still safe; positions just don't get the automated help.

### Risk parameters

**Q: How do you actually set the tiers and LTVs?**
A three-tier `AssetQualityRegistry`. Tier 1, like a T-bill: 80% max LTV (8000 bps), 85% liquidation threshold (8500 bps), 5% penalty (500 bps). Lower tiers get lower LTV plus isolation mode and debt ceilings, reflecting asset quality and liquidity. And LTV is dynamic — if the oracle drops to single-source, effective LTV is auto-capped to the 45% tier-3 floor regardless of the configured value. Risk parameters respond to oracle health, not just the asset.

**Q: Walk me through the liquidation mechanics.**
Health factor is collateral value × liquidation threshold ÷ debt, in 1e18. Below 1.0 the position is flagged and we stamp `unhealthySince`. A liquidator can only seize after a 300-second grace period, and only if it's still unhealthy, applying the 5% penalty. The grace window fits RWA settlement reality and avoids liquidating on a transient blip. Liquidation is fully blocked if the collateral's breaker is tripped — you can never liquidate on a frozen or fake price.

**Q: Your grace period only clears the unhealthy flag on a repay or liquidate call. If a position gets flagged, recovers because the price ticked up, but nobody calls those, `unhealthySince` stays set — so the next dip below 1.0 liquidates instantly with no grace. Isn't your headline anti-blip protection silently gone for any position that ever wobbled?** *(landmine)*
That's a genuine bug, not a nuance — a stale flag from an earlier wobble means the next dip skips the grace window entirely. `unhealthySince` is only zeroed on repay or liquidation, never on a price-driven recovery. The fix is to reset it the moment health is restored, including on a poke that moves the price back to healthy, or to require the position be *continuously* unhealthy for the full window rather than trusting one old timestamp. The grace concept is sound; our flag lifecycle is incomplete, and I'd rather you hear that than a claim it always holds.

**Q: Show me who liquidates an underwater position. Your `liquidate()` makes the liquidator repay the full debt but caps the seized amount at the user's collateral — which, once underwater, is worth less than the debt. So every rational liquidator takes a loss and nobody calls it. How does bad debt ever clear?** *(landmine)*
Correct — once collateral is worth less than debt, our full-repay/capped-seize liquidation is a guaranteed loss and no one runs it, so bad debt sits until a reserve eats it. Two things we owe: partial liquidations so a liquidator can clear the profitable slice, and a backstop buyer — the reserve or a Dutch auction — for the underwater remainder. The grace period *does* raise underwater risk; that's the deliberate tradeoff for not liquidating on blips. We don't pretend the keeper buffer substitutes for a real liquidation market.

**Q: What about bad debt — a position that goes underwater past the penalty?**
Conservative LTV plus the grace period minimize it, but if health factor collapses faster than liquidation clears — gap risk — you get bad debt, like any lending protocol. Our first line is the AI monitor repaying from the keeper buffer to restore HF before it hits 1.0. Beyond that it's a protocol reserve or socialized loss. As we discussed, the liquidation function itself is unprofitable once underwater, so the reserve is really the backstop and partial liquidation is on the roadmap. We don't pretend bad debt is impossible.

**Q: Your demo shows health factor 1.275 — walk me through the math.**
50,000 bMTB at $1.02 is $51,000 of collateral. Liquidation threshold is 85%, so risk-adjusted that's $43,350. Debt is 34,000 mUSDC. Health factor is 43,350 ÷ 34,000 = 1.275. Then the guardian pushes one feed 40% below the honest one ($0.51 against $0.85); the breaker trips on the 4,000-bps deviation, the price holds at last-good, and the user is not liquidated. That's the whole headline in one number.

### Architecture

**Q: Give me the architecture in thirty seconds.**
Separation of concerns. `OracleAggregator` owns price truth and the breaker. `AssetQualityRegistry` owns per-asset risk config and the single-source LTV floor. `RiskEngine` is a pure read model — health factor, borrow-allowed, liquidatable — and it reads prices only through the aggregator, never a raw adapter. `CollateralVault` is the only fund-moving contract: reentrancy-guarded, pausable, role-gated. Every state change emits an event. Clean seams mean each piece is testable and swappable.

**Q: Does this scale to many assets and users?**
Yes. Config is per-asset, positions are per-user, reads are O(1). The demo simplifies to one collateral asset per user for isolation clarity, but that's just an extension of the same mapping. Aggregator poke is per-asset and anyone (or a keeper) can call it. HashKey is EVM-compatible, so the gas model is standard and nothing here is exotic or unbounded.

**Q: Why build an aggregator instead of just using Chainlink?**
RWA feeds often aren't on Chainlink — issuers publish NAV through their own oracles. Our aggregator is feed-agnostic behind an adapter interface, and it layers the deviation breaker and single-source LTV floor on top of whatever feeds exist. The day Chainlink lists the asset, it's simply another adapter plugged in. We're adding a risk layer, not reinventing price feeds.

### Business

**Q: Name your first real customer. Who have you actually talked to that will deposit a tokenized T-bill and borrow against it on day one?** *(landmine)*
Honestly, we have zero signed users — this is a hackathon build, and I won't pretend otherwise. Our hypothesis is crypto-native treasuries and market-maker desks already holding Ondo or Superstate paper who want USD without unwinding yield. The right next step before we write more Solidity is ten customer conversations to test whether that pain is real. If it isn't, the risk framework doesn't matter — and we'd rather find that out than assume demand.

**Q: What's your moat versus Aave, Morpho, Centrifuge — or Maple, which already does institutional RWA lending with underwriters and real AUM?** *(landmine — never omit Maple)*
Maple is the closest comp and we should name it directly. Maple is a permissioned, underwriter-gated pool — relationship lending with off-chain credit diligence. We're going the other way: permissionless, over-collateralized, transparent on-chain risk against *liquid* tokenized bills, no underwriter in the loop. Different risk model, different customer. Aave and Morpho are crypto-collateral-first with RWA bolted on and instant-oracle liquidations that don't fit T+N settlement; Centrifuge is RWA but off-chain-heavy. Our wedge is RWA-native risk primitives from day one. But you're right that the honest gap is a *non-code* moat: Maple has a track record we don't, and code alone is forkable.

**Q: Your moat is a circuit breaker, an LTV floor and a grace period — about 200 lines Aave could ship in a sprint. How is a risk framework a moat?** *(landmine)*
You're right that the code isn't the moat — anyone can fork these primitives. Defensibility, if it exists, is on the business side: exclusive integrations with licensed issuers for their NAV feeds, being the default lending venue on a compliance chain before anyone else, and a risk track record you can't fork. Today we have none of those. What we have is a correct starting design, not a moat, and I won't oversell it as one.

**Q: Why HashKey Chain specifically — and doesn't a compliance chain with almost no DeFi liquidity starve you of the stablecoin supply a lending market needs?** *(landmine)*
HashKey is a licensed, compliance-oriented chain and exchange group in Asia with real institutional and RWA focus — the right venue for regulated tokenized assets and KYC'd participants, and it's EVM-compatible (chainId 133, HSK gas) so there's no rewrite. The real tradeoff you're pointing at is liquidity: HashKey buys us compliant participants but not deep retail stablecoin supply. The honest plan is that liquidity here is institutional and relationship-sourced — the same desks and treasuries on both sides of the book — or we bridge dollars in. If that supply doesn't materialize, the compliance positioning isn't worth what we gave up. It's a bet, and supply is the thing that has to prove out.

**Q: You're lending against securities. A "licensed chain" doesn't give the protocol a license. What's your regulatory posture?** *(landmine)*
HashKey's licenses cover HashKey, not us — the chain doesn't launder our regulatory status. Realistically this ships behind a licensed operating entity or in partnership with the issuer, with permissioned access, not as anonymous permissionless DeFi. We built the compliance gate precisely because we assume this is a regulated venue. But I won't claim we've cleared that bar — the legal wrapper is unbuilt, and it's a bigger lift than the smart contracts.

**Q: Who actually uses this?**
Institutions and treasuries holding tokenized T-bills who want USD liquidity without selling the yield-bearing asset — the RWA version of borrowing against your bond portfolio. Supply side is RWA holders unlocking capital efficiency while keeping the yield; demand side is stablecoin borrowers. As I said, we have no signed users yet — this is a validated hypothesis, not a pipeline.

**Q: How is this not just a wrapper around existing lending code?**
The lending loop — deposit, borrow, repay, liquidate — is intentionally boring and battle-tested; we don't innovate where we shouldn't. The novel surface is everything that makes RWA collateral safe: the deviation breaker that survived a −40% attack live, oracle-health-driven dynamic LTV, and settlement-aware liquidation. We innovate on risk and reuse on plumbing. That's the responsible split.

---

## 4. Landmine questions — the 6–8 hardest, with the exact answer to give

These are the questions a code-reading judge is most likely to ask and most likely to trip us up. **Memorize the concession + the fix.** The pattern is always: *"You're right → here's the precise flaw → here's the production fix → I won't defend the demo wiring."*

1. **"Your breaker fires on a real crash / feed-latency skew, freezing liquidations exactly when you need them."**
   → Concede it's the sharpest critique. Fix: **sustained-deviation gate (persist across N pokes) + allow liquidation on the more-conservative feed instead of a hard freeze.**

2. **"Single-source mode leaves existing positions on an unchecked lone feed; the 45% floor only gates new borrows."**
   → Concede the floor protects the wrong thing. Fix: **suspend liquidations (and/or tighten the liquidation threshold) in single-source mode**, not just cap new borrowing.

3. **"One keeper key signs BOTH adapters — there's no source independence as deployed."**
   → Concede fully: demo wiring, not design. Fix: **genuinely independent providers per feed (issuer NAV oracle + Chainlink), behind a multisig.** The demo proves the *mechanism*, not independence.

4. **"Single-source + `clearBreaker` + `pause` in one key is a theft path — so 'never theft' is false."**
   → Concede "never theft" is too strong. Fix: **separate the price-author key from the breaker-clear key, and suspend seizure in single-source mode.**

5. **"`poke()` is permissionless, so an insolvent borrower sustains the freeze and can never be liquidated — your safety property becomes a liquidation shield."**
   → Concede it's the sharpest DoS. Fix: **time-box the freeze** — after a guardian-review window the asset must resolve to a defensible price and liquidations resume; clearing isn't re-trippable by an interested party's poke.

6. **"`unhealthySince` is never reset on a price-driven recovery, so the grace period is defeated on a second dip."** *(concrete bug)*
   → Concede it's a genuine bug. Fix: **reset `unhealthySince` on recovery (including via poke), or require continuous unhealthiness for the full window.**

7. **"Liquidation is unprofitable once underwater (full-repay, collateral-capped seize, no partial), so bad debt never clears."**
   → Concede the primary liquidation path fails when it's needed most. Fix: **partial liquidations + a backstop bidder (reserve or Dutch auction).**

8. **"Name a real customer / where's your non-code moat / Maple already does this."**
   → Concede zero signed users; name Maple directly; concede code is forkable. **Moat is business-side (issuer integrations, chain-default position, track record) and unbuilt — validated hypothesis, not a pipeline.**

**Bonus landmine (code-reading judge):** *"No absolute price sanity floor — a shared-zero passes the deviation check and liquidations fire on $0."* → Concede it's a real hole; fix is **per-asset absolute floor/ceiling band + non-zero check, evaluated before deviation.**

---

## 5. Honest weaknesses & how to own them

| Weakness | How to own it |
|---|---|
| **Breaker can't distinguish manipulation from a real crash, latency skew, or a sustained griefing freeze.** | Lead with it — it's the conceptual core. "Freeze is fail-safe against manipulation, fail-dangerous against a real crash. The fix is a sustained-deviation gate and allowing liquidation on the conservative feed." |
| **Single-source mode removes the entire manipulation check while leaving liquidations live on the lone price; the 45% floor only gates new borrows.** | "Correct — single-source should suspend seizure, not just cap new leverage. It's the attacker's actual objective and the highest-priority fix." |
| **No source independence as deployed — one keeper key signs both feeds + clears the breaker + can pause.** | "Demo wiring. Production is independent providers, a multisig, and separated price-author / breaker-clear / pause keys." Never claim independence exists today. |
| **The "AI" agent is deterministic threshold policy, not a model.** | "Policy-driven autonomous agent with a model-ready seam; determinism is a safety feature for a fund-touching actor. The defensible property is capped + repay-only, not the label." |
| **Two concrete bugs: `unhealthySince` not reset on recovery; full-range deviation gets more fragile with more feeds.** | Name both as genuine bugs with one-line fixes. Knowing your own bugs is the strongest possible posture. |
| **Liquidation economics break underwater (no partial liquidation, unprofitable full-repay).** | "The reserve is the backstop, not the primary path; partial liquidation + a Dutch-auction backstop is the fix." |
| **Everything real is mocked — no real issuer, custodian, oracle feed, or legal wrapper.** | "Mocks are demo-scoped; the adapter interface and compliance gate are the real integration points. Issuer credit and custody are off-chain legal risk no protocol removes." |
| **No named customers; forkable moat; Maple omitted; carry math unproven; HashKey liquidity thin.** | Concede each precisely. Zero signed users, name Maple, moat is business-side and unbuilt, carry only works for active desks, liquidity is a bet on institutional supply. |
| **Keeper subsidy (buffer repays user debt) is an unfunded liability at scale.** | "In production it's a funded facility priced into rates or a borrower-paid premium, not the protocol eating losses." |

---

## 6. Glossary — say these consistently

- **Health factor (HF):** collateral value × liquidation threshold ÷ debt, in 1e18. HF < 1.0 (`1e18`) means liquidatable. Demo position = 1.275.
- **LTV (loan-to-value):** how much you can borrow as a % of collateral value, in bps. bMTB max LTV = 80% (8000 bps).
- **Liquidation threshold:** the LTV at which a position becomes liquidatable, in bps. bMTB = 85% (8500 bps). Always ≥ max LTV, so a fresh loan isn't instantly underwater.
- **Circuit breaker:** the aggregator state that trips when two live feeds disagree by more than the deviation limit; freezes the asset on its last-good price and blocks borrows and liquidations until a guardian clears it.
- **Staleness:** a feed whose `updatedAt` is older than `maxStaleness` is dropped before it can influence the price; a "good" price that itself ages past `maxStaleness` makes `getPrice` revert.
- **Deviation (bps):** relative spread between the highest and lowest live feed, `(max − min) × 1e4 / max`. Demo attack = 4,000 bps (40%) vs a 500 bps (5%) limit → trip.
- **Isolation mode:** collateral that can only be used on its own (one collateral asset per user in the demo), with a debt ceiling, to contain risk from a single asset.
- **Single-source cap:** when only one live feed remains, `effectiveMaxLtv` is floored to the tier-3 value (4500 bps / 45%) because the manipulation cross-check is gone.
- **Grace-period liquidation:** a flagged position isn't seized immediately; it must remain unhealthy for `GRACE_PERIOD` (300s in the demo) before a liquidator can seize, matching RWA settlement reality and avoiding liquidation on a transient blip.
