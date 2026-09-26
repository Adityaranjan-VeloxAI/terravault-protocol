// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IRiskEngine} from "../interfaces/IRiskEngine.sol";
import {OracleAggregator} from "../oracle/OracleAggregator.sol";
import {AssetQualityRegistry} from "../risk/AssetQualityRegistry.sol";

/**
 * @title CollateralVault
 * @notice Custodies collateral and a mUSDC lending pool; drives deposit / borrow / repay /
 *         withdraw and a soft, grace-period liquidation. All risk decisions are delegated to
 *         the {RiskEngine}; all prices are read through the {OracleAggregator} only.
 *
 * @dev NON-NEGOTIABLES enforced here:
 *      - Every fund-moving call is `nonReentrant`.
 *      - No borrow and no liquidation while the collateral asset's circuit breaker is tripped
 *        (cannot act on a manipulated / frozen price).
 *      - Guardian/keeper actions use scoped AccessControl roles (no owner god-mode).
 *      - Every state change emits an event.
 *
 *      LIQUIDATION is permissionless and partial: any outside agent reads {quoteLiquidation},
 *      calls liquidate(user, repayAmount) to flag (phase 1) and, after GRACE_PERIOD, to repay a
 *      slice for collateral worth slice * (1 + liqPenaltyBps). The slice is capped at what the
 *      collateral can back at that bonus, so a liquidator never covers bad debt; the debt left
 *      on a fully-seized position is written off against the protocol {reserve}. Agents should
 *      call {refreshFlag} each tick after a price recovery so stale flags are cleared.
 *
 *      Isolation simplification: each user has exactly ONE collateral asset at a time. This
 *      keeps health-factor accounting and the isolation rules trivial for the demo.
 *
 *      SCALING: mUSDC debt is 6dp; collateral (bMTB) is 18dp; prices 1e8; HF 1e18.
 */
