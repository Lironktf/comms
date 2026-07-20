import {
  createPublicClient,
  getContract,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from "viem";
import {
  attestationRegistryAbi,
  canonicalBytes,
  hashDocument,
  parseIpfsUri,
  validateMerchantMetadata,
  vendorRegistryAbi,
  verifyCid,
  verifyDocumentHash,
  type AttestationRecord,
  type ContractTerms,
  type MerchantMetadata,
  type RiskScore,
  type VendorRecord,
} from "@actp/core";

export {hashDocument, verifyDocumentHash, validateMerchantMetadata, computeCid, verifyCid} from "@actp/core";
export type {VendorRecord, MerchantMetadata, ContractTerms, RiskScore} from "@actp/core";

export interface ActpClientOptions {
  /** ACTP backend API base URL, e.g. http://localhost:8402 */
  apiUrl: string;
  /** JSON-RPC endpoint. Required for onchain reads/writes. */
  rpcUrl?: string;
  vendorRegistryAddress?: Address;
  attestationRegistryAddress?: Address;
  /** viem wallet client for onchain writes (vendor registration, metadata anchoring). */
  walletClient?: WalletClient<Transport, Chain | undefined, Account>;
  /** API key for admin/mutating backend endpoints. */
  apiKey?: string;
  /** IPFS HTTP gateway for content-addressed document retrieval, e.g. https://ipfs.io */
  ipfsGatewayUrl?: string;
  fetchFn?: typeof fetch;
}

export class ActpApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActpApiError";
  }
}

/**
 * ACTP SDK.
 *
 * Reads combine the indexed backend API (fast, enriched) with direct onchain access
 * (trustless). The integrity helpers never trust the backend: metadata documents are
 * re-hashed locally and compared against the hash anchored in the VendorRegistry.
 */
export class ActpClient {
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly publicClient: PublicClient | undefined;
  private readonly walletClient: ActpClientOptions["walletClient"];
  private readonly registryAddress: Address | undefined;
  private readonly attestationAddress: Address | undefined;
  private readonly ipfsGatewayUrl: string | undefined;

  constructor(opts: ActpClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.walletClient = opts.walletClient;
    this.registryAddress = opts.vendorRegistryAddress;
    this.attestationAddress = opts.attestationRegistryAddress;
    this.ipfsGatewayUrl = opts.ipfsGatewayUrl?.replace(/\/$/, "");
    if (opts.rpcUrl) {
      this.publicClient = createPublicClient({transport: http(opts.rpcUrl)}) as PublicClient;
    }
  }

  // ------------------------------------------------------------------ API reads

  async getVendor(vendorId: Hex): Promise<VendorRecord> {
    const res = await this.api<{vendor: VendorRecord}>("GET", `/v1/vendors/${vendorId}`);
    return res.vendor;
  }

  /** Resolve the vendor claiming a domain. Returns null when unclaimed (fail closed upstream). */
  async resolveDomain(domain: string): Promise<VendorRecord | null> {
    return this.resolve(`domain=${encodeURIComponent(domain)}`);
  }

  /** Resolve the vendor claiming a payout wallet — the primary x402 pre-payment check. */
  async resolveWallet(wallet: Address): Promise<VendorRecord | null> {
    return this.resolve(`wallet=${wallet}`);
  }

  private async resolve(query: string): Promise<VendorRecord | null> {
    try {
      const res = await this.api<{vendor: VendorRecord}>("GET", `/v1/vendors?${query}`);
      return res.vendor;
    } catch (err) {
      if (err instanceof ActpApiError && err.status === 404) return null;
      throw err;
    }
  }

  async getAttestations(vendorId: Hex): Promise<AttestationRecord[]> {
    const res = await this.api<{attestations: AttestationRecord[]}>(
      "GET",
      `/v1/vendors/${vendorId}/attestations`,
    );
    return res.attestations;
  }

  async getRisk(vendorId: Hex): Promise<RiskScore> {
    return this.api<RiskScore>("GET", `/v1/vendors/${vendorId}/risk`);
  }

  async getContractTerms(vendorId: Hex): Promise<{terms: ContractTerms; merchantAnchored: boolean}> {
    return this.api("GET", `/v1/vendors/${vendorId}/contract-terms`);
  }

