// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IRiskEngine} from "../interfaces/IRiskEngine.sol";
import {OracleAggregator} from "../oracle/OracleAggregator.sol";
import {AssetQualityRegistry} from "./AssetQualityRegistry.sol";

/**
 * @notice Read-only surface of the CollateralVault that the RiskEngine depends on.
 *         Declared as an interface to avoid a circular concrete import (the vault imports
 *         IRiskEngine). Every function here is satisfied by a public mapping getter on the
 *         vault, so no extra vault code is required.
 */
interface IVaultView {
    function collateralAsset(address user) external view returns (address);
    function collateral(address user, address asset) external view returns (uint256);
    function debt(address user) external view returns (uint256);
    function totalDebtByAsset(address asset) external view returns (uint256);
}

/**
 * @title RiskEngine
 * @notice Pure risk math for Terravault. Computes health factors, borrow eligibility and
 *         liquidation eligibility. Holds NO funds and mutates NO user balances.
 *
 * @dev SCALING CONVENTIONS (used consistently across the protocol):
 *      - Prices are 1e8 fixed point (Chainlink-style). $1.02 => 102_000_000.
 *      - Basis points: 1e4 == 100%. maxLtv 80% => 8000, liqThreshold 85% => 8500.
 *      - Health factor is 1e18 fixed point. Liquidation when HF < 1e18.
 *      - Internally, USD values are carried in the 1e8 price scale.
 *
 *      SECURITY: All prices are read through {OracleAggregator} ONLY — never a raw adapter.
 *      The aggregator reverts on a circuit-broken or stale price, and this engine additionally
 *      refuses to authorize borrows or flag liquidations while a breaker is tripped. That is the
 *      headline property: a manipulated price cannot be used to liquidate a healthy user.
 */
