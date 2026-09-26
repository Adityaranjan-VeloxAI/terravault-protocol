import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * TERRAVAULT — END-TO-END DEMO FLOW (the live 3-minute demo, as an executable script).
 *
 * The it() blocks run in order and share state, so the Mocha log reads top-to-bottom
 * as the exact demo narrative:
 *   1) Onboard bMTB as a Tier-1 RWA.
 *   2) Deposit 50,000 bMTB ($51,000) and borrow 34,000 mUSDC  => HF ~1.275.
 *   3) ATTACK: a guardian pushes a -40% price. The aggregator sees the deviation,
 *      trips the breaker, holds the last-good price. borrow() and liquidate() revert.
 *      The user is NOT liquidated on a fake price. (Headline security property.)
 *   4) DECLINE: both feeds fall together (they agree) => accepted => HF < 1.10 =>
 *      a simulated risk-monitor agent repays from a capped keeper buffer to restore HF.
 *   5) STALE: one feed stops updating => single-source => effective LTV capped to 4500 bps.
 *
 * SCALING (used consistently):
 *   prices 1e8 | bps 1e4 (100%) | health factor 1e18 | bMTB 18dp | mUSDC 6dp
 *
 * Convention assumptions beyond the pinned external interfaces:
 *   - Constructors: mocks/adapters/aggregator take no args and grant admin+guardian roles
 *     to the deployer. AssetQualityRegistry(aggregator). RiskEngine(registry, aggregator,
 *     mUSDC) with a setVault(vault). CollateralVault(riskEngine, registry, aggregator, mUSDC).
 *   - The vault exposes its per-user state as public mappings:
 *       debt(address user) -> uint256                       (mUSDC, 6dp)
 *       collateral(address user, address asset) -> uint256  (18dp)
 *   - The mUSDC borrow asset is valued at $1 par by the RiskEngine (a stablecoin),
 *     so it is not routed through the aggregator. bMTB (collateral) always is.
 *   - repay(uint256) reduces msg.sender's debt; the agent funds the user from its
 *     capped keeper buffer, then the user repays — honoring the pinned repay(uint256).
 *   Reverts are asserted with `.to.be.reverted` so a custom error or a require-string
 *   for the same guard both satisfy the test.
 */

const P = (v: string) => ethers.parseUnits(v, 8); // 1e8 price
const RWA = (v: string) => ethers.parseUnits(v, 18); // bMTB, 18dp
const USD6 = (v: string) => ethers.parseUnits(v, 6); // mUSDC, 6dp
const WAD = (v: string) => ethers.parseUnits(v, 18); // 1e18 health factor

// Health factors involve integer division on-chain; assert within a small bps band.
function hfCloseTo(actual: bigint, expected: bigint, tolBps = 50n): boolean {
  const tol = (expected * tolBps) / 10000n;
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff <= tol;
}