  /**
   * Fetch the latest metadata document and verify it against the onchain anchor.
   * `trusted` is computed locally: document re-hashed here, anchor read from the chain
   * when an RPC is configured (falling back to the indexed anchor otherwise).
   */
  async getVerifiedMetadata(vendorId: Hex): Promise<{
    document: MerchantMetadata;
    canonicalHash: Hex;
    cid: string | null;
    trusted: boolean;
    anchorSource: "chain" | "indexer";
  }> {
    const res = await this.api<{document: MerchantMetadata; version: number; cid: string | null}>(
      "GET",
      `/v1/vendors/${vendorId}/metadata`,
    );
    const canonicalHash = hashDocument(res.document);

    let anchor: Hex | null = null;
    let anchorSource: "chain" | "indexer" = "indexer";
    if (this.publicClient && this.registryAddress) {
      anchor = (await this.registry().read.metadataHashOf([vendorId])) as Hex;
      anchorSource = "chain";
    } else {
      const vendor = await this.getVendor(vendorId);
      anchor = vendor.metadataHash;
    }

    const trusted =
      anchor !== null &&
      anchor !== "0x0000000000000000000000000000000000000000000000000000000000000000" &&
      anchor.toLowerCase() === canonicalHash.toLowerCase();

    return {document: res.document, canonicalHash, cid: res.cid ?? null, trusted, anchorSource};
  }

