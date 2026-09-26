/**
 * TERRAVAULT — AI Risk Monitor (off-chain agent)
 * -------------------------------------------------------------------------
 * Standalone ethers v6 agent (run with `npm run agent` / ts-node). Polls the
 * tracked user's on-chain health factor every few seconds and acts:
 *
 *   HF >= WARN (1.20)   → healthy, observe only.
 *   ACT <= HF < WARN    → warn: position deteriorating, arm the buffer.
 *   HF < ACT  (1.10)    → ACT: repay from a CAPPED keeper buffer
 *                         (<= 2000 mUSDC per action, total <= buffer cap) to
 *                         push HF back toward TARGET. Emits real repay txs.
 *   buffer exhausted &   → ESCALATE: pause new borrows on the vault and alert
 *   still unhealthy         (human intervention required).
 *
 * Safety rails that make this a "responsible" agent:
 *   • Only ever spends the keeper's OWN buffer — never touches user principal.
 *   • Per-action and cumulative spend caps are hard limits.
 *   • If the oracle circuit breaker is tripped for the collateral, the agent
 *     REFUSES to act: the manipulated price is rejected on-chain, the user is
 *     already protected, and repaying on a fake price would be wrong.
 *   Legit declines (feeds agree) are handled; manipulation is left to the breaker.
 */

import * as fs from "fs";
import * as path from "path";
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseUnits,
  formatUnits,
  MaxUint256,
} from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

// --- Minimal ABIs --------------------------------------------------------
const RISK_ENGINE_ABI = [
  "function getHealthFactor(address user) external view returns (uint256)",
  "function isLiquidatable(address user) external view returns (bool)",
];
const VAULT_ABI = [
  "function repayFor(address user, uint256 amount) external",
  "function debtOf(address user) external view returns (uint256)",
  "function pause() external",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];
const AGGREGATOR_ABI = [
  "function isCircuitBroken(address asset) external view returns (bool)",
  "function isSingleSource(address asset) external view returns (bool)",
];

// --- Config --------------------------------------------------------------
const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MS || 5000);
const WARN_HF = parseUnits(process.env.AGENT_WARN_HF || "1.20", 18);
const ACT_HF = parseUnits(process.env.AGENT_ACT_HF || "1.10", 18);
const TARGET_HF = parseUnits(process.env.AGENT_TARGET_HF || "1.30", 18);
const MAX_REPAY_PER_ACTION = parseUnits(
  process.env.AGENT_MAX_REPAY_PER_ACTION || "2000",
  6
); // mUSDC 6dp
const BUFFER_CAP = parseUnits(process.env.AGENT_BUFFER_CAP || "10000", 6);
const ONE = parseUnits("1", 18);

