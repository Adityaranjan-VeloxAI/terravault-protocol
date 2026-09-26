// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IRWAToken
 * @notice Minimal compliance-hook surface for tokenized real-world assets.
 *         A permissioned RWA (ERC-3643-style) can defer transfer eligibility to an
 *         external authority via {canTransfer}. This is the hook {ComplianceGate}
 *         implements; it is intentionally a small subset of a full ERC-3643 token.
 */
interface IRWAToken {
    /**
     * @notice Returns whether a transfer of `amount` from `from` to `to` is permitted.
     * @dev Implementations should treat mint (from == address(0)) and burn
     *      (to == address(0)) as always allowed.
     */
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
}
