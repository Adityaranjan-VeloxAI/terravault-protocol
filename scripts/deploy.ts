import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ===========================================================================
// TERRAVAULT — deployment script
//
// Deploys the full protocol in dependency order, wires scoped AccessControl
// roles (no owner god-mode), and writes deployments/<network>.json (+ latest).
//
// Dependency order:
//   1. MockRWAToken (bMTB, 18dp)          tokens/MockRWAToken.sol
//   2. MockUSDC     (mUSDC, 6dp)          mocks/MockUSDC.sol
//   3. GuardianOracleAdapter x2 (A,B)     oracle/GuardianOracleAdapter.sol
//   4. OracleAggregator                   oracle/OracleAggregator.sol
//   5. AssetQualityRegistry(aggregator)   risk/AssetQualityRegistry.sol
//   6. RiskEngine(registry, aggregator, mUSDC)   risk/RiskEngine.sol
//   7. CollateralVault(riskEngine, registry, aggregator, mUSDC)  vault/CollateralVault.sol
//   8. ComplianceGate (optional PoC)      compliance/ComplianceGate.sol
//   9. riskEngine.setCollateralVault(vault)   (breaks the vault<->engine cycle)
//
// Assumed constructor signatures (the contracts MUST match these; documented
// so the Solidity and script stay in lock-step):
//   MockRWAToken()                         // name/symbol/decimals fixed in ctor
//   MockUSDC()
//   GuardianOracleAdapter()                // grants GUARDIAN_ROLE + admin to deployer
//   OracleAggregator()                     // grants DEFAULT_ADMIN_ROLE + GUARDIAN_ROLE to deployer
//   AssetQualityRegistry(address aggregator)
//   RiskEngine(address registry, address aggregator, address borrowAsset)
//     + setCollateralVault(address vault)  // onlyRole(DEFAULT_ADMIN_ROLE)
//   CollateralVault(address riskEngine, address registry, address aggregator, address borrowToken)
//   ComplianceGate()
// ===========================================================================

// keccak256 role ids (OpenZeppelin AccessControl).
const DEFAULT_ADMIN_ROLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const GUARDIAN_ROLE = ethers.id("GUARDIAN_ROLE");
const PAUSER_ROLE = ethers.id("PAUSER_ROLE");
const KEEPER_ROLE = ethers.id("KEEPER_ROLE");

function line() {
  console.log("─".repeat(74));
}

