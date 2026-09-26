/**
 * reset-demo.ts — put the live demo back to its opening state (HF 1.275).
 *
 *   npm run reset          # HashKey testnet
 *   npm run reset:local    # local node
 *
 * Run it between rehearsals, and between the ATTACK and DECLINE scenes if you
 * demo the attack first. The circuit breaker is manual by design (no auto
 * re-arm), so resetting the keeper's control file alone does NOT clear it.
 *
 * Steps:
 *   1. rewrite scripts/keeper/demo-control.json to steady prices (1.02 / 1.02)
 *   2. push agreeing prices, clear the breaker (GUARDIAN_ROLE), poke
 *   3. unpause the vault if the agent escalated
 *   4. restore the demo debt to 34,000 mUSDC (the agent repays some on DECLINE)
 *   5. top the keeper's repay buffer back up to 10,000 mUSDC
 *
 * The keeper can keep running. Restart `npm run agent` afterwards so its
 * in-memory buffer counter starts from zero again.
 */
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

const PRICE = ethers.parseUnits("1.02", 8);
const TARGET_DEBT = ethers.parseUnits("34000", 6);
const TARGET_COLL = ethers.parseUnits("50000", 18);
const STAGE_DEPOSIT = ethers.parseUnits("1000", 18); // bMTB kept in the wallet for the live deposit
const KEEPER_BUFFER = ethers.parseUnits("10000", 6);
const CONTROL_FILE = path.join(__dirname, "keeper", "demo-control.json");

const STEADY_CONTROL = {
  _comment:
    "Live demo control — hot-reloaded by guardian-price-pusher.ts each tick. Edit and save to stage a scenario.",
  _scenarios: {
    steady: "bMTB priceA/priceB = 1.02 (this file's default) — healthy, HF 1.275",
    attack: "set bMTB.priceB = 0.51  -> one feed 40% below the honest $0.85 (run after decline), breaker trips, position safe",
    decline: "set bMTB.priceA AND priceB = 0.85  -> feeds agree, accepted, agent auto-repays",
    stale: "set bMTB.skipB = true  -> adapterB stops updating, single-source, LTV capped to 45%",
    reset: "run `npm run reset` (clears the breaker and restores the position)",
  },
  bMTB: { priceA: 1.02, priceB: 1.02, skipA: false, skipB: false },
  mUSDC: { priceA: 1.0, priceB: 1.0, skipA: false, skipB: false },
};

// Public testnet RPCs are load-balanced: retry reads, and retry sends only when
// they failed before broadcast (no receipt) so a mined tx is never re-sent.
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

