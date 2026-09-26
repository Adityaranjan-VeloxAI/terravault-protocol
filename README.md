# TerraVault Protocol

**TerraVault is an RWA collateral lending protocol whose defining feature is a manipulation-resistant oracle.** Users deposit tokenized real-world assets (a mock tokenized T-bill, `bMTB`) and borrow a stablecoin (`mUSDC`) against them. Two independent price feeds cross-check each other through an `OracleAggregator`: if they disagree by more than a configured deviation limit, a **circuit breaker** trips, freezes the asset on its last honest price, and blocks both borrows and liquidations — so a manipulated feed can never wrongly liquidate a healthy borrower. Legitimate declines (where feeds agree) flow through normally, an **autonomous risk-monitor agent** auto-deleverages positions from a capped, repay-only buffer before they reach liquidation, and when the oracle degrades to a single feed the protocol automatically caps leverage to a conservative floor. Liquidation is soft and grace-period-based to fit real RWA settlement (T+1/T+2). Built with Solidity `^0.8.24`, Hardhat + TypeScript, OpenZeppelin, and ethers v6, targeting **HashKey Chain**.

## Tracks targeted

- **AI Agents** — an autonomous, policy-driven on-chain risk monitor that watches health factor and acts within a capped budget (`agents/risk-monitor.ts`).
- **AI × Web3** — off-chain agent + keeper driving on-chain risk decisions through scoped roles.
- **DeFi** — an over-collateralized money market with dynamic, oracle-health-aware risk parameters.
- **RWA** — tokenized T-bill collateral, compliance-gated transfers (PoC toward ERC-3643), and settlement-aware liquidation.

## Architecture

```
                 GuardianOracleAdapter A ┐
                 GuardianOracleAdapter B ┘
                          │ (each: getPrice → price 1e8, updatedAt)
                          ▼
                  OracleAggregator ───────────────► circuit breaker + staleness
                          │  (the ONLY price source the risk layer may read)      + single-source flag
                          ▼
   AssetQualityRegistry ──┤  effectiveMaxLtv() floors LTV to 45% when single-source
   (tiers, LTV, thresholds,│
    penalty, ceilings)     ▼
                     RiskEngine  ──────────────────► getHealthFactor / isBorrowAllowed /
                          │  (pure read model, no funds)   isLiquidatable / maxBorrowable
                          ▼
                   CollateralVault ─────────────────► deposit / withdraw / borrow / repay /
                   (ReentrancyGuard, Pausable,          grace-period liquidate; the ONLY
                    AccessControl; only fund mover)      fund-moving contract

  Off-chain:
    scripts/keeper/guardian-price-pusher.ts  → pushes feed prices + pokes the aggregator (keeper key)
    agents/risk-monitor.ts (AI Risk Monitor) → polls HF, repays from a capped buffer back to HF 1.30 (keeper key)
    agents/liquidator.ts (liquidator agent)  → outside bot, own wallet, no protocol role
    app/ (web app, `npm run app`)            → consumer UI + presenter controls; runs the three processes above
```

**Data flow:** keeper pushes prices into the two `GuardianOracleAdapter`s → `OracleAggregator.poke()` drops stale feeds, runs the deviation/circuit-breaker check, and stores a last-good price → `RiskEngine` reads that price (only through the aggregator) and computes health factor and borrow/liquidation eligibility → `CollateralVault` executes fund movements gated by the `RiskEngine`, with an independent circuit-breaker guard on `borrow()` and `liquidate()`.

**Contracts** (`contracts/`):

| Contract | Path | Role |
|---|---|---|
| `GuardianOracleAdapter` | `oracle/GuardianOracleAdapter.sol` | Single role-gated price source; guardian pushes prices, stamps `block.timestamp`. Two independent instances (A, B). |
| `OracleAggregator` | `oracle/OracleAggregator.sol` | Fans out to adapters, drops stale feeds, cross-checks for deviation, trips/holds the circuit breaker, exposes one guarded `getPrice`. |
| `AssetQualityRegistry` | `risk/AssetQualityRegistry.sol` | Per-asset risk config (tier, LTV, threshold, penalty, debt ceiling, isolation) + single-source LTV floor (4500 bps). |
| `RiskEngine` | `risk/RiskEngine.sol` | Pure read model: health factor, borrow-allowed, liquidatable, max-borrowable. Reads prices only through the aggregator. |
| `CollateralVault` | `vault/CollateralVault.sol` | Custody + lending pool; deposit/withdraw/borrow/repay/soft-liquidate. Reentrancy-guarded, pausable, role-gated. |
| `MockRWAToken` | `tokens/MockRWAToken.sol` | `bMTB`, 18 decimals, public `mint` for the demo. |
| `MockUSDC` | `mocks/MockUSDC.sol` | `mUSDC`, 6 decimals, public `mint` for the demo. |
| `ComplianceGate` | `compliance/ComplianceGate.sol` | Allowlist `canTransfer` — PoC toward ERC-3643, not full identity registry. |

