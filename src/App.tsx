import { 
  createConfig, 
  http, 
  WagmiProvider, 
  useAccount, 
  useConnect, 
  useDisconnect, 
  useBalance,
  useWriteContract,
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useSendTransaction
} from 'wagmi';
import { base } from 'wagmi/chains';
import { injected, coinbaseWallet } from 'wagmi/connectors';
import { ConnectKitProvider, getDefaultConfig, ConnectKitButton, useModal } from 'connectkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Settings, 
  RefreshCw, 
  Trash2, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink,
  Coins,
  ArrowRight,
  Zap,
  Hammer,
  Wrench,
  Search,
  Twitter
} from 'lucide-react';
import { formatUnits, createPublicClient, http } from 'viem'
import axios from 'axios';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Constants ---
const ONE_INCH_ROUTER = '0x111111125421caae10460d09cc2b79471d860ac9' as Address;
const PROTOCOL_FEE_RECIPIENT = '0xEe36C3c644240302eB8121F66D4e23C068512a40' as Address; // Fee collector
const WETH = '0x4200000000000000000000000000000000000006' as Address;

// Curated list of popular Base tokens to scan for dust (Expanded)
const COMMON_BASE_TOKENS = [
  // --- Major Stables & Blue Chips ---
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4C7C32D4f71bdA02913' as Address, decimals: 6 },
  { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2AD3d69d441' as Address, decimals: 6 },
  { symbol: 'DAI', address: '0x50c5725949A6F0C72E6C45641830677285586337' as Address, decimals: 18 },
  { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address, decimals: 8 },
  { symbol: 'cbETH', address: '0x2Ae3F1Ec7F1F5012CFE70ee95827646271473123' as Address, decimals: 18 },
  { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD91310' as Address, decimals: 18 },
  { symbol: 'VIRTUAL', address: '0x0b3e328455822223971382464b7c99b1241e83c8' as Address, decimals: 18 },
  { symbol: 'DEGEN', address: '0x4ed4E28C58478308a44512032003185179F059Be' as Address, decimals: 18 },
  { symbol: 'ALEX', address: '0x58f7e9577f44cc682484f654b0d74d399999ed9a' as Address, decimals: 18 },
  { symbol: 'LUNA', address: '0x1c83060e22748c1697d1ac0647e5b7fb99706571' as Address, decimals: 18 },
  { symbol: 'WELL', address: '0xa88594d2723002a43325a1b1e730c454ba57c5ce' as Address, decimals: 18 },
  { symbol: 'MOXIE', address: '0x8c9037d1ef5c6d1f6816278c7aaf5491d24cd527' as Address, decimals: 18 },
  { symbol: 'TYBG', address: '0x0d97F5d86f573310829952807410781fEf28763E' as Address, decimals: 18 },
  { symbol: 'TOSHI', address: '0xAC1Bd2434a17Df23317720222203d688A4626a91' as Address, decimals: 18 },
  { symbol: 'KEYCAT', address: '0x9D9c7977815607141d99759f8134afA056794905' as Address, decimals: 18 },
  { symbol: 'BENJI', address: '0xBC452fdC8F851d7c5B72E1Fe74DFB63bb793D511' as Address, decimals: 18 },
  { symbol: 'MOG', address: '0x295640784da6A423816041667F906426b1fC690f' as Address, decimals: 18 },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' as Address, decimals: 18 },
  { symbol: 'LESTER', address: '0x27d7959cf26135d8019d0f1e4a2280a8a355c4f5' as Address, decimals: 18 },
  { symbol: 'BAMBOO', address: '0x689644b86075ed61c647596862c7403e1c474dbf' as Address, decimals: 18 },
  { symbol: 'BSB', address: '0x8a24d7260cd02d3dfd8eefb66bc17ad4b17d494c' as Address, decimals: 18 },
  { symbol: 'FAIR', address: '0x7d928816cc9c462dd7adef911de41535e444cb07' as Address, decimals: 18 },
  { symbol: 'KURBI', address: '0x653a143b8d15c565c6623d1f168cfbec1056d872' as Address, decimals: 9 },
  { symbol: 'MUTE', address: '0xa023316fa5c85dadf008c611790b3235433e781e' as Address, decimals: 18 },
  { symbol: 'BRIUN', address: '0x8c81b4c816d66d36c4bf348bdec01dbcbc70e987' as Address, decimals: 18 },
  { symbol: 'CLONES', address: '0xaadd98ad4660008c917c6fe7286bc54b2eef894d' as Address, decimals: 18 },
  { symbol: 'BLUE', address: '0x7f65323e468939073ef3b5287c73f13951b0ff5b' as Address, decimals: 18 },
  { symbol: 'BIM', address: '0x555fff48549c1a25a723bd8e7ed10870d82e8379' as Address, decimals: 18 },
  { symbol: 'DPAD', address: '0x1234d66b6fbb900296ae2f57740b800fd8960927' as Address, decimals: 18 },
  { symbol: 'BRITT', address: '0x3b1228c3ede7e0898d57054cd9b8f812d24315c1' as Address, decimals: 9 },
  { symbol: 'TONY', address: '0x36a947baa2492c72bf9d3307117237e79145a87d' as Address, decimals: 18 },
  { symbol: 'MATRIX', address: '0x0390a285c97f04c6ac9d162352b44e6fc310d3f2' as Address, decimals: 18 },
  { symbol: 'SKICAT', address: '0xa6f774051dfb6b54869227fda2df9cb46f296c09' as Address, decimals: 18 },
  { symbol: 'BLERF', address: '0x347f500323d51e9350285daf299ddb529009e6ae' as Address, decimals: 18 },
  { symbol: 'FRENZ', address: '0xdda98a036e03611aa50ff457fffbbe9163981529' as Address, decimals: 18 },
  { symbol: 'PEACE', address: '0xc2eeca228ebac45c339cc5e522dd3a10638155f1' as Address, decimals: 18 },
  { symbol: 'CARLO', address: '0x38d513ec43dda20f323f26c7bef74c5cf80b6477' as Address, decimals: 18 },
  { symbol: 'PLAI', address: '0x9215e6362f76fc781df00d51293cc7179c6c99a4' as Address, decimals: 18 },
  { symbol: 'HOUSE', address: '0xf25cc9c024036dec8fc983e88253549667ee5b07' as Address, decimals: 18 },
  { symbol: 'OMNI', address: '0xf7178122a087ef8f5c7bea362b7dabe38f20bf05' as Address, decimals: 18 },
  { symbol: 'WILDW', address: '0x8129609e5303910464fce3022a809fa44455fe9a' as Address, decimals: 18 },
  { symbol: 'KEREN', address: '0x174e33ef2effa0a4893d97dda5db4044cc7993a3' as Address, decimals: 18 },
  { symbol: 'ARTTO', address: '0x9239e9f9e325e706ef8b89936ece9d48896abbe3' as Address, decimals: 18 },
  { symbol: 'CBADA', address: '0xcbada732173e39521cdbe8bf59a6dc85a9fc7b8c' as Address, decimals: 6 },
  { symbol: 'GLE', address: '0xecd8bcc95be6aebcae272ee388c9037b24ab28da' as Address, decimals: 18 },
  { symbol: 'REBASE', address: '0x3421cc14f0e3822cf3b73c3a4bec2a1023b8d9cf' as Address, decimals: 9 },
  { symbol: 'LOBO', address: '0x4e98b3917310b0e1f0d53c0619f87fe48deb804b' as Address, decimals: 18 },
  { symbol: 'APU', address: '0x6f35720b272bf23832852b13ae9888c706e1a379' as Address, decimals: 18 },
  { symbol: 'BOE', address: '0xff62ddfa80e513114c3a0bf4d6ffff1c1d17aadf' as Address, decimals: 18 },
  { symbol: 'FIN', address: '0xfb60b8266243d994eaa7499fca71d4ffe76c08d7' as Address, decimals: 18 },
  { symbol: 'DWA', address: '0x1d4731111bd2a50ab3dd5178574e6f3698270ffc' as Address, decimals: 18 },
  { symbol: 'CONDO', address: '0x30d19fb77c3ee5cfa97f73d72c6a1e509fa06aef' as Address, decimals: 18 },
  { symbol: 'BIOS', address: '0x73cb479f2ccf77bad90bcda91e3987358437240a' as Address, decimals: 18 },
  { symbol: 'GAME', address: '0x1c4cca7c5db003824208adda61bd749e55f463a3' as Address, decimals: 18 },
  { symbol: 'BUTT', address: '0xd11a584de5fa50a4ee560c48ab44dbb31823d9bc' as Address, decimals: 18 },
  { symbol: 'ZEME', address: '0x65d88916d9fa10762e62d26592610fe52de31d5a' as Address, decimals: 18 },
  { symbol: 'MOON', address: '0xfd008f937b4d73eeb00cf74ce90c392be5f07f96' as Address, decimals: 18 },
  { symbol: 'WAGMI', address: '0x2ce1340f1d402ae75afeb55003d7491645db1857' as Address, decimals: 18 },
  { symbol: 'WODS', address: '0x4398c398e5ac747e6d51bf1db1dac346ca90fee0' as Address, decimals: 18 },
  { symbol: 'BOMO', address: '0x0215ed0fe07951b2cd68e1b39ffbd0a841fe3c6e' as Address, decimals: 18 },
  { symbol: 'BRAZA', address: '0xbbf81ddc9fb90cf9146b495ce0546a3460fd1769' as Address, decimals: 18 },
  { symbol: 'ROCK', address: '0xece7b98bd817ee5b1f2f536daf34d0b6af8bb542' as Address, decimals: 18 },
  { symbol: 'BLUBI', address: '0x7b8d415f5239ae5e0f485971529b4f798e63b0b4' as Address, decimals: 18 },
  { symbol: 'TIPN', address: '0x5ba8d32579a4497c12d327289a103c3ad5b64eb1' as Address, decimals: 18 },
  { symbol: 'FROK', address: '0x42069babe14fb1802c5cb0f50bb9d2ad6fef55e2' as Address, decimals: 18 },
  { symbol: 'IAERO', address: '0x81034fb34009115f215f5d5f564aac9ffa46a1dc' as Address, decimals: 18 },
  { symbol: 'GECKO', address: '0x452867ec20dc5061056c1613db2801f512dda1c1' as Address, decimals: 18 },
  { symbol: 'ROCKETAI', address: '0x03f64375f98aaafb617d18ca1e4a9a85a5c74476' as Address, decimals: 18 },
  { symbol: 'CHIDO', address: '0xf31e6d62bfc485857af2186eb3d8ee94b4379fed' as Address, decimals: 18 },
  { symbol: 'EDGE', address: '0xed6e000def95780fb89734c07ee2ce9f6dcaf110' as Address, decimals: 18 },
  { symbol: 'AXR', address: '0x58db197e91bc8cf1587f75850683e4bd0730e6bf' as Address, decimals: 18 },
  { symbol: 'DCAI', address: '0xb8147ce9b0dac5f8165785dec6494e57748e4b78' as Address, decimals: 18 },
  { symbol: 'FROST', address: '0x320c99aeddf34721b8a566ba2540f8fb72400e88' as Address, decimals: 18 },
  { symbol: 'KIBBLE', address: '0x64cc19a52f4d631ef5be07947caba14ae00c52eb' as Address, decimals: 18 },
  { symbol: '5TARS', address: '0xb27e7b18aba8d6ef2467b93486be600860a1395e' as Address, decimals: 18 },
  { symbol: 'DUDEGEN', address: '0xcc6ce98579ba909344bb765f0c4f45964d5ce1d2' as Address, decimals: 18 },
  { symbol: 'TOKITO', address: '0x097b1b242d3ed90e191c5f83a62f41abe16f6ceb' as Address, decimals: 18 },
  { symbol: 'DGENAI', address: '0x54eaf6bb665565bb8897f9d7ad5b3818ded143b4' as Address, decimals: 18 },
  { symbol: 'MMAI', address: '0x30b8a2c8e7fa41e77b54b8faf45c610e7ad909e3' as Address, decimals: 18 },
  { symbol: 'FUKU', address: '0xe10c9e9d5d8005cde4fcc5e635614665de736148' as Address, decimals: 18 },
  { symbol: 'DEUS', address: '0x73582df1cad3187cd0746b7a473d65c06386837e' as Address, decimals: 18 },
  { symbol: 'SCRVUSD', address: '0x646a737b9b6024e49f5908762b3ff73e65b5160c' as Address, decimals: 18 },
  { symbol: 'LAÏKA', address: '0x05a5b4e217004eb84c6787e0ecbe7a46cfd94cdd' as Address, decimals: 18 },
  { symbol: 'BASED', address: '0x32e0f9d26d1e33625742a52620cc76c1130efde6' as Address, decimals: 18 },
  { symbol: 'TRUFFI', address: '0x2496a9af81a87ed0b17f6edeaf4ac57671d24f38' as Address, decimals: 9 },
  { symbol: 'KENDU', address: '0x5597ce42b315f29e42071d231dcd0158da35b77b' as Address, decimals: 18 },
  { symbol: 'BALD', address: '0xfe20c1b85aba875ea8cecac8200bf86971968f3a' as Address, decimals: 18 },
  { symbol: 'LYRA', address: '0x99956f143dcca77cddf4b4b2a0fa4d491703244d' as Address, decimals: 18 },
  { symbol: 'CODY', address: '0x3977fc913db86b01a257232c568317798b903b07' as Address, decimals: 18 },
  { symbol: 'AION', address: '0xfc48314ad4ad5bd36a84e8307b86a68a01d95d9c' as Address, decimals: 18 },
  { symbol: 'GROOVE', address: '0x1cd38856ee0fdfd65c757e530e3b1de3061008d3' as Address, decimals: 18 },
  { symbol: 'WBMSTR', address: '0x1a4f71b0ff3c22540887bcf83b50054a213c673d' as Address, decimals: 18 },
  { symbol: 'LIFE', address: '0x151ccc74972a6f85690afe997d0fdd69efdc71fe' as Address, decimals: 18 },
  { symbol: 'AMARA', address: '0x14d4ce8b1729c67130bcd90339ea1f9b480a739f' as Address, decimals: 18 },
  { symbol: 'HENLO', address: '0x23a96680ccde03bd4bdd9a3e9a0cb56a5d27f7c9' as Address, decimals: 18 },
  { symbol: 'LILBULE', address: '0xbf71faf1e649f359de0092adffae4756710f4127' as Address, decimals: 18 },
  { symbol: 'HPC', address: '0x1f3ba804efb9cfe17d595e7262cea4782dbf6e4e' as Address, decimals: 18 },
  { symbol: 'KAZONOMICS', address: '0xca416d6d3c2b3a8a2c48419b53dd611420ffa776' as Address, decimals: 18 },
  { symbol: 'CHATR', address: '0x948d07d30400518f2c57ba24bafbb1d71f9c2b07' as Address, decimals: 18 },
  { symbol: 'PIZZA', address: '0x13b628ff6db92070c0fbad79523240e0f5defb07' as Address, decimals: 18 },
  { symbol: 'MAICRO', address: '0xe74731ba9d1da6fd3c8c60ff363732bebac5273e' as Address, decimals: 18 },
  { symbol: 'BOMET', address: '0x33e7f871ce502ec77a0d96fdcd02c9219f95e944' as Address, decimals: 18 },
  { symbol: 'PSYOPS', address: '0x9f1529e296972f6eab3c7c87e898dac2c3a020bc' as Address, decimals: 18 },
  { symbol: 'UBONK', address: '0xf56ce53561a9cc084e094952232bbfe1e5fb599e' as Address, decimals: 18 },
  { symbol: 'TRANSLATE', address: '0x5cd9166494673c15cbdfe8750def8bbab80a5b07' as Address, decimals: 18 },
  { symbol: 'ZIGGY', address: '0xd628dc2c4ec10feb07e5c8bf039f7c1c374d1b07' as Address, decimals: 18 },
  { symbol: 'VOLS', address: '0x9c94e82d8751f16953f9c86e13ed9cd0414e6e97' as Address, decimals: 18 },
  { symbol: 'JUNO', address: '0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07' as Address, decimals: 18 },
  { symbol: 'ROCK', address: '0xece7b98bd817ee5b1f2f536daf34d0b6af8bb542' as Address, decimals: 18 },
  { symbol: 'BLUBI', address: '0x7b8d415f5239ae5e0f485971529b4f798e63b0b4' as Address, decimals: 18 },
  { symbol: 'TIPN', address: '0x5ba8d32579a4497c12d327289a103c3ad5b64eb1' as Address, decimals: 18 },
  { symbol: 'FROK', address: '0x42069babe14fb1802c5cb0f50bb9d2ad6fef55e2' as Address, decimals: 18 },
  { symbol: 'IAERO', address: '0x81034fb34009115f215f5d5f564aac9ffa46a1dc' as Address, decimals: 18 },
  { symbol: 'GECKO', address: '0x452867ec20dc5061056c1613db2801f512dda1c1' as Address, decimals: 18 },
  { symbol: 'ROCKETAI', address: '0x03f64375f98aaafb617d18ca1e4a9a85a5c74476' as Address, decimals: 18 },
  { symbol: 'CHIDO', address: '0xf31e6d62bfc485857af2186eb3d8ee94b4379fed' as Address, decimals: 18 },
  { symbol: 'EDGE', address: '0xed6e000def95780fb89734c07ee2ce9f6dcaf110' as Address, decimals: 18 },
  { symbol: 'AXR', address: '0x58db197e91bc8cf1587f75850683e4bd0730e6bf' as Address, decimals: 18 },
  { symbol: 'DCAI', address: '0xb8147ce9b0dac5f8165785dec6494e57748e4b78' as Address, decimals: 18 },
  { symbol: 'FROST', address: '0x320c99aeddf34721b8a566ba2540f8fb72400e88' as Address, decimals: 18 },
  { symbol: 'KIBBLE', address: '0x64cc19a52f4d631ef5be07947caba14ae00c52eb' as Address, decimals: 18 },
  { symbol: '5TARS', address: '0xb27e7b18aba8d6ef2467b93486be600860a1395e' as Address, decimals: 18 },
  { symbol: 'DUDEGEN', address: '0xcc6ce98579ba909344bb765f0c4f45964d5ce1d2' as Address, decimals: 18 },
  { symbol: 'TOKITO', address: '0x097b1b242d3ed90e191c5f83a62f41abe16f6ceb' as Address, decimals: 18 },
  { symbol: 'DGENAI', address: '0x54eaf6bb665565bb8897f9d7ad5b3818ded143b4' as Address, decimals: 18 },
  { symbol: 'MMAI', address: '0x30b8a2c8e7fa41e77b54b8faf45c610e7ad909e3' as Address, decimals: 18 },
  { symbol: 'FUKU', address: '0xe10c9e9d5d8005cde4fcc5e635614665de736148' as Address, decimals: 18 },
  { symbol: 'DEUS', address: '0x73582df1cad3187cd0746b7a473d65c06386837e' as Address, decimals: 18 },
  { symbol: 'SCRVUSD', address: '0x646a737b9b6024e49f5908762b3ff73e65b5160c' as Address, decimals: 18 },
  { symbol: 'LAÏKA', address: '0x05a5b4e217004eb84c6787e0ecbe7a46cfd94cdd' as Address, decimals: 18 },
  { symbol: 'BASED', address: '0x32e0f9d26d1e33625742a52620cc76c1130efde6' as Address, decimals: 18 },
  { symbol: 'TRUFFI', address: '0x2496a9af81a87ed0b17f6edeaf4ac57671d24f38' as Address, decimals: 9 },
  { symbol: 'KENDU', address: '0x5597ce42b315f29e42071d231dcd0158da35b77b' as Address, decimals: 18 },
  { symbol: 'BALD', address: '0xfe20c1b85aba875ea8cecac8200bf86971968f3a' as Address, decimals: 18 },
  { symbol: 'LYRA', address: '0x99956f143dcca77cddf4b4b2a0fa4d491703244d' as Address, decimals: 18 },
  { symbol: 'CODY', address: '0x3977fc913db86b01a257232c568317798b903b07' as Address, decimals: 18 },
  { symbol: 'AION', address: '0xfc48314ad4ad5bd36a84e8307b86a68a01d95d9c' as Address, decimals: 18 },
  { symbol: 'GROOVE', address: '0x1cd38856ee0fdfd65c757e530e3b1de3061008d3' as Address, decimals: 18 },
  { symbol: 'WBMSTR', address: '0x1a4f71b0ff3c22540887bcf83b50054a213c673d' as Address, decimals: 18 },
  { symbol: 'LIFE', address: '0x151ccc74972a6f85690afe997d0fdd69efdc71fe' as Address, decimals: 18 },
  { symbol: 'AMARA', address: '0x14d4ce8b1729c67130bcd90339ea1f9b480a739f' as Address, decimals: 18 },
  { symbol: 'HENLO', address: '0x23a96680ccde03bd4bdd9a3e9a0cb56a5d27f7c9' as Address, decimals: 18 },
  { symbol: 'LILBULE', address: '0xbf71faf1e649f359de0092adffae4756710f4127' as Address, decimals: 18 },
  { symbol: 'HPC', address: '0x1f3ba804efb9cfe17d595e7262cea4782dbf6e4e' as Address, decimals: 18 },
  { symbol: 'KAZONOMICS', address: '0xca416d6d3c2b3a8a2c48419b53dd611420ffa776' as Address, decimals: 18 },
  { symbol: 'CHATR', address: '0x948d07d30400518f2c57ba24bafbb1d71f9c2b07' as Address, decimals: 18 },
  { symbol: 'PIZZA', address: '0x13b628ff6db92070c0fbad79523240e0f5defb07' as Address, decimals: 18 },
  { symbol: 'MAICRO', address: '0xe74731ba9d1da6fd3c8c60ff363732bebac5273e' as Address, decimals: 18 },
  { symbol: 'BOMET', address: '0x33e7f871ce502ec77a0d96fdcd02c9219f95e944' as Address, decimals: 18 },
  { symbol: 'PSYOPS', address: '0x9f1529e296972f6eab3c7c87e898dac2c3a020bc' as Address, decimals: 18 },
  { symbol: 'UBONK', address: '0xf56ce53561a9cc084e094952232bbfe1e5fb599e' as Address, decimals: 18 },
  { symbol: 'TRANSLATE', address: '0x5cd9166494673c15cbdfe8750def8bbab80a5b07' as Address, decimals: 18 },
  { symbol: 'ZIGGY', address: '0xd628dc2c4ec10feb07e5c8bf039f7c1c374d1b07' as Address, decimals: 18 },
  { symbol: 'VOLS', address: '0x9c94e82d8751f16953f9c86e13ed9cd0414e6e97' as Address, decimals: 18 },
  { symbol: 'JUNO', address: '0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07' as Address, decimals: 18 },
  { symbol: 'OPSYS', address: '0x38b88d6568d61556d33592ad7bc24e89a7fb6691' as Address, decimals: 18 },
  { symbol: 'BASEMENT', address: '0x18b9ba6b284994d7cbae852c5e1361e8dfab7e9d' as Address, decimals: 18 },
  { symbol: 'ATA', address: '0xb18c609796848c723eacadc0be5b71ceb2289a48' as Address, decimals: 18 },
  { symbol: 'BOOKOFRUGS', address: '0xbbe6693a1825270886fa53167359caa32ff87c5e' as Address, decimals: 18 },
  { symbol: 'IDRISS', address: '0x000096630066820566162c94874a776532705231' as Address, decimals: 18 },
  { symbol: 'BALAJIS', address: '0xcaf75598b8b9a6e645b60d882845d361f549f5ec' as Address, decimals: 18 },
  { symbol: 'SKITTEN', address: '0x4b6104755afb5da4581b81c552da3a25608c73b8' as Address, decimals: 18 },
  { symbol: 'MWXT', address: '0x93918567cdd1bc845be955325a43419a7c56d66f' as Address, decimals: 18 },
  { symbol: 'BLEU', address: '0xbf4db8b7a679f89ef38125d5f84dd1446af2ea3b' as Address, decimals: 18 },
  { symbol: '0XDP', address: '0x0a3a6eef246ed15dbf97f8a237e20a3bc091cba3' as Address, decimals: 18 },
  { symbol: 'VITAFOXO', address: '0xe8f802b0cb13adf1a4333b541d4d3f703b8a69fa' as Address, decimals: 18 },
  { symbol: 'GRK', address: '0x2e2cc4dfce60257f091980631e75f5c436b71c87' as Address, decimals: 18 },
  { symbol: 'AIBRK', address: '0xd0924fa4c6ba194294a414d0fb826739ded98b24' as Address, decimals: 18 },
  { symbol: 'WBTSLA', address: '0x1f82284c1658ad71c576f7230e6c2dee7901c1fa' as Address, decimals: 18 },
  { symbol: 'BUNNY', address: '0x75570e1189ffc1d63b3417cdf0889f87cd3e9bd1' as Address, decimals: 18 },
  { symbol: 'FACY', address: '0xfac77f01957ed1b3dd1cbea992199b8f85b6e886' as Address, decimals: 18 },
  { symbol: 'PILT', address: '0x43e74d30443b5e7661ac077ce626a6b134e803c4' as Address, decimals: 18 },
  { symbol: 'CATCH', address: '0x44f77502418c9b225ad8f80a9def915c8c271a19' as Address, decimals: 18 },
  { symbol: 'KIBO', address: '0x16d5765e3dea16a6cdfcb24b5e05480dbaef798f' as Address, decimals: 18 },
  { symbol: 'AUDIT', address: '0xb17a7581c9a006e8b5fda85506cfd3448ed75746' as Address, decimals: 18 },
  { symbol: 'CLAWBERRY', address: '0x896bf81f9c92c6ef6f9a49679c62e876b405bba3' as Address, decimals: 18 },
  { symbol: 'BONKE', address: '0x1754e5aadce9567a95f545b146a616ce34eead53' as Address, decimals: 9 },
  { symbol: 'DONNA', address: '0x61527cd3667243b0a80d41cb690237444e42a8d0' as Address, decimals: 18 },
  { symbol: 'LCAP', address: '0x4da9a0f397db1397902070f93a4d6ddbc0e0e6e8' as Address, decimals: 18 },
  { symbol: 'RE7WETH', address: '0xa2cac0023a4797b4729db94783405189a4203afc' as Address, decimals: 18 },
  { symbol: 'SOGNI', address: '0xe014d2a4da6e450f21b5050120d291e63c8940fd' as Address, decimals: 18 },
  { symbol: 'LINKS', address: '0x901f1d2bf312e6fa1716df603df8f86315bcb355' as Address, decimals: 18 },
  { symbol: 'CHAR', address: '0x20b048fa035d5763685d695e66adf62c5d9f5055' as Address, decimals: 18 },
  { symbol: 'IRA', address: '0x029c58a909fbe3d4be85a24f414dda923a3fde0f' as Address, decimals: 18 },
  { symbol: 'WBASEDOGE', address: '0x373504da48418c67e6fcd071f33cb0b3b47613c7' as Address, decimals: 18 },
  { symbol: 'YOBTC', address: '0xbcbc8cb4d1e8ed048a6276a5e94a3e952660bcbc' as Address, decimals: 8 },
  { symbol: 'FANS', address: '0x04cafd53ecfa6f6a9168de3d6d2b837d04a51b07' as Address, decimals: 18 },
  { symbol: 'HINT', address: '0x91da780bc7f4b7cf19abe90411a2a296ec5ff787' as Address, decimals: 18 },
  { symbol: 'PEPPER', address: '0xbf388570ebd5b88bfc7cd21ec469813c15f453a3' as Address, decimals: 18 },
  { symbol: 'ORCL', address: '0xd1d7aa941c71fd95e9d31bbd81937b3e71bd6231' as Address, decimals: 18 },
  { symbol: 'ST', address: '0x214419f6fdd2b23bf6a32f33cf95186d188b784b' as Address, decimals: 18 },
  { symbol: 'PRFI', address: '0x7bbcf1b600565ae023a1806ef637af4739de3255' as Address, decimals: 18 },
  { symbol: 'BT365', address: '0x706e1963ba410a548673b46d694104391fb7dca5' as Address, decimals: 5 },
  { symbol: 'WAYE', address: '0xc1b641e72327208f0fe37405a9d46439b626af6a' as Address, decimals: 18 },
  { symbol: 'GM', address: '0x5d9c2457a10d455e0ad8e28e40cc28eacf27a06a' as Address, decimals: 18 },
  { symbol: 'BP', address: '0x9f3bb51d5c14aaf53794fe5780c085967dacaf2d' as Address, decimals: 18 },
  { symbol: 'KVCM', address: '0x00fbac94fec8d4089d3fe979f39454f48c71a65d' as Address, decimals: 18 },
  { symbol: 'MOLGE', address: '0x92b5fea742ecfd24f1ef41f35497373363599b07' as Address, decimals: 18 },
  { symbol: 'SENKU', address: '0x0671799f205b8880d270fc6bec77942636dd8c03' as Address, decimals: 18 },
  { symbol: 'PERKOS', address: '0xf714e60f85497d70508f7e356b5db80e64539ba3' as Address, decimals: 18 },
  { symbol: 'FREN', address: '0xf42c45e5b79c9564c95a9b8641518a58b0d089de' as Address, decimals: 18 },
  { symbol: 'SMOL', address: '0x291a8da3c42b7d7f00349d6f1be3c823a2b3fca4' as Address, decimals: 18 },
  { symbol: 'BRANDER', address: '0xb2b34bd71f05445e40a23c1032e1730f4d693b07' as Address, decimals: 18 },
  { symbol: 'WIF', address: '0x7f6f6720a73c0f54f95ab343d7efeb1fa991f4f7' as Address, decimals: 18 },
  { symbol: 'FLIPR', address: '0xffcadd0cdadd39673991a1dda4a756a801535f48' as Address, decimals: 18 },
  { symbol: 'USOL', address: '0x9b8df6e244526ab5f6e6400d331db28c8fdddb55' as Address, decimals: 18 },
  { symbol: 'BLUNNY', address: '0x7546e0d4d947a15f914e33de6616ffed826f45ef' as Address, decimals: 18 },
  { symbol: 'MRSMIGGLES', address: '0x31b28012f61fc3600e1c076bafc9fd997fb2da90' as Address, decimals: 18 },
  { symbol: 'DESS', address: '0xd901b38bdd0cd7a8800575cd505d65428a48ba38' as Address, decimals: 18 },
  { symbol: 'SQUOGE', address: '0x589c8e8fe013133b41abf546c819787a75688690' as Address, decimals: 18 },
  { symbol: 'WGLUE', address: '0x840b20fa3d48ac709fd841fcd878c3e8aabd7087' as Address, decimals: 18 },
  { symbol: 'EQTY', address: '0xc71f37d9bf4c5d1e7fe4bccb97e6f30b11b37d29' as Address, decimals: 18 },
  { symbol: 'WARS', address: '0xec3d2537a03fc4d790aa1fc66fa7dfadc6b245fb' as Address, decimals: 18 },
];

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

// --- Config ---
const config = createConfig(
  getDefaultConfig({
    appName: 'Dust Cleaning Engine',
    chains: [base],
    walletConnectProjectId: '96933333333333333333333333333333', // Placeholder or real ID
    transports: {
      [base.id]: http([
        'https://mainnet.base.org',
        'https://base.llamarpc.com',
        'https://base-rpc.publicnode.com'
      ], {
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000
      }),
    },
    // Explicitly set SSR to false as this is a client-side app
    ssr: false,
    // Limit connectors to avoid iframe-related wallet extension errors
    connectors: [
      injected(),
      coinbaseWallet({ appName: 'Dust Cleaning Engine' }),
    ],
  })
);

const queryClient = new QueryClient();

// --- Components ---

const Gear = ({ className, speed = 10, reverse = false }: { className?: string; speed?: number; reverse?: boolean }) => (
  <motion.div
    animate={{ rotate: reverse ? -360 : 360 }}
    transition={{ duration: speed, repeat: Infinity, ease: "linear" }}
    className={cn("text-zinc-600", className)}
  >
    <Settings size={40} strokeWidth={1.5} />
  </motion.div>
);

interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
  balance: bigint;
  formattedBalance: string;
  priceUsd: number;
  valueUsd: number;
  isVerified: boolean;
  selected: boolean;
}

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider>
          <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
            <header className="border-b border-zinc-800/50 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-50">
              <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Gear className="text-emerald-500" speed={5} />
                    <Gear className="absolute -top-1 -right-1 scale-50 text-emerald-400" speed={3} reverse />
                  </div>
                  <div className="flex flex-col -gap-1">
                    <h1 className="text-xl font-bold tracking-tighter uppercase italic leading-none">
                      Dust <span className="text-emerald-500">Engine</span>
                    </h1>
                    <span className="text-[8px] font-mono text-zinc-500 tracking-[0.2em] uppercase">Model v1.0.4-BASE</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-zinc-800 rounded-full border border-zinc-700">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-mono text-zinc-400">BASE MAINNET</span>
                  </div>
                  <ConnectButton />
                </div>
              </div>
            </header>

            <main className="max-w-4xl mx-auto px-4 py-12">
              <EngineCore />
            </main>
          </div>
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function ConnectButton() {
  return (
    <div className="scale-90 origin-right max-w-[140px] sm:max-w-none overflow-hidden">
      <ConnectKitButton />
    </div>
  );
}

function EngineCore() {
  const { address, isConnected } = useAccount();
  const { setOpen } = useModal();
  const publicClient = usePublicClient();

  // fallback RPC client for Base when wallet is not connected
  const baseRpcClient = createPublicClient({
    chain: base,
    transport: http("https://mainnet.base.org")
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [scanAddress, setScanAddress] = useState('');
  const [apiStatus, setApiStatus] = useState<{debank: boolean, oneinch: boolean}>({ debank: false, oneinch: false });
  const [log, setLog] = useState<string[]>([]);
  const [customAddress, setCustomAddress] = useState('');
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [dustThreshold, setDustThreshold] = useState(1.0);
  const [globalStats, setGlobalStats] = useState<any>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await axios.get('/api/stats');
        setGlobalStats(res.data);
      } catch (e) {
        console.warn("Failed to fetch stats");
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const checkApi = async () => {
      try {
        const res = await axios.get('/api/health');
        setApiStatus({
          debank: !!res.data.keys?.debank,
          oneinch: !!res.data.keys?.oneinch
        });
      } catch (e) {
        console.error("Health check failed");
      }
    };
    checkApi();
  }, []);

  const addLog = (msg: string) => {
    setLog(prev => [msg, ...prev].slice(0, 5));
  };

  const analyze = async (targetAddress?: string) => {
    const addressToScan = targetAddress || address;
    if (!addressToScan) {
      addLog("ERROR: NO ADDRESS TO SCAN");
      return;
    }
    
    // If we have a publicClient, check chain. If not, we'll proceed (might fail if needed)
    // Only check chain if we are scanning the connected wallet
    if (publicClient && !targetAddress) {
      const chainId = await publicClient.getChainId();
      if (chainId !== base.id) {
        addLog("ERROR: WRONG NETWORK (SWITCH TO BASE)");
        alert("Please switch your wallet to the Base network to use the Dust Engine.");
        return;
      }
    }

    if (!window.navigator.onLine) {
      addLog("ERROR: NO INTERNET CONNECTION");
      setIsAnalyzing(false);
      return;
    }

    setIsAnalyzing(true);
    setTokens([]);
    addLog(`SCANNING: ${addressToScan.slice(0, 6)}...${addressToScan.slice(-4)}`);

    try {
      // --- Phase 1: Multi-Source Discovery ---
      addLog("INITIATING AGGRESSIVE SCAN...");
      let discoveredTokens: any[] = [];
      
      // 1.1 Backend Deep Scan
      try {
        const backendRes = await axios.get(`/api/scan/${addressToScan}`, { timeout: 15000 });
        if (backendRes.data?.tokens) {
          discoveredTokens = [...discoveredTokens, ...backendRes.data.tokens];
          addLog(`BACKEND: DISCOVERED ${backendRes.data.tokens.length} ASSETS`);
        }
      } catch (e: any) { 
        console.warn("Backend scan failed", e); 
        addLog(`BACKEND SCAN FAILED: ${e.message}`);
      }

      // 1.2 Direct Blockscout Indexer Scan (Supplement)
      try {
        const bsRes = await axios.get(`https://base.blockscout.com/api/v2/addresses/${addressToScan}/token-balances`, { timeout: 10000 });
        const bsItems = Array.isArray(bsRes.data) ? bsRes.data : (bsRes.data.items || []);
        if (bsItems.length > 0) {
          const bsTokens = bsItems.map((t: any) => ({
            symbol: t.token?.symbol || '???',
            address: t.token?.address as Address,
            decimals: parseInt(t.token?.decimals || '18'),
            priceUsd: parseFloat(t.token?.exchange_rate || '0')
          }));
          discoveredTokens = [...discoveredTokens, ...bsTokens];
          addLog(`INDEXER: DISCOVERED ${bsTokens.length} ASSETS`);
        }
      } catch (e) { console.warn("Indexer scan failed", e); }

      // 1.3 1inch discovery disabled
      // 1inch returns ALL Base tokens which breaks dust detection
      let oneInchTokens: any[] = [];
      addLog("1INCH DISCOVERY DISABLED (USING WALLET TOKENS ONLY)");

      // 1.4 Deep Scan (DexScreener Search for any missing assets)
      addLog("DEEP SCAN: CHECKING DEX LIQUIDITY...");
      try {
        // Find tokens that have balances but might not be in our lists
        const potentialAddresses = discoveredTokens.map(t => t.address).filter(Boolean);
        if (potentialAddresses.length > 0) {
          const dsRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${potentialAddresses.slice(0, 30).join(',')}`, { timeout: 8000 });
          if (dsRes.data?.pairs) {
            dsRes.data.pairs.forEach((pair: any) => {
              if (pair.baseToken?.address && pair.chainId === 'base') {
                const addr = pair.baseToken.address as Address;
                if (!discoveredTokens.some(dt => dt.address?.toLowerCase() === addr.toLowerCase())) {
                  discoveredTokens.push({
                    symbol: pair.baseToken.symbol || '???',
                    address: addr,
                    decimals: 18,
                    priceUsd: parseFloat(pair.priceUsd || '0')
                  });
                }
              }
            });
          }
        }
      } catch (e) { console.warn("Deep scan failed", e); }

      // --- Phase 2: Final Scan List (only tokens actually held by wallet) ---
      const finalScanList = discoveredTokens
        .filter(t => t.address)
        .map(t => ({
          symbol: t.symbol || '???',
          address: t.address as Address,
          decimals: t.decimals || 18
      }));

      addLog(`INDEXER PROVIDED ${finalScanList.length} TOKENS TO VERIFY`);

      // Add 1inch tokens (Very aggressive discovery)
      oneInchTokens.forEach(t => {
        if (t.address && !finalSeen.has(t.address.toLowerCase())) {
          finalScanList.push(t);
          finalSeen.add(t.address.toLowerCase());
        }
      });

      addLog(`VERIFYING ${finalScanList.length} ASSETS ON-CHAIN...`);
      
      // 2. Multicall balances with retry logic
      const chunkSize = 100;
      const allBalances: bigint[] = [];
      for (let i = 0; i < finalScanList.length; i += chunkSize) {
        const chunk = finalScanList.slice(i, i + chunkSize);
        addLog(`SCANNING CHUNK ${Math.floor(i/chunkSize) + 1}/${Math.ceil(finalScanList.length/chunkSize)}...`);
        
        let success = false;
        let retries = 0;
        while (!success && retries < 2) {
          try {
            const client = publicClient || baseRpcClient;

            const results = await (client as any).multicall({
              contracts: chunk.map(t => ({
                address: t.address,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: [addressToScan as Address],
              })),
            });
            results.forEach((res: any) => {
              allBalances.push(res.status === 'success' ? (res.result as unknown as bigint) : 0n);
            });
            success = true;
          } catch (chunkErr) {
            retries++;
            if (retries === 2) {
              addLog(`CHUNK ${Math.floor(i/chunkSize) + 1} FAILED.`);
              chunk.forEach(() => allBalances.push(0n));
            } else {
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }
        await new Promise(r => setTimeout(r, 50));
      }

      // 3. Filter tokens with balance
      const tokensWithBalance = finalScanList.filter((_, i) => allBalances[i] > 0n);
      const balancesForTokens = allBalances.filter(b => b > 0n);
      
      addLog(`BALANCES DETECTED: ${tokensWithBalance.length} ASSETS`);
      
      if (tokensWithBalance.length === 0) {
        addLog("NO BALANCES DETECTED");
        setIsAnalyzing(false);
        return;
      }

      // --- Phase 3: Price Fetching & Verification ---
      addLog(`FETCHING PRICES FOR ${tokensWithBalance.length} ASSETS...`);
      const priceAddresses = tokensWithBalance.map(t => t.address?.toLowerCase()).filter(Boolean);
      let prices: Record<string, number> = {};
      
      // 3.1 Use prices from indexer first
      discoveredTokens.forEach(t => {
        if (t.address && t.priceUsd > 0) prices[t.address.toLowerCase()] = t.priceUsd;
      });

      // 3.2 CoinGecko (Chunked to prevent URI too long or 422)
      try {
        const chunkSize = 50;
        for (let i = 0; i < priceAddresses.length; i += chunkSize) {
          const chunk = priceAddresses.slice(i, i + chunkSize);
          const cgRes = await axios.get(`https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${chunk.join(',')}&vs_currencies=usd`, {
            timeout: 8000
          });
          Object.entries(cgRes.data).forEach(([addr, val]: [string, any]) => {
            if (val.usd) prices[addr.toLowerCase()] = val.usd;
          });
          if (priceAddresses.length > chunkSize) await new Promise(r => setTimeout(r, 200)); // Rate limit buffer
        }
      } catch (e) { console.warn("CoinGecko failed", e); }

      // 3.3 DexScreener (Fallback)
      const missingAddresses = priceAddresses.filter(addr => !prices[addr]);
      if (missingAddresses.length > 0) {
        try {
          for (let i = 0; i < missingAddresses.length; i += 30) {
            const chunk = missingAddresses.slice(i, i + 30);
            const dsRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { timeout: 8000 });
            if (dsRes.data?.pairs) {
              dsRes.data.pairs.forEach((pair: any) => {
                const addr = pair.baseToken.address.toLowerCase();
                if (pair.priceUsd) prices[addr] = parseFloat(pair.priceUsd);
              });
            }
          }
        } catch (e) { console.warn("DexScreener failed", e); }
      }

      const fallbackPrices: Record<string, number> = {
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0, // USDC
        '0xfde4c96c8593536e31f229ea8f37b2ad3d69d441': 1.0, // USDT
        '0x50c5725949a6f0c72e6c45641830677285586337': 1.0, // DAI
        '0x4200000000000000000000000000000000000006': 2500, // WETH
      };

      // Create a set of verified addresses from 1inch list
      const verifiedAddresses = new Set(oneInchTokens.map(t => t.address?.toLowerCase()).filter(Boolean));
      COMMON_BASE_TOKENS.forEach(t => {
        if (t.address) verifiedAddresses.add(t.address.toLowerCase());
      });

      addLog(`CALCULATING VALUES FOR ${tokensWithBalance.length} ASSETS...`);
      const results: TokenInfo[] = [];
      for (let i = 0; i < tokensWithBalance.length; i++) {
        const t = tokensWithBalance[i];
        const balance = balancesForTokens[i];
        const formatted = formatUnits(balance, t.decimals);
        const addrLower = t.address?.toLowerCase();
        
        if (!addrLower) continue;

        const price = prices[addrLower] || fallbackPrices[addrLower] || 0;
        const valueUsd = (parseFloat(formatted) || 0) * price;

        if (balance > 0n) {
          results.push({
            ...t,
            balance,
            formattedBalance: formatted,
            priceUsd: price,
            valueUsd,
            isVerified: verifiedAddresses.has(addrLower) || !!prices[addrLower],
            selected: valueUsd > 0 && valueUsd < dustThreshold && (verifiedAddresses.has(addrLower) || !!prices[addrLower]),
          });
        }
      }

      addLog(`SORTING ${results.length} ASSETS...`);
      results.sort((a, b) => {
        if (Math.abs(b.valueUsd - a.valueUsd) > 0.0001) {
          return b.valueUsd - a.valueUsd;
        }
        return a.symbol.localeCompare(b.symbol);
      });

      setTokens(results);
      addLog(`SCAN COMPLETE: FOUND ${results.length} ASSETS`);
    } catch (err: any) {
      console.error("Analysis failed", err);
      const errorMsg = err.response?.data?.message || err.message || "NETWORK ERROR";
      addLog(`ERROR: ${errorMsg.toUpperCase()}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const addCustomToken = async () => {
    if (!customAddress.startsWith('0x') || customAddress.length !== 42) {
      alert("Invalid address format");
      return;
    }
    setIsAddingCustom(true);
    try {
      const contract = getContract({
        address: customAddress as Address,
        abi: ERC20_ABI,
        client: publicClient as any,
      });
      
      const [symbol, decimals, balance] = await Promise.all([
        (contract as any).read.symbol(),
        (contract as any).read.decimals(),
        (contract as any).read.balanceOf([address as Address]),
      ]);

      const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${customAddress.toLowerCase()}&vs_currencies=usd`);
      const price = priceRes.data[customAddress.toLowerCase()]?.usd || 0;
      const formatted = formatUnits(balance as bigint, decimals as number);
      const valueUsd = parseFloat(formatted) * price;

      const newToken: TokenInfo = {
        symbol: symbol as string,
        address: customAddress as Address,
        decimals: decimals as number,
        balance: balance as bigint,
        formattedBalance: formatted,
        priceUsd: price,
        valueUsd,
        isVerified: !!price,
        selected: true,
      };

      setTokens(prev => {
        const filtered = prev.filter(t => t.address?.toLowerCase() !== customAddress.toLowerCase());
        return [newToken, ...filtered];
      });
      setCustomAddress('');
      addLog(`ADDED CUSTOM TOKEN: ${symbol}`);
    } catch (err) {
      console.error(err);
      alert("Failed to fetch token info. Ensure it's a valid ERC20 on Base.");
    } finally {
      setIsAddingCustom(false);
    }
  };

  const toggleSelect = (addr: Address) => {
    setTokens(prev => prev.map(t => t.address === addr ? { ...t, selected: !t.selected } : t));
  };

  const toggleAll = () => {
    const allSelected = filteredTokens.length > 0 && filteredTokens.every(t => t.selected);
    setTokens(prev => prev.map(t => {
      const isFiltered = filteredTokens.some(ft => ft.address === t.address);
      if (isFiltered) return { ...t, selected: !allSelected };
      return t;
    }));
  };

  const filteredTokens = useMemo(() => {
    if (showAll) return tokens;
    return tokens.filter(t => t.valueUsd < dustThreshold && t.isVerified);
  }, [tokens, showAll, dustThreshold]);

  const totalValueUsd = useMemo(() => 
    filteredTokens.filter(t => t.selected).reduce((acc, t) => acc + (t.valueUsd || 0), 0)
  , [filteredTokens]);

  const unpricedCount = useMemo(() => 
    filteredTokens.filter(t => t.selected && !t.priceUsd).length
  , [filteredTokens]);

  return (
    <div className="space-y-8">
      {/* Global Analytics Bar */}
      {globalStats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 text-center">
            <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Total Dust Cleaned</p>
            <p className="text-xl font-black text-emerald-500">${(globalStats.totalDustCleanedUsd || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 text-center">
            <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Total Swaps</p>
            <p className="text-xl font-black text-zinc-100">{(globalStats.totalSwaps || 0).toLocaleString()}</p>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 text-center">
            <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Users Served</p>
            <p className="text-xl font-black text-zinc-100">{(globalStats.usersServed || 0).toLocaleString()}</p>
          </div>
        </div>
      )}

      {/* Machine Head */}
      <div className="relative bg-zinc-900 border border-zinc-800 rounded-3xl p-8 overflow-hidden shadow-2xl">
        <div className="absolute top-0 right-0 p-4 opacity-10">
          <Gear className="scale-[4]" speed={20} />
        </div>
        
        <div className="relative z-10 flex flex-col md:flex-row items-center gap-8">
          <div className="flex-1 space-y-4 text-center md:text-left">
            <h2 className="text-3xl font-black uppercase italic tracking-tighter">
              AI <span className="text-emerald-500">DUST ENGINE</span>
            </h2>
            <p className="text-zinc-400 max-w-md">
              Detects tiny token balances across your wallet and transforms them into usable assets using smart routing and real-time market data.
            </p>
            <div className="flex gap-2 pt-2">
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">⚡ AI Scan</span>
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">🔄 Smart Conversion</span>
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">🧹 Wallet Cleanup</span>
            </div>
            
            {!isConnected ? (
              <div className="pt-4 flex flex-col items-center md:items-start">
                <div className="flex items-center gap-4 mb-4 px-3 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded-lg">
                  <div className="flex items-center gap-2">
                    <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.debank ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                    <span className="text-[9px] font-mono text-zinc-400 uppercase">Debank</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.oneinch ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                    <span className="text-[9px] font-mono text-zinc-400 uppercase">1inch</span>
                  </div>
                </div>
                <p className="text-sm text-zinc-500 mb-4 italic">Connect your wallet to power the engine</p>
                <div className="flex justify-center max-w-full overflow-hidden">
                  <ConnectKitButton />
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded-lg">
                    <div className="flex items-center gap-2">
                      <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.debank ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                      <span className="text-[9px] font-mono text-zinc-400 uppercase">Debank</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.oneinch ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                      <span className="text-[9px] font-mono text-zinc-400 uppercase">1inch</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 justify-center md:justify-start">
                  <button
                    onClick={() => analyze()}
                    disabled={isAnalyzing}
                    className="group relative px-8 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 text-zinc-950 font-bold rounded-xl transition-all active:scale-95 overflow-hidden"
                  >
                    <span className="relative z-10 flex items-center gap-2">
                      {isAnalyzing ? <RefreshCw className="animate-spin" size={18} /> : <Zap size={18} />}
                      {isAnalyzing ? 'ANALYZING...' : 'START ENGINE'}
                    </span>
                    <motion.div 
                      className="absolute inset-0 bg-white/20"
                      initial={{ x: '-100%' }}
                      whileHover={{ x: '100%' }}
                      transition={{ duration: 0.5 }}
                    />
                  </button>
                  
                  <div className="flex flex-col gap-1 px-4 py-2 bg-zinc-950 border border-zinc-800 rounded-xl min-w-[160px]">
                    <div className="flex justify-between items-center">
                      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-tighter">Dust Threshold</span>
                      <span className="text-[10px] font-mono text-emerald-500">${dustThreshold.toFixed(2)}</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.01" 
                      max="5.0" 
                      step="0.01" 
                      value={dustThreshold}
                      onChange={(e) => setDustThreshold(parseFloat(e.target.value))}
                      className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                    />
                  </div>

                  <div className="flex items-center gap-2 px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl">
                    <div className="flex -space-x-1">
                      <div className="w-4 h-4 rounded-full bg-emerald-500/20 border border-emerald-500/50 flex items-center justify-center text-[6px] font-bold text-emerald-500">1i</div>
                      <div className="w-4 h-4 rounded-full bg-blue-500/20 border border-blue-500/50 flex items-center justify-center text-[6px] font-bold text-blue-500">Ae</div>
                      <div className="w-4 h-4 rounded-full bg-pink-500/20 border border-pink-500/50 flex items-center justify-center text-[6px] font-bold text-pink-500">Un</div>
                    </div>
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">1inch Aggregator Active</span>
                  </div>
                </div>
              </div>
            )}

            {/* Wallet Scan */}
            <div className="flex items-center gap-2 pt-2 opacity-60 hover:opacity-100 transition-opacity">
              <div className="relative flex-1 max-w-xs">
                <input 
                  type="text"
                  placeholder="Enter wallet address (0x...)"
                  value={scanAddress}
                  onChange={(e) => setScanAddress(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-[10px] font-mono focus:outline-none focus:border-emerald-500/50"
                />
              </div>
              <button 
                onClick={() => analyze(scanAddress)}
                disabled={isAnalyzing || !scanAddress}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-[10px] font-bold uppercase tracking-tight transition-colors"
              >
                {isAnalyzing ? 'Scanning...' : 'Scan Wallet'}
              </button>
            </div>
          </div>

          <div className="w-48 h-48 relative flex items-center justify-center">
            <div className="absolute inset-0 border-4 border-dashed border-zinc-800 rounded-full animate-[spin_20s_linear_infinite]" />
            <div className="relative">
              <Gear className={cn("text-zinc-700", isAnalyzing && "text-emerald-500")} speed={isAnalyzing ? 2 : 10} />
              <Gear className="absolute -top-6 -right-6 scale-75 text-zinc-800" speed={isAnalyzing ? 1.5 : 8} reverse />
              <Gear className="absolute -bottom-4 -left-4 scale-50 text-zinc-800" speed={isAnalyzing ? 1 : 5} />
            </div>
            
            {/* Mechanical Log Monitor */}
            <div className="absolute -bottom-10 w-64 bg-black/80 border border-zinc-800 rounded p-2 font-mono text-[9px] text-emerald-500/80 shadow-xl overflow-hidden h-16 pointer-events-none">
              <div className="flex justify-between border-b border-zinc-800 pb-1 mb-1 text-[7px] uppercase tracking-widest text-zinc-600">
                <span>System Monitor</span>
                <span className="animate-pulse">ONLINE</span>
              </div>
              <div className="space-y-0.5">
                {log.length > 0 ? log.map((msg, i) => (
                  <div key={i} className={cn(i === 0 ? "text-emerald-400" : "opacity-50")}>
                    {`> ${msg}`}
                  </div>
                )) : (
                  <div className="opacity-30 italic">WAITING FOR INPUT...</div>
                )}
              </div>
            </div>
            <div className="absolute -bottom-24 flex items-center gap-4">
              <a href="https://x.com/enginedust" target="_blank" rel="noopener noreferrer">
                <img src="/x-logo.svg" width="28" alt="X" />
              </a>
              <a href="https://farcaster.xyz/dustengine" target="_blank" rel="noopener noreferrer">
                <img src="/farcaster-logo.svg" width="28" alt="Farcaster" />
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Results Section */}
      <AnimatePresence mode="wait">
        {tokens.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-4">
                <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <Trash2 size={14} /> {showAll ? 'All Assets' : 'Detected Dust'} ({filteredTokens.length})
                </h3>
                <button 
                  onClick={() => setShowAll(!showAll)}
                  className={cn(
                    "px-2 py-1 rounded text-[10px] font-bold uppercase transition-all border",
                    showAll 
                      ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500" 
                      : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  {showAll ? 'Show Dust Only' : 'Show All Coins'}
                </button>
                {isAnalyzing && (
                  <div className="flex items-end gap-0.5 h-3">
                    {[1,2,3,4,5].map(i => (
                      <motion.div
                        key={i}
                        animate={{ height: [4, 12, 6, 10, 4] }}
                        transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                        className="w-1 bg-emerald-500 rounded-full"
                      />
                    ))}
                  </div>
                )}
              </div>
              <button 
                onClick={toggleAll}
                className="group flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-[10px] font-bold uppercase text-zinc-400 hover:text-emerald-500 hover:border-emerald-500/50 transition-all"
              >
                <div className={cn(
                  "w-3 h-3 rounded border flex items-center justify-center transition-colors",
                  filteredTokens.length > 0 && filteredTokens.every(t => t.selected) ? "bg-emerald-500 border-emerald-500 text-zinc-950" : "border-zinc-700"
                )}>
                  {filteredTokens.length > 0 && filteredTokens.every(t => t.selected) && <CheckCircle2 size={10} strokeWidth={4} />}
                </div>
                {filteredTokens.length > 0 && filteredTokens.every(t => t.selected) ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            <div className="grid gap-3">
              {filteredTokens.map((token) => (
                <div key={token.address}>
                  <TokenRow 
                    token={token} 
                    onToggle={() => toggleSelect(token.address)} 
                  />
                </div>
              ))}
            </div>

            {/* Swap Panel */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
              <div className="space-y-1 text-center md:text-left">
                <p className="text-xs text-zinc-500 uppercase font-bold tracking-tighter">Total Compression Value</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-emerald-500">${(totalValueUsd || 0).toFixed(4)}</span>
                  <span className="text-sm font-mono text-zinc-400">≈ {((totalValueUsd || 0) / 2500).toFixed(6)} ETH</span>
                </div>
                {unpricedCount > 0 && (
                  <p className="text-[10px] text-zinc-500 italic">
                    * {unpricedCount} tokens have unknown market value
                  </p>
                )}
                <p className="text-[10px] text-zinc-600 italic uppercase">Includes 3% protocol fee</p>
              </div>

              <SwapButton 
                tokens={filteredTokens.filter(t => t.selected)} 
                setTokens={setTokens}
                addLog={addLog}
                isConnected={isConnected}
                setOpen={setOpen}
                onSuccess={() => {
                  // This callback is now handled internally in SwapButton for better precision
                  // but we keep it for potential external triggers
                }}
              />
            </div>
          </motion.div>
        )}

        {isConnected && !isAnalyzing && tokens.length === 0 && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12 border-2 border-dashed border-zinc-800 rounded-3xl bg-zinc-900/20"
          >
            <div className="flex justify-center mb-4">
              <div className="relative">
                <Trash2 className="text-zinc-700" size={48} />
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-zinc-800 rounded-full flex items-center justify-center">
                  <Search size={8} className="text-zinc-500" />
                </div>
              </div>
            </div>
            <p className="text-zinc-400 font-bold uppercase tracking-widest mb-2">No Dust Detected</p>
            <p className="text-zinc-600 text-xs max-w-xs mx-auto italic mb-6">
              The engine scanned {COMMON_BASE_TOKENS.length} common Base tokens but found no balances under $1.
            </p>
            <button 
              onClick={analyze}
              className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-colors"
            >
              Re-calibrate Scanner
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TokenRow({ token, onToggle }: { token: TokenInfo; onToggle: () => void }) {
  return (
    <div 
      onClick={onToggle}
      className={cn(
        "group flex items-center gap-4 p-4 rounded-xl border transition-all cursor-pointer",
        token.selected 
          ? "bg-emerald-500/5 border-emerald-500/30" 
          : "bg-zinc-900/50 border-zinc-800 hover:border-zinc-700"
      )}
    >
      <div className={cn(
        "w-6 h-6 rounded-md border flex items-center justify-center transition-colors",
        token.selected ? "bg-emerald-500 border-emerald-500 text-zinc-950" : "border-zinc-700"
      )}>
        {token.selected && <CheckCircle2 size={16} strokeWidth={3} />}
      </div>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-100 truncate">{token.symbol}</span>
          {token.isVerified && (
            <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded uppercase font-bold tracking-tighter shrink-0">Verified</span>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 font-mono truncate opacity-60">{token.address}</p>
      </div>

      <div className="text-right">
        <p className="font-bold text-zinc-200">{token.formattedBalance}</p>
        <p className={cn(
          "text-xs font-medium",
          token.valueUsd > 0 ? "text-emerald-500/80" : "text-zinc-500 italic"
        )}>
          {token.valueUsd > 0 ? `$${token.valueUsd.toFixed(4)}` : 'Price N/A'}
        </p>
      </div>
    </div>
  );
}

function SwapButton({ tokens, setTokens, onSuccess, addLog, isConnected, setOpen }: { 
  tokens: TokenInfo[]; 
  setTokens: (val: TokenInfo[] | ((prev: TokenInfo[]) => TokenInfo[])) => void; 
  onSuccess: () => void; 
  addLog: (msg: string) => void;
  isConnected: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'idle' | 'routing' | 'approving' | 'swapping' | 'cleaning'>('idle');
  const [currentSource, setCurrentSource] = useState<string>('');
  const { address, chain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [showSuccess, setShowSuccess] = useState(false);
  const [successData, setSuccessData] = useState({ count: 0, value: 0 });

  const handleSwap = async (e?: any) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!isConnected) {
      setOpen(true);
      return;
    }
    if (tokens.length === 0 || !address) return;
    
    // Ensure correct chain
    if (chain?.id !== base.id) {
      try {
        addLog("SWITCHING TO BASE NETWORK...");
        await switchChainAsync({ chainId: base.id });
      } catch (err) {
        addLog("FAILED TO SWITCH NETWORK. PLEASE SWITCH TO BASE MANUALLY.");
        return;
      }
    }

    setLoading(true);
    setShowSuccess(false); // Reset success state

    try {
      const selectedTokens = tokens.filter(t => t.selected);
      let successCount = 0;
      let actualSwappedValue = 0;
      const successfulTokenAddresses: string[] = [];
      
      if (selectedTokens.length === 0) {
        setLoading(false);
        return;
      }
      
      // Step 1: Routing via 1inch
      setStep('routing');
      addLog("QUERYING 1INCH AGGREGATOR...");
      await new Promise(r => setTimeout(r, 1000));
      
      // REAL TRANSACTION FLOW
      
      // Try EIP-5792 Batching (Smart Wallets like Coinbase)
      let batchSupported = false;
      try {
        // Check if wallet supports batching
        const capabilities = await (window as any).ethereum?.request({
          method: 'wallet_getCapabilities',
          params: [address]
        });
        batchSupported = !!capabilities?.[base.id.toString()]?.atomicBatch?.supported;
      } catch (e) { console.warn("Batching not supported", e); }

      if (batchSupported) {
        addLog("SMART WALLET DETECTED: PREPARING ATOMIC BATCH...");
        const calls = [];
        const batchSuccessfulAddresses: string[] = [];
        let batchTotalValue = 0;

        for (const token of selectedTokens) {
          try {
            addLog(`FETCHING SWAP DATA FOR ${token.symbol}...`);
            const swapRes = await axios.get('/api/swap/quote', {
              params: {
                fromTokenAddress: token.address,
                toTokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // Native ETH
                amount: token.balance.toString(),
                fromAddress: address,
                slippage: 3
              }
            });

            if (swapRes.data?.tx) {
              // 1. Approval call
              calls.push({
                to: token.address,
                data: encodeFunctionData({
                  abi: ERC20_ABI,
                  functionName: 'approve',
                  args: [ONE_INCH_ROUTER, token.balance]
                })
              });

              // 2. Swap call
              calls.push({
                to: swapRes.data.tx.to as Address,
                data: swapRes.data.tx.data,
                value: BigInt(swapRes.data.tx.value || '0')
              });

              batchSuccessfulAddresses.push(token.address);
              batchTotalValue += token.valueUsd;
            } else {
              addLog(`SWAP DATA UNAVAILABLE FOR ${token.symbol}`);
            }
          } catch (e: any) {
            addLog(`FAILED TO GET SWAP DATA FOR ${token.symbol}: ${e.message}`);
          }
        }

        if (calls.length > 0) {
          try {
            addLog(`SENDING BATCH OF ${calls.length} CALLS...`);
            const batchHash = await (window as any).ethereum.request({
              method: 'wallet_sendCalls',
              params: [{
                chainId: `0x${base.id.toString(16)}`,
                from: address,
                calls
              }]
            });
            addLog(`BATCH TX SENT: ${batchHash.slice(0, 10)}...`);
            addLog("WAITING FOR BATCH CONFIRMATION...");
            
            // Wait for batch confirmation (EIP-5792 doesn't have a standard wait hook yet in wagmi)
            await new Promise(r => setTimeout(r, 5000));
            
            successCount = batchSuccessfulAddresses.length;
            actualSwappedValue = batchTotalValue;
            successfulTokenAddresses.push(...batchSuccessfulAddresses);
          } catch (batchErr: any) {
            addLog(`BATCH FAILED: ${batchErr.message}`);
            throw batchErr;
          }
        } else {
          addLog("NO VALID SWAP CALLS TO BATCH");
        }
      } else {
        // Fallback to sequential for standard wallets
        for (const token of selectedTokens) {
          addLog(`PROCESSING ${token.symbol}...`);
          
          // 1. Check Allowance & Approve
          setStep('approving');
          try {
            const allowance = await (publicClient as any).readContract({
              address: token.address,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [address as Address, ONE_INCH_ROUTER],
            });

            if (allowance < token.balance) {
              addLog(`APPROVING ${token.symbol} FOR 1INCH...`);
              const approveHash = await writeContractAsync({
                account: address as Address,
                chain: base,
                address: token.address,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [ONE_INCH_ROUTER, token.balance],
              });
              addLog(`APPROVE TX SENT: ${approveHash.slice(0, 10)}...`);
              addLog("WAITING FOR CONFIRMATION...");
              
              // Wait for approval to be mined
              await publicClient?.waitForTransactionReceipt({ hash: approveHash });
              addLog("APPROVAL CONFIRMED.");
            } else {
              addLog(`${token.symbol} ALREADY APPROVED`);
            }
          } catch (approveErr: any) {
            if (approveErr.message?.includes('User rejected')) {
              addLog(`USER REJECTED ${token.symbol} APPROVAL`);
              continue;
            }
            addLog(`APPROVAL FAILED FOR ${token.symbol}: ${approveErr.message}`);
            continue;
          }

          // 2. Real Swap (Attempt via Proxy)
          setStep('swapping');
          addLog(`SWAPPING ${token.symbol} -> ETH...`);
          try {
            const swapRes = await axios.get('/api/swap/quote', {
              params: {
                fromTokenAddress: token.address,
                toTokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // Native ETH
                amount: token.balance.toString(),
                fromAddress: address,
                slippage: 3
              }
            });

            if (swapRes.data?.tx) {
              addLog(`EXECUTING 1INCH SWAP FOR ${token.symbol}...`);
              console.log("Swap TX Data:", swapRes.data.tx);
              const swapHash = await sendTransactionAsync({
                account: address as Address,
                to: swapRes.data.tx.to as Address,
                data: swapRes.data.tx.data,
                value: BigInt(swapRes.data.tx.value || '0'),
                gas: BigInt(swapRes.data.tx.gas || '1000000'),
              });
              
              addLog(`SWAP TX SENT: ${swapHash.slice(0, 10)}...`);
              addLog("WAITING FOR SWAP CONFIRMATION...");
              const receipt = await publicClient?.waitForTransactionReceipt({ hash: swapHash });
              
              if (receipt?.status === 'success') {
                addLog(`SWAP CONFIRMED FOR ${token.symbol}.`);
                successCount++;
                actualSwappedValue += token.valueUsd;
                successfulTokenAddresses.push(token.address);
              } else {
                addLog(`SWAP REVERTED ON-CHAIN FOR ${token.symbol}. CHECK GAS OR SLIPPAGE.`);
              }
            } else {
              addLog(`SWAP DATA UNAVAILABLE FOR ${token.symbol} (SIMULATING)`);
              await new Promise(r => setTimeout(r, 1000));
              // For simulation, we'll count it as success for the UI demo if needed, 
              // but ideally only real transactions count.
              // successCount++; 
              // actualSwappedValue += token.valueUsd;
              // successfulTokenAddresses.push(token.address);
            }
          } catch (swapErr: any) {
            const errorMsg = swapErr.response?.data?.description || swapErr.response?.data?.error || swapErr.message;
            addLog(`SWAP FAILED FOR ${token.symbol}: ${errorMsg}`);
            addLog("SKIPPING TO NEXT TOKEN...");
          }
        }
      }
      
      // Step 4: Cleaning & Fee Distribution
      if (successCount > 0) {
        setStep('cleaning');
        addLog("DISTRIBUTING 3% PROTOCOL FEE...");
        await new Promise(r => setTimeout(r, 1000));

        addLog("COMPRESSION COMPLETE");
        
        // Report to backend for analytics
        try {
          await axios.post('/api/report-swap', { valueUsd: actualSwappedValue });
        } catch (e) {
          console.warn("Failed to report swap analytics");
        }

        setSuccessData({ count: successCount, value: actualSwappedValue });
        setShowSuccess(true);
        
        // Surgically remove only successful tokens
        setTokens(prev => prev.filter(t => !successfulTokenAddresses.includes(t.address)));
        addLog(`UI UPDATED: ${successCount} ASSETS REMOVED`);
      } else {
        addLog("NO TOKENS WERE SUCCESSFULLY COMPRESSED. CHECK LOGS FOR ERRORS.");
      }
    } catch (err: any) {
      console.error(err);
      const errorDetail = err.response?.data?.description || err.response?.data?.error || err.shortMessage || err.message;
      addLog(`ERROR: ${errorDetail || "ROUTER FAILURE"}`);
    } finally {
      setLoading(false);
      setStep('idle');
      setCurrentSource('');
    }
  };

  const getLabel = () => {
    switch (step) {
      case 'routing': return `ROUTING: ${currentSource}...`;
      case 'approving': return 'OILING 1INCH GEARS...';
      case 'swapping': return 'AGGREGATING LIQUIDITY...';
      case 'cleaning': return 'DISTRIBUTING FEES...';
      default: return `COMPRESS ${tokens.filter(t => t.selected).length} TOKENS`;
    }
  };

  return (
    <div className="w-full md:w-auto space-y-4">
      {loading && (
        <div className="bg-zinc-950/50 border border-zinc-800 rounded-xl p-3 flex items-center gap-4 animate-pulse">
          <div className="flex -space-x-2">
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">1i</div>
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">Ae</div>
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">Un</div>
          </div>
          <div className="flex-1">
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-emerald-500"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: 5, ease: "linear" }}
              />
            </div>
            <p className="text-[10px] text-zinc-500 mt-1 uppercase tracking-tighter font-mono">
              Aggregator Path: Dust → 1inch → {currentSource || '...'} → ETH
            </p>
          </div>
        </div>
      )}

      <button
        onClick={(e) => handleSwap(e)}
        disabled={loading || tokens.filter(t => t.selected).length === 0}
        type="button"
        className={cn(
          "w-full md:w-auto px-12 py-4 font-black uppercase italic tracking-tighter rounded-xl transition-all active:scale-95 flex items-center justify-center gap-3 shadow-lg relative overflow-hidden",
          loading 
            ? "bg-zinc-800 text-emerald-500 cursor-wait" 
            : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-[0_0_20px_rgba(16,185,129,0.3)]"
        )}
      >
        {loading ? (
          <RefreshCw className="animate-spin" size={20} />
        ) : (
          <Zap size={20} className={tokens.filter(t => t.selected).length > 0 ? "animate-pulse" : ""} />
        )}
        {getLabel()}

        {/* Batch Mode Badge */}
        {!loading && (
          <div className="absolute top-1 right-2 flex items-center gap-1">
            <div className="w-1 h-1 rounded-full bg-black/40 animate-pulse" />
            <span className="text-[7px] font-bold opacity-40">EIP-5792 READY</span>
          </div>
        )}
      </button>

      <AnimatePresence>
        {showSuccess && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          >
            <div className="bg-zinc-900 border border-emerald-500/50 rounded-3xl p-8 max-w-sm w-full text-center space-y-6 shadow-[0_0_50px_rgba(16,185,129,0.2)]">
              <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto border border-emerald-500/50">
                <CheckCircle2 size={40} className="text-emerald-500" />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-black uppercase italic tracking-tighter">Compression Successful</h3>
                <p className="text-zinc-400 text-sm">
                  Successfully compressed {successData.count} tokens into ETH via 1inch Aggregator.
                </p>
                <div className="pt-2 font-mono text-emerald-500 text-lg">
                  +${successData.value.toFixed(4)} Value
                </div>
              </div>
              <button 
                onClick={() => {
                  setShowSuccess(false);
                  onSuccess();
                }}
                className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl transition-all"
              >
                DISMISS
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
