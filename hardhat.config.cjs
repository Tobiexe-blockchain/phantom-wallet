// Used only to run a local development chain: npx hardhat node
module.exports = {
  solidity: '0.8.24',
  networks: { hardhat: { chainId: 31337, mining: { auto: true } } },
};
