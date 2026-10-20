// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VendorRegistry} from "@grayr/VendorRegistry.sol";
import {AttestationRegistry} from "@grayr/AttestationRegistry.sol";
import {IVendorRegistry} from "@grayr/interfaces/IVendorRegistry.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {VendorTree} from "../src/VendorTree.sol";
import {AssociationSetRegistry} from "../src/AssociationSetRegistry.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {IV3SwapRouter} from "../src/adapters/IV3SwapRouter.sol";
import {IHonkVerifier} from "../src/interfaces/IHonkVerifier.sol";
import {IAssociationSet} from "../src/interfaces/IAssociationSet.sol";
import {IVendorTree} from "../src/interfaces/IVendorTree.sol";
import {IAttestationLevels} from "../src/interfaces/IAttestationLevels.sol";
import {IPoseidon2} from "../src/interfaces/IPoseidon2.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {VerifierLinker} from "./VerifierLinker.sol";

/// Deploys the shielded pool stack.
///
/// LOCAL (default, chain 31337): also deploys fresh Grayr registries, MockUSDC, a mock WETH
/// and a mock SwapRouter02, so everything runs offline on anvil.
///
///   anvil
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
/// TESTNET (Base Sepolia, run by a human, never by tooling): set
///   VENDOR_REGISTRY, ATTESTATION_REGISTRY  existing Grayr proxies (contracts/deployments/base-sepolia.json)
///   USDC                                   0x036CbD53842c5426634e7929541eC2318f3dCF7e (Circle, Base Sepolia)
///   SWAP_ROUTER                            optional: a SwapRouter02 address; omit to skip swaps
///   ASP_POSTMAN                            address allowed to publish association-set roots
///   OWNER                                  pool owner (token config only); use a Safe
///   USDC_MAX_DEPOSIT                       optional per-deposit cap, atomic units (default 10,000 USDC;
///                                          1 USDC on Base mainnet)
/// and pass --rpc-url $BASE_SEPOLIA_RPC_URL with your own key. See zk/docs/deploy.md.
/// BASE MAINNET (8453): same variables, USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913. Unaudited:
/// keep the 1 USDC cap. See zk/docs/deploy.md §6.
contract Deploy is Script {
    struct Deployed {
        address poseidon2;
        address transactVerifier;
        address policyPayVerifier;
        address budgetInitVerifier;
        address ragequitVerifier;
        address vendorRegistry;
        address attestationRegistry;
        address vendorTree;
        address associationSet;
        address pool;
        address usdc;
        address weth;
        address swapRouter;
        address swapAdapter;
        address aggregate2Verifier;
        address aggregate4Verifier;
        address aggregate8Verifier;
    }

    function run() external returns (Deployed memory d) {
        bool local = block.chainid == 31337;
        address owner = vm.envOr("OWNER", msg.sender);
        address postman = vm.envOr("ASP_POSTMAN", msg.sender);

        vm.startBroadcast();

        d.poseidon2 = deployCode("Poseidon2Yul.sol:Poseidon2Yul_BN254");
        d.transactVerifier = VerifierLinker.deploy("TransactVerifier");
        d.policyPayVerifier = VerifierLinker.deploy("PolicyPayVerifier");
        d.budgetInitVerifier = VerifierLinker.deploy("BudgetInitVerifier");
        d.ragequitVerifier = VerifierLinker.deploy("RagequitVerifier");
        d.aggregate2Verifier = VerifierLinker.deploy("Aggregate2Verifier");
        d.aggregate4Verifier = VerifierLinker.deploy("Aggregate4Verifier");
        d.aggregate8Verifier = VerifierLinker.deploy("Aggregate8Verifier");

        d.vendorRegistry = vm.envOr("VENDOR_REGISTRY", address(0));
        d.attestationRegistry = vm.envOr("ATTESTATION_REGISTRY", address(0));
        if (d.vendorRegistry == address(0)) {
            require(local, "set VENDOR_REGISTRY / ATTESTATION_REGISTRY off-anvil");
            VendorRegistry vrImpl = new VendorRegistry();
            d.vendorRegistry =
                address(new ERC1967Proxy(address(vrImpl), abi.encodeCall(VendorRegistry.initialize, (msg.sender))));
            AttestationRegistry arImpl = new AttestationRegistry();
            d.attestationRegistry = address(
                new ERC1967Proxy(
                    address(arImpl),
                    abi.encodeCall(AttestationRegistry.initialize, (msg.sender, IVendorRegistry(d.vendorRegistry)))
                )
            );
            AttestationRegistry(d.attestationRegistry).grantRole(
                AttestationRegistry(d.attestationRegistry).VERIFIER_ROLE(), msg.sender
            );
        }

        d.vendorTree = address(
            new VendorTree(
                IVendorRegistry(d.vendorRegistry),
                IAttestationLevels(d.attestationRegistry),
                IPoseidon2(d.poseidon2),
                owner
            )
        );
        d.associationSet = address(new AssociationSetRegistry(owner, postman));
        ShieldedPool pool = new ShieldedPool(
            IHonkVerifier(d.transactVerifier),
            IHonkVerifier(d.policyPayVerifier),
            IHonkVerifier(d.budgetInitVerifier),
            IHonkVerifier(d.ragequitVerifier),
            IAssociationSet(d.associationSet),
            IVendorTree(d.vendorTree),
            IPoseidon2(d.poseidon2),
            msg.sender,
            [IHonkVerifier(d.aggregate2Verifier), IHonkVerifier(d.aggregate4Verifier), IHonkVerifier(d.aggregate8Verifier)]
        );
        d.pool = address(pool);

        if (local) {
            d.usdc = address(new MockUSDC());
            d.weth = address(new MockERC20("Wrapped Ether", "WETH", 18));
            d.swapRouter = address(new MockSwapRouter());
            // 1 USDC (1e6) -> 0.0004 WETH (4e14): i.e. $2500/ETH
            MockSwapRouter(d.swapRouter).setRate(d.usdc, d.weth, 4e14, 1e6);
            MockSwapRouter(d.swapRouter).setRate(d.weth, d.usdc, 1e6, 4e14);
            MockUSDC(d.usdc).mint(d.swapRouter, 1_000_000e6);
            MockERC20(d.weth).mint(d.swapRouter, 1_000e18);
        } else {
            d.usdc = vm.envAddress("USDC");
            d.swapRouter = vm.envOr("SWAP_ROUTER", address(0));
            d.weth = vm.envOr("WETH", address(0));
        }

        // Per-deposit cap: research deployment, keep exposure small. On Base mainnet (8453) the
        // default is 1 USDC (ASSUMPTION: a demo needs no more; raise only after an audit).
        uint256 usdcCap = vm.envOr("USDC_MAX_DEPOSIT", block.chainid == 8453 ? uint256(1e6) : uint256(10_000e6));
        pool.configureToken(d.usdc, true, true, uint128(usdcCap));
        if (d.weth != address(0)) pool.configureToken(d.weth, true, false, 10e18);
        if (d.swapRouter != address(0)) {
            d.swapAdapter = address(new UniswapV3Adapter(IV3SwapRouter(d.swapRouter), d.pool));
            pool.setSwapAdapter(d.swapAdapter, true);
        }
        if (owner != msg.sender) pool.transferOwnership(owner);

        vm.stopBroadcast();

        string memory j = "d";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "poseidon2", d.poseidon2);
        vm.serializeAddress(j, "transactVerifier", d.transactVerifier);
        vm.serializeAddress(j, "policyPayVerifier", d.policyPayVerifier);
        vm.serializeAddress(j, "budgetInitVerifier", d.budgetInitVerifier);
        vm.serializeAddress(j, "ragequitVerifier", d.ragequitVerifier);
        vm.serializeAddress(j, "aggregate2Verifier", d.aggregate2Verifier);
        vm.serializeAddress(j, "aggregate4Verifier", d.aggregate4Verifier);
        vm.serializeAddress(j, "aggregate8Verifier", d.aggregate8Verifier);
        vm.serializeAddress(j, "aggregationModule", ShieldedPool(d.pool).aggregationModule());
        vm.serializeAddress(j, "vendorRegistry", d.vendorRegistry);
        vm.serializeAddress(j, "attestationRegistry", d.attestationRegistry);
        vm.serializeAddress(j, "vendorTree", d.vendorTree);
        vm.serializeAddress(j, "associationSet", d.associationSet);
        vm.serializeAddress(j, "usdc", d.usdc);
        vm.serializeAddress(j, "weth", d.weth);
        vm.serializeAddress(j, "swapRouter", d.swapRouter);
        vm.serializeAddress(j, "swapAdapter", d.swapAdapter);
        vm.serializeAddress(j, "paymentBook", address(ShieldedPool(d.pool).paymentBook()));
        vm.serializeUint(j, "deployBlock", block.number);
        string memory out = vm.serializeAddress(j, "pool", d.pool);
        string memory file = local ? "deployments/anvil.json" : string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, file);
        console.log("ShieldedPool: %s", d.pool);
        console.log("wrote %s", file);
    }
}