describe("Terravault — E2E live demo flow", () => {
  let admin: any, user: any, keeper: any, liquidator: any;

  let bMTB: any, mUSDC: any;
  let adapterA: any, adapterB: any;
  let aggregator: any, registry: any, risk: any, vault: any;

  let bMTBAddr: string, mUSDCAddr: string;
  let adapterAAddr: string, adapterBAddr: string, vaultAddr: string;

  const MAX_STALENESS = 3600; // 1h
  const MAX_DEVIATION_BPS = 500; // 5%

  before(async () => {
    [admin, user, keeper, liquidator] = await ethers.getSigners();

    // --- Tokens ---
    const RWAFactory = await ethers.getContractFactory("MockRWAToken");
    bMTB = await RWAFactory.deploy();
    await bMTB.waitForDeployment();
    const USDCFactory = await ethers.getContractFactory("MockUSDC");
    mUSDC = await USDCFactory.deploy();
    await mUSDC.waitForDeployment();

    // --- Oracle stack: two independent guardian-pushed adapters + aggregator ---
    const Guardian = await ethers.getContractFactory("GuardianOracleAdapter");
    adapterA = await Guardian.deploy();
    await adapterA.waitForDeployment();
    adapterB = await Guardian.deploy();
    await adapterB.waitForDeployment();

    const Agg = await ethers.getContractFactory("OracleAggregator");
    aggregator = await Agg.deploy();
    await aggregator.waitForDeployment();

    // --- Risk stack ---
    const Registry = await ethers.getContractFactory("AssetQualityRegistry");
    registry = await Registry.deploy(await aggregator.getAddress());
    await registry.waitForDeployment();

    const Risk = await ethers.getContractFactory("RiskEngine");
    risk = await Risk.deploy(
      await registry.getAddress(),
      await aggregator.getAddress(),
      await mUSDC.getAddress()
    );
    await risk.waitForDeployment();

    const Vault = await ethers.getContractFactory("CollateralVault");
    vault = await Vault.deploy(
      await risk.getAddress(),
      await registry.getAddress(),
      await aggregator.getAddress(),
      await mUSDC.getAddress()
    );
    await vault.waitForDeployment();

    // RiskEngine reads live collateral/debt from the vault (break the deploy cycle).
    await risk.setVault(await vault.getAddress());

    bMTBAddr = await bMTB.getAddress();
    mUSDCAddr = await mUSDC.getAddress();
    adapterAAddr = await adapterA.getAddress();
    adapterBAddr = await adapterB.getAddress();
    vaultAddr = await vault.getAddress();

    // --- Fund the world ---
    await bMTB.mint(user.address, RWA("50000")); // the borrower's RWA collateral
    // Fund the lending pool through fundPool() so the vault's poolLiquidity counter is tracked.
    await mUSDC.mint(admin.address, USD6("1000000"));
    await mUSDC.approve(vaultAddr, USD6("1000000"));
    await vault.fundPool(USD6("1000000")); // the lending pool liquidity
    await mUSDC.mint(keeper.address, USD6("10000")); // the agent's capped keeper buffer
  });

  describe("1) ONBOARDING — bMTB becomes a Tier-1 RWA", () => {
    it("registers bMTB (Tier 1: maxLtv 80%, liqThreshold 85%, penalty 5%)", async () => {
      await registry.setAsset(bMTBAddr, {
        tier: 1,
        maxLtvBps: 8000,
        liqThresholdBps: 8500,
        liqPenaltyBps: 500,
        debtCeiling: USD6("100000000"),
        isolation: false,
        enabled: true,
      });

      const cfg = await registry.getConfig(bMTBAddr);
      expect(cfg.tier).to.equal(1);
      expect(cfg.maxLtvBps).to.equal(8000n);
      expect(cfg.liqThresholdBps).to.equal(8500n);
      expect(cfg.liqPenaltyBps).to.equal(500n);
      expect(cfg.enabled).to.equal(true);
    });

    it("prices bMTB at $1.02 through the two-source aggregator (full LTV, not single-source)", async () => {
      await aggregator.configureAsset(
        bMTBAddr,
        [adapterAAddr, adapterBAddr],
        MAX_STALENESS,
        MAX_DEVIATION_BPS
      );
      await adapterA.updatePrice(bMTBAddr, P("1.02"));
      await adapterB.updatePrice(bMTBAddr, P("1.02"));
      await aggregator.poke(bMTBAddr);

      const [px] = await aggregator.getPrice(bMTBAddr);
      expect(px).to.equal(P("1.02"));
      expect(await aggregator.isSingleSource(bMTBAddr)).to.equal(false);
      // Two healthy sources => the registry grants the full 8000 bps LTV.
      expect(await registry.effectiveMaxLtv(bMTBAddr)).to.equal(8000n);
    });
  });

  describe("2) DEPOSIT & BORROW — HF lands at ~1.275", () => {
    it("user deposits 50,000 bMTB ($51,000 of collateral value)", async () => {
      await bMTB.connect(user).approve(vaultAddr, RWA("50000"));
      await expect(vault.connect(user).deposit(bMTBAddr, RWA("50000")))
        .to.emit(vault, "Deposit");

      expect(await vault.collateral(user.address, bMTBAddr)).to.equal(RWA("50000"));
    });

    it("user borrows 34,000 mUSDC and health factor settles at ~1.275", async () => {
      await expect(vault.connect(user).borrow(USD6("34000"))).to.emit(vault, "Borrow");
      expect(await vault.debt(user.address)).to.equal(USD6("34000"));

      const hf = await risk.getHealthFactor(user.address);
      console.log(`      HF after borrow = ${ethers.formatUnits(hf, 18)} (target 1.275)`);
      // (51000 * 0.85) / 34000 = 1.275
      expect(hfCloseTo(hf, WAD("1.275"))).to.equal(true);
      expect(await risk.isLiquidatable(user.address)).to.equal(false);
    });
  });

  describe("3) ATTACK — price manipulation is detected and blocked", () => {
    it("a guardian pushes bMTB down -40% to $0.612 on one feed", async () => {
      // The other feed (adapterB) still honestly reports $1.02.
      await adapterA.updatePrice(bMTBAddr, P("0.612"));
      const [reported] = await adapterA.getPrice(bMTBAddr);
      expect(reported).to.equal(P("0.612"));
    });

    it("poke() sees the ~3900+ bps deviation, trips the breaker, and does NOT adopt the fake price", async () => {
      await expect(aggregator.poke(bMTBAddr))
        .to.emit(aggregator, "CircuitBreakerTripped")
        .withArgs(bMTBAddr, anyValue);

      expect(await aggregator.isCircuitBroken(bMTBAddr)).to.equal(true);
      // Frozen: the aggregator refuses to serve any price while under review.
      await expect(aggregator.getPrice(bMTBAddr)).to.be.reverted;
    });

    it("RiskEngine reports borrowing as disallowed while the breaker is tripped", async () => {
      const [allowed, reason] = await risk.isBorrowAllowed(user.address, bMTBAddr, USD6("1"));
      expect(allowed).to.equal(false);
      console.log(`      Borrow gate says: "${reason}"`);
    });

    it("borrow() reverts on the frozen asset", async () => {
      await expect(vault.connect(user).borrow(USD6("1"))).to.be.reverted;
    });

    it("liquidate() reverts — nobody can seize the position on a frozen/fake price", async () => {
      await expect(
        vault.connect(liquidator).liquidate(user.address, USD6("34000"))
      ).to.be.revertedWith("cannot liquidate on frozen price");
    });

    it("the user's position is fully intact — 34,000 debt, 50,000 collateral, NOT liquidated", async () => {
      expect(await vault.debt(user.address)).to.equal(USD6("34000"));
      expect(await vault.collateral(user.address, bMTBAddr)).to.equal(RWA("50000"));
    });

    it("guardian clears the breaker after review; the retained last-good price is still $1.02", async () => {
      await aggregator.clearBreaker(bMTBAddr);
      expect(await aggregator.isCircuitBroken(bMTBAddr)).to.equal(false);

      const [restored] = await aggregator.getPrice(bMTBAddr);
      expect(restored).to.equal(P("1.02")); // never the poisoned $0.612
    });
  });

  describe("4) DECLINE — a genuine, agreeing drop is accepted; the agent heals the position", () => {
    it("both feeds fall together to $0.85 (they agree) => accepted, no breaker", async () => {
      await adapterA.updatePrice(bMTBAddr, P("0.85"));
      await adapterB.updatePrice(bMTBAddr, P("0.85"));

      await expect(aggregator.poke(bMTBAddr)).to.emit(aggregator, "PricePoked");
      expect(await aggregator.isCircuitBroken(bMTBAddr)).to.equal(false);

      const [px] = await aggregator.getPrice(bMTBAddr);
      expect(px).to.equal(P("0.85")); // legit moves ARE allowed; only manipulation is blocked
    });

    it("health factor drops below 1.10 but the user is still solvent (not yet liquidatable)", async () => {
      const hf = await risk.getHealthFactor(user.address);
      console.log(`      HF after honest decline = ${ethers.formatUnits(hf, 18)} (≈1.0625)`);
      // (50000 * 0.85 * 0.85) / 34000 = 1.0625
      expect(hf < WAD("1.10")).to.equal(true);
      expect(hf > WAD("1.0")).to.equal(true);
      expect(await risk.isLiquidatable(user.address)).to.equal(false);
    });

    it("the risk-monitor agent repays 2,000 mUSDC from its capped keeper buffer, restoring HF > 1.10", async () => {
      const bufferAction = USD6("2000"); // <= 2000 mUSDC/action cap; cannot touch principal

      // Agent moves buffer funds to the tracked user, then repays that user's debt.
      await mUSDC.connect(keeper).transfer(user.address, bufferAction);
      await mUSDC.connect(user).approve(vaultAddr, bufferAction);
      await expect(vault.connect(user).repay(bufferAction)).to.emit(vault, "Repay");

      expect(await vault.debt(user.address)).to.equal(USD6("32000"));
      const hf = await risk.getHealthFactor(user.address);
      console.log(`      HF after agent repay = ${ethers.formatUnits(hf, 18)} (target > 1.10)`);
      // (50000 * 0.85 * 0.85) / 32000 = 1.1289
      expect(hf > WAD("1.10")).to.equal(true);
    });
  });

  describe("5) STALE — one dead feed forces single-source and caps effective LTV to 4500 bps", () => {
    it("one adapter stops updating past maxStaleness => aggregator falls to single-source", async () => {
      await time.increase(MAX_STALENESS + 1); // both feeds now look stale...
      await adapterA.updatePrice(bMTBAddr, P("0.85")); // ...but only adapterA revives

      await expect(aggregator.poke(bMTBAddr))
        .to.emit(aggregator, "PricePoked")
        .withArgs(bMTBAddr, P("0.85"), true);

      expect(await aggregator.isSingleSource(bMTBAddr)).to.equal(true);
    });

    it("AssetQualityRegistry caps effective LTV to the tier-3 floor (4500 bps) despite the 8000 config", async () => {
      const cfg = await registry.getConfig(bMTBAddr);
      expect(cfg.maxLtvBps).to.equal(8000n); // configured ceiling unchanged...
      // ...but with only one live source, effective LTV is floored to 4500 bps.
      expect(await registry.effectiveMaxLtv(bMTBAddr)).to.equal(4500n);
      console.log("      Single-source detected => effective LTV capped 8000 -> 4500 bps");
    });
  });
});
