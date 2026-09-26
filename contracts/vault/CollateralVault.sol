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

        // Clear the soft-liquidation flag once the position is healthy again.
        if (debt[user] == 0) {
            _clearFlag(user, asset);
        } else if (!oracle.isCircuitBroken(asset) && riskEngine.getHealthFactor(user) >= WAD) {
            _clearFlag(user, asset);
        }

        emit Repay(payer, user, pay);
    }

    // ---------------------------------------------------------------------
    // Liquidation (soft, grace-period)
    // ---------------------------------------------------------------------

    /**
     * @notice Soft-liquidate `user`. Two-phase:
     *         Phase 1 (flag): the first time a user is found liquidatable, stamp
     *                         `unhealthySince[user] = now` and return without seizing. This
     *                         gives the borrower / the risk-monitor agent a GRACE_PERIOD to cure.
     *         Phase 2 (seize): after GRACE_PERIOD, if STILL liquidatable, the liquidator repays
     *                          the debt and seizes collateral plus the liquidation penalty.
     *
     * @dev NO LIQUIDATION ON A BROKEN PRICE: if the collateral breaker is tripped, revert. A
     *      manipulated -40% print must never seize a healthy user — the breaker freezes the price
     *      at last-good and this guard blocks seizure entirely until a guardian clears it.
     *      If the user has become healthy again, any stale flag is cleared and the call reverts.
     */
    function liquidate(address user) external nonReentrant {
        address asset = collateralAsset[user];
        require(asset != address(0), "no position");

        // Headline guard: cannot liquidate on a frozen / circuit-broken price.
        require(!oracle.isCircuitBroken(asset), "cannot liquidate on frozen price");

        if (!riskEngine.isLiquidatable(user)) {
            // Recovered: drop any stale flag and stop.
            _clearFlag(user, asset);
            revert("not liquidatable");
        }

        // Phase 1: begin the grace window.
        if (unhealthySince[user] == 0) {
            unhealthySince[user] = block.timestamp;
            emit LiquidationFlagged(user, asset, block.timestamp);
            return;
        }

        // Phase 2: grace must have elapsed.
        require(block.timestamp >= unhealthySince[user] + GRACE_PERIOD, "grace period active");

        AssetQualityRegistry.AssetConfig memory cfg = registry.getConfig(asset);
        (uint256 price, ) = oracle.getPrice(asset); // safe: breaker checked above
        uint8 dec = IERC20Metadata(asset).decimals();

        uint256 d = debt[user];

        // Collateral to seize = debtValue * (1 + penalty) / price, in collateral base units.
        uint256 debtValue1e8 = (d * PRICE_SCALE) / (10 ** borrowDecimals);
        uint256 seizeValue1e8 = (debtValue1e8 * (BPS + cfg.liqPenaltyBps)) / BPS;
        uint256 seizeAmount = (seizeValue1e8 * (10 ** dec)) / price;

        uint256 userCol = collateral[user][asset];
        if (seizeAmount > userCol) seizeAmount = userCol; // cap at available collateral

        // Effects: liquidator covers the full debt; user's debt is cleared.
        borrowToken.safeTransferFrom(msg.sender, address(this), d);
        poolLiquidity += d;
        debt[user] = 0;
        totalDebtByAsset[asset] -= d;
        collateral[user][asset] = userCol - seizeAmount;
        unhealthySince[user] = 0;
        if (collateral[user][asset] == 0) {
            collateralAsset[user] = address(0);
        }

        // Interaction: hand seized collateral to the liquidator.
        IERC20(asset).safeTransfer(msg.sender, seizeAmount);

        emit Liquidated(user, msg.sender, asset, d, seizeAmount, cfg.liqPenaltyBps);
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
