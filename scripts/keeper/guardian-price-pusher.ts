/**
 * TERRAVAULT — Guardian Price Pusher (keeper)
 * -------------------------------------------------------------------------
 * Standalone ethers v6 script (run with `npm run keeper` / ts-node). Runs
 * continuously during the demo. Every interval it:
 *   1. reads a live control file (so the demo driver can stage scenarios),
 *   2. pushes the reference price into each GuardianOracleAdapter,
 *   3. calls OracleAggregator.poke(asset) to run the deviation/staleness logic,
 *   4. prints the resulting aggregator state (price, singleSource, breaker).
 *
 * Signs with KEEPER_PRIVATE_KEY, which holds GUARDIAN_ROLE on both adapters
 * and the aggregator (granted in deploy.ts) — never owner god-mode.
 *
 * Control file (JSON, hot-reloaded each tick; all fields optional):
 *   {
 *     "bMTB":  { "priceA": 1.02, "priceB": 1.02, "skipA": false, "skipB": false },
 *     "mUSDC": { "priceA": 1.00, "priceB": 1.00 }
 *   }
 * Staged scenarios:
 *   • ATTACK  — set bMTB.priceB = 0.612 (a -40% single-feed manipulation).
 *               poke() sees ~3900bps > 500bps => trips the breaker, keeps last-good.
 *   • DECLINE — set BOTH bMTB.priceA & priceB = 0.90 (feeds agree) => accepted.
 *   • STALE   — set bMTB.skipB = true => adapterB stops updating => after
 *               maxStaleness the aggregator falls to a single source.
 */

import * as fs from "fs";
import * as path from "path";
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

// --- Minimal ABIs --------------------------------------------------------
const ADAPTER_ABI = [
  "function updatePrice(address asset, uint256 price) external",
  "function getPrice(address asset) external view returns (uint256, uint256)",
];
const AGGREGATOR_ABI = [
  "function poke(address asset) external",
  "function getPrice(address asset) external view returns (uint256, uint256)",
  "function isSingleSource(address asset) external view returns (bool)",
  "function isCircuitBroken(address asset) external view returns (bool)",
];

const PRICE_DP = 8;
const INTERVAL_MS = Number(process.env.PUSHER_INTERVAL_MS || 8000);
const CONTROL_FILE =
  process.env.PUSHER_CONTROL_FILE ||
  path.join(__dirname, "demo-control.json");

type AssetControl = {
  priceA?: number;
  priceB?: number;
  skipA?: boolean;
  skipB?: boolean;
};

function loadDeployment() {
  const explicit = process.env.DEPLOYMENTS_FILE;
  const net = process.env.NETWORK || "hashkeyTestnet";
  const byNet = path.join(__dirname, "..", "..", "deployments", `${net}.json`);
  const latest = path.join(__dirname, "..", "..", "deployments", "latest.json");
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

// Defaults reproduce the calm baseline: bMTB $1.02, mUSDC $1.00, both feeds.
function loadControl(): Record<string, AssetControl> {
  const base: Record<string, AssetControl> = {
    bMTB: { priceA: 1.02, priceB: 1.02, skipA: false, skipB: false },
    mUSDC: { priceA: 1.0, priceB: 1.0, skipA: false, skipB: false },
  };
  try {
    if (fs.existsSync(CONTROL_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
      for (const k of Object.keys(base)) {
        base[k] = { ...base[k], ...(parsed[k] || {}) };
      }
    }
  } catch (e) {
    console.warn(`  ⚠ could not parse control file, using defaults: ${(e as Error).message}`);
  }
  return base;
}

function ts(): string {
  return new Date().toISOString().split("T")[1].replace("Z", "");
}

async function main() {
  const dep = loadDeployment();
  const c = dep.contracts;
  const net = dep.network || process.env.NETWORK || "hashkeyTestnet";

  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk || !/^0x?[0-9a-fA-F]{64}$/.test(pk.replace(/^0x/, "0x"))) {
    throw new Error("KEEPER_PRIVATE_KEY is missing or malformed in .env");
  }
  const provider = new JsonRpcProvider(rpcUrl(net));
  const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);

  const adapterA = new Contract(c.adapterA, ADAPTER_ABI, wallet);
  const adapterB = new Contract(c.adapterB, ADAPTER_ABI, wallet);
  const aggregator = new Contract(c.aggregator, AGGREGATOR_ABI, wallet);

  const assets: { name: string; addr: string }[] = [
    { name: "bMTB", addr: c.bMTB },
    { name: "mUSDC", addr: c.mUSDC },
  ];

  console.log("═".repeat(74));
  console.log("TERRAVAULT — Guardian Price Pusher");
  console.log(`  network : ${net} (chainId ${dep.chainId})`);
  console.log(`  keeper  : ${wallet.address}`);
  console.log(`  interval: ${INTERVAL_MS}ms   control: ${CONTROL_FILE}`);
  console.log("═".repeat(74));

  let tick = 0;
  const run = async () => {
    tick++;
    const ctrl = loadControl();
    for (const { name, addr } of assets) {
      const cc = ctrl[name] || {};
      const pA = parseUnits(String(cc.priceA ?? 1), PRICE_DP);
      const pB = parseUnits(String(cc.priceB ?? 1), PRICE_DP);
      try {
        // 1) push into each adapter (unless skipped so it can go stale)
        if (!cc.skipA) await (await adapterA.updatePrice(addr, pA)).wait();
        if (!cc.skipB) await (await adapterB.updatePrice(addr, pB)).wait();

        // 2) run aggregator logic
        await (await aggregator.poke(addr)).wait();

        // 3) read resulting state
        const broken: boolean = await aggregator.isCircuitBroken(addr);
        const single: boolean = await aggregator.isSingleSource(addr);
        let priceStr = "—";
        try {
          const [px] = await aggregator.getPrice(addr);
          priceStr = `$${formatUnits(px, 8)}`;
        } catch {
          priceStr = "(reverts — frozen)";
        }

        const feeds = `A=${cc.skipA ? "·" : "$" + formatUnits(pA, 8)} B=${
          cc.skipB ? "·" : "$" + formatUnits(pB, 8)
        }`;
        let flag = "OK";
        if (broken) flag = "🛑 CIRCUIT BROKEN (manipulation rejected, last-good retained)";
        else if (single) flag = "⚠ SINGLE-SOURCE (LTV capped to tier-3 floor)";

        console.log(
          `[${ts()}] #${tick} ${name.padEnd(5)} feeds ${feeds.padEnd(28)} agg ${priceStr.padEnd(
            22
          )} ${flag}`
        );
      } catch (e) {
        console.error(`[${ts()}] #${tick} ${name} push/poke failed: ${(e as Error).message}`);
      }
    }
  };

  await run();
  const timer = setInterval(run, INTERVAL_MS);
  const stop = () => {
    clearInterval(timer);
    console.log("\nPusher stopped.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
