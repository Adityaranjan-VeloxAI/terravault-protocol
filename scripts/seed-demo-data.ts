import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ===========================================================================
// TERRAVAULT — demo seeding
//
// Reproduces the exact front-end demo numbers:
//   • Onboard bMTB (Mock Tokenized T-Bill), Tier 1:
//       maxLtv 8000, liqThreshold 8500, liqPenalty 500, isolation false.
//   • Prices (1e8): bMTB = $1.02 (102000000), mUSDC = $1.00 (100000000).
//   • Demo user deposits 50,000 bMTB  => collateral value $51,000.
//   • Demo user borrows  34,000 mUSDC.
//   • HF = (51,000 * 0.85) / 34,000 = 1.275  => 1.275e18.
//
// Two guardian adapters (A,B) feed the aggregator so a single manipulated feed
// can be caught by the deviation check (the headline security property).
// ===========================================================================

const PRICE_DECIMALS = 8; // Chainlink-style 1e8 fixed point.
const BPS = 10_000n;

// Demo constants (kept here so the numbers are auditable at a glance).
const BMTB_PRICE = ethers.parseUnits("1.02", PRICE_DECIMALS); // 102000000
const MUSDC_PRICE = ethers.parseUnits("1.00", PRICE_DECIMALS); // 100000000

const DEPOSIT_BMTB = ethers.parseUnits("50000", 18); // 50,000 bMTB (18dp)
const BORROW_MUSDC = ethers.parseUnits("34000", 6); // 34,000 mUSDC (6dp)

const POOL_LIQUIDITY = ethers.parseUnits("1000000", 6); // 1,000,000 mUSDC lending pool
const KEEPER_BUFFER = ethers.parseUnits("10000", 6); // capped keeper repay buffer

const MAX_STALENESS = 90n; // seconds — demo-friendly (STALE scenario)
const MAX_DEVIATION_BPS = 500n; // 5% — the manipulation guard

