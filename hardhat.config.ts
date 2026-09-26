import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// TERRAVAULT — Hardhat configuration
//
// Target chain: HashKey Chain (gas token HSK — NEVER assume ETH / chainId 1).
//   - HashKey Testnet: chainId 133, RPC https://testnet.hsk.xyz (drpc.org needs a paid plan)
//   - HashKey Mainnet: chainId 177, RPC https://mainnet.hsk.xyz
//
// RPC URLs and private keys are pulled from .env (see .env.example).
// ---------------------------------------------------------------------------

const HASHKEY_TESTNET_RPC =
  process.env.HASHKEY_TESTNET_RPC || "https://testnet.hsk.xyz";
const HASHKEY_MAINNET_RPC =
  process.env.HASHKEY_MAINNET_RPC || "https://mainnet.hsk.xyz";

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY || "";

// Only pass well-formed private keys to Hardhat (avoids "invalid account" throws
// when a key is left blank during local compile/test).
function accounts(): string[] {
  const keys = [DEPLOYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY].filter(
    (k) => typeof k === "string" && /^0x?[0-9a-fA-F]{64}$/.test(k.replace(/^0x/, "0x"))
  );
  return keys.map((k) => (k.startsWith("0x") ? k : `0x${k}`));
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // viaIR keeps the larger vault/risk contracts under the stack limit.
      viaIR: true,
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    hashkeyTestnet: {
      url: HASHKEY_TESTNET_RPC,
      chainId: 133,
      accounts: accounts(),
    },
    hashkeyMainnet: {
      url: HASHKEY_MAINNET_RPC,
      chainId: 177,
      accounts: accounts(),
    },
  },
  // Block explorer verification (HashKey uses a Blockscout instance).
  etherscan: {
    apiKey: {
      hashkeyTestnet: process.env.HASHKEY_EXPLORER_API_KEY || "empty",
      hashkeyMainnet: process.env.HASHKEY_EXPLORER_API_KEY || "empty",
    },
    customChains: [
      {
        network: "hashkeyTestnet",
        chainId: 133,
        urls: {
          apiURL: "https://hashkeychain-testnet-explorer.alt.technology/api",
          browserURL: "https://hashkeychain-testnet-explorer.alt.technology",
        },
      },
      {
        network: "hashkeyMainnet",
        chainId: 177,
        urls: {
          apiURL: "https://explorer.hsk.xyz/api",
          browserURL: "https://explorer.hsk.xyz",
        },
      },
    ],
  },
  mocha: {
    timeout: 120000,
  },
};

export default config;
