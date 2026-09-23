// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// Reference tree builder for tests, matching the anchorer's off-chain builder:
/// level by level, adjacent nodes combined with sorted-pair keccak256, and a
/// trailing odd node carried up unchanged (its proof skips that level).
library MerkleHelper {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function nextLevel(bytes32[] memory level) internal pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i; i < level.length / 2; ++i) {
            next[i] = hashPair(level[2 * i], level[2 * i + 1]);
        }
        if (level.length % 2 == 1) next[next.length - 1] = level[level.length - 1];
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = nextLevel(level);
        }
        return level[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        bytes32[] memory tmp = new bytes32[](64);
        uint256 n;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) tmp[n++] = level[sibling];
            level = nextLevel(level);
            index /= 2;
        }
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }
}
