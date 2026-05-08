// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @title ConfidentialWETHWrapper
/// @notice Wraps any ERC-20 WETH into an ERC-7984 confidential token at 1:1.
///         Users deposit WETH and receive cWETH whose balance and transfers are
///         fully encrypted via FHEVM. Collateral is denominated in ETH — matching
///         the Chainlink ETH/USD oracle used by PerpetualFutures and OptionsPool.
///
/// Usage:
///   1. user calls weth.approve(wrapperAddress, amount)
///   2. user calls wrapper.wrap(userAddress, amount)
///      → WETH is held by this contract, cWETH is minted encrypted to user
///   3. To exit: wrapper.unwrap(userAddress, userAddress, encAmount, inputProof)
///      → cWETH burned, WETH returned
contract ConfidentialWETHWrapper is ZamaEthereumConfig, ERC7984ERC20Wrapper {
  constructor(
    IERC20 underlying
  ) ERC7984("Confidential WETH", "cWETH", "") ERC7984ERC20Wrapper(underlying) {}
}
