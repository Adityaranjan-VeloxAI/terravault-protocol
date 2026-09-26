import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * LIQUIDATION V2 — permissionless, partial, reserve-backed liquidation.
 *
 * Every test starts from the seeded demo loan: 50,000 bMTB deposited at $1.02, 34,000 mUSDC
 * borrowed, bMTB Tier 1 (maxLtv 80%, liqThreshold 85%, liqPenalty/bonus 5%).
 *
 * Key prices:
 *   $0.78 => HF = 50,000 * 0.78 * 0.85 / 34,000 = 0.975 (liquidatable, collateral covers debt + bonus)
 *   $0.70 => HF = 0.875; collateral $35,000 backs only 35,000 / 1.05 = 33,333.333333 mUSDC at the
 *            bonus, so 666.666667 mUSDC is an underwater remainder for the reserve.
 */

const P = (v: string) => ethers.parseUnits(v, 8);
const RWA = (v: string) => ethers.parseUnits(v, 18);
const USD6 = (v: string) => ethers.parseUnits(v, 6);

const BPS = 10_000n;
const BONUS = 500n;
const GRACE = 300;

// Mirrors CollateralVault._liquidationSlice (same integer rounding).
const backedBy = (col: bigint, price: bigint) =>
  (col * price * 10n ** 6n * BPS) / (10n ** 18n * 10n ** 8n * (BPS + BONUS));
const seizeFor = (slice: bigint, price: bigint) =>
  (slice * (BPS + BONUS) * 10n ** 8n * 10n ** 18n) / (BPS * 10n ** 6n * price);
// Collateral (18dp) value in mUSDC units (6dp) at a 1e8 price.
const valueUsd6 = (col: bigint, price: bigint) => (col * price) / 10n ** 20n;

async function deployFixture() {
  const [admin, user, liquidator, keeper, funder] = await ethers.getSigners();

  const bMTB: any = await (await ethers.getContractFactory("MockRWAToken")).deploy();
  const mUSDC: any = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const Guardian = await ethers.getContractFactory("GuardianOracleAdapter");
  const adapterA = await Guardian.deploy();
  const adapterB = await Guardian.deploy();
  const aggregator = await (await ethers.getContractFactory("OracleAggregator")).deploy();
  const registry = await (await ethers.getContractFactory("AssetQualityRegistry")).deploy(
    await aggregator.getAddress()
  );
  const risk = await (await ethers.getContractFactory("RiskEngine")).deploy(
    await registry.getAddress(),
    await aggregator.getAddress(),
    await mUSDC.getAddress()
  );
  const vault: any = await (await ethers.getContractFactory("CollateralVault")).deploy(
    await risk.getAddress(),
    await registry.getAddress(),
    await aggregator.getAddress(),
    await mUSDC.getAddress()
  );
  await risk.setVault(await vault.getAddress());

  const asset = await bMTB.getAddress();
  const vaultAddr = await vault.getAddress();

  await registry.setAsset(asset, {
    tier: 1,
    maxLtvBps: 8000,
    liqThresholdBps: 8500,
    liqPenaltyBps: 500,
    debtCeiling: USD6("100000000"),
    isolation: false,
    enabled: true,
  });
  await aggregator.configureAsset(
    asset,
    [await adapterA.getAddress(), await adapterB.getAddress()],
    3600,
    500
  );

  const setPrice = async (v: string) => {
    await adapterA.updatePrice(asset, P(v));
    await adapterB.updatePrice(asset, P(v));
    await aggregator.poke(asset);
  };
  await setPrice("1.02");

  // Lending pool.
  await mUSDC.mint(admin.address, USD6("1000000"));
  await mUSDC.approve(vaultAddr, USD6("1000000"));
  await vault.fundPool(USD6("1000000"));

  // Seeded loan: 50,000 bMTB, 34,000 mUSDC.
  await bMTB.mint(user.address, RWA("50000"));
  await bMTB.connect(user).approve(vaultAddr, RWA("50000"));
  await vault.connect(user).deposit(asset, RWA("50000"));
  await vault.connect(user).borrow(USD6("34000"));

  // An outside liquidator with no protocol role, holding plenty of mUSDC.
  await mUSDC.mint(liquidator.address, USD6("100000"));
  await mUSDC.connect(liquidator).approve(vaultAddr, ethers.MaxUint256);

  // Contracts are returned as `any` (like the e2e suite) so `.connect(signer).fn()` type-checks.
  return {
    admin, user, liquidator, keeper, funder, asset, vaultAddr, setPrice,
    bMTB: bMTB as any, mUSDC: mUSDC as any, adapterA: adapterA as any, adapterB: adapterB as any,
    aggregator: aggregator as any, registry: registry as any, risk: risk as any, vault: vault as any,
  };
}