function loadDeployment() {
  const explicit = process.env.DEPLOYMENTS_FILE;
  const byNetwork = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const latest = path.join(__dirname, "..", "deployments", "latest.json");
  const file = explicit || (fs.existsSync(byNetwork) ? byNetwork : latest);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment file found (looked at ${byNetwork} then ${latest}). Run: npm run deploy`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function line() {
  console.log("─".repeat(74));
}

async function main() {
  const dep = loadDeployment();
  const c = dep.contracts;
  const [deployer] = await ethers.getSigners();
  const demoUser = dep.demoUser as string;
  const keeper = dep.keeper as string;

  line();
  console.log("TERRAVAULT demo seeding");
  console.log(`  network : ${network.name} (chainId ${dep.chainId})`);
  console.log(`  demoUser: ${demoUser}`);
  console.log(`  keeper  : ${keeper}`);
  line();

  const bMTB = await ethers.getContractAt("MockRWAToken", c.bMTB);
  const mUSDC = await ethers.getContractAt("MockUSDC", c.mUSDC);
  const adapterA = await ethers.getContractAt("GuardianOracleAdapter", c.adapterA);
  const adapterB = await ethers.getContractAt("GuardianOracleAdapter", c.adapterB);
  const aggregator = await ethers.getContractAt("OracleAggregator", c.aggregator);
  const registry = await ethers.getContractAt("AssetQualityRegistry", c.registry);
  const riskEngine = await ethers.getContractAt("RiskEngine", c.riskEngine);
  const vault = await ethers.getContractAt("CollateralVault", c.vault);

  // --- 1. Onboard bMTB in the AssetQualityRegistry (Tier 1) ---------------
  const cfg = {
    tier: 1,
    maxLtvBps: 8000n, // 80%
    liqThresholdBps: 8500n, // 85%
    liqPenaltyBps: 500n, // 5%
    debtCeiling: ethers.parseUnits("100000000", 6), // large (100M mUSDC)
    isolation: false,
    enabled: true,
  };
  await (await registry.setAsset(c.bMTB, cfg)).wait();
  console.log("bMTB onboarded  : tier 1 | maxLtv 8000 | liqThreshold 8500 | penalty 500");

  // --- 2. Configure the aggregator for both assets ------------------------
  await (
    await aggregator.configureAsset(
      c.bMTB,
      [c.adapterA, c.adapterB],
      MAX_STALENESS,
      MAX_DEVIATION_BPS
    )
  ).wait();
  await (
    await aggregator.configureAsset(
      c.mUSDC,
      [c.adapterA, c.adapterB],
      MAX_STALENESS,
      MAX_DEVIATION_BPS
    )
  ).wait();
  console.log(
    `aggregator      : bMTB & mUSDC configured | staleness ${MAX_STALENESS}s | maxDev ${MAX_DEVIATION_BPS}bps`
  );

  // --- 3. Seed guardian prices (both adapters agree) + poke ----------------
  // Public testnet RPCs are load-balanced: a call right after a write can land on
  // a node one block behind. Retry reads, and retry sends only when they failed
  // before broadcast (no receipt) so a mined-and-reverted tx is never re-sent.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function retry<T>(fn: () => Promise<T>, tries = 6, delayMs = 2500): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= tries - 1) throw e;
        await sleep(delayMs);
      }
    }
  }
  async function send(label: string, fn: () => Promise<any>, tries = 6) {
    for (let i = 0; ; i++) {
      try {
        return await (await fn()).wait();
      } catch (e: any) {
        if (e?.receipt || i >= tries - 1) throw e;
        console.log(`  (${label}: RPC not synced yet, retrying…)`);
        await sleep(2500);
      }
    }
  }
  // Push both feeds for both assets, then poke. maxStaleness is short on purpose
  // (the STALE scenario demos fast), so the seed refreshes again before borrowing.
  async function refreshPrices() {
    await send("price bMTB A", () => adapterA.updatePrice(c.bMTB, BMTB_PRICE));
    await send("price bMTB B", () => adapterB.updatePrice(c.bMTB, BMTB_PRICE));
    await send("price mUSDC A", () => adapterA.updatePrice(c.mUSDC, MUSDC_PRICE));
    await send("price mUSDC B", () => adapterB.updatePrice(c.mUSDC, MUSDC_PRICE));
    await send("poke bMTB", () => aggregator.poke(c.bMTB));
    await send("poke mUSDC", () => aggregator.poke(c.mUSDC));
  }
  await refreshPrices();
  const [bmtbPx] = await retry(() => aggregator.getPrice(c.bMTB));
  const [usdcPx] = await retry(() => aggregator.getPrice(c.mUSDC));
  console.log(
    `prices poked    : bMTB $${ethers.formatUnits(bmtbPx, 8)} | mUSDC $${ethers.formatUnits(usdcPx, 8)}`
  );

  // --- 4. Fund the lending pool via fundPool() so poolLiquidity is tracked --
  await (await mUSDC.mint(deployer.address, POOL_LIQUIDITY)).wait();
  await (await mUSDC.approve(c.vault, POOL_LIQUIDITY)).wait();
  await send("fundPool", () => vault.fundPool(POOL_LIQUIDITY));
  console.log(`lending pool    : funded ${ethers.formatUnits(POOL_LIQUIDITY, 6)} mUSDC via fundPool()`);

  // --- 5. Fund the keeper repay buffer -------------------------------------
  await (await mUSDC.mint(keeper, KEEPER_BUFFER)).wait();
  console.log(`keeper buffer   : minted ${ethers.formatUnits(KEEPER_BUFFER, 6)} mUSDC -> keeper`);

  // Top up keeper HSK gas if it's running low (keeps the demo smooth).
  try {
    const keeperGas = await ethers.provider.getBalance(keeper);
    if (keeperGas < ethers.parseEther("0.1")) {
      await (
        await deployer.sendTransaction({ to: keeper, value: ethers.parseEther("0.5") })
      ).wait();
      console.log("keeper gas      : topped up 0.5 HSK");
    }
  } catch {
    /* non-fatal */
  }

  // --- 6. Mint bMTB to the demo user + deposit -----------------------------
  await (await bMTB.mint(demoUser, DEPOSIT_BMTB)).wait();
  console.log(`bMTB minted     : ${ethers.formatUnits(DEPOSIT_BMTB, 18)} -> demoUser`);

  // The demo user must be a local signer to open the position from this script.
  const signers = await ethers.getSigners();
  const userSigner = signers.find(
    (s) => s.address.toLowerCase() === demoUser.toLowerCase()
  );
  if (!userSigner) {
    console.log(
      "\n⚠  demoUser is not a local signer; skipping deposit/borrow. Open the\n" +
        "   position from the front-end wallet, or set DEPLOYER_PRIVATE_KEY = demoUser."
    );
  } else {
    // Re-push prices so the borrow sees a fresh last-good price inside maxStaleness.
    await refreshPrices();
    await (await bMTB.connect(userSigner).approve(c.vault, DEPOSIT_BMTB)).wait();
    await send("deposit", () => vault.connect(userSigner).deposit(c.bMTB, DEPOSIT_BMTB));
    console.log(`deposit         : ${ethers.formatUnits(DEPOSIT_BMTB, 18)} bMTB deposited`);

    await send("borrow", () => vault.connect(userSigner).borrow(BORROW_MUSDC));
    console.log(`borrow          : ${ethers.formatUnits(BORROW_MUSDC, 6)} mUSDC borrowed`);
  }

  // --- 7. Report resulting health factor -----------------------------------
  line();
  const hf = await retry(() => riskEngine.getHealthFactor(demoUser));
  const hfNum = Number(ethers.formatUnits(hf, 18));
  const collateralUSD =
    (Number(ethers.formatUnits(DEPOSIT_BMTB, 18)) * Number(ethers.formatUnits(BMTB_PRICE, 8)));
  const liqAdjusted = (collateralUSD * Number(cfg.liqThresholdBps)) / Number(BPS);
  const debtUSD = Number(ethers.formatUnits(BORROW_MUSDC, 6));
  console.log("Demo position opened:");
  console.log(`  collateral value : $${collateralUSD.toLocaleString()}`);
  console.log(`  liq-adjusted     : $${liqAdjusted.toLocaleString()} (x0.85)`);
  console.log(`  debt             : $${debtUSD.toLocaleString()}`);
  console.log(`  expected HF      : ${(liqAdjusted / debtUSD).toFixed(3)}`);
  console.log(`  on-chain HF      : ${hfNum.toFixed(3)}   (${hf.toString()} wei)`);
  line();
  console.log("Seed complete. Now run, in separate terminals:");
  console.log("  npm run keeper   # guardian price pusher (drives attack/decline/stale)");
  console.log("  npm run agent    # AI risk-monitor (auto-repays on legit decline)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
