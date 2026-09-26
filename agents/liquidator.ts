/**
 * TERRAVAULT — contestant liquidator agent (off-chain)
 * -------------------------------------------------------------------------
 * An outside bot with its own wallet and no protocol role. Every tick it
 * quotes the tracked position and acts only when that is allowed and pays:
 *
 *   quote   → vault.quoteLiquidation(user): liquidatable?, grace seconds left,
 *             maxRepay (the slice the collateral can back at the bonus),
 *             collateral it would receive, bonus; profit at the oracle price
 *   flag    → first liquidate(user, amount) once HF < 1.0: starts the 5-minute
 *             grace period
 *   seize   → after the grace period, repays a slice (maxRepay, or at most
 *             LIQUIDATOR_MAX_REPAY mUSDC for a partial close) and takes
 *             collateral worth slice × (1 + bonus). Debt left once the
 *             collateral is gone is written off against the protocol reserve,
 *             never charged to the liquidator
 *   refresh → if the price recovers while a grace flag is set, calls the
 *             permissionless refreshFlag(user) so a later dip gets a fresh
 *             grace period
 *   verify  → confirms on-chain that the debt fell and bMTB arrived
 *
 * A tripped circuit breaker blocks it like anyone else ("cannot liquidate on
 * frozen price"). Its wallet key comes from LIQUIDATOR_PRIVATE_KEY, or is
 * generated once into deployments/liquidator-wallet.json (gitignored). Gas is
 * topped up from the deployer and mUSDC is minted from the demo token.
 *
 *   npm run liquidator
 */
import * as fs from "fs";
import * as path from "path";
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, parseEther } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const VAULT_ABI = [
  "function liquidate(address user, uint256 repayAmount) external",
  "function quoteLiquidation(address user) view returns (bool liquidatable, uint256 graceSecondsLeft, uint256 maxRepay, uint256 collateralOut, uint256 bonusBps)",
  "function refreshFlag(address user) external returns (bool)",
  "function debt(address user) view returns (uint256)",
  "function collateral(address user, address asset) view returns (uint256)",
  "function collateralAsset(address user) view returns (address)",
  "function unhealthySince(address user) view returns (uint256)",
  "function GRACE_PERIOD() view returns (uint256)",
  "event Liquidated(address indexed user, address indexed liquidator, address indexed asset, uint256 debtRepaid, uint256 collateralSeized, uint256 penaltyBps)",
  "event DebtWrittenOff(address indexed user, address indexed asset, uint256 amount, uint256 coveredByReserve)",
];
const AGG_ABI = [
  "function getAssetOracle(address) view returns (address[],uint256,uint256,bool,uint256,uint256,bool,bool)",
];
const REG_ABI = [
  "function getConfig(address) view returns (tuple(uint8 tier,uint256 maxLtvBps,uint256 liqThresholdBps,uint256 liqPenaltyBps,uint256 debtCeiling,bool isolation,bool enabled))",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
];