/** Flag the user at the current price and let the grace period fully elapse. */
async function flagAndWait(vault: any, liquidator: any, user: string) {
  await expect(vault.connect(liquidator).liquidate(user, 1n)).to.emit(vault, "LiquidationFlagged");
  await time.increase(GRACE);
}

describe("CollateralVault — liquidation v2 (permissionless, partial, reserve-backed)", () => {
  describe("quoteLiquidation", () => {
    it("healthy position: not liquidatable, quotes nothing, liquidate() reverts", async () => {
      const { vault, user, liquidator } = await loadFixture(deployFixture);
      const q = await vault.quoteLiquidation(user.address);
      expect(q.liquidatable).to.equal(false);
      expect(q.graceSecondsLeft).to.equal(0n);
      expect(q.maxRepay).to.equal(0n);
      expect(q.collateralOut).to.equal(0n);
      expect(q.bonusBps).to.equal(BONUS);
      await expect(vault.connect(liquidator).liquidate(user.address, USD6("1000"))).to.be.revertedWith(
        "not liquidatable"
      );
    });

    it("unhealthy position: exact maxRepay / collateralOut, grace counts down, and liquidate() honours the quote", async () => {
      const { vault, user, liquidator, asset, setPrice } = await loadFixture(deployFixture);
      await setPrice("0.78");

      let q = await vault.quoteLiquidation(user.address);
      expect(q.liquidatable).to.equal(true);
      expect(q.graceSecondsLeft).to.equal(BigInt(GRACE)); // not flagged yet
      expect(q.maxRepay).to.equal(USD6("34000")); // debt-bound: collateral backs more than the debt
      expect(q.collateralOut).to.equal(seizeFor(USD6("34000"), P("0.78")));
      expect(q.bonusBps).to.equal(BONUS);

      await vault.connect(liquidator).liquidate(user.address, 1n); // phase 1: flag
      await expect(vault.connect(liquidator).liquidate(user.address, 1n)).to.be.revertedWith("grace period active");

      const since = await vault.unhealthySince(user.address);
      await time.increase(100);
      q = await vault.quoteLiquidation(user.address);
      expect(q.graceSecondsLeft).to.equal(since + BigInt(GRACE) - BigInt(await time.latest()));
      expect(q.graceSecondsLeft > 0n && q.graceSecondsLeft < BigInt(GRACE - 100)).to.equal(true);

      await time.increaseTo(since + BigInt(GRACE));
      q = await vault.quoteLiquidation(user.address);
      expect(q.graceSecondsLeft).to.equal(0n);

      await expect(vault.connect(liquidator).liquidate(user.address, q.maxRepay))
        .to.emit(vault, "Liquidated")
        .withArgs(user.address, liquidator.address, asset, q.maxRepay, q.collateralOut, BONUS);
      expect(await vault.debt(user.address)).to.equal(0n);
    });
  });

  describe("partial liquidation", () => {
    it("repays a slice for collateral worth slice x 1.05 (profitable); flag stays while unhealthy, clears once healthy", async () => {
      const { vault, user, liquidator, bMTB, mUSDC, asset, setPrice } = await loadFixture(deployFixture);
      const price = P("0.78");
      await setPrice("0.78");
      await flagAndWait(vault, liquidator, user.address);

      // Slice 1: 1,000 mUSDC. HF after ~0.977 => still unhealthy, flag kept.
      const slice1 = USD6("1000");
      const usdBefore: bigint =await mUSDC.balanceOf(liquidator.address);
      const pool0: bigint =await vault.poolLiquidity();
      await expect(vault.connect(liquidator).liquidate(user.address, slice1))
        .to.emit(vault, "Liquidated")
        .withArgs(user.address, liquidator.address, asset, slice1, seizeFor(slice1, price), BONUS);
      expect(await vault.debt(user.address)).to.equal(USD6("33000"));
      expect(await vault.poolLiquidity()).to.equal(pool0 + slice1);
      expect(await vault.unhealthySince(user.address)).to.not.equal(0n);

      // Slice 2: 10,000 mUSDC. HF after > 1 => the flag is cleared in the same call.
      const slice2 = USD6("10000");
      await expect(vault.connect(liquidator).liquidate(user.address, slice2)).to.emit(vault, "LiquidationCleared");
      expect(await vault.debt(user.address)).to.equal(USD6("23000"));
      expect(await vault.unhealthySince(user.address)).to.equal(0n);

      const paid: bigint =usdBefore - (await mUSDC.balanceOf(liquidator.address));
      const got: bigint = await bMTB.balanceOf(liquidator.address);
      expect(paid).to.equal(slice1 + slice2);
      expect(got).to.equal(seizeFor(slice1, price) + seizeFor(slice2, price));
      const gotValue = valueUsd6(got, price);
      expect(gotValue > paid).to.equal(true);
      // ~5% bonus on what was paid (allow 1 unit of rounding).
      expect(gotValue >= (paid * (BPS + BONUS)) / BPS - 1n).to.equal(true);
      console.log(`      paid ${ethers.formatUnits(paid, 6)} mUSDC, received $${ethers.formatUnits(gotValue, 6)} of bMTB`);
    });

    it("caps the slice at what the collateral can back at the bonus (never asks the liquidator to cover bad debt)", async () => {
      const { vault, user, liquidator, bMTB, mUSDC, asset, setPrice } = await loadFixture(deployFixture);
      const price = P("0.70");
      await setPrice("0.70");
      await flagAndWait(vault, liquidator, user.address);

      const cap = backedBy(RWA("50000"), price);
      expect(cap).to.equal(USD6("33333.333333"));

      const usdBefore: bigint =await mUSDC.balanceOf(liquidator.address);
      await expect(vault.connect(liquidator).liquidate(user.address, USD6("34000"))) // asks for the whole debt
        .to.emit(vault, "Liquidated")
        .withArgs(user.address, liquidator.address, asset, cap, RWA("50000"), BONUS);

      const paid: bigint =usdBefore - (await mUSDC.balanceOf(liquidator.address));
      expect(paid).to.equal(cap); // charged only the collateral-backed slice
      expect(await bMTB.balanceOf(liquidator.address)).to.equal(RWA("50000"));
      expect(valueUsd6(RWA("50000"), price) > paid).to.equal(true); // $35,000 for $33,333.33
    });
  });

  describe("protocol reserve", () => {
    it("fundReserve is open to anyone and emits ReserveFunded", async () => {
      const { vault, mUSDC, funder, vaultAddr } = await loadFixture(deployFixture);
      await mUSDC.mint(funder.address, USD6("1000"));
      await mUSDC.connect(funder).approve(vaultAddr, USD6("1000"));
      await expect(vault.connect(funder).fundReserve(USD6("1000")))
        .to.emit(vault, "ReserveFunded")
        .withArgs(funder.address, USD6("1000"));
      expect(await vault.reserve()).to.equal(USD6("1000"));
      await expect(vault.connect(funder).fundReserve(0)).to.be.revertedWith("zero amount");
    });

    it("writes off the underwater remainder against the reserve (reserve pays the pool)", async () => {
      const { vault, user, liquidator, mUSDC, funder, asset, vaultAddr, setPrice } = await loadFixture(deployFixture);
      await mUSDC.mint(funder.address, USD6("1000"));
      await mUSDC.connect(funder).approve(vaultAddr, USD6("1000"));
      await vault.connect(funder).fundReserve(USD6("1000"));

      await setPrice("0.70");
      await flagAndWait(vault, liquidator, user.address);

      const cap = USD6("33333.333333");
      const remainder = USD6("34000") - cap; // 666.666667
      const pool0: bigint =await vault.poolLiquidity();

      await expect(vault.connect(liquidator).liquidate(user.address, ethers.MaxUint256))
        .to.emit(vault, "DebtWrittenOff")
        .withArgs(user.address, asset, remainder, remainder)
        .and.to.emit(vault, "LiquidationCleared")
        .and.not.to.emit(vault, "BadDebtRecorded");

      expect(await vault.debt(user.address)).to.equal(0n);
      expect(await vault.collateral(user.address, asset)).to.equal(0n);
      expect(await vault.collateralAsset(user.address)).to.equal(ethers.ZeroAddress);
      expect(await vault.totalDebtByAsset(asset)).to.equal(0n);
      expect(await vault.unhealthySince(user.address)).to.equal(0n);
      expect(await vault.reserve()).to.equal(USD6("1000") - remainder);
      expect(await vault.badDebt()).to.equal(0n);
      // Pool made whole: liquidator slice + reserve write-off == the full 34,000 debt.
      expect(await vault.poolLiquidity()).to.equal(pool0 + USD6("34000"));
      // Accounting matches the tokens actually held.
      expect(await mUSDC.balanceOf(vaultAddr)).to.equal((await vault.poolLiquidity()) + (await vault.reserve()));
    });

    it("records bad debt with an event when the reserve is short; the liquidator is still profitable", async () => {
      const { vault, user, liquidator, bMTB, mUSDC, funder, asset, vaultAddr, setPrice } = await loadFixture(deployFixture);
      await mUSDC.mint(funder.address, USD6("100"));
      await mUSDC.connect(funder).approve(vaultAddr, USD6("100"));
      await vault.connect(funder).fundReserve(USD6("100"));

      await setPrice("0.70");
      await flagAndWait(vault, liquidator, user.address);

      const remainder = USD6("666.666667");
      const shortfall = remainder - USD6("100");
      const usdBefore: bigint =await mUSDC.balanceOf(liquidator.address);
      await expect(vault.connect(liquidator).liquidate(user.address, USD6("34000")))
        .to.emit(vault, "DebtWrittenOff")
        .withArgs(user.address, asset, remainder, USD6("100"))
        .and.to.emit(vault, "BadDebtRecorded")
        .withArgs(user.address, asset, shortfall);

      expect(await vault.reserve()).to.equal(0n);
      expect(await vault.badDebt()).to.equal(shortfall);
      expect(await vault.debt(user.address)).to.equal(0n);
      const paid: bigint =usdBefore - (await mUSDC.balanceOf(liquidator.address));
      expect(valueUsd6(await bMTB.balanceOf(liquidator.address), P("0.70")) > paid).to.equal(true);
    });
  });

  describe("flag clearing (unhealthySince)", () => {
    it("refreshFlag clears after a price recovery, so a later dip needs a fresh grace period", async () => {
      const { vault, user, liquidator, keeper, asset, setPrice } = await loadFixture(deployFixture);
      await setPrice("0.78");
      await vault.connect(liquidator).liquidate(user.address, 1n); // flagged
      const firstFlag = await vault.unhealthySince(user.address);
      expect(firstFlag).to.not.equal(0n);

      // Still unhealthy: refreshFlag is a harmless no-op.
      expect(await vault.connect(keeper).refreshFlag.staticCall(user.address)).to.equal(false);

      await setPrice("1.02"); // recovery
      expect(await vault.connect(keeper).refreshFlag.staticCall(user.address)).to.equal(true);
      await expect(vault.connect(keeper).refreshFlag(user.address))
        .to.emit(vault, "LiquidationCleared")
        .withArgs(user.address, asset);
      expect(await vault.unhealthySince(user.address)).to.equal(0n);

      // Well past the original grace window, the price dips again.
      await time.increase(GRACE * 2);
      await setPrice("0.78");
      // The old flag is gone: this call only starts a NEW grace period, it does not seize.
      await expect(vault.connect(liquidator).liquidate(user.address, USD6("34000")))
        .to.emit(vault, "LiquidationFlagged")
        .and.not.to.emit(vault, "Liquidated");
      expect(await vault.unhealthySince(user.address)).to.be.greaterThan(firstFlag);
      await expect(vault.connect(liquidator).liquidate(user.address, USD6("34000"))).to.be.revertedWith(
        "grace period active"
      );
      expect(await vault.debt(user.address)).to.equal(USD6("34000"));
    });

    it("liquidate() on a recovered, flagged position clears the flag without reverting (the clear persists)", async () => {
      const { vault, user, liquidator, asset, setPrice } = await loadFixture(deployFixture);
      await setPrice("0.78");
      await vault.connect(liquidator).liquidate(user.address, 1n);
      await setPrice("1.02");

      await expect(vault.connect(liquidator).liquidate(user.address, USD6("1000")))
        .to.emit(vault, "LiquidationCleared")
        .withArgs(user.address, asset);
      expect(await vault.unhealthySince(user.address)).to.equal(0n);
      // Nothing left to clear: now it reverts.
      await expect(vault.connect(liquidator).liquidate(user.address, USD6("1000"))).to.be.revertedWith(
        "not liquidatable"
      );
    });

    it("repayFor and deposit clear the flag when they restore health", async () => {
      const { vault, user, liquidator, keeper, bMTB, mUSDC, asset, vaultAddr, setPrice } = await loadFixture(deployFixture);
      await setPrice("0.78");

      // repayFor: 5,000 => HF = 39,000 * 0.85 / 29,000 ≈ 1.14
      await vault.connect(liquidator).liquidate(user.address, 1n);
      await mUSDC.mint(keeper.address, USD6("5000"));
      await mUSDC.connect(keeper).approve(vaultAddr, USD6("5000"));
      await expect(vault.connect(keeper).repayFor(user.address, USD6("5000"))).to.emit(vault, "LiquidationCleared");
      expect(await vault.unhealthySince(user.address)).to.equal(0n);

      // deposit: dip further to $0.60 (HF ≈ 0.88), flag, then top up 20,000 bMTB (HF ≈ 1.24).
      await setPrice("0.60");
      await vault.connect(liquidator).liquidate(user.address, 1n);
      expect(await vault.unhealthySince(user.address)).to.not.equal(0n);
      await bMTB.mint(user.address, RWA("20000"));
      await bMTB.connect(user).approve(vaultAddr, RWA("20000"));
      await expect(vault.connect(user).deposit(asset, RWA("20000"))).to.emit(vault, "LiquidationCleared");
      expect(await vault.unhealthySince(user.address)).to.equal(0n);
    });
  });

  describe("circuit breaker", () => {
    it("a disagreeing feed still blocks liquidation with exactly 'cannot liquidate on frozen price'", async () => {
      const { vault, user, liquidator, adapterA, aggregator, asset, setPrice } = await loadFixture(deployFixture);
      // Even a flagged position past its grace period cannot be seized on a frozen price.
      await setPrice("0.78");
      await flagAndWait(vault, liquidator, user.address);

      await adapterA.updatePrice(asset, P("0.46")); // B still says $0.78 => ~41% spread
      await expect(aggregator.poke(asset)).to.emit(aggregator, "CircuitBreakerTripped");

      await expect(vault.connect(liquidator).liquidate(user.address, USD6("34000"))).to.be.revertedWith(
        "cannot liquidate on frozen price"
      );
      const q = await vault.quoteLiquidation(user.address);
      expect(q.liquidatable).to.equal(false);
      expect(q.maxRepay).to.equal(0n);
      // A frozen price cannot prove recovery either: refreshFlag keeps the flag.
      expect(await vault.refreshFlag.staticCall(user.address)).to.equal(false);
      expect(await vault.debt(user.address)).to.equal(USD6("34000"));
      expect(await vault.collateral(user.address, asset)).to.equal(RWA("50000"));
    });
  });

  describe("demo scenario: agreed crash to $0.70 on the seeded loan", () => {
    it("is liquidatable after the grace period and the outside liquidator ends with more value than it paid", async () => {
      const { vault, user, liquidator, bMTB, mUSDC, funder, asset, vaultAddr, setPrice } = await loadFixture(deployFixture);
      await mUSDC.mint(funder.address, USD6("1000"));
      await mUSDC.connect(funder).approve(vaultAddr, USD6("1000"));
      await vault.connect(funder).fundReserve(USD6("1000"));

      // Both feeds agree on the crash => accepted, breaker stays armed.
      await setPrice("0.70");

      let q = await vault.quoteLiquidation(user.address);
      expect(q.liquidatable).to.equal(true);
      expect(q.graceSecondsLeft).to.equal(BigInt(GRACE));

      await expect(vault.connect(liquidator).liquidate(user.address, q.maxRepay)).to.emit(vault, "LiquidationFlagged");

      await network.provider.send("evm_increaseTime", [GRACE]);
      await network.provider.send("evm_mine");

      q = await vault.quoteLiquidation(user.address);
      expect(q.graceSecondsLeft).to.equal(0n);
      expect(q.maxRepay).to.equal(USD6("33333.333333"));
      expect(q.collateralOut).to.equal(RWA("50000"));

      const usdBefore: bigint =await mUSDC.balanceOf(liquidator.address);
      await expect(vault.connect(liquidator).liquidate(user.address, q.maxRepay))
        .to.emit(vault, "Liquidated")
        .withArgs(user.address, liquidator.address, asset, q.maxRepay, q.collateralOut, BONUS);

      const paid: bigint =usdBefore - (await mUSDC.balanceOf(liquidator.address));
      const received: bigint = await bMTB.balanceOf(liquidator.address);
      const receivedValue = valueUsd6(received, P("0.70"));
      console.log(
        `      liquidator paid ${ethers.formatUnits(paid, 6)} mUSDC, received ${ethers.formatUnits(received, 18)} bMTB ` +
          `worth $${ethers.formatUnits(receivedValue, 6)}`
      );
      expect(paid).to.equal(USD6("33333.333333"));
      expect(receivedValue).to.equal(USD6("35000"));
      expect(receivedValue > paid).to.equal(true);
      expect(await vault.debt(user.address)).to.equal(0n); // remainder written off against the reserve
      expect(await vault.badDebt()).to.equal(0n);
    });
  });
});
