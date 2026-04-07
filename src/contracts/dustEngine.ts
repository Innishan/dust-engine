export const DUST_ENGINE_ADDRESS =
  "0x82d60C6fe0497619Cb2D9DdBcD08D88ff060A12b";

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
