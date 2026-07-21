import {afterEach, describe, expect, it} from "vitest";
import {computeCid} from "@actp/core";
import {KuboIpfsStore, MemoryIpfsStore} from "./ipfs.js";

/**
 * The security property of a content-addressed store: it must NEVER return bytes that don't
 * hash to the requested CID, no matter what the underlying node says. These tests point the
 * Kubo store at a lying node (stubbed fetch) and confirm it refuses the bytes.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
}

describe("KuboIpfsStore — never trust the node", () => {
  it("get() returns null when the node returns bytes that don't match the CID", async () => {
    const realBytes = new TextEncoder().encode("the authentic document");
    const cid = await computeCid(realBytes);
    // node lies: returns different bytes for the requested CID
    stubFetch((url) => {
      if (url.includes("/block/get")) return new Response(Buffer.from("TAMPERED content"), {status: 200});
      return new Response("", {status: 404});
    });
    const store = new KuboIpfsStore("http://ipfs.local:5001");
    expect(await store.get(cid)).toBeNull();
  });

  it("get() returns the bytes only when they genuinely match the CID", async () => {
    const realBytes = new TextEncoder().encode("the authentic document");
    const cid = await computeCid(realBytes);
    stubFetch((url) => {
      if (url.includes("/block/get")) return new Response(Buffer.from(realBytes), {status: 200});
      return new Response("", {status: 404});
    });
    const store = new KuboIpfsStore("http://ipfs.local:5001");
    const got = await store.get(cid);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe("the authentic document");
  });

  it("put() throws if the node returns a CID different from the locally-computed one", async () => {
    stubFetch((url) => {
      if (url.includes("/block/put")) {
        return new Response(JSON.stringify({Key: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Size: 3}), {status: 200});
      }
      return new Response("", {status: 404});
    });
    const store = new KuboIpfsStore("http://ipfs.local:5001");
    await expect(store.put(new TextEncoder().encode("x"))).rejects.toThrow(/unexpected CID/i);
  });

  it("get() returns null on a node error", async () => {
    stubFetch(() => new Response("boom", {status: 500}));
    const store = new KuboIpfsStore("http://ipfs.local:5001");
    expect(await store.get("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")).toBeNull();
  });
});

describe("MemoryIpfsStore", () => {
  it("round-trips and verifies on read", async () => {
    const store = new MemoryIpfsStore();
    const bytes = new TextEncoder().encode("doc");
    const {cid} = await store.put(bytes);
    expect(new TextDecoder().decode((await store.get(cid))!)).toBe("doc");
    expect(await store.get("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")).toBeNull();
  });
});
