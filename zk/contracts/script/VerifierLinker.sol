// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// Deploys a bb-generated UltraHonk verifier from its artifact (verifier files can't be
/// imported together: bb emits identical file-level names). The default (non --optimized)
/// bb verifier keeps itself under 24 KB by moving RelationsLib and ZKTranscriptLib behind
/// `external` calls; if the artifact has such link placeholders (`__$<keccak(fqn)[:17]>$__`)
/// they are linked to freshly deployed copies. The --optimized verifier we ship has none.
/// Used by script/Deploy.s.sol and the tests (cheatcodes work in both).
library VerifierLinker {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deploy(string memory name) internal returns (address verifier) {
        string memory file = string.concat(name, ".sol");
        string memory code = vm.parseJsonString(vm.readFile(string.concat("out/", file, "/", name, ".json")), ".bytecode.object");
        if (vm.contains(code, "__$")) {
            code = _link(code, file, "RelationsLib");
            code = _link(code, file, "ZKTranscriptLib");
        }
        bytes memory bc = vm.parseBytes(code);
        assembly ("memory-safe") {
            verifier := create(0, add(bc, 0x20), mload(bc))
        }
        require(verifier != address(0), "verifier deployment failed");
    }

    function _link(string memory code, string memory file, string memory lib) private returns (string memory) {
        address addr = vm.deployCode(string.concat(file, ":", lib));
        bytes17 h = bytes17(keccak256(bytes(string.concat("src/verifiers/", file, ":", lib))));
        string memory placeholder = string.concat("__$", _noPrefix(vm.toString(abi.encodePacked(h))), "$__");
        return vm.replace(code, placeholder, _noPrefix(vm.toString(abi.encodePacked(addr))));
    }

    function _noPrefix(string memory s) private pure returns (string memory) {
        return vm.replace(s, "0x", "");
    }
}
