// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IPriceFeedAdapter} from "../interfaces/IPriceFeedAdapter.sol";

/// @title GuardianOracleAdapter
/// @notice A single, role-gated price source. In the Terravault demo the
///         guardian keeper pushes reference prices here; the OracleAggregator
///         then reads this adapter (alongside a second independent adapter) and
///         applies deviation / staleness / single-source protections.
/// @dev SECURITY MODEL:
///      - Only holders of GUARDIAN_ROLE may write a price. There is deliberately
///        NO owner god-mode setter — price authorship is a scoped role so it can
///        be granted to a keeper key and revoked without touching admin control.
///      - Every write stamps `block.timestamp`, which is what lets the
///        aggregator detect a stale feed (a compromised or dead keeper simply
///        stops updating, and the aggregator ages it out).
///      - This adapter does NOT itself judge whether a price is sane. That is
///        intentional: sanity (deviation vs. a second source, circuit breaking)
///        lives in the OracleAggregator so that a single rogue adapter can never
///        be trusted in isolation.
contract GuardianOracleAdapter is IPriceFeedAdapter, AccessControl {
    /// @notice Role permitted to push prices. Granted to the guardian keeper.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    struct Feed {
        uint256 price; // 1e8 fixed-point USD price
        uint256 updatedAt; // unix timestamp of last write
    }

    /// @notice asset => latest guardian-reported feed.
    mapping(address => Feed) private _feeds;

    /// @notice Emitted on every accepted price write.
    /// @param asset     The priced asset.
    /// @param price     New 1e8 price.
    /// @param updatedAt Timestamp stamped for this write.
    event PriceUpdated(address indexed asset, uint256 price, uint256 updatedAt);

    /// @notice The deployer receives DEFAULT_ADMIN_ROLE and the initial GUARDIAN_ROLE.
    constructor() {
        address admin = msg.sender;
        // DEFAULT_ADMIN_ROLE can add/remove guardians but cannot itself write
        // prices — separation of duties between control-plane and data-plane.
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
    }

    /// @notice Push a new price for `asset`. Stamps the current block timestamp.
    /// @dev onlyRole(GUARDIAN_ROLE). Reverts on a zero price so the aggregator
    ///      never has to special-case a "0 means unset" sentinel from a live feed.
    /// @param asset The priced asset.
    /// @param price 1e8 fixed-point USD price (must be > 0).
    function updatePrice(address asset, uint256 price) external onlyRole(GUARDIAN_ROLE) {
        require(asset != address(0), "GOA: zero asset");
        require(price > 0, "GOA: zero price");

        _feeds[asset] = Feed({price: price, updatedAt: block.timestamp});
        emit PriceUpdated(asset, price, block.timestamp);
    }

    /// @inheritdoc IPriceFeedAdapter
    /// @dev Pure read of the last written feed. Freshness is NOT enforced here;
    ///      the aggregator ages the feed against its own `maxStaleness` so that a
    ///      single adapter's staleness policy can never silently gate the system.
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) {
        Feed storage f = _feeds[asset];
        return (f.price, f.updatedAt);
    }
}
