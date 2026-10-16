/** Writes Prover.toml files for the M0 exercises (zk/docs/learn-zk.md). */
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {h3} from "../src/hashes.js";
import {MerkleTree} from "../src/merkle.js";
import {ZK_DIR} from "../src/devnet.js";

const c = join(ZK_DIR, "circuits");
writeFileSync(join(c, "m0_commitment", "Prover.toml"),
  `# commitment = H3(amount, secret, 0). Change amount or secret and \`nargo execute\` must fail.\ncommitment = "${h3(42n, 7n, 0n)}"\namount = "42"\nsecret = "7"\n`);
const t = new MerkleTree(20);
t.insert([111n, 222n, 333n, 444n]);
writeFileSync(join(c, "m0_merkle", "Prover.toml"),
  `# Tree with leaves [111, 222, 333, 444]; proving leaf 333 at index 2.\nroot = "${t.root}"\nleaf = "333"\nindex = "2"\npath = [${t.path(2).map((x) => `"${x}"`).join(", ")}]\n`);
console.log("wrote m0 Prover.toml files");
