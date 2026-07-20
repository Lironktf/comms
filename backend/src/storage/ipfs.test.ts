import {describe, expect, it} from "vitest";
import {computeCid, verifyCid} from "@actp/core";
import {MemoryIpfsStore} from "./ipfs.js";

describe("MemoryIpfsStore", () => {
  it("stores bytes under their real CID and round-trips them", async () => {
    const store = new MemoryIpfsStore();
    const bytes = new TextEncoder().encode('{"schema":"actp.metadata.v1"}');
    const {cid} = await store.put(bytes);

    expect(cid).toBe(await computeCid(bytes));
    const fetched = await store.get(cid);
    expect(fetched).not.toBeNull();
    expect(await verifyCid(fetched!, cid)).toBe(true);
    expect(new TextDecoder().decode(fetched!)).toBe('{"schema":"actp.metadata.v1"}');
  });

  it("returns null for an unknown CID", async () => {
    const store = new MemoryIpfsStore();
    expect(await store.get("bafkreiabc")).toBeNull();
  });

  it("deduplicates identical content to the same CID", async () => {
    const store = new MemoryIpfsStore();
    const bytes = new TextEncoder().encode("same");
    const a = await store.put(bytes);
    const b = await store.put(new TextEncoder().encode("same"));
    expect(a.cid).toBe(b.cid);
  });
});
