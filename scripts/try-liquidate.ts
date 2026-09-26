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
  console.log("─".repeat(74));
  console.log(`Attempting liquidate(${user}) on ${network.name}`);
  console.log(`  circuit breaker : ${broken ? "🛑 TRIPPED" : "armed"}`);
  try {
    await vault.liquidate.staticCall(user);
    console.log("  result          : ⚠ liquidation would go through");
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