async function main() {
  const [deployer] = await ethers.getSigners();

  // Resolve the keeper address. Prefer the explicit KEEPER_PRIVATE_KEY so the
  // off-chain pusher/agent (which sign with that key) get the scoped roles.
  let keeperAddress: string;
  const keeperPk = process.env.KEEPER_PRIVATE_KEY || "";
  // Accept a 64-hex key with or without 0x (MetaMask exports it without).
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(keeperPk.trim())) {
    keeperAddress = new ethers.Wallet(
      keeperPk.startsWith("0x") ? keeperPk : `0x${keeperPk}`
    ).address;
  } else {
    const signers = await ethers.getSigners();
    keeperAddress = signers[1]?.address ?? deployer.address;
    console.warn(
      "⚠  KEEPER_PRIVATE_KEY not set — falling back to a local signer for the keeper role."
    );
  }

  line();
  console.log("TERRAVAULT deployment");
  console.log(`  network  : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`  deployer : ${deployer.address}`);
  console.log(`  keeper   : ${keeperAddress}`);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`  balance  : ${ethers.formatEther(bal)} HSK`);
  line();

  // --- 1. Tokens -----------------------------------------------------------
  const bMTB = await (await ethers.getContractFactory("MockRWAToken")).deploy();
  await bMTB.waitForDeployment();
  const bMTBAddr = await bMTB.getAddress();
  console.log(`MockRWAToken (bMTB)      : ${bMTBAddr}`);

  const mUSDC = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await mUSDC.waitForDeployment();
  const mUSDCAddr = await mUSDC.getAddress();
  console.log(`MockUSDC (mUSDC)         : ${mUSDCAddr}`);

  // --- 2. Oracle adapters (two independent guardian feeds) -----------------
  const adapterA = await (
    await ethers.getContractFactory("GuardianOracleAdapter")
  ).deploy();
  await adapterA.waitForDeployment();
  const adapterAAddr = await adapterA.getAddress();
  console.log(`GuardianOracleAdapter A : ${adapterAAddr}`);

  const adapterB = await (
    await ethers.getContractFactory("GuardianOracleAdapter")
  ).deploy();
  await adapterB.waitForDeployment();
  const adapterBAddr = await adapterB.getAddress();
  console.log(`GuardianOracleAdapter B : ${adapterBAddr}`);

  // --- 3. Oracle aggregator ------------------------------------------------
  const aggregator = await (
    await ethers.getContractFactory("OracleAggregator")
  ).deploy();
  await aggregator.waitForDeployment();
  const aggregatorAddr = await aggregator.getAddress();
  console.log(`OracleAggregator        : ${aggregatorAddr}`);

  // --- 4. Asset quality registry (holds the aggregator ref) ----------------
  const registry = await (
    await ethers.getContractFactory("AssetQualityRegistry")
  ).deploy(aggregatorAddr);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`AssetQualityRegistry    : ${registryAddr}`);

  // --- 5. Risk engine (registry, aggregator, borrow asset) -----------------
  const riskEngine = await (
    await ethers.getContractFactory("RiskEngine")
  ).deploy(registryAddr, aggregatorAddr, mUSDCAddr);
  await riskEngine.waitForDeployment();
  const riskEngineAddr = await riskEngine.getAddress();
  console.log(`RiskEngine              : ${riskEngineAddr}`);

  // --- 6. Collateral vault -------------------------------------------------
  const vault = await (
    await ethers.getContractFactory("CollateralVault")
  ).deploy(riskEngineAddr, registryAddr, aggregatorAddr, mUSDCAddr);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`CollateralVault         : ${vaultAddr}`);

  // --- 7. Compliance gate (optional PoC) -----------------------------------
  let complianceGateAddr = ethers.ZeroAddress;
  try {
    const gate = await (
      await ethers.getContractFactory("ComplianceGate")
    ).deploy();
    await gate.waitForDeployment();
    complianceGateAddr = await gate.getAddress();
    console.log(`ComplianceGate          : ${complianceGateAddr}`);
  } catch {
    console.log("ComplianceGate          : (skipped — contract not present)");
  }

  line();
  console.log("Wiring cross-references and roles…");

  // --- 8. Break the vault <-> engine cycle ---------------------------------
  await (await riskEngine.setVault(vaultAddr)).wait();
  console.log("  riskEngine.setVault(vault)                         ✓");

  // --- 9. Scoped roles (no owner god-mode) ---------------------------------
  // Keeper drives both guardian feeds + the aggregator poke/clearBreaker.
  await (await adapterA.grantRole(GUARDIAN_ROLE, keeperAddress)).wait();
  await (await adapterB.grantRole(GUARDIAN_ROLE, keeperAddress)).wait();
  await (await aggregator.grantRole(GUARDIAN_ROLE, keeperAddress)).wait();
  console.log("  GUARDIAN_ROLE -> keeper (adapterA, adapterB, aggregator)  ✓");

  // The risk-monitor agent (keeper key) gets KEEPER_ROLE only. It holds no pause
  // power: running out of buffer must never freeze the whole vault.
  for (const [label, role] of [["KEEPER_ROLE", KEEPER_ROLE]] as const) {
    try {
      await (await (vault as any).grantRole(role, keeperAddress)).wait();
      console.log(`  ${label} -> keeper (vault)                        ✓`);
    } catch {
      console.log(`  ${label} -> keeper (vault)  (role not defined, skipped)`);
    }
  }

  // Deployer is the demo user (front-end connects this wallet).
  const demoUser = deployer.address;

  // --- 10. Persist addresses ----------------------------------------------
  const deployment = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 0),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    keeper: keeperAddress,
    demoUser,
    roles: {
      DEFAULT_ADMIN_ROLE,
      GUARDIAN_ROLE,
      PAUSER_ROLE,
      KEEPER_ROLE,
    },
    contracts: {
      bMTB: bMTBAddr,
      mUSDC: mUSDCAddr,
      adapterA: adapterAAddr,
      adapterB: adapterBAddr,
      aggregator: aggregatorAddr,
      registry: registryAddr,
      riskEngine: riskEngineAddr,
      vault: vaultAddr,
      complianceGate: complianceGateAddr,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const byNetwork = path.join(outDir, `${network.name}.json`);
  const latest = path.join(outDir, "latest.json");
  fs.writeFileSync(byNetwork, JSON.stringify(deployment, null, 2));
  fs.writeFileSync(latest, JSON.stringify(deployment, null, 2));

  line();
  console.log("Deployment complete. Addresses written to:");
  console.log(`  ${byNetwork}`);
  console.log(`  ${latest}`);
  line();
  console.log(JSON.stringify(deployment.contracts, null, 2));
  line();
  console.log("Next: npm run seed   (mint + configure bMTB + open demo position)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
