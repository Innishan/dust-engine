export const DUST_ENGINE_ADDRESS =
  "0xE1345815fc49E2852bC3D9c7091461E7c6b1C850";

export const DUST_ENGINE_ABI = [
  {
    name: "cleanDust",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "permitSignatures", type: "bytes[]" },
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "data", type: "bytes[]" }
    ],
    outputs: []
  }
];