### Scaling conventions (used consistently everywhere)

- **Prices:** 1e8 fixed point (Chainlink-style). `$1.02` → `102000000`.
- **Basis points:** 1e4 = 100%. maxLtv 80% → `8000`; liqThreshold 85% → `8500`.
- **Health factor:** 1e18 fixed point. HF 1.27 → `1.27e18`. Liquidation when HF < `1e18`.
- **Token amounts:** `bMTB` 18 decimals; `mUSDC` 6 decimals.

## Setup

```bash
npm install
cp .env.example .env      # fill in DEPLOYER_PRIVATE_KEY + KEEPER_PRIVATE_KEY (HashKey has HSK gas, not ETH)
```

Target chain (from `hardhat.config.ts`):

| Network | chainId | Gas token | RPC |
|---|---|---|---|
| HashKey Testnet | 133 | HSK | `https://testnet.hsk.xyz` |
| HashKey Mainnet | 177 | HSK | `https://mainnet.hsk.xyz` |
| Local Hardhat | 31337 | — | in-process |

### Compile, test, deploy

```bash
npm run compile          # hardhat compile
npm run test             # hardhat test (OracleAggregator.test.ts + e2e-demo-flow.test.ts)

# Deploy + seed the demo position
npm run deploy           # → HashKey Testnet; writes deployments/hashkeyTestnet.json + latest.json
npm run seed             # onboard bMTB, fund pool, mint + deposit 50k bMTB, borrow 34k mUSDC (HF 1.275)

# Local dry run (no testnet needed)
npx hardhat node         # in one terminal
npm run deploy:local
npm run seed:local
```

Deploy wires scoped `AccessControl` roles (no owner god-mode): the keeper key receives `GUARDIAN_ROLE` on both adapters and the aggregator, plus `KEEPER_ROLE` on the vault. It does not get `PAUSER_ROLE` (it was revoked on the live testnet deployment, and `npm run reset` revokes it again if present), so the agent can't freeze the vault. Addresses are written to `deployments/<network>.json` and `deployments/latest.json`, which the off-chain scripts read.

## Run the demo

The demo is a web app. After `deploy` + `seed`:

```bash
npm run app              # http://localhost:3000
```

`app/server.js` serves the page and starts three child processes: the price keeper, the AI risk monitor (~15s later) and the liquidator agent (~17s later). Their logs print in the same terminal. The page reads HashKey Testnet directly.

- **Position** card: health factor, collateral, debt, liquidation price, borrow limit used.
- **Manage** card: deposit / borrow / repay / withdraw through MetaMask. It switches to (or adds) HashKey Testnet, chainId 133, and can mint 10,000 test bMTB.
- **Oracle shield**: both feeds, how far apart they are against the 5% limit, and the frozen state.
- **AI guardian**: the risk monitor's and the liquidator's live reasoning, and an on-chain activity feed with explorer links.
- **Presenter bar** (only when served by `npm run app`): **Market decline** (both feeds $0.85), **Oracle attack** (feed B $0.51, 40% below the honest $0.85), **Try liquidation** (static call, no gas), **Crash** (both feeds $0.70), **Reset demo**.

The presenter buttons write prices into `scripts/keeper/demo-control.json`; the keeper pushes them on its next tick (up to ~15s). The market moves are staged; what happens after (breaker, health factor, repays, flags, reverts) is real contract behaviour on testnet.

A public static copy with no presenter bar is at https://terravault-adityaranjan-veloxais-projects.vercel.app. It is only reachable after Vercel Authentication is turned off in the project settings.

What to expect:

1. **Market decline.** Feeds agree at $0.85, the price is accepted. On the seeded position HF falls to 1.063. The risk monitor repays exactly `debt − collateralValue × liqThreshold / 1.30` in steps of at most 2,000 mUSDC: verified on testnet, 6,211.54 mUSDC in four repays, HF 1.063 → 1.300. It records what the user owes the facility (spent + 1% premium) in `deployments/agent-state.json`.
2. **Oracle attack** (after the decline). 4,000 bps deviation against a 500 bps limit: the breaker trips, the last-good $0.85 is kept, borrows and liquidations revert. Both agents stand down. **Try liquidation** returns `cannot liquidate on frozen price`.
3. **Crash** (from a fresh Reset only; the breaker stays tripped after an attack). HF 0.875. The risk monitor stands down (it never repays below HF 1.0). The liquidator quotes repay 34,000 mUSDC, receive 50,000 bMTB (the 5% bonus is capped by the collateral, ~2.9% effective, +$1,000), flags the position, waits the 300s grace period, seizes if still profitable, and verifies on-chain. Verified on testnet through the flag.
4. **Reset demo** (~20–60s): steady prices, breaker cleared, collateral back to 50,000 then debt to 34,000, 1,000 bMTB staged in the deployer wallet for a live deposit, facility ledger cleared, keeper buffer refilled to 10,000 mUSDC, `PAUSER_ROLE` revoked from the agent key if present, risk monitor restarted.

