// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {OracleAggregator} from "../oracle/OracleAggregator.sol";

/// @title AssetQualityRegistry
/// @notice On-chain registry of per-asset risk parameters (tier, LTV, thresholds,
///         penalties, debt ceiling, isolation) for Terravault collateral.
/// @dev The registry couples static risk config with LIVE oracle quality: when
///      the OracleAggregator reports that an asset is running on a single live
///      feed, the registry automatically caps effective max-LTV to a
///      conservative floor. Static parameters describe the asset's credit
///      quality; the oracle link enforces that we only lend aggressively while
///      price discovery is healthy (>= 2 agreeing feeds).
contract AssetQualityRegistry is AccessControl {
    /// @notice Basis-point denominator: 1e4 = 100%.
    uint256 public constant BPS = 10_000;

    /// @notice LTV cap applied whenever an asset degrades to a single live feed.
    ///         Equals the tier-3 (lowest-quality) LTV floor: 4500 bps = 45%.
    ///         On a lone feed we cannot cross-check for manipulation, so we treat
    ///         even a tier-1 asset as if it were our weakest collateral.
    uint256 public constant SINGLE_SOURCE_LTV_FLOOR = 4500;

    struct AssetConfig {
        uint8 tier; // 1 = highest quality ... 3 = lowest
        uint256 maxLtvBps; // borrow limit, bps of collateral value (80% => 8000)
        uint256 liqThresholdBps; // insolvency threshold, bps (85% => 8500)
        uint256 liqPenaltyBps; // liquidation bonus/penalty, bps (5% => 500)
        uint256 debtCeiling; // max debt against this asset (mUSDC, 6dp)
        bool isolation; // true => isolated-mode collateral
        bool enabled; // false => cannot be used as collateral
    }

    /// @notice Role note: this registry uses AccessControl's DEFAULT_ADMIN_ROLE
    ///         for parameter changes. No owner god-mode — risk params are a
    ///         scoped admin capability that can be handed to governance.
    mapping(address => AssetConfig) private _configs;

    /// @notice The single oracle the registry consults for live feed quality.
    OracleAggregator public immutable oracle;

    /// @notice Emitted whenever an asset's risk config is set/updated.
    event AssetSet(
        address indexed asset,
        uint8 tier,
        uint256 maxLtvBps,
        uint256 liqThresholdBps,
        uint256 liqPenaltyBps,
        uint256 debtCeiling,
        bool isolation,
        bool enabled
    );

    /// @param oracle_ The OracleAggregator used for single-source detection.
    /// @notice The deployer receives DEFAULT_ADMIN_ROLE.
    constructor(OracleAggregator oracle_) {
        require(address(oracle_) != address(0), "AQR: zero oracle");
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        oracle = oracle_;
    }

    /// @notice Set (or overwrite) the risk config for `asset`.
    /// @dev onlyRole(DEFAULT_ADMIN_ROLE). Validates the bps ordering so a config
    ///      can never allow borrowing above the liquidation threshold, which
    ///      would create positions that are underwater the instant they open.
    function setAsset(address asset, AssetConfig calldata cfg) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(asset != address(0), "AQR: zero asset");
        require(cfg.tier >= 1 && cfg.tier <= 3, "AQR: bad tier");
        require(cfg.maxLtvBps <= cfg.liqThresholdBps, "AQR: ltv>threshold");
        require(cfg.liqThresholdBps <= BPS, "AQR: threshold>100%");
        require(cfg.liqPenaltyBps < BPS, "AQR: penalty>=100%");

        _configs[asset] = cfg;

        emit AssetSet(
            asset,
            cfg.tier,
            cfg.maxLtvBps,
            cfg.liqThresholdBps,
            cfg.liqPenaltyBps,
            cfg.debtCeiling,
            cfg.isolation,
            cfg.enabled
        );
    }

    /// @notice Full stored risk config for `asset`.
    function getConfig(address asset) external view returns (AssetConfig memory) {
        return _configs[asset];
    }

    /// @notice The max-LTV the protocol will actually honor for `asset` right now.
    /// @dev SECURITY: if the oracle reports `isSingleSource`, we cannot
    ///      cross-check the price against a second feed, so we cap LTV to
    ///      SINGLE_SOURCE_LTV_FLOOR (4500 bps) — never above the asset's own
    ///      configured maxLtv. Otherwise the configured maxLtv applies. This is
    ///      the STALE/degradation branch of the demo: one adapter stops updating,
    ///      the aggregator falls to a lone feed, and this function tightens LTV.
    function effectiveMaxLtv(address asset) external view returns (uint256) {
        uint256 configured = _configs[asset].maxLtvBps;
        if (oracle.isSingleSource(asset)) {
            return configured < SINGLE_SOURCE_LTV_FLOOR ? configured : SINGLE_SOURCE_LTV_FLOOR;
        }
        return configured;
    }
}
