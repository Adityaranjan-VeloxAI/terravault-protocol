import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * OracleAggregator unit tests.
 *
 * Pinned interface (implement to these EXACT signatures):
 *   configureAsset(address asset, address[] adapters, uint256 maxStaleness, uint256 maxDeviationBps) onlyRole(DEFAULT_ADMIN_ROLE)
 *   poke(address asset)                       // NON-view: reads all adapters, drops stale, sets breaker on deviation
 *   getPrice(address asset) view returns (uint256 price, uint256 updatedAt)  // reverts if broken or stale
 *   isSingleSource(address asset) view returns (bool)
 *   isCircuitBroken(address asset) view returns (bool)
 *   clearBreaker(address asset) onlyRole(GUARDIAN_ROLE)
 * Events: CircuitBreakerTripped(asset, deviationBps), BreakerCleared(asset), PricePoked(asset, price, singleSource)
 *
 * GuardianOracleAdapter (IPriceFeedAdapter):
 *   updatePrice(address asset, uint256 price) onlyRole(GUARDIAN_ROLE)  // stamps block.timestamp
 *   getPrice(address asset) view returns (uint256 price, uint256 updatedAt)
 *
 * Convention assumptions (not fixed by the pinned interface list):
 *   - GuardianOracleAdapter() and OracleAggregator() constructors grant DEFAULT_ADMIN_ROLE
 *     and GUARDIAN_ROLE to the deployer. Tests act as the deployer, so no role grants are needed.
 *   - MockRWAToken() takes no constructor args (fixed name "Mock T-Bill" / symbol bMTB).
 *   Reverts are asserted with `.to.be.reverted` so the tests pass whether the implementer
 *   used a custom error (e.g. NoValidPrice) or a require-string for the same condition.
 */

const P = (v: string) => ethers.parseUnits(v, 8); // 1e8 fixed-point price, Chainlink-style

describe("OracleAggregator", () => {
  let admin: any;
  let aggregator: any;
  let adapterA: any;
  let adapterB: any;
  let ASSET: string;
  let adapterAAddr: string;
  let adapterBAddr: string;

  beforeEach(async () => {
    [admin] = await ethers.getSigners();

    const Guardian = await ethers.getContractFactory("GuardianOracleAdapter");
    adapterA = await Guardian.deploy();
    await adapterA.waitForDeployment();
    adapterB = await Guardian.deploy();
    await adapterB.waitForDeployment();

    const Agg = await ethers.getContractFactory("OracleAggregator");
    aggregator = await Agg.deploy();
    await aggregator.waitForDeployment();

    // A real token address to use as the asset key.
    const Tok = await ethers.getContractFactory("MockRWAToken");
    const tok = await Tok.deploy();
    await tok.waitForDeployment();

    ASSET = await tok.getAddress();
    adapterAAddr = await adapterA.getAddress();
    adapterBAddr = await adapterB.getAddress();
  });

  describe("staleness handling", () => {
    it("drops a stale adapter and falls back to the single-source path", async () => {
      await aggregator.configureAsset(ASSET, [adapterAAddr, adapterBAddr], 1000, 500);

      // Two fresh, agreeing sources => multi-source, not single.
      await adapterA.updatePrice(ASSET, P("1.00"));
      await adapterB.updatePrice(ASSET, P("1.00"));
      await aggregator.poke(ASSET);
      expect(await aggregator.isSingleSource(ASSET)).to.equal(false);

      // adapterB stops updating past maxStaleness; only adapterA stays fresh.
      await time.increase(1001);
      await adapterA.updatePrice(ASSET, P("1.00"));

      await expect(aggregator.poke(ASSET))
        .to.emit(aggregator, "PricePoked")
        .withArgs(ASSET, P("1.00"), true);

      // The stale source was dropped, leaving exactly one valid source.
      expect(await aggregator.isSingleSource(ASSET)).to.equal(true);
      const [px] = await aggregator.getPrice(ASSET);
      expect(px).to.equal(P("1.00"));
    });

    it("reverts getPrice once the last-good price is itself older than maxStaleness", async () => {
      await aggregator.configureAsset(ASSET, [adapterAAddr], 1000, 500);
      await adapterA.updatePrice(ASSET, P("1.00"));
      await aggregator.poke(ASSET);

      // Fresh right after poke.
      const [px] = await aggregator.getPrice(ASSET);
      expect(px).to.equal(P("1.00"));

      // Let the last-good timestamp age out; getPrice must refuse to serve a stale price.
      await time.increase(1001);
      await expect(aggregator.getPrice(ASSET)).to.be.reverted;
    });
  });

  describe("deviation handling", () => {
    it("trips the circuit breaker on an out-of-band deviation and retains the last-good price", async () => {
      await aggregator.configureAsset(ASSET, [adapterAAddr, adapterBAddr], 3600, 500);

      // Establish an honest last-good price of $1.00 from two agreeing sources.
      await adapterA.updatePrice(ASSET, P("1.00"));
      await adapterB.updatePrice(ASSET, P("1.00"));
      await aggregator.poke(ASSET);
      const [good] = await aggregator.getPrice(ASSET);
      expect(good).to.equal(P("1.00"));

      // One source now deviates +50% (5000 bps) — far beyond the 500 bps tolerance.
      await adapterA.updatePrice(ASSET, P("1.50"));

      await expect(aggregator.poke(ASSET))
        .to.emit(aggregator, "CircuitBreakerTripped")
        .withArgs(ASSET, anyValue);

      // Breaker is latched; getPrice refuses to serve while frozen.
      expect(await aggregator.isCircuitBroken(ASSET)).to.equal(true);
      await expect(aggregator.getPrice(ASSET)).to.be.reverted;

      // Guardian reviews and clears. The last-good $1.00 is preserved — never the poisoned $1.50.
      await aggregator.clearBreaker(ASSET);
      expect(await aggregator.isCircuitBroken(ASSET)).to.equal(false);
      const [restored] = await aggregator.getPrice(ASSET);
      expect(restored).to.equal(P("1.00"));
    });
  });

  describe("source-count paths", () => {
    it("takes the single-source path when exactly one adapter is valid", async () => {
      await aggregator.configureAsset(ASSET, [adapterAAddr], 3600, 500);
      await adapterA.updatePrice(ASSET, P("0.99"));

      await expect(aggregator.poke(ASSET))
        .to.emit(aggregator, "PricePoked")
        .withArgs(ASSET, P("0.99"), true);

      expect(await aggregator.isSingleSource(ASSET)).to.equal(true);
      const [px] = await aggregator.getPrice(ASSET);
      expect(px).to.equal(P("0.99"));
    });

    it("reverts poke when zero adapters have a valid, fresh price (0-source)", async () => {
      await aggregator.configureAsset(ASSET, [adapterAAddr, adapterBAddr], 1000, 500);
      // Neither adapter was ever updated for ASSET => updatedAt == 0 => both stale/dropped.
      await expect(aggregator.poke(ASSET)).to.be.reverted;
    });
  });
});