The processes also run on their own:

```bash
npm run keeper           # price pusher, reads scripts/keeper/demo-control.json each tick
npm run agent            # AI risk monitor
npm run liquidator       # liquidator agent (key from LIQUIDATOR_PRIVATE_KEY, or generated into deployments/liquidator-wallet.json)
npm run reset            # back to the opening state (HF 1.275)
npm run try-liquidate    # static liquidate() call against the demo user
```

Run only one keeper and one agent at a time; they share the keeper key. `npm run app` already runs them.

The timed 3-minute script (what to click, what appears, what to say, presenter split, backup) is in [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md). The Q&A brief is in [`docs/DEMO_BRIEF.md`](docs/DEMO_BRIEF.md). If testnet is down: `npx hardhat test test/e2e-demo-flow.test.ts` runs the same contracts through the same beats on a local chain.

### Demo numbers

- Seeded position: **50,000 bMTB** @ **$1.02** = **$51,000** collateral, **34,000 mUSDC** debt, HF = (51,000 × 0.85) / 34,000 = **1.275**.
- bMTB Tier 1: maxLtv **8000**, liqThreshold **8500**, liqPenalty **500**, grace period **300s**.
- Decline to **$0.85**: HF **1.063**; agent repays **6,211.54** mUSDC in four steps to HF **1.300**.
- Attack: feed B **$0.51** vs feed A **$0.85** → deviation **4000 bps** vs a **500 bps** limit → breaker trips.
- Crash to **$0.70**: HF **0.875**; full liquidation repays 34,000 and seizes all 50,000 bMTB (+$1,000). Below **~$0.68** a full liquidation is unprofitable.
- Agent: warn **1.20**, act **1.10**, target **1.30**; ≤ **2,000 mUSDC/action**; buffer cap **10,000 mUSDC**; **1%** facility premium.
- With the on-stage deposit and borrow of 1,000 each (51,000 bMTB, 35,000 debt): HF 1.263 before the decline, ~1.053 after it, ~6,656 mUSDC repaid to reach 1.300.

## Deployed addresses — HashKey Testnet (chainId 133)

> Live on HashKey Testnet. Source of truth: `deployments/hashkeyTestnet.json`. The demo position (50,000 bMTB collateral, 34,000 mUSDC debt, HF 1.275) is open for the deployer/demo user.

