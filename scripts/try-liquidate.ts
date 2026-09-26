/**
 * try-liquidate.ts — attempt to liquidate the demo user, live, and show the result.
 *
 *   npm run try-liquidate
 *
 * Run it on stage right after the ATTACK trips the breaker: the vault refuses
 * with "cannot liquidate on frozen price". It is a static call (a simulated
 * transaction), so it costs no gas and changes nothing.
 */
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8")
  );
  const c = dep.contracts;
  const user: string = dep.demoUser;
  const vault = await ethers.getContractAt("CollateralVault", c.vault);
  const aggregator = await ethers.getContractAt("OracleAggregator", c.aggregator);

  const broken = await aggregator.isCircuitBroken(c.bMTB);
  const q = await vault.quoteLiquidation(user);
  // Use the vault's own quote as the slice; fall back to the full debt when it quotes nothing
  // (frozen price / healthy), so the call still exercises the guards.
  const repay = q.maxRepay > 0n ? q.maxRepay : await vault.debt(user);
  console.log("─".repeat(74));
  console.log(`Attempting liquidate(${user}, ${ethers.formatUnits(repay, 6)} mUSDC) on ${network.name}`);
  console.log(`  circuit breaker : ${broken ? "🛑 TRIPPED" : "armed"}`);
  console.log(
    `  quote           : liquidatable=${q.liquidatable} graceLeft=${q.graceSecondsLeft}s ` +
      `maxRepay=${ethers.formatUnits(q.maxRepay, 6)} mUSDC collateralOut=${ethers.formatUnits(q.collateralOut, 18)} ` +
      `bonus=${Number(q.bonusBps) / 100}%`
  );
  try {
    await vault.liquidate.staticCall(user, repay > 0n ? repay : 1n);
    console.log(
      q.liquidatable && q.graceSecondsLeft === 0n
        ? "  result          : ⚠ liquidation would go through"
        : "  result          : call would succeed without seizing (starts or clears the grace flag)"
    );
  } catch (e: any) {
    const reason: string = e?.reason || e?.shortMessage || e?.message || String(e);
    console.log(`  result          : ❌ REVERTED — ${reason}`);
    if (/frozen price/.test(reason)) {
      console.log("                    The manipulated price can't be used to seize this position.");
    }
  }
  console.log("─".repeat(74));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
