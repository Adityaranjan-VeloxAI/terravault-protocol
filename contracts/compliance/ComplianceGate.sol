// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IRWAToken} from "../interfaces/IRWAToken.sol";

/**
 * @title ComplianceGate
 * @notice Minimal allowlist-based transfer gate implementing the {IRWAToken} hook surface.
 *         `canTransfer(from,to,amount)` returns true only when BOTH parties are allowlisted.
 *         Mints/burns (from or to == address(0)) are always allowed so token issuance and
 *         redemption are never blocked.
 *
 * @dev PROOF-OF-CONCEPT ONLY. This is NOT a full ERC-3643 / T-REX permissioned-token
 *      implementation: there is no identity registry, no claim/topic verification, no
 *      modular compliance rules, and no country/limit checks. It exists to demonstrate that
 *      the RWA token can defer transfer eligibility to an external, role-managed authority.
 *
 *      Uses scoped AccessControl (COMPLIANCE_ROLE) — no owner god-mode.
 */
contract ComplianceGate is AccessControl, IRWAToken {
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    /// @notice Whether an address has passed (mock) KYC/AML and may send/receive.
    mapping(address => bool) public allowlisted;

    event AllowlistUpdated(address indexed account, bool allowed);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(COMPLIANCE_ROLE, msg.sender);
    }

    /// @notice Add or remove a single account from the allowlist.
    function setAllowlisted(address account, bool allowed) external onlyRole(COMPLIANCE_ROLE) {
        allowlisted[account] = allowed;
        emit AllowlistUpdated(account, allowed);
    }

    /// @notice Batch allowlist update convenience for demo setup.
    function setAllowlistedBatch(address[] calldata accounts, bool allowed)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        for (uint256 i = 0; i < accounts.length; i++) {
            allowlisted[accounts[i]] = allowed;
            emit AllowlistUpdated(accounts[i], allowed);
        }
    }

    /**
     * @notice {IRWAToken} hook. Both counterparties must be allowlisted for a peer transfer.
     * @dev Issuance (from == 0) and redemption (to == 0) bypass the allowlist.
     */
    function canTransfer(address from, address to, uint256 /* amount */)
        external
        view
        returns (bool)
    {
        if (from == address(0) || to == address(0)) return true; // mint / burn
        return allowlisted[from] && allowlisted[to];
    }
}