| Contract | Address |
|---|---|
| MockRWAToken (`bMTB`) | [`0x2D9dc2776C9cd2c9c68BaD7C86577CBB7388BC0E`](https://hashkeychain-testnet-explorer.alt.technology/address/0x2D9dc2776C9cd2c9c68BaD7C86577CBB7388BC0E) |
| MockUSDC (`mUSDC`) | [`0x2fC4DA60C9B43881a4a1e752DC5e7aFE2e91993C`](https://hashkeychain-testnet-explorer.alt.technology/address/0x2fC4DA60C9B43881a4a1e752DC5e7aFE2e91993C) |
| GuardianOracleAdapter A | [`0x126f835dA5Bed8B147708c0912BfD570D203817A`](https://hashkeychain-testnet-explorer.alt.technology/address/0x126f835dA5Bed8B147708c0912BfD570D203817A) |
| GuardianOracleAdapter B | [`0x8d6C9878ce0BE6b1775695303B1F3b0Aea3fe400`](https://hashkeychain-testnet-explorer.alt.technology/address/0x8d6C9878ce0BE6b1775695303B1F3b0Aea3fe400) |
| OracleAggregator | [`0xe932f559332aA604cE683e66Db91E006223Fc9B2`](https://hashkeychain-testnet-explorer.alt.technology/address/0xe932f559332aA604cE683e66Db91E006223Fc9B2) |
| AssetQualityRegistry | [`0x1F7f82ef0F12a647cF5116E9E71C3eb07DaCCe34`](https://hashkeychain-testnet-explorer.alt.technology/address/0x1F7f82ef0F12a647cF5116E9E71C3eb07DaCCe34) |
| RiskEngine | [`0xd6F7D14beD2e96B54b697B55a42f2B6E6A64393f`](https://hashkeychain-testnet-explorer.alt.technology/address/0xd6F7D14beD2e96B54b697B55a42f2B6E6A64393f) |
| CollateralVault | [`0xA025bb7981D50130d6F0F0e77c19cB283e18e472`](https://hashkeychain-testnet-explorer.alt.technology/address/0xA025bb7981D50130d6F0F0e77c19cB283e18e472) |
| ComplianceGate | [`0x6c07990b23EE25Fb2585AB13a4F2Ff51114BB7Ca`](https://hashkeychain-testnet-explorer.alt.technology/address/0x6c07990b23EE25Fb2585AB13a4F2Ff51114BB7Ca) |
| Deployer / demo user | [`0x856df6369Cb732FEdb768AdBE253B02fbA7fE2FB`](https://hashkeychain-testnet-explorer.alt.technology/address/0x856df6369Cb732FEdb768AdBE253B02fbA7fE2FB) |
| Keeper / agent | [`0xf7B09Cc2E1b994Dd4296C632B729515E6682BA29`](https://hashkeychain-testnet-explorer.alt.technology/address/0xf7B09Cc2E1b994Dd4296C632B729515E6682BA29) |

Block explorer (Blockscout): `https://hashkeychain-testnet-explorer.alt.technology`

## What's mocked vs real (honest accounting)

**Real (shipped, compiled, tested in this repo, running on HashKey Testnet):**
- All nine Solidity contracts, compiled under Solidity 0.8.24 (`viaIR`).
- The circuit-breaker / deviation / staleness / single-source logic in `OracleAggregator`, and the guarded `getPrice` read path.
- Health-factor math, borrow/liquidation gating, and dynamic (single-source-aware) LTV in `RiskEngine` + `AssetQualityRegistry`.
- Reentrancy-guarded, pausable, role-gated fund flows and grace-period soft liquidation in `CollateralVault`.
- The web app's reads and writes: every number on the page comes from the chain, and deposit / borrow / repay / withdraw are real MetaMask transactions.
- The off-chain processes: the keeper (price pusher) and the risk monitor sign with the keeper key; the liquidator agent signs with its own key and holds no protocol role.
- Tests: `test/OracleAggregator.test.ts`, `test/e2e-demo-flow.test.ts`.

**Mocked / demo-scoped:**
- The market. Price moves come from the presenter bar (or `demo-control.json`); there is no real price source.
- Both price feeds are `GuardianOracleAdapter`s pushed by **one keeper key**, so *source independence does not exist as deployed.* The demo proves the breaker mechanism, not independent sources. Production needs genuinely independent providers (issuer NAV oracle + Chainlink) behind a multisig.
- `bMTB` and `mUSDC` are mock ERC-20s with public `mint`; there is no real tokenized T-bill, issuer, or custodian. The liquidator mints its own mUSDC to repay debt, and its gas is topped up from the deployer.
- The agent's facility ledger (buffer used, and what each user owes including the 1% premium) is a local JSON file, `deployments/agent-state.json`. Nothing on-chain records or collects that debt, and `npm run reset` clears it.
- The "AI" risk monitor is deterministic threshold policy, not a trained model.
- `ComplianceGate` is an allowlist PoC, not a full ERC-3643 identity registry; issuer credit, custody, and legal enforceability are off-chain and unmodeled.
- The Vercel copy is static: no presenter bar and no agent reasoning, only what the chain shows.

**Known limitations on main (a `liquidation-v2` branch addressing the liquidation items is in progress, not merged):**
- Liquidation repays the **full debt**; there is no partial close.
- There is **no reserve for bad debt**. Because the seize is capped at the borrower's collateral, a full liquidation of the seeded loan is unprofitable below ~$0.68, and nobody will run it.
- `unhealthySince` is **not cleared on price recovery**. `liquidate()` tries to clear it when the position is healthy, but then reverts `not liquidatable`, which rolls the clear back. Only a repay (at HF ≥ 1.0) or a completed liquidation clears it, so a position that dipped and recovered skips the grace period on its next dip.
- There is **no on-chain quote function**; the liquidator computes its quote off-chain from the vault, aggregator and registry.
- The breaker can't tell manipulation from a real crash or feed-latency skew (single-poke, full-range deviation; no sustained-deviation gate).
- Single-source mode caps only *new* borrows; existing positions still run on the lone feed, and liquidations remain live.
- The keeper key holds price authorship for both feeds and `clearBreaker` together; production must separate these and decentralize the guardian. (It no longer holds `PAUSER_ROLE`.)

More detail and the planned fixes: `docs/DEMO_BRIEF.md` §4–5.

## License

MIT.
