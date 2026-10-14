import assert from "node:assert/strict";
import { mergeTokenLogoURI, resolveTokenLogoURI, tokenLogoKey, tokenLogoMapFromMetadata, usableTokenLogoUrl } from "../src/tokenLogo";

assert.equal(tokenLogoKey(8453, "0xAbCd"), "8453:0xabcd");
assert.equal(tokenLogoKey(1, "0xAbCd"), "1:0xabcd", "logo identity includes the network");
assert.equal(usableTokenLogoUrl("https://assets.example/token.png"), true);
assert.equal(usableTokenLogoUrl("http://assets.example/token.png"), true);
assert.equal(usableTokenLogoUrl("javascript:alert(1)"), false);
assert.equal(usableTokenLogoUrl("data:image/svg+xml,anything"), false);
assert.equal(usableTokenLogoUrl("not a URL"), false);
assert.equal(usableTokenLogoUrl(undefined), false, "missing or invalid logo URLs use the component fallback");
assert.equal(
  resolveTokenLogoURI(8453, "0xAbCd", undefined, { "0xabcd": "https://assets.example/base-token.png" }),
  "https://assets.example/base-token.png",
  "logo metadata returned in the API's address map is resolved by chain and normalized address",
);
assert.equal(resolveTokenLogoURI(1, "0xAbCd", undefined, { "0xabcd": "https://assets.example/base-token.png" }), undefined);
assert.equal(mergeTokenLogoURI(undefined, "https://assets.example/merged.png"), "https://assets.example/merged.png", "candidate deduplication retains an incoming logo when the earlier record lacks one");
assert.equal(mergeTokenLogoURI("bad-url", "javascript:alert(1)"), undefined);
assert.deepEqual(tokenLogoMapFromMetadata(8453, [
  { chainId: 8453, address: "0x1111111111111111111111111111111111111111", symbol: "SHARED", logoURI: "https://assets.example/base.png" },
  { chainId: 1, address: "0x2222222222222222222222222222222222222222", symbol: "SHARED", logoURI: "https://assets.example/eth.png" },
  { chainId: 8453, address: "not-an-address", logoURI: "https://assets.example/invalid.png" },
  { chainId: 8453, address: "0x3333333333333333333333333333333333333333", logoURI: "" },
]), {
  "8453:0x1111111111111111111111111111111111111111": "https://assets.example/base.png",
}, "LI.FI fallback maps logos only by chain ID and contract address");

console.log("token logo tests passed");
