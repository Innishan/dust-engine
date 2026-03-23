export const DUST_ENGINE_ADDRESS =
  "0x603a1194C4f2963c0fd2D88eC17535a929098C94";

export const DUST_ENGINE_ABI = [
  {"inputs":[],"name":"FEE_PERCENT","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"FEE_WALLET","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"PERMIT2","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"WETH","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address[]","name":"tokens","type":"address[]"},{"internalType":"uint256[]","name":"amounts","type":"uint256[]"},{"internalType":"bytes[]","name":"permitSignatures","type":"bytes[]"},{"internalType":"address","name":"oneInchRouter","type":"address"},{"internalType":"bytes[]","name":"swapData","type":"bytes[]"}],"name":"cleanDust","outputs":[],"stateMutability":"nonpayable","type":"function"},{"stateMutability":"payable","type":"receive"}
];
