export const DUST_ENGINE_ADDRESS =
  "0x3c669ec616b1e5ec10f6b0d535e63508475f707b";

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
