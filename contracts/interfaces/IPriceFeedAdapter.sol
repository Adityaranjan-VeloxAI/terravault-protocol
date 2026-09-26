// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceFeedAdapter
/// @notice Common price-source surface for Terravault. BOTH the raw guardian
///         adapter AND the OracleAggregator implement this interface, so higher
///         layers can treat any price source uniformly.
/// @dev SCALING: `price` is a 1e8 fixed-point USD price (Chainlink convention).
///      e.g. $1.02 => 102_000_000. `updatedAt` is a unix timestamp (seconds).
///
///      TERRAVAULT INVARIANT: RiskEngine / CollateralVault MUST read prices
///      through the OracleAggregator implementation of this interface, never
///      through a raw adapter. Reading a raw adapter would bypass the deviation
///      check, staleness check and circuit breaker.
interface IPriceFeedAdapter {
    /// @notice Returns the latest known price for `asset` and when it was set.
    /// @param asset The collateral / priced asset address.
    /// @return price     1e8 fixed-point USD price.
    /// @return updatedAt Unix timestamp the price was last stamped.
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt);
}