  /**
   * Fully trustless metadata retrieval: fetch the document from an IPFS gateway by the CID
   * recorded in the vendor's onchain metadataURI, then verify it against BOTH the content
   * address (the gateway can't tamper) AND the onchain keccak anchor (the vendor committed
   * to exactly this document). Never touches the ACTP backend — no operator to trust.
   *
   * Requires rpcUrl + vendorRegistryAddress (to read the onchain URI + anchor) and either
   * `ipfsGatewayUrl` on the client or the `gatewayUrl` argument.
   */
  async getMetadataTrustless(
    vendorId: Hex,
    gatewayUrl?: string,
  ): Promise<{
    document: MerchantMetadata;
    cid: string;
    cidValid: boolean;
    anchorMatch: boolean;
    trusted: boolean;
  }> {
    const gateway = (gatewayUrl ?? this.ipfsGatewayUrl)?.replace(/\/$/, "");
    if (!gateway) throw new Error("ipfsGatewayUrl is required for trustless retrieval");

    const view = (await this.registry().read.getVendor([vendorId])) as {
      metadataURI: string;
      metadataHash: Hex;
    };
    const cid = parseIpfsUri(view.metadataURI);
    if (!cid) throw new Error(`vendor metadataURI is not an ipfs:// CID: "${view.metadataURI}"`);

    const res = await this.fetchFn(`${gateway}/ipfs/${cid}`);
    if (!res.ok) throw new Error(`gateway fetch failed: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    const cidValid = await verifyCid(bytes, cid);
    const document = JSON.parse(new TextDecoder().decode(bytes)) as MerchantMetadata;
    // recompute the keccak anchor over the SAME canonical bytes the registry committed to
    const anchorMatch =
      hashDocument(document).toLowerCase() === view.metadataHash.toLowerCase() &&
      // and confirm the fetched bytes are themselves canonical (no whitespace games)
      new TextDecoder().decode(canonicalBytes(document)) === new TextDecoder().decode(bytes);

    return {document, cid, cidValid, anchorMatch, trusted: cidValid && anchorMatch};
  }

  // ------------------------------------------------------------------ API writes

  async publishMetadata(
    vendorId: Hex,
    document: MerchantMetadata,
  ): Promise<{version: number; canonicalHash: Hex; cid: string; uri: string}> {
    validateMerchantMetadata(document);
    return this.api("PUT", `/v1/vendors/${vendorId}/metadata`, document);
  }

  async submitContractDocument(
    vendorId: Hex,
    input: {content: string; docType?: string; sourceUrl?: string},
  ): Promise<{terms: ContractTerms; merchantAnchored: boolean}> {
    return this.api("POST", `/v1/vendors/${vendorId}/contract-documents`, input);
  }

  // ------------------------------------------------------------------ onchain

  /** Compute the deterministic vendor id for a primary domain (pure onchain call). */
  async computeVendorId(primaryDomain: string): Promise<Hex> {
    return (await this.registry().read.computeVendorId([primaryDomain])) as Hex;
  }

  /** Register a vendor onchain. Requires walletClient. Returns the vendorId. */
  async registerVendor(params: {
    primaryDomain: string;
    extraDomains?: string[];
    wallets?: Address[];
    x402Endpoint?: string;
    metadata?: MerchantMetadata;
    metadataUri?: string;
  }): Promise<{vendorId: Hex; txHash: Hex; metadataHash: Hex | null}> {
    const wallet = this.requireWallet();
    const metadataHash = params.metadata ? hashDocument(validateMerchantMetadata(params.metadata)) : null;

    const txHash = await wallet.writeContract({
      address: this.requireAddress(this.registryAddress, "vendorRegistryAddress"),
      abi: vendorRegistryAbi,
      functionName: "registerVendor",
      args: [
        params.primaryDomain,
        params.extraDomains ?? [],
        params.wallets ?? [],
        params.x402Endpoint ?? "",
        metadataHash ?? ("0x" + "0".repeat(64) as Hex),
        params.metadataUri ?? "",
      ],
      chain: wallet.chain ?? null,
    });
    await this.requirePublic().waitForTransactionReceipt({hash: txHash});
    const vendorId = await this.computeVendorId(params.primaryDomain);
    return {vendorId, txHash, metadataHash};
  }

  /** Anchor a metadata document hash onchain (vendor owner key). */
  async anchorMetadata(vendorId: Hex, document: MerchantMetadata, uri = ""): Promise<{txHash: Hex; hash: Hex}> {
    const wallet = this.requireWallet();
    const hash = hashDocument(validateMerchantMetadata(document));
    const txHash = await wallet.writeContract({
      address: this.requireAddress(this.registryAddress, "vendorRegistryAddress"),
      abi: vendorRegistryAbi,
      functionName: "setMetadata",
      args: [vendorId, hash, uri],
      chain: wallet.chain ?? null,
    });
    await this.requirePublic().waitForTransactionReceipt({hash: txHash});
    return {txHash, hash};
  }

  /** Anchor a contract-terms document hash onchain (vendor owner key). */
  async anchorContractDocument(vendorId: Hex, content: string): Promise<{txHash: Hex; hash: Hex}> {
    const wallet = this.requireWallet();
    const {keccak256, toBytes} = await import("viem");
    const hash = keccak256(toBytes(content));
    const txHash = await wallet.writeContract({
      address: this.requireAddress(this.registryAddress, "vendorRegistryAddress"),
      abi: vendorRegistryAbi,
      functionName: "setContractMetadataHash",
      args: [vendorId, hash],
      chain: wallet.chain ?? null,
    });
    await this.requirePublic().waitForTransactionReceipt({hash: txHash});
    return {txHash, hash};
  }

  /** Vendor owner signs the currently anchored metadata (verification level 4). */
  async vendorSignMetadata(vendorId: Hex): Promise<Hex> {
    const wallet = this.requireWallet();
    const txHash = await wallet.writeContract({
      address: this.requireAddress(this.attestationAddress, "attestationRegistryAddress"),
      abi: attestationRegistryAbi,
      functionName: "vendorSignMetadata",
      args: [vendorId],
      chain: wallet.chain ?? null,
    });
    await this.requirePublic().waitForTransactionReceipt({hash: txHash});
    return txHash;
  }

  /** Live onchain verification level (trustless read; no indexer involved). */
  async onchainVerificationLevel(vendorId: Hex): Promise<number> {
    const level = await this.attestations_().read.verificationLevel([vendorId]);
    return Number(level);
  }

  /** Live onchain vendor status: 0 None, 1 Active, 2 Suspended, 3 Revoked. */
  async onchainVendorStatus(vendorId: Hex): Promise<number> {
    const status = await this.registry().read.vendorStatus([vendorId]);
    return Number(status);
  }

  // ------------------------------------------------------------------ internals

  private registry() {
    return getContract({
      address: this.requireAddress(this.registryAddress, "vendorRegistryAddress"),
      abi: vendorRegistryAbi,
      client: this.requirePublic(),
    });
  }

  private attestations_() {
    return getContract({
      address: this.requireAddress(this.attestationAddress, "attestationRegistryAddress"),
      abi: attestationRegistryAbi,
      client: this.requirePublic(),
    });
  }

  private requirePublic(): PublicClient {
    if (!this.publicClient) throw new Error("rpcUrl is required for onchain operations");
    return this.publicClient;
  }

  private requireWallet(): NonNullable<ActpClientOptions["walletClient"]> {
    if (!this.walletClient) throw new Error("walletClient is required for onchain writes");
    return this.walletClient;
  }

  private requireAddress(addr: Address | undefined, name: string): Address {
    if (!addr) throw new Error(`${name} is required`);
    return addr;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.apiUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? {"x-api-key": this.apiKey} : {}),
      },
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as {error?: string};
        if (data.error) message = data.error;
      } catch {
        // keep default
      }
      throw new ActpApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