contract RiskEngine is IRiskEngine, AccessControl {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant PRICE_SCALE = 1e8; // oracle price fixed point

    AssetQualityRegistry public immutable registry;
    OracleAggregator public immutable oracle;

    /// @notice The borrow asset (mUSDC). Debt is denominated in it and valued 1:1 vs USD.
    address public immutable borrowAsset;
    uint8 public immutable borrowDecimals;

    /// @notice Set once, after the vault is deployed (resolves the deploy-time cycle).
    IVaultView public vault;
    bool private _vaultSet;

    event VaultSet(address indexed vault);

    constructor(address _registry, address _oracle, address _borrowAsset) {
        registry = AssetQualityRegistry(_registry);
        oracle = OracleAggregator(_oracle);
        borrowAsset = _borrowAsset;
        borrowDecimals = IERC20Metadata(_borrowAsset).decimals();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice One-time wiring of the vault reference.
    function setVault(address _vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!_vaultSet, "RiskEngine: vault already set");
        require(_vault != address(0), "RiskEngine: zero vault");
        vault = IVaultView(_vault);
        _vaultSet = true;
        emit VaultSet(_vault);
    }

    // ---------------------------------------------------------------------
    // IRiskEngine
    // ---------------------------------------------------------------------

    /**
     * @notice Health factor of a user, 1e18 fixed point.
     *
     * @dev HF = (collateralValueUSD * liqThresholdBps / BPS) / debtValueUSD, scaled to 1e18.
     *      With a single collateral asset per user this is:
     *
     *          HF = collateralValue1e8 * liqThresholdBps * 1e18
     *               ---------------------------------------------
     *                         BPS * debtValue1e8
     *
     *      No debt => type(uint256).max (infinitely safe).
     *
     *      Reverts if the collateral price is unavailable (circuit broken or stale): a health
     *      factor derived from a frozen/deviant price would be meaningless, so callers on the
     *      liquidation path must treat "unreadable" as "not liquidatable" (see isLiquidatable).
     */
    function getHealthFactor(address user) public view returns (uint256 hf) {
        address asset = vault.collateralAsset(user);
        uint256 d = vault.debt(user);
        if (d == 0) return type(uint256).max;

        AssetQualityRegistry.AssetConfig memory cfg = registry.getConfig(asset);

        uint256 colValue1e8 = _collateralValue1e8(user, asset); // reads price via aggregator
        uint256 debtValue1e8 = _debtValue1e8(d);

        // weightedCollateral (1e8) = colValue1e8 * liqThreshold / BPS ; then scale by 1e18/debt.
        hf = (colValue1e8 * cfg.liqThresholdBps * WAD) / (BPS * debtValue1e8);
    }

    /**
     * @notice Whether `user` may borrow `amount` more mUSDC against collateral `asset`.
     * @return ok      true if allowed
     * @return reason  human-readable rejection reason ("" when ok)
     *
     * @dev Guards, in order:
     *      1. asset must be enabled in the registry;
     *      2. NO BORROW ON A BROKEN PRICE — if the circuit breaker is tripped for `asset`,
     *         reject outright (a manipulated/deviant feed must not unlock borrowing);
     *      3. resulting debt value must stay within effectiveMaxLtv of collateral value
     *         (effectiveMaxLtv is floored to the tier-3 single-source floor when the aggregator
     *         has fallen to a single source — see AssetQualityRegistry);
     *      4. the asset debt ceiling must not be exceeded;
     *      5. isolation: a user has exactly one collateral asset, so the borrow asset must match
     *         the user's existing collateral asset.
     */
    function isBorrowAllowed(address user, address asset, uint256 amount)
        external
        view
        returns (bool ok, string memory reason)
    {
        AssetQualityRegistry.AssetConfig memory cfg = registry.getConfig(asset);
        if (!cfg.enabled) return (false, "asset disabled");

        // (2) Headline guard: never borrow on a circuit-broken price.
        if (oracle.isCircuitBroken(asset)) return (false, "circuit breaker tripped");

        // Isolation / single-collateral invariant.
        address userAsset = vault.collateralAsset(user);
        if (userAsset != address(0) && userAsset != asset) {
            return (false, "isolation: single collateral asset");
        }

        // Collateral value (reverts if price stale; single-source is allowed but LTV is floored).
        uint256 colValue1e8 = _collateralValue1e8(user, asset);

        uint256 effLtv = registry.effectiveMaxLtv(asset); // bps, single-source-aware
        uint256 maxBorrowValue1e8 = (colValue1e8 * effLtv) / BPS;

        uint256 newDebt = vault.debt(user) + amount;
        uint256 newDebtValue1e8 = _debtValue1e8(newDebt);
        if (newDebtValue1e8 > maxBorrowValue1e8) return (false, "exceeds max LTV");

        // (4) Debt ceiling on the collateral asset.
        if (vault.totalDebtByAsset(asset) + amount > cfg.debtCeiling) {
            return (false, "debt ceiling exceeded");
        }

        return (true, "");
    }

    /**
     * @notice Whether a user is currently liquidatable (HF < 1e18).
     * @dev Defensive: returns false while the collateral breaker is tripped. You cannot and
     *      must not liquidate on a frozen price — so we report "not liquidatable" rather than
     *      reverting on the unreadable price. The vault also blocks liquidation on a tripped
     *      breaker independently.
     */
    function isLiquidatable(address user) external view returns (bool) {
        address asset = vault.collateralAsset(user);
        if (asset == address(0)) return false;
        if (vault.debt(user) == 0) return false;
        if (oracle.isCircuitBroken(asset)) return false; // never liquidate on a frozen price
        return getHealthFactor(user) < WAD;
    }

    /**
     * @notice Additional mUSDC (6dp) the user could still borrow right now.
     * @dev Bounded by both effectiveMaxLtv headroom and remaining debt-ceiling room.
     *      Returns 0 if the breaker is tripped (borrowing is disabled then).
     */
    function maxBorrowable(address user) external view returns (uint256) {
        address asset = vault.collateralAsset(user);
        if (asset == address(0)) return 0;
        if (oracle.isCircuitBroken(asset)) return 0;

        AssetQualityRegistry.AssetConfig memory cfg = registry.getConfig(asset);
        if (!cfg.enabled) return 0;

        uint256 colValue1e8 = _collateralValue1e8(user, asset);
        uint256 effLtv = registry.effectiveMaxLtv(asset);
        uint256 maxBorrowValue1e8 = (colValue1e8 * effLtv) / BPS;

        // Convert the max borrowable USD value back to mUSDC base units (6dp).
        uint256 maxDebt = (maxBorrowValue1e8 * (10 ** borrowDecimals)) / PRICE_SCALE;
        uint256 cur = vault.debt(user);
        if (maxDebt <= cur) return 0;
        uint256 ltvRoom = maxDebt - cur;

        // Respect the debt ceiling.
        uint256 used = vault.totalDebtByAsset(asset);
        if (used >= cfg.debtCeiling) return 0;
        uint256 ceilingRoom = cfg.debtCeiling - used;

        return ltvRoom < ceilingRoom ? ltvRoom : ceilingRoom;
    }

    // ---------------------------------------------------------------------
    // Internal valuation helpers (all USD values in the 1e8 price scale)
    // ---------------------------------------------------------------------

    /// @dev collateralValue1e8 = amount * price / 10**assetDecimals. Price via aggregator only.
    function _collateralValue1e8(address user, address asset) internal view returns (uint256) {
        (uint256 price, ) = oracle.getPrice(asset); // reverts if broken or stale
        uint256 amt = vault.collateral(user, asset);
        uint8 dec = IERC20Metadata(asset).decimals();
        return (amt * price) / (10 ** dec);
    }

    /// @dev debtValue1e8 = debt * 1e8 / 10**borrowDecimals (mUSDC pegged to $1).
    function _debtValue1e8(uint256 debtAmount) internal view returns (uint256) {
        return (debtAmount * PRICE_SCALE) / (10 ** borrowDecimals);
    }
}