contract CollateralVault is ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE"); // guardian / risk monitor
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE"); // off-chain risk-monitor agent

    /// @notice Soft-liquidation grace window. A flagged user cannot be seized until it elapses.
    uint256 public constant GRACE_PERIOD = 300; // seconds

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PRICE_SCALE = 1e8;

    IRiskEngine public immutable riskEngine;
    AssetQualityRegistry public immutable registry;
    OracleAggregator public immutable oracle;
    IERC20 public immutable borrowToken; // mUSDC
    uint8 public immutable borrowDecimals;

    /// @notice mUSDC available to lend. Funded via {fundPool}; grows on repay, shrinks on borrow.
    uint256 public poolLiquidity;

    /// @notice Protocol reserve (mUSDC, 6dp) held by the vault, separate from {poolLiquidity}.
    ///         Funded by anyone via {fundReserve}. Used to write off the debt that remains on a
    ///         position once liquidation has taken all of its collateral (underwater remainder),
    ///         so liquidators are never asked to cover bad debt.
    uint256 public reserve;

    /// @notice Cumulative debt (mUSDC, 6dp) written off that the reserve could not cover.
    uint256 public badDebt;

    // ---- user accounting ----
    mapping(address => address) public collateralAsset;                    // user => single asset
    mapping(address => mapping(address => uint256)) public collateral;     // user => asset => amt
    mapping(address => uint256) public debt;                               // user => mUSDC debt (6dp)
    mapping(address => uint256) public totalDebtByAsset;                   // asset => total borrowed
    mapping(address => uint256) public unhealthySince;                     // user => flag timestamp

    // ---- events (one per state change) ----
    event Deposit(address indexed user, address indexed asset, uint256 amount);
    event Withdraw(address indexed user, address indexed asset, uint256 amount);
    event Borrow(address indexed user, address indexed asset, uint256 amount);
    event Repay(address indexed payer, address indexed user, uint256 amount);
    event LiquidationFlagged(address indexed user, address indexed asset, uint256 since);
    event LiquidationCleared(address indexed user, address indexed asset);
    event Liquidated(
        address indexed user,
        address indexed liquidator,
        address indexed asset,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 penaltyBps
    );
    event PoolFunded(address indexed from, uint256 amount);
    event ReserveFunded(address indexed from, uint256 amount);
    /// @notice Remaining debt of a fully-seized position was written off. `coveredByReserve` of
    ///         it was paid from the reserve into the pool; the rest (if any) is bad debt.
    event DebtWrittenOff(address indexed user, address indexed asset, uint256 amount, uint256 coveredByReserve);
    /// @notice The reserve was short: `amount` of written-off debt is unbacked (lenders absorb it).
    event BadDebtRecorded(address indexed user, address indexed asset, uint256 amount);

    constructor(
        address _riskEngine,
        address _registry,
        address _oracle,
        address _borrowToken
    ) {
        riskEngine = IRiskEngine(_riskEngine);
        registry = AssetQualityRegistry(_registry);
        oracle = OracleAggregator(_oracle);
        borrowToken = IERC20(_borrowToken);
        borrowDecimals = IERC20Metadata(_borrowToken).decimals();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Liquidity provisioning
    // ---------------------------------------------------------------------

    /// @notice Supply mUSDC to the lending pool so users can borrow. Anyone may fund.
    function fundPool(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        borrowToken.safeTransferFrom(msg.sender, address(this), amount);
        poolLiquidity += amount;
        emit PoolFunded(msg.sender, amount);
    }

    /// @notice Supply mUSDC to the protocol reserve (the bad-debt backstop). Anyone may fund.
    function fundReserve(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        borrowToken.safeTransferFrom(msg.sender, address(this), amount);
        reserve += amount;
        emit ReserveFunded(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Collateral
    // ---------------------------------------------------------------------

    /**
     * @notice Deposit `amount` of `asset` as collateral.
     * @dev Enforces the single-collateral-asset (isolation) invariant.
     */
    function deposit(address asset, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "zero amount");
        AssetQualityRegistry.AssetConfig memory cfg = registry.getConfig(asset);
        require(cfg.enabled, "asset disabled");

        address cur = collateralAsset[msg.sender];
        require(cur == address(0) || cur == asset, "one collateral asset per user");
        if (cur == address(0)) {
            collateralAsset[msg.sender] = asset;
        }

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        collateral[msg.sender][asset] += amount;

        emit Deposit(msg.sender, asset, amount);

        // Topping up collateral can cure a flagged position: drop the stale flag.
        _clearFlagIfHealthy(msg.sender, asset);
    }

    /**
     * @notice Withdraw `amount` of `asset` collateral.
     * @dev Blocked if it would push HF below 1e18. Effects (balance decrement) are applied
     *      before the HF check and the external transfer; nonReentrant protects the whole call.
     */
    function withdraw(address asset, uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        require(collateral[msg.sender][asset] >= amount, "insufficient collateral");

        collateral[msg.sender][asset] -= amount;

        // If the user still carries debt, the post-withdraw position must remain healthy.
        if (debt[msg.sender] > 0) {
            require(riskEngine.getHealthFactor(msg.sender) >= WAD, "would breach health factor");
        }

        // Fully exited: release the collateral-asset slot.
        if (collateral[msg.sender][asset] == 0 && debt[msg.sender] == 0) {
            collateralAsset[msg.sender] = address(0);
        }

        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, asset, amount);
    }

    // ---------------------------------------------------------------------
    // Debt
    // ---------------------------------------------------------------------

    /**
     * @notice Borrow `amount` mUSDC against the caller's collateral.
     * @dev Two independent guards keep manipulated prices from unlocking credit:
     *      (a) an explicit circuit-breaker check here, and
     *      (b) RiskEngine.isBorrowAllowed (which also refuses on a tripped breaker and enforces
     *          effectiveMaxLtv, the debt ceiling and the isolation rule).
     */
    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "zero amount");
        address asset = collateralAsset[msg.sender];
        require(asset != address(0), "no collateral");

        // (a) NO BORROW ON A BROKEN PRICE.
        require(!oracle.isCircuitBroken(asset), "price circuit breaker tripped");

        // (b) Full risk gate.
        (bool ok, string memory reason) = riskEngine.isBorrowAllowed(msg.sender, asset, amount);
        require(ok, reason);

        require(poolLiquidity >= amount, "insufficient pool liquidity");

        debt[msg.sender] += amount;
        totalDebtByAsset[asset] += amount;
        poolLiquidity -= amount;

        borrowToken.safeTransfer(msg.sender, amount);
        emit Borrow(msg.sender, asset, amount);
    }

    /// @notice Repay part or all of the caller's own debt.
    function repay(uint256 amount) external nonReentrant {
        _repay(msg.sender, msg.sender, amount);
    }

    /**
     * @notice Repay part or all of `user`'s debt on their behalf (payer funds it).
     * @dev Used by the off-chain risk-monitor agent's capped keeper buffer to restore HF on a
     *      legitimate price decline. Reduces `user`'s debt; the payer supplies the mUSDC.
     */
    function repayFor(address user, uint256 amount) external nonReentrant {
        _repay(msg.sender, user, amount);
    }

    function _repay(address payer, address user, uint256 amount) internal {
        require(amount > 0, "zero amount");
        uint256 d = debt[user];
        require(d > 0, "no debt");

        uint256 pay = amount > d ? d : amount; // never overpay
        address asset = collateralAsset[user];

        borrowToken.safeTransferFrom(payer, address(this), pay);
        debt[user] = d - pay;
        totalDebtByAsset[asset] -= pay;
        poolLiquidity += pay;

        emit Repay(payer, user, pay);

        // Clear the soft-liquidation flag once the position is healthy again.
        _clearFlagIfHealthy(user, asset);
    }

    // ---------------------------------------------------------------------
    // Liquidation (soft, grace-period, partial, permissionless)
    // ---------------------------------------------------------------------

    /**
     * @notice One-call quote for an outside liquidator (no role needed to liquidate).
     * @return liquidatable      true if HF < 1 on a readable, non-frozen price.
     * @return graceSecondsLeft  seconds until seizure (phase 2) is allowed. Equals GRACE_PERIOD
     *                           while the position is liquidatable but not yet flagged (the next
     *                           liquidate() call starts the clock). Seizure is possible right now
     *                           iff `liquidatable && graceSecondsLeft == 0`.
     * @return maxRepay          largest slice (mUSDC, 6dp) liquidate() will take right now:
     *                           min(debt, collateralValue / (1 + bonus)). 0 if not liquidatable.
     * @return collateralOut     collateral base units the liquidator receives for `maxRepay`
     *                           (worth maxRepay * (1 + bonus) at the oracle price).
     * @return bonusBps          liquidation bonus in bps (the asset's liqPenaltyBps).
     */
    function quoteLiquidation(address user)
        external
        view
        returns (
            bool liquidatable,
            uint256 graceSecondsLeft,
            uint256 maxRepay,
            uint256 collateralOut,
            uint256 bonusBps
        )
    {
        address asset = collateralAsset[user];
        if (asset == address(0)) return (false, 0, 0, 0, 0);
        bonusBps = registry.getConfig(asset).liqPenaltyBps;
        if (debt[user] == 0 || oracle.isCircuitBroken(asset)) return (false, 0, 0, 0, bonusBps);

        uint256 price;
        try oracle.getPrice(asset) returns (uint256 p, uint256) {
            price = p;
        } catch {
            return (false, 0, 0, 0, bonusBps); // stale / unreadable price: nothing to act on
        }
        if (!riskEngine.isLiquidatable(user)) return (false, 0, 0, 0, bonusBps);

        liquidatable = true;
        uint256 since = unhealthySince[user];
        if (since == 0) {
            graceSecondsLeft = GRACE_PERIOD;
        } else if (block.timestamp < since + GRACE_PERIOD) {
            graceSecondsLeft = since + GRACE_PERIOD - block.timestamp;
        }
        (maxRepay, collateralOut) = _liquidationSlice(user, asset, price, type(uint256).max, bonusBps);
    }

    /**
     * @notice Soft, partial liquidation of `user`. Permissionless: any address may call.
     *         Phase 1 (flag): the first call on a liquidatable user stamps
     *                         `unhealthySince[user] = now` and returns without seizing. This
     *                         gives the borrower / the risk-monitor agent a GRACE_PERIOD to cure.
     *         Phase 2 (seize): after GRACE_PERIOD, if STILL liquidatable, the caller repays a
     *                          slice of the debt and receives collateral worth
     *                          slice * (1 + liqPenaltyBps) at the oracle price.
     *
     * @param repayAmount Requested slice (mUSDC, 6dp). It is capped to
     *        min(debt, collateralValue / (1 + bonus)) so the liquidator is never asked to cover
     *        bad debt and every slice stays profitable. Pass type(uint256).max for "as much as
     *        possible"; use {quoteLiquidation} to learn the exact cap first.
     *
     * @dev NO LIQUIDATION ON A BROKEN PRICE: if the collateral breaker is tripped, revert with
     *      "cannot liquidate on frozen price". A manipulated print must never seize a healthy user.
     *      If the user is healthy again (HF >= 1) and still carries a stale flag, the flag is
     *      cleared and the call RETURNS (so the clear persists); with no flag it reverts
     *      "not liquidatable".
     *      If the slice takes the last of the collateral while debt remains (underwater
     *      remainder), that debt is written off against the reserve (see {_writeOff}).
     */
    function liquidate(address user, uint256 repayAmount) external nonReentrant {
        require(repayAmount > 0, "zero amount");
        address asset = collateralAsset[user];
        require(asset != address(0), "no position");

        // Headline guard: cannot liquidate on a frozen / circuit-broken price.
        require(!oracle.isCircuitBroken(asset), "cannot liquidate on frozen price");

        if (!riskEngine.isLiquidatable(user)) {
            // Recovered: drop the stale flag and return (a revert would roll the clear back).
            require(unhealthySince[user] != 0, "not liquidatable");
            _clearFlag(user, asset);
            return;
        }

        // Phase 1: begin the grace window.
        if (unhealthySince[user] == 0) {
            unhealthySince[user] = block.timestamp;
            emit LiquidationFlagged(user, asset, block.timestamp);
            return;
        }

        // Phase 2: grace must have elapsed.
        require(block.timestamp >= unhealthySince[user] + GRACE_PERIOD, "grace period active");

        uint256 bonusBps = registry.getConfig(asset).liqPenaltyBps;
        (uint256 price, ) = oracle.getPrice(asset); // safe: breaker checked above
        (uint256 slice, uint256 seize) = _liquidationSlice(user, asset, price, repayAmount, bonusBps);

        // Effects: the slice repays debt into the pool; the user loses the seized collateral.
        debt[user] -= slice;
        totalDebtByAsset[asset] -= slice;
        poolLiquidity += slice;
        uint256 colLeft = collateral[user][asset] - seize;
        collateral[user][asset] = colLeft;

        // Underwater remainder: no collateral left but debt remains => reserve write-off.
        if (colLeft == 0 && debt[user] > 0) {
            _writeOff(user, asset);
        }

        if (debt[user] == 0) {
            _clearFlag(user, asset);
            if (colLeft == 0) collateralAsset[user] = address(0);
        } else {
            // Still open: keep the flag only while the position remains unhealthy.
            _clearFlagIfHealthy(user, asset);
        }

        // Interactions: pull the slice, hand over the collateral.
        if (slice > 0) borrowToken.safeTransferFrom(msg.sender, address(this), slice);
        if (seize > 0) IERC20(asset).safeTransfer(msg.sender, seize);

        emit Liquidated(user, msg.sender, asset, slice, seize, bonusBps);
    }

    /**
     * @notice Permissionless flag refresh: clears `user`'s soft-liquidation flag when the
     *         position is healthy again (HF >= 1, or no debt). No-op returning false otherwise,
     *         including while the breaker is tripped or the price is unreadable.
     * @dev OFF-CHAIN AGENTS: call this every tick after a price recovery, i.e. whenever
     *      `unhealthySince(user) != 0` but {quoteLiquidation} reports `liquidatable == false`.
     *      Otherwise a stale flag from an earlier dip would let a later dip skip the grace period.
     *      The flag is also cleared automatically on deposit / repay / repayFor / partial
     *      liquidation whenever they restore health.
     */
    function refreshFlag(address user) external nonReentrant returns (bool cleared) {
        return _clearFlagIfHealthy(user, collateralAsset[user]);
    }

    /**
     * @dev Liquidation math shared by {quoteLiquidation} and {liquidate}.
     *      backed = collateralValue / (1 + bonus), in mUSDC units: the most debt the collateral
     *      can repay at the bonus. slice = min(requested, debt, backed).
     *      seize  = slice * (1 + bonus) / price, in collateral units, capped at the collateral.
     *      When the slice is collateral-bound (slice == backed <= debt) the full collateral is
     *      seized, so rounding never strands dust collateral against unpayable debt.
     */
    function _liquidationSlice(
        address user,
        address asset,
        uint256 price,
        uint256 requested,
        uint256 bonusBps
    ) internal view returns (uint256 slice, uint256 seize) {
        uint256 userCol = collateral[user][asset];
        uint256 d = debt[user];
        uint256 colUnit = 10 ** IERC20Metadata(asset).decimals();
        uint256 debtUnit = 10 ** borrowDecimals;

        uint256 backed = (userCol * price * debtUnit * BPS) / (colUnit * PRICE_SCALE * (BPS + bonusBps));
        uint256 cap = d < backed ? d : backed;
        slice = requested < cap ? requested : cap;

        if (slice == backed && backed <= d) {
            seize = userCol;
        } else {
            seize = (slice * (BPS + bonusBps) * PRICE_SCALE * colUnit) / (BPS * debtUnit * price);
            if (seize > userCol) seize = userCol;
        }
    }

    /**
     * @dev Write off `user`'s remaining debt after all collateral has been seized. The reserve
     *      pays as much as it can into the pool; any shortfall is recorded as bad debt.
     */
    function _writeOff(address user, address asset) internal {
        uint256 remaining = debt[user];
        uint256 covered = remaining < reserve ? remaining : reserve;

        reserve -= covered;
        poolLiquidity += covered;
        debt[user] = 0;
        totalDebtByAsset[asset] -= remaining;
        emit DebtWrittenOff(user, asset, remaining, covered);

        if (remaining > covered) {
            uint256 shortfall = remaining - covered;
            badDebt += shortfall;
            emit BadDebtRecorded(user, asset, shortfall);
        }
    }

    /// @dev Clear the flag if the position is healthy (HF >= 1 or no debt). Never reverts on an
    ///      unreadable price: a frozen or stale price cannot prove recovery, so the flag stays.
    function _clearFlagIfHealthy(address user, address asset) internal returns (bool) {
        if (unhealthySince[user] == 0) return false;
        if (debt[user] == 0) {
            _clearFlag(user, asset);
            return true;
        }
        if (asset == address(0) || oracle.isCircuitBroken(asset)) return false;
        try riskEngine.getHealthFactor(user) returns (uint256 hf) {
            if (hf < WAD) return false;
        } catch {
            return false;
        }
        _clearFlag(user, asset);
        return true;
    }

    function _clearFlag(address user, address asset) internal {
        if (unhealthySince[user] != 0) {
            unhealthySince[user] = 0;
            emit LiquidationCleared(user, asset);
        }
    }

    // ---------------------------------------------------------------------
    // Guardian controls (scoped roles, no owner god-mode)
    // ---------------------------------------------------------------------

    /// @notice Pause deposits & borrows (escalation lever for the risk monitor / guardian).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume after a pause.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