async function main() {
  const depFile = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
  const c = dep.contracts;
  const demoUser: string = dep.demoUser;
  const keeper: string = dep.keeper;
  const [deployer] = await ethers.getSigners();

  const adapterA = await ethers.getContractAt("GuardianOracleAdapter", c.adapterA);
  const adapterB = await ethers.getContractAt("GuardianOracleAdapter", c.adapterB);
  const aggregator = await ethers.getContractAt("OracleAggregator", c.aggregator);
  const vault = await ethers.getContractAt("CollateralVault", c.vault);
  const mUSDC = await ethers.getContractAt("MockUSDC", c.mUSDC);
  const bMTB = await ethers.getContractAt("MockRWAToken", c.bMTB);
  const riskEngine = await ethers.getContractAt("RiskEngine", c.riskEngine);

  console.log("─".repeat(74));
  console.log(`TERRAVAULT demo reset — ${network.name}`);
  console.log("─".repeat(74));

  // 1. Steady control file first, so a running keeper stops pushing attack prices.
  fs.writeFileSync(CONTROL_FILE, JSON.stringify(STEADY_CONTROL, null, 2) + "\n");
  console.log("control file    : steady (1.02 / 1.02)");

  // 2. Agreeing prices, clear breaker, poke. A keeper tick that started before
  //    the control reset can still push an attack price and re-trip, so verify.
  for (let attempt = 1; ; attempt++) {
    await send("price A", () => adapterA.updatePrice(c.bMTB, PRICE));
    await send("price B", () => adapterB.updatePrice(c.bMTB, PRICE));
    if (await retry(() => aggregator.isCircuitBroken(c.bMTB))) {
      await send("clearBreaker", () => aggregator.clearBreaker(c.bMTB));
      console.log("breaker         : cleared (guardian review)");
    }
    await send("poke", () => aggregator.poke(c.bMTB));
    await sleep(3000); // let lagging RPC nodes catch up before checking
    if (!(await retry(() => aggregator.isCircuitBroken(c.bMTB)))) break;
    if (attempt >= 3) {
      throw new Error("breaker re-tripped 3 times. Stop the keeper (Ctrl+C) and run reset again.");
    }
    console.log("  breaker re-tripped (a keeper tick raced the reset); retrying in 10s…");
    await sleep(10_000);
  }
  console.log("oracle          : bMTB $1.02, two sources, breaker armed");

  // 3. Unpause if the agent escalated.
  if (await retry(() => vault.paused())) {
    await send("unpause", () => vault.unpause());
    console.log("vault           : unpaused");
  }

  // The agent holds no pause power: running out of buffer must never freeze the vault.
  const PAUSER_ROLE = await vault.PAUSER_ROLE();
  if (await retry(() => vault.hasRole(PAUSER_ROLE, keeper))) {
    await send("revoke PAUSER_ROLE", () => vault.revokeRole(PAUSER_ROLE, keeper));
    console.log("agent key       : PAUSER_ROLE revoked");
  }

  // 4. Restore the demo position: 50,000 bMTB collateral first (a liquidation can
  //    seize all of it, and borrowing needs collateral), then 34,000 mUSDC debt.
  if (demoUser.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`⚠  demo user ${demoUser} is not the local signer; skipping position restore.`);
  } else {
    // The live on-stage deposit adds collateral; put it back so the next run's
    // market decline still pushes health below the agent's 1.10 act line.
    const coll: bigint = await retry(() => vault.collateral(demoUser, c.bMTB));
    if (coll > TARGET_COLL) {
      const amt = coll - TARGET_COLL;
      await send("withdraw", () => vault.withdraw(c.bMTB, amt));
      console.log(`collateral      : withdrew ${ethers.formatUnits(amt, 18)} back to the wallet → 50,000 bMTB`);
    } else if (coll < TARGET_COLL) {
      const amt = TARGET_COLL - coll;
      const bal: bigint = await retry(() => bMTB.balanceOf(deployer.address));
      if (bal < amt) await send("mint bMTB", () => bMTB.mint(deployer.address, amt - bal));
      await (await bMTB.approve(c.vault, amt)).wait();
      await send("deposit", () => vault.deposit(c.bMTB, amt));
      console.log(`collateral      : deposited ${ethers.formatUnits(amt, 18)} → 50,000 bMTB`);
    } else {
      console.log("collateral      : 50,000 bMTB");
    }

    const debt: bigint = await retry(() => vault.debt(demoUser));
    if (debt < TARGET_DEBT) {
      const amt = TARGET_DEBT - debt;
      await send("borrow", () => vault.borrow(amt));
      console.log(`debt            : borrowed ${ethers.formatUnits(amt, 6)} back → 34,000 mUSDC`);
    } else if (debt > TARGET_DEBT) {
      const amt = debt - TARGET_DEBT;
      await (await mUSDC.approve(c.vault, amt)).wait();
      await send("repay", () => vault.repay(amt));
      console.log(`debt            : repaid ${ethers.formatUnits(amt, 6)} → 34,000 mUSDC`);
    } else {
      console.log("debt            : already 34,000 mUSDC");
    }

    // Stage the live deposit: 1,000 bMTB in the wallet and a standing approval,
    // so the deposit on stage is a single wallet confirmation.
    const walletBMTB: bigint = await retry(() => bMTB.balanceOf(deployer.address));
    if (walletBMTB < STAGE_DEPOSIT) {
      await send("mint stage bMTB", () => bMTB.mint(deployer.address, STAGE_DEPOSIT - walletBMTB));
    }
    const allowance: bigint = await retry(() => bMTB.allowance(deployer.address, c.vault));
    if (allowance < STAGE_DEPOSIT) {
      await send("approve bMTB", () => bMTB.approve(c.vault, ethers.MaxUint256));
    }
    console.log("stage deposit   : 1,000 bMTB in the wallet, vault pre-approved");
  }

  // 5. Refill the agent's repay buffer and clear its persisted facility ledger.
  fs.writeFileSync(
    path.join(__dirname, "..", "deployments", "agent-state.json"),
    JSON.stringify({ spent: "0", owed: {} }, null, 2) + "\n"
  );
  const buf: bigint = await retry(() => mUSDC.balanceOf(keeper));
  if (buf < KEEPER_BUFFER) {
    await send("mint buffer", () => mUSDC.mint(keeper, KEEPER_BUFFER - buf));
    console.log(`keeper buffer   : topped up to ${ethers.formatUnits(KEEPER_BUFFER, 6)} mUSDC`);
  } else {
    console.log(`keeper buffer   : ${ethers.formatUnits(buf, 6)} mUSDC`);
  }

  await sleep(3000);
  const hf: bigint = await retry(() => riskEngine.getHealthFactor(demoUser));
  const deployerGas = await ethers.provider.getBalance(deployer.address);
  const keeperGas = await ethers.provider.getBalance(keeper);
  console.log("─".repeat(74));
  console.log(`health factor   : ${Number(ethers.formatUnits(hf, 18)).toFixed(3)} (target 1.275)`);
  console.log(
    `gas             : deployer ${Number(ethers.formatEther(deployerGas)).toFixed(4)} HSK | ` +
      `keeper ${Number(ethers.formatEther(keeperGas)).toFixed(4)} HSK`
  );
  if (keeperGas < ethers.parseEther("0.02")) {
    console.log("⚠  keeper gas is low. Top it up at the faucet before the demo.");
  }
  console.log("Reset complete. Restart `npm run agent` so its buffer counter resets.");
  console.log("─".repeat(74));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
