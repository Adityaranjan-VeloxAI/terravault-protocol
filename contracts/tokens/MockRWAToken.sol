// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IRWAToken} from "../interfaces/IRWAToken.sol";

/**
 * @title MockRWAToken
 * @notice Mock Tokenized T-Bill "bMTB" — the Tier-1 collateral asset for the Terravault demo.
 *         Standard 18-decimal ERC20 with an open `mint` faucet for the demo.
 *
 * @dev Implements the optional {IRWAToken} compliance hook surface. A ComplianceGate can be
 *      wired in via {setComplianceGate}; when set, peer-to-peer transfers are gated by
 *      `canTransfer(from,to,amount)`. When unset (the default), all transfers pass, so the
 *      demo can run without allowlisting. Mints and burns (to/from address(0)) are never gated.
 *
 *      This is a proof-of-concept transfer restriction, NOT a full ERC-3643 permissioned token.
 *
 *      Public, unpermissioned `mint` is for DEMO / TESTNET ONLY.
 */
contract MockRWAToken is ERC20, AccessControl, IRWAToken {
    /// @notice Optional compliance gate. address(0) => no restriction (all transfers allowed).
    IRWAToken public complianceGate;

    event ComplianceGateSet(address indexed gate);

    constructor() ERC20("Mock T-Bill", "bMTB") {
        // Deployer is admin. Uses scoped AccessControl (no owner god-mode).
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice 18 decimals (default for ERC20; declared explicitly for clarity).
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice Open faucet mint for the demo. amount is in 18-decimal base units.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Wire in (or clear) an optional compliance gate. Pass address(0) to disable gating.
    function setComplianceGate(address gate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        complianceGate = IRWAToken(gate);
        emit ComplianceGateSet(gate);
    }

    /**
     * @notice IRWAToken hook. Returns whether a peer-to-peer transfer is currently permitted.
     * @dev With no gate configured this is always true. Otherwise it delegates to the gate.
     */
    function canTransfer(address from, address to, uint256 amount) public view returns (bool) {
        if (address(complianceGate) == address(0)) return true;
        return complianceGate.canTransfer(from, to, amount);
    }

    /**
     * @dev Enforce the compliance hook on real transfers only. Minting (from == 0) and
     *      burning (to == 0) are exempt so the demo faucet and any burns are never blocked.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            require(canTransfer(from, to, value), "MockRWAToken: transfer not permitted");
        }
        super._update(from, to, value);
    }
}
