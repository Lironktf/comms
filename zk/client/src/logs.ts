import type {PublicClient} from "viem";

/**
 * Block-range cap per eth_getLogs, learned per client. Starts at 2,000 and halves whenever the
 * RPC rejects a range. Measured: https://sepolia.base.org answers "eth_getLogs is limited to a
 * 200 range" (code -32614), 2026-10-17.
 */
const START = 2_000n;
const learned = new WeakMap<PublicClient, bigint>();

const isRangeError = (e: unknown) => {
  const err = e as {status?: number; details?: string; message?: string};
  if (err.status === 429) return false; // rate limited, not a range cap: viem's retry handles it
  return /range|block limit|too many (results|logs|blocks)|exceed/i.test(`${err.details ?? ""} ${err.message ?? ""}`);
};

/** Runs `fetch` over [fromBlock, toBlock] in chunks the RPC accepts, in block order. */
export async function scanLogs<R>(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  fetch: (from: bigint, to: bigint) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let from = fromBlock; from <= toBlock; ) {
    const size = learned.get(client) ?? START;
    const to = from + size - 1n < toBlock ? from + size - 1n : toBlock;
    try {
      out.push(...(await fetch(from, to)));
      from = to + 1n;
    } catch (e) {
      if (size === 1n || !isRangeError(e)) throw e;
      // use the cap when the RPC states it ("limited to a 200 range"), else halve
      const stated = /limited to a (\d+) range/.exec(`${(e as {details?: string}).details ?? ""}`)?.[1];
      learned.set(client, stated && BigInt(stated) < size ? BigInt(stated) : size / 2n);
    }
  }
  return out;
}
