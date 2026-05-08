import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const MockConfidentialToken = await ethers.getContractFactory("MockConfidentialToken");
  const token = await MockConfidentialToken.deploy();
  await token.waitForDeployment();

  console.log("MockConfidentialToken:", await token.getAddress());
}

main().catch(console.error);
