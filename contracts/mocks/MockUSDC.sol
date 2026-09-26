// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice The protocol's borrow asset for the Terravault demo: "Mock USDC" (mUSDC).
 *         Uses 6 decimals to mirror real USDC. Treated as a $1.00 peg by the RiskEngine
 *         (debt is denominated in mUSDC and valued 1:1 against USD).
 *
 * @dev Public, unpermissioned `mint` is for DEMO / TESTNET ONLY. Never ship an open mint
 *      to production. Target chain: HashKey Testnet (chainId 133, gas token HSK).
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    /// @notice USDC-style 6 decimals (so 1 mUSDC == 1_000_000 base units).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet mint for the demo. amount is in 6-decimal base units.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
