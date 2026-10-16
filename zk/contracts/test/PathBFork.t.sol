// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC3009} from "../src/interfaces/IERC3009.sol";
import {PoolFixture} from "./helpers/PoolFixture.sol";

/// Path B against the REAL Circle FiatToken (USDC) bytecode, on a local fork. Read-only RPC;
/// nothing is broadcast. Skipped unless FORK_URL is set, e.g.
///   FORK_URL=https://sepolia.base.org USDC_ADDR=0x036CbD53842c5426634e7929541eC2318f3dCF7e forge test --match-contract PathBFork -vv
///   FORK_URL=https://mainnet.base.org USDC_ADDR=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 forge test --match-contract PathBFork -vv
contract PathBForkTest is PoolFixture {
    IERC20 realUsdc;
    bool enabled;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        enabled = true;
        vm.createSelectFork(url);
        setUpPool();
        realUsdc = IERC20(vm.envAddress("USDC_ADDR"));
        pool.configureToken(address(realUsdc), true, true, 1_000e6);
    }

    function test_realUsdc_acceptsPoolEip1271Authorization() public {
        if (!enabled) {
            emit log("FORK_URL not set: skipped");
            return;
        }
        // fund the pool through a normal deposit
        address alice = makeAddr("alice");
        deal(address(realUsdc), alice, 10e6);
        vm.startPrank(alice);
        realUsdc.approve(address(pool), 10e6);
        pool.deposit(address(realUsdc), 10e6, 42, "");
        vm.stopPrank();

        ShieldedPool.TransactInputs memory t;
        t.root = pool.root();
        t.aspRoot = 777;
        t.nullifiers = [uint256(1), uint256(2)];
        t.outCommitments = [uint256(3), uint256(4)];
        t.publicAmount = 3e6;
        t.token = address(realUsdc);
        t.recipient = merchant;
        ShieldedPool.ExtData memory e = ext(address(0), 0);
        ShieldedPool.Authorization3009 memory a =
            ShieldedPool.Authorization3009(block.timestamp - 1, block.timestamp + 300, keccak256("nonce-1"));
        vTransact.declareTrue(
            transactPub(t, true, pool.computeContext(4, e, keccak256(abi.encode(a.validAfter, a.validBefore, a.nonce))))
        );
        bytes32 digest = pool.authorizeTransfer("", t, e, a);

        // The pool's digest must be exactly what real USDC hashes (EIP-712 with ITS domain).
        // A standard x402 facilitator now settles with the bytes-signature overload:
        vm.prank(makeAddr("facilitator"));
        IERC3009(address(realUsdc)).transferWithAuthorization(
            address(pool), merchant, 3e6, a.validAfter, a.validBefore, a.nonce, hex"677261797a6b2e706f6f6c2e65697031323731"
        );
        assertEq(realUsdc.balanceOf(merchant), 3e6, "real USDC executed the pool-authorized transfer");
        assertTrue(IERC3009(address(realUsdc)).authorizationState(address(pool), a.nonce));
        emit log_named_bytes32("digest accepted by real FiatToken via EIP-1271", digest);

        // and it refuses anything the pool did not register
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        IERC3009(address(realUsdc)).transferWithAuthorization(
            address(pool), merchant, 1e6, a.validAfter, a.validBefore, keccak256("nonce-2"), hex"00"
        );
    }
}