function loadDeployment() {
  const explicit = process.env.DEPLOYMENTS_FILE;
  const net = process.env.NETWORK || "hashkeyTestnet";
  const byNet = path.join(__dirname, "..", "deployments", `${net}.json`);
  const latest = path.join(__dirname, "..", "deployments", "latest.json");
  const file = explicit || (fs.existsSync(byNet) ? byNet : latest);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment file (looked at ${byNet}, ${latest}). Run: npm run deploy`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function rpcUrl(net: string): string {
  if (net === "hashkeyMainnet") {
    return process.env.HASHKEY_MAINNET_RPC || "https://mainnet.hsk.xyz";
  }
  return process.env.HASHKEY_TESTNET_RPC || "https://hashkey-testnet.drpc.org";
}

function hf(x: bigint): string {
  if (x === MaxUint256) return "∞ (no debt)";
  return Number(formatUnits(x, 18)).toFixed(3);
}
function ts(): string {
  return new Date().toISOString().split("T")[1].replace("Z", "");
}
function log(prefix: string, msg: string) {
  console.log(`[${ts()}] ${prefix} ${msg}`);
}

async function main() {
  const dep = loadDeployment();
  const c = dep.contracts;
  const net = dep.network || process.env.NETWORK || "hashkeyTestnet";
  const user = dep.demoUser as string;

  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk || !/^0x?[0-9a-fA-F]{64}$/.test(pk.replace(/^0x/, "0x"))) {
    throw new Error("KEEPER_PRIVATE_KEY is missing or malformed in .env");
  }
  const provider = new JsonRpcProvider(rpcUrl(net));
  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);

  const riskEngine = new Contract(c.riskEngine, RISK_ENGINE_ABI, wallet);
  const vault = new Contract(c.vault, VAULT_ABI, wallet);
  const mUSDC = new Contract(c.mUSDC, ERC20_ABI, wallet);
  const aggregator = new Contract(c.aggregator, AGGREGATOR_ABI, wallet);

  console.log("═".repeat(74));
  console.log("TERRAVAULT — AI Risk Monitor");
  console.log(`  network      : ${net} (chainId ${dep.chainId})`);
  console.log(`  tracked user : ${user}`);
  console.log(`  keeper       : ${wallet.address}`);
  console.log(
    `  thresholds   : warn ${hf(WARN_HF)}  act ${hf(ACT_HF)}  target ${hf(TARGET_HF)}`
  );
  console.log(
    `  buffer       : cap ${formatUnits(BUFFER_CAP, 6)} mUSDC | max/action ${formatUnits(
      MAX_REPAY_PER_ACTION,
      6
    )} mUSDC`
  );
  console.log("═".repeat(74));

  // Ensure the vault can pull the buffer for repayFor.
  try {
    const allowance: bigint = await mUSDC.allowance(wallet.address, c.vault);
    if (allowance < BUFFER_CAP) {
      log("SETUP", "approving vault to spend keeper buffer (mUSDC)…");
      await (await mUSDC.approve(c.vault, MaxUint256)).wait();
      log("SETUP", "approval confirmed.");
    }
  } catch (e) {
    log("SETUP", `⚠ could not set allowance: ${(e as Error).message}`);
  }

  let spent = 0n; // cumulative mUSDC deployed from the buffer
  let paused = false;

  const tick = async () => {
    // Is the collateral oracle frozen by the circuit breaker?
    let broken = false;
    let single = false;
    try {
      broken = await aggregator.isCircuitBroken(c.bMTB);
      single = await aggregator.isSingleSource(c.bMTB);
    } catch {
      /* ignore */
    }

    if (broken) {
      // Manipulation was rejected on-chain. Do NOT act on a fake price.
      log(
        "🛡 GUARD",
        "bMTB circuit breaker TRIPPED — manipulated feed rejected on-chain. " +
          "User protected by the breaker; agent standing down (no repay on a frozen price)."
      );
      return;
    }

    let currentHf: bigint;
    try {
      currentHf = await riskEngine.getHealthFactor(user);
    } catch (e) {
      log("WARN", `getHealthFactor reverted (${(e as Error).message}). Skipping tick.`);
      return;
    }

    const sourceNote = single ? " [single-source: LTV capped]" : "";

    if (currentHf >= WARN_HF) {
      log("✓ OK", `HF ${hf(currentHf)} — healthy.${sourceNote}`);
      return;
    }

    if (currentHf >= ACT_HF) {
      log(
        "⚠ WARN",
        `HF ${hf(currentHf)} below warn ${hf(WARN_HF)} — arming buffer, watching closely.${sourceNote}`
      );
      return;
    }

    // --- HF < ACT: intervene -------------------------------------------
    log("🚨 ACT ", `HF ${hf(currentHf)} below act ${hf(ACT_HF)} — intervening.${sourceNote}`);

    const remainingBuffer = BUFFER_CAP - spent;
    if (remainingBuffer <= 0n) {
      return escalate(currentHf);
    }

    // Buffer is also bounded by the keeper's actual mUSDC balance.
    let keeperBal = 0n;
    try {
      keeperBal = await mUSDC.balanceOf(wallet.address);
    } catch {
      /* ignore */
    }

    // Optionally size to outstanding debt so we never over-repay.
    let debt: bigint = MaxUint256;
    try {
      debt = await vault.debtOf(user);
    } catch {
      /* debtOf optional */
    }

    let amount = MAX_REPAY_PER_ACTION;
    if (amount > remainingBuffer) amount = remainingBuffer;
    if (amount > keeperBal) amount = keeperBal;
    if (debt !== MaxUint256 && amount > debt) amount = debt;

    if (amount <= 0n) {
      log("🚨 ACT ", "buffer/balance exhausted before any repay was possible.");
      return escalate(currentHf);
    }

    try {
      log("→ REPAY", `repaying ${formatUnits(amount, 6)} mUSDC on behalf of user from buffer…`);
      const txr = await (await vault.repayFor(user, amount)).wait();
      spent += amount;
      const newHf: bigint = await riskEngine.getHealthFactor(user);
      log(
        "✓ REPAY",
        `tx ${txr?.hash ?? ""} | HF ${hf(currentHf)} → ${hf(newHf)} | ` +
          `buffer used ${formatUnits(spent, 6)}/${formatUnits(BUFFER_CAP, 6)} mUSDC`
      );
      if (newHf >= TARGET_HF) {
        log("✓ DONE ", `HF restored above target ${hf(TARGET_HF)}. Standing down.`);
      } else if (BUFFER_CAP - spent <= 0n && newHf < ACT_HF) {
        await escalate(newHf);
      }
    } catch (e) {
      log("✗ REPAY", `repay failed: ${(e as Error).message}`);
    }
  };

  const escalate = async (currentHf: bigint) => {
    if (paused) {
      log("🚨 ESCALATE", `still unhealthy (HF ${hf(currentHf)}); borrows already paused. ALERT ops.`);
      return;
    }
    log(
      "🚨 ESCALATE",
      `buffer exhausted and HF ${hf(currentHf)} still critical — pausing new borrows and alerting ops.`
    );
    try {
      await (await vault.pause()).wait();
      paused = true;
      log("🚨 ESCALATE", "vault borrows PAUSED (PAUSER_ROLE). Human intervention required.");
    } catch (e) {
      log("🚨 ESCALATE", `could not pause vault (need PAUSER_ROLE?): ${(e as Error).message}`);
    }
  };

  await tick();
  const timer = setInterval(tick, INTERVAL_MS);
  const stop = () => {
    clearInterval(timer);
    console.log("\nRisk monitor stopped.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
