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

  Off-chain (scoped keeper key, no owner god-mode):
    scripts/keeper/guardian-price-pusher.ts  → pushes feed prices + pokes the aggregator
    agents/risk-monitor.ts (AI Risk Monitor) → polls HF, auto-repays from a capped buffer, escalates
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
| HashKey Testnet | 133 | HSK | `https://hashkey-testnet.drpc.org` |
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

Deploy wires scoped `AccessControl` roles (no owner god-mode): the keeper key receives `GUARDIAN_ROLE` on both adapters and the aggregator, plus `PAUSER_ROLE` and `KEEPER_ROLE` on the vault. Addresses are written to `deployments/<network>.json` and `deployments/latest.json`, which the off-chain scripts read.

## Run the demo end-to-end

Open three terminals after `deploy` + `seed`:

```bash
npm run keeper           # scripts/keeper/guardian-price-pusher.ts — pushes prices + pokes the aggregator each tick
npm run agent            # agents/risk-monitor.ts — AI Risk Monitor: polls HF, auto-repays from the capped buffer
# + your front-end console connected to the demoUser wallet
```

Stage the three scenarios by editing **`scripts/keeper/demo-control.json`** (hot-reloaded by the keeper each tick):

- **ATTACK** — set `bMTB.priceB = 0.612` (a −40% single-feed manipulation). Deviation ≈ 4000 bps > 500 bps → breaker trips, last-good retained, `getPrice`/`borrow`/`liquidate` revert for bMTB. The user is **not** liquidated.
- **DECLINE** — set both `bMTB.priceA` and `bMTB.priceB` to `0.90` (feeds agree). Price accepted, HF falls below 1.10, the agent repays from the capped buffer to restore HF.
- **STALE** — set `bMTB.skipB = true` (adapterB stops updating). After `maxStaleness` the aggregator falls to a single source and the registry caps effective LTV to the 45% tier-3 floor.

The full timed script (what to click, what to say, presenter split, and the testnet-down backup) is in [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md). The Q&A brief and glossary are in [`docs/DEMO_BRIEF.md`](docs/DEMO_BRIEF.md).

### Demo numbers (must reproduce exactly)

- Deposit **50,000 bMTB** @ **$1.02** = **$51,000** collateral value.
- Borrow **34,000 mUSDC**.
- Health factor = (51,000 × 0.85) / 34,000 = **1.275**.
- Attack pushes one feed to **$0.612** → deviation ≈ **4000 bps** (40%) vs a **500 bps** (5%) limit → **breaker trips**.
- bMTB Tier 1: maxLtv **8000**, liqThreshold **8500**, liqPenalty **500**, grace period **300s**.
- Agent thresholds: warn **1.20**, act **1.10**, target **1.30**; repay ≤ **2,000 mUSDC/action**, buffer cap **10,000 mUSDC**.

## Deployed addresses — HashKey Testnet (chainId 133)

> Fill in after `npm run deploy`. Values are read live from `deployments/hashkeyTestnet.json`. **Keep the deploy tx hash handy for the demo.**

| Contract | Address |
|---|---|
| MockRWAToken (`bMTB`) | `0x…` |
| MockUSDC (`mUSDC`) | `0x…` |
| GuardianOracleAdapter A | `0x…` |
| GuardianOracleAdapter B | `0x…` |
| OracleAggregator | `0x…` |
| AssetQualityRegistry | `0x…` |
| RiskEngine | `0x…` |
| CollateralVault | `0x…` |
| ComplianceGate | `0x…` |
| Deploy tx hash | `0x…` |

Block explorer (Blockscout): `https://hashkeychain-testnet-explorer.alt.technology`

## What's mocked vs real (honest accounting)

**Real (shipped, compiled, tested in this repo):**
- All nine Solidity contracts, compiled under Solidity 0.8.24 (`viaIR`).
- The circuit-breaker / deviation / staleness / single-source logic in `OracleAggregator`, and the guarded `getPrice` read path.
- Health-factor math, borrow/liquidation gating, and dynamic (single-source-aware) LTV in `RiskEngine` + `AssetQualityRegistry`.
- Reentrancy-guarded, pausable, role-gated fund flows and grace-period soft liquidation in `CollateralVault`.
- The off-chain keeper (price pusher) and the AI Risk Monitor agent, both signing with a scoped keeper key.
- Tests: `test/OracleAggregator.test.ts`, `test/e2e-demo-flow.test.ts`.

**Mocked / demo-scoped:**
- `bMTB` and `mUSDC` are mock ERC-20s with public `mint`; there is no real tokenized T-bill, issuer, or custodian.
- Both price feeds are `GuardianOracleAdapter`s pushed by **one keeper key** — so *source independence does not exist as deployed.* The demo proves the breaker mechanism, not Byzantine independence. Production requires genuinely independent providers (issuer NAV oracle + Chainlink) behind a multisig.
- `ComplianceGate` is an allowlist PoC, not a full ERC-3643 identity registry; issuer credit, custody, and legal enforceability are off-chain and unmodeled.
- The "AI" agent is deterministic threshold policy with a model-ready seam, not a trained model.

**Known limitations we own (not defended — see `docs/DEMO_BRIEF.md` §5):**
- The breaker can't distinguish manipulation from a real crash or feed-latency skew (single-block, full-range deviation; no sustained-deviation gate).
- Single-source mode caps only *new* borrows; existing positions still run on the lone feed, and liquidations remain live. Fix: suspend seizure in single-source mode.
- `unhealthySince` is not reset on a price-driven recovery, which can defeat the grace period on a later dip.
- Liquidation is unprofitable once a position is underwater (full-repay, collateral-capped seize, no partial liquidation); a reserve / Dutch-auction backstop is needed.
- The keeper key holds price-authorship, `clearBreaker`, and `pause` together; production must separate these and decentralize the guardian.

## License

MIT.