const INTERVAL_MS = Number(process.env.LIQUIDATOR_INTERVAL_MS || 5000);
// Optional per-tick slice cap in mUSDC (e.g. "5000") for partial closes; unset = the vault's maxRepay.
const SLICE_CAP = process.env.LIQUIDATOR_MAX_REPAY ? parseUnits(process.env.LIQUIDATOR_MAX_REPAY, 6) : 0n;
const BPS = 10_000n;
const TX = { gasLimit: 500_000 };
const WALLET_FILE = path.join(__dirname, "..", "deployments", "liquidator-wallet.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function send(fn: () => Promise<any>, tries = 5): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      return await (await fn()).wait();
    } catch (e: any) {
      if (e?.receipt || i >= tries - 1) throw e;
      await sleep(2000);
    }
  }
}
const short = (e: unknown): string => {
  const m: string = (e as any)?.reason || (e as any)?.shortMessage || (e as Error)?.message || String(e);
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
};
const usd6 = (x: bigint) => Number(formatUnits(x, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const tok = (x: bigint) => Number(formatUnits(x, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const ts = () => new Date().toISOString().slice(11, 23);
const log = (tag: string, msg: string) => console.log(`[${ts()}] ${tag} ${msg}`);
const normKey = (k: string) => (k.trim().startsWith("0x") ? k.trim() : `0x${k.trim()}`);

function rpcUrl(net: string) {
  if (net === "hashkeyMainnet") return process.env.HASHKEY_MAINNET_RPC || "https://mainnet.hsk.xyz";
  return process.env.HASHKEY_TESTNET_RPC || "https://testnet.hsk.xyz";
}

async function main() {
  const net = process.env.NETWORK || "hashkeyTestnet";
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${net}.json`), "utf8"));
  const c = dep.contracts;
  const user: string = dep.demoUser;
  const provider = new JsonRpcProvider(rpcUrl(net));

  let key = process.env.LIQUIDATOR_PRIVATE_KEY;
  if (!key) {
    if (!fs.existsSync(WALLET_FILE)) {
      fs.writeFileSync(WALLET_FILE, JSON.stringify({ privateKey: Wallet.createRandom().privateKey }, null, 2) + "\n");
    }
    key = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8")).privateKey as string;
  }
  const wallet = new Wallet(normKey(key), provider);
  const funder = process.env.DEPLOYER_PRIVATE_KEY ? new Wallet(normKey(process.env.DEPLOYER_PRIVATE_KEY), provider) : null;

  const vault = new Contract(c.vault, VAULT_ABI, wallet);
  const agg = new Contract(c.aggregator, AGG_ABI, provider);
  const reg = new Contract(c.registry, REG_ABI, provider);
  const mUSDC = new Contract(c.mUSDC, ERC20_ABI, wallet);
  const bMTB = new Contract(c.bMTB, ERC20_ABI, provider);
  const grace = Number(await vault.GRACE_PERIOD());

  console.log("═".repeat(74));
  console.log("TERRAVAULT — Contestant Liquidator Agent (no protocol role)");
  console.log(`  network   : ${net}`);
  console.log(`  liquidator: ${wallet.address}`);
  console.log(`  watching  : ${user}`);
  console.log("═".repeat(74));

  if (funder && (await provider.getBalance(wallet.address)) < parseEther("0.003")) {
    await send(() => funder.sendTransaction({ to: wallet.address, value: parseEther("0.006") }));
    log("SETUP", "topped up gas from the deployer.");
  }

  let lastLine = "";
  let lastAt = 0;
  const say = (tag: string, msg: string, every = 30_000) => {
    const key = tag + msg.replace(/[\d.,]+s left/, "");
    if (key === lastLine && Date.now() - lastAt < every) return;
    lastLine = key;
    lastAt = Date.now();
    log(tag, msg);
  };

  const quote = async () => {
    const asset: string = await vault.collateralAsset(user);
    if (asset === "0x0000000000000000000000000000000000000000") return null;
    const [coll, debt, since, ora, cfg, oq] = await Promise.all([
      vault.collateral(user, asset) as Promise<bigint>,
      vault.debt(user) as Promise<bigint>,
      vault.unhealthySince(user) as Promise<bigint>,
      agg.getAssetOracle(asset),
      reg.getConfig(asset),
      vault.quoteLiquidation(user),
    ]);
    const broken: boolean = ora[3];
    const price: bigint = ora[4];
    const collValue1e8 = (coll * price) / 10n ** 18n;
    const debtValue1e8 = debt * 100n; // 6dp → 1e8, $1 peg
    const hf = debt > 0n ? Number((collValue1e8 * BigInt(cfg.liqThresholdBps) * 1000n) / (BPS * debtValue1e8)) / 1000 : Infinity;

    // The vault's own quote is authoritative: slice cap, collateral out, bonus and grace.
    const bonusBps = BigInt(oq.bonusBps);
    let repay = BigInt(oq.maxRepay);
    let seize = BigInt(oq.collateralOut);
    if (SLICE_CAP > 0n && repay > SLICE_CAP && price > 0n) {
      // Partial close: a smaller slice. Same rounding as the vault for a non-final slice.
      repay = SLICE_CAP;
      seize = (repay * (BPS + bonusBps) * 10n ** 8n * 10n ** 18n) / (BPS * 10n ** 6n * price);
    }
    const seizeValue1e8 = (seize * price) / 10n ** 18n;
    return {
      asset, coll, debt, broken, price, hf, repay, seize,
      liquidatable: Boolean(oq.liquidatable),
      flagged: since > 0n,
      graceLeft: Number(oq.graceSecondsLeft),
      fullCollateral: seize === coll,
      profit1e8: seizeValue1e8 - repay * 100n,
      penaltyPct: Number(bonusBps) / 100,
    };
  };

  const tick = async () => {
    const q = await quote();
    if (!q || q.debt === 0n) return say("· IDLE ", "no open loan to watch.");
    const px = `$${Number(formatUnits(q.price, 8)).toFixed(4)}`;
    const profit = Number(q.profit1e8) / 1e8;
    const repayUsd = Number(formatUnits(q.repay, 6));
    const quoteLine =
      `HF ${q.hf.toFixed(3)} at ${px} · repay ${usd6(q.repay)} of ${usd6(q.debt)} mUSDC · receive ${tok(q.seize)} bMTB ` +
      `· profit ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (${repayUsd > 0 ? ((profit / repayUsd) * 100).toFixed(1) : "0.0"}% effective; ` +
      `${q.penaltyPct}% bonus${q.fullCollateral ? ", slice capped at what the collateral backs; the rest is written off against the reserve" : ""})`;

    if (q.broken) return say("🛑 BLOCK", "price frozen by the circuit breaker: liquidation not allowed.");
    if (!q.liquidatable) {
      // Recovered with a stale grace flag: clear it (permissionless) so a later dip gets a fresh grace period.
      if (q.flagged && (await vault.refreshFlag.staticCall(user))) {
        await send(() => vault.refreshFlag(user, TX));
        return log("✓ CLEAR", `HF ${q.hf.toFixed(3)}: healthy again, stale grace flag cleared via refreshFlag().`);
      }
      return say("· WATCH", `HF ${q.hf.toFixed(3)}: healthy, nothing to liquidate.`);
    }

    if (!q.flagged) {
      say("📋 QUOTE", quoteLine, 0);
      await send(() => vault.liquidate(user, q.repay > 0n ? q.repay : 1n, TX));
      return log("⏳ FLAG ", `liquidatable, grace period started (${grace}s). Borrower can still cure.`);
    }
    if (q.graceLeft > 0) return say("⏳ WAIT ", `grace period, ${q.graceLeft}s left · ${quoteLine}`, 20_000);
    if (q.repay === 0n || q.profit1e8 <= 0n) return say("✗ SKIP ", `nothing profitable to repay: ${quoteLine}`);

    say("📋 QUOTE", quoteLine, 0);
    const bal: bigint = await mUSDC.balanceOf(wallet.address);
    if (bal < q.repay) await send(() => mUSDC.mint(wallet.address, q.repay - bal, TX));
    await send(() => mUSDC.approve(c.vault, q.repay, TX));
    const before: bigint = await bMTB.balanceOf(wallet.address);
    const rc = await send(() => vault.liquidate(user, q.repay, TX));
    const parsed = rc.logs.map((l: any) => { try { return vault.interface.parseLog(l); } catch { return null; } });
    const ev = parsed.find((p: any) => p?.name === "Liquidated");
    const wo = parsed.find((p: any) => p?.name === "DebtWrittenOff");
    await sleep(2500); // let lagging RPC nodes catch up before verifying
    const [debtAfter, after] = await Promise.all([vault.debt(user) as Promise<bigint>, bMTB.balanceOf(wallet.address) as Promise<bigint>]);
    const got = after - before;
    const ok = debtAfter < q.debt && ev && got === ev.args.collateralSeized;
    log(
      ok ? "🔨 SEIZE" : "✗ CHECK",
      `tx ${rc.hash} | repaid ${usd6(ev?.args.debtRepaid ?? 0n)} mUSDC, received ${tok(got)} bMTB ` +
        `(${q.penaltyPct}% bonus) | borrower debt ${usd6(q.debt)} → ${usd6(debtAfter)}` +
        (wo ? ` | ${usd6(wo.args.amount)} remainder written off (${usd6(wo.args.coveredByReserve)} from reserve)` : "") +
        (ok ? " ✓ verified" : " — verification failed")
    );
  };

  const stop = () => {
    console.log("\nLiquidator stopped.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log("WARN ", `tick failed: ${short(e)}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
