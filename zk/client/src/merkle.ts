import {h2} from "./hashes.js";

/**
 * Client-side mirror of contracts/src/libraries/MerkleTree.sol: an append-only Poseidon2
 * tree whose empty leaves are 0. Unlike the contract (which keeps only the frontier),
 * the client keeps every node so it can produce a Merkle path for any leaf.
 */
export class MerkleTree {
  readonly depth: number;
  readonly zeros: bigint[];
  /** layers[d] = nodes of level d that differ from zeros[d], by position */
  private readonly layers: Map<number, bigint>[];
  private _size = 0;

  constructor(depth = 20) {
    this.depth = depth;
    this.zeros = [0n];
    for (let i = 0; i < depth; i++) this.zeros.push(h2(this.zeros[i]!, this.zeros[i]!));
    this.layers = Array.from({length: depth + 1}, () => new Map<number, bigint>());
  }

  get size(): number {
    return this._size;
  }

  node(level: number, pos: number): bigint {
    return this.layers[level]!.get(pos) ?? this.zeros[level]!;
  }

  get root(): bigint {
    return this.node(this.depth, 0);
  }

  /** Append leaves starting at the current size; returns the first leaf index. */
  insert(leaves: readonly bigint[]): number {
    const start = this._size;
    if (start + leaves.length > 2 ** this.depth) throw new Error("tree full");
    leaves.forEach((l, i) => this.setNode(0, start + i, l));
    this._size += leaves.length;
    // recompute every ancestor of the touched range
    let lo = start;
    let hi = start + leaves.length - 1;
    for (let d = 0; d < this.depth; d++) {
      lo >>= 1;
      hi >>= 1;
      for (let p = lo; p <= hi; p++) this.setNode(d + 1, p, h2(this.node(d, 2 * p), this.node(d, 2 * p + 1)));
    }
    return start;
  }

  /** Insert a leaf at an explicit index (used when replaying events, which carry indices). */
  insertAt(index: number, leaf: bigint): void {
    if (index !== this._size) throw new Error(`tree out of sync: expected index ${this._size}, got ${index}`);
    this.insert([leaf]);
  }

  /** Skip an empty leaf (contract inserts (commitment, 0) pairs at deposit). */
  pad(count: number): void {
    this._size += count;
  }

  path(index: number): bigint[] {
    if (index < 0 || index >= 2 ** this.depth) throw new Error("index out of range");
    const out: bigint[] = [];
    let pos = index;
    for (let d = 0; d < this.depth; d++) {
      out.push(this.node(d, pos ^ 1));
      pos >>= 1;
    }
    return out;
  }

  indexOf(leaf: bigint): number {
    for (const [pos, v] of this.layers[0]!) if (v === leaf) return pos;
    return -1;
  }

  private setNode(level: number, pos: number, v: bigint): void {
    if (v === this.zeros[level]) this.layers[level]!.delete(pos);
    else this.layers[level]!.set(pos, v);
  }
}

/** Recompute a root from a leaf + path (what the circuit does), for client-side checks. */
export function rootFromPath(leaf: bigint, index: number, path: readonly bigint[]): bigint {
  let node = leaf;
  let pos = index;
  for (const sib of path) {
    node = pos & 1 ? h2(sib, node) : h2(node, sib);
    pos >>= 1;
  }
  return node;
}
