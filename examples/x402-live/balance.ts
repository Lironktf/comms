/** Check the demo payer wallet's Base Sepolia ETH (gas) and USDC balances. */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {createPublicClient, http, formatUnits, formatEther, getContract} from "viem";
import {baseSepolia} from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const erc20 = [{type: "function", name: "balanceOf", stateMutability: "view", inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}]}] as const;

function addr(key: string): `0x${string}` {
  for (const line of readFileSync(join(HERE, ".wallet.testnet.env"), "utf8").split("\n")) {
    const m = new RegExp(`^${key}=(.*)$`).exec(line.trim());
    if (m) return m[1] as `0x${string}`;
  }
  throw new Error(`${key} not found`);
}

const payer = addr("DEMO_ADDRESS");
const client = createPublicClient({chain: baseSepolia, transport: http()});

const eth = await client.getBalance({address: payer});
const usdc = await getContract({address: USDC, abi: erc20, client}).read.balanceOf([payer]);

console.log(`payer wallet: ${payer}`);
console.log(`  ETH  (gas):  ${formatEther(eth)}`);
console.log(`  USDC:        ${formatUnits(usdc, 6)}`);
const ok = eth > 0n && usdc >= 10000n;
console.log(ok ? "\n✅ funded — ready to run the demo" : "\n⛔ not funded yet — need Base Sepolia ETH (gas) + ≥0.01 USDC");
process.exit(ok ? 0 : 1);
