// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRiskEngine
/// @notice Risk / solvency oracle for Terravault positions. The CollateralVault
///         gates every fund-moving action through this surface.
/// @dev SCALING CONVENTIONS:
///      - Health factor (`hf`): 1e18 fixed point. HF 1.27 => 1.27e18.
///        Liquidation is permitted only when HF < 1e18.
///      - Borrow / borrowable amounts: mUSDC native units (6 decimals).
interface IRiskEngine {
    /// @notice Health factor for `user` scaled to 1e18.
    /// @dev sum(collateralValueUSD * liqThresholdBps) / debtUSD, scaled 1e18.
    ///      Returns type(uint256).max when the user has no debt.
    function getHealthFactor(address user) external view returns (uint256 hf);

    /// @notice Whether `user` may borrow `amount` more of the borrow asset while
    ///         posting `asset` as collateral.
    /// @return allowed True if the borrow is permitted.
    /// @return reason  Human-readable rejection reason ("" when allowed).
    function isBorrowAllowed(address user, address asset, uint256 amount)
        external
        view
        returns (bool allowed, string memory reason);

    /// @notice True when `user`'s health factor is below 1e18.
    function isLiquidatable(address user) external view returns (bool);

    /// @notice Maximum additional mUSDC (6 decimals) `user` may borrow right now.
    function maxBorrowable(address user) external view returns (uint256);
}
