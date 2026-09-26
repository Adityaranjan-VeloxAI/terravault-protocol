/**
 * TERRAVAULT — AI Risk Monitor (off-chain agent)
 * -------------------------------------------------------------------------
 * Standalone ethers v6 agent (run with `npm run agent` / ts-node). Polls the
 * tracked user's on-chain health factor every few seconds and acts:
 *
 *   HF >= WARN (1.20)       → healthy, observe only.
 *   ACT <= HF < WARN        → warn: position deteriorating.
 *   1.0 <= HF < ACT (1.10)  → ACT: repay exactly what brings HF back to TARGET
 *                             (1.30): debt − collateralValue × liqThreshold / TARGET,
 *                             in steps capped by the per-action limit, remaining
 *                             buffer, keeper balance and outstanding debt, until
 *                             HF >= TARGET or the buffer is empty.
 *   HF < 1.0                → stand down: the buffer never subsidizes an insolvent
 *                             position; it is left to liquidators.
 *
 * The buffer is a funded facility: each repay is recorded as owed by the user
 * plus a premium, and cumulative use persists in deployments/agent-state.json
 * so a restart cannot refill the cap (`npm run reset` clears it).
 *
 * Safety rails:
 *   • Only ever spends the keeper's OWN buffer — never touches user principal.
 *   • Per-action and cumulative spend caps are hard limits.
 *   • Holds no pause power: running out of buffer never freezes the vault.
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
  "function debt(address user) external view returns (uint256)",
  "function collateral(address user, address asset) external view returns (uint256)",
  "function collateralAsset(address user) external view returns (address)",
];
const REGISTRY_ABI = [
  "function getConfig(address) view returns (tuple(uint8 tier,uint256 maxLtvBps,uint256 liqThresholdBps,uint256 liqPenaltyBps,uint256 debtCeiling,bool isolation,bool enabled))",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];
const AGGREGATOR_ABI = [
  "function isCircuitBroken(address asset) external view returns (bool)",
  "function isSingleSource(address asset) external view returns (bool)",
  "function getPrice(address asset) external view returns (uint256, uint256)",
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
const PREMIUM_BPS = BigInt(process.env.AGENT_PREMIUM_BPS || "100"); // facility premium, 1%
const ONE = parseUnits("1", 18);
const BPS = 10_000n;
const STATE_FILE = path.join(__dirname, "..", "deployments", "agent-state.json");

// Cumulative buffer use and what each user owes the facility, persisted so a
// restart cannot refill the cap.
type AgentState = { spent: string; owed: Record<string, string> };
function loadState(): AgentState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { spent: "0", owed: {} };
  }
}
function saveState(s: AgentState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

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

// Agent and keeper share one key over a load-balanced RPC. A fixed gas limit
// avoids under-estimates from a node that is behind (unused gas is refunded),
// and a send rejected before inclusion (nonce race, stale node) is retried.
// A tx that was mined is never re-sent, so a repay can't land twice.
const TX = { gasLimit: 500_000 };
async function send(fn: () => Promise<any>, tries = 5): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      return await (await fn()).wait();
    } catch (e: any) {
      if (e?.receipt || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
const short = (e: unknown): string => {
  const m: string = (e as any)?.shortMessage || (e as Error)?.message || String(e);
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
};

function rpcUrl(net: string): string {
  if (net === "hashkeyMainnet") {
    return process.env.HASHKEY_MAINNET_RPC || "https://mainnet.hsk.xyz";
  }
  return process.env.HASHKEY_TESTNET_RPC || "https://testnet.hsk.xyz";
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
  // Accept a 64-hex key with or without 0x (MetaMask exports it without).
  if (!pk || !/^(0x)?[0-9a-fA-F]{64}$/.test(pk.trim())) {
    throw new Error("KEEPER_PRIVATE_KEY is missing or malformed in .env");
  }
  const provider = new JsonRpcProvider(rpcUrl(net));
  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);

  const riskEngine = new Contract(c.riskEngine, RISK_ENGINE_ABI, wallet);
  const vault = new Contract(c.vault, VAULT_ABI, wallet);
  const mUSDC = new Contract(c.mUSDC, ERC20_ABI, wallet);
  const aggregator = new Contract(c.aggregator, AGGREGATOR_ABI, wallet);
  const registry = new Contract(c.registry, REGISTRY_ABI, wallet);

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

  // repayFor pulls the buffer from this wallet, so the vault needs an allowance.
  // Checked at startup and again before every repay, so an approval that fails
  // (e.g. a nonce race with the keeper) heals itself instead of breaking repays.
  const ensureAllowance = async () => {
    const allowance: bigint = await mUSDC.allowance(wallet.address, c.vault);
    if (allowance >= BUFFER_CAP) return;
    log("SETUP", "approving vault to spend keeper buffer (mUSDC)…");
    await send(() => mUSDC.approve(c.vault, MaxUint256, TX));
    log("SETUP", "approval confirmed.");
  };
  try {
    await ensureAllowance();
  } catch (e) {
    log("SETUP", `⚠ allowance not set yet (${short(e)}); will retry before the first repay.`);
  }

  const state = loadState();
  log("SETUP", `facility used ${formatUnits(BigInt(state.spent), 6)}/${formatUnits(BUFFER_CAP, 6)} mUSDC (persisted).`);

  // Exact repay that brings HF to TARGET: debt − collateralValue × liqThreshold / TARGET.
  const repayToTarget = async (): Promise<{ debt: bigint; need: bigint }> => {
    const asset: string = await vault.collateralAsset(user);
    const [coll, debt, [price], cfg] = await Promise.all([
      vault.collateral(user, asset) as Promise<bigint>,
      vault.debt(user) as Promise<bigint>,
      aggregator.getPrice(asset) as Promise<[bigint, bigint]>,
      registry.getConfig(asset),
    ]);
    const collValue1e8 = (coll * price) / 10n ** 18n;
    const weighted1e8 = (collValue1e8 * BigInt(cfg.liqThresholdBps)) / BPS;
    const targetDebt = (weighted1e8 * ONE) / TARGET_HF / 100n; // 1e8 USD → 6dp mUSDC ($1 peg)
    return { debt, need: debt > targetDebt ? debt - targetDebt : 0n };
  };

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
      log("WARN", `health factor unreadable (${short(e)}): price stale or frozen, skipping tick.`);
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

    // --- HF < 1.0: insolvent, not ours to subsidize --------------------
    if (currentHf < ONE) {
      log(
        "⛔ HOLD ",
        `HF ${hf(currentHf)} is below 1.0 — not subsidizing an insolvent position. Left to liquidators.`
      );
      return;
    }

    // --- 1.0 <= HF < ACT: repay exactly back to TARGET -------------------
    let first = true;
    let newHf = currentHf;
    try {
      await ensureAllowance();
      const { need } = await repayToTarget();
      log(
        "🚨 ACT ",
        `HF ${hf(currentHf)} below act ${hf(ACT_HF)} — ${formatUnits(need, 6)} mUSDC restores ${hf(TARGET_HF)}.${sourceNote}`
      );
      while (newHf < TARGET_HF && newHf >= ONE) {
        const { debt, need: left } = await repayToTarget();
        const spent = BigInt(state.spent);
        const keeperBal: bigint = await mUSDC.balanceOf(wallet.address);
        let amount = left;
        if (amount > MAX_REPAY_PER_ACTION) amount = MAX_REPAY_PER_ACTION;
        if (amount > BUFFER_CAP - spent) amount = BUFFER_CAP - spent;
        if (amount > keeperBal) amount = keeperBal;
        if (amount > debt) amount = debt;
        if (amount <= 0n) {
          log("⛔ HOLD ", `facility exhausted at HF ${hf(newHf)}; if it falls below 1.0, liquidators take over.`);
          return;
        }
        const before = newHf;
        const txr = await send(() => vault.repayFor(user, amount, TX));
        state.spent = (spent + amount).toString();
        const owed = BigInt(state.owed[user] || "0") + (amount * (BPS + PREMIUM_BPS)) / BPS;
        state.owed[user] = owed.toString();
        saveState(state);
        // A read right after the write can hit a node one block behind; wait for the new HF.
        for (let i = 0; i < 4 && newHf === before; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          newHf = await riskEngine.getHealthFactor(user);
        }
        log(
          "✓ REPAY",
          `tx ${txr?.hash ?? ""} | ${formatUnits(amount, 6)} mUSDC | HF ${hf(before)} → ${hf(newHf)} | ` +
            `facility ${formatUnits(BigInt(state.spent), 6)}/${formatUnits(BUFFER_CAP, 6)}, user owes ${formatUnits(owed, 6)} incl. ${Number(PREMIUM_BPS) / 100}% premium`
        );
        first = false;
      }
      if (!first && newHf >= TARGET_HF) {
        log("✓ DONE ", `HF ${hf(newHf)} is at or above target ${hf(TARGET_HF)}. Standing down.`);
      }
    } catch (e) {
      log("✗ REPAY", `repay failed: ${short(e)}`);
    }
  };

  const stop = () => {
    console.log("\nRisk monitor stopped.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Sequential loop, not setInterval: if a repay tick outlasts the interval, an
  // overlapping tick could decide to repay again before the first one lands.
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log("WARN", `tick failed: ${short(e)}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
