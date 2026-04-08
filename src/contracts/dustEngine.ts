export const DUST_ENGINE_ADDRESS =
  "0x32416A874b999E98B0C064f9Af32b679Fa1bfA02";

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
