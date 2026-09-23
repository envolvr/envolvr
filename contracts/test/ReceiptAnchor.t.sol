// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {MerkleHelper} from "./MerkleHelper.sol";

contract ReceiptAnchorTest is Test {
    ReceiptAnchor internal anchorLog;
    address internal owner = makeAddr("owner");
    address internal gateway = makeAddr("gateway");
    bytes32 internal constant PROVIDER = keccak256("envolvr.provider:gateway-1");

    function setUp() public {
        anchorLog = new ReceiptAnchor(owner);
        vm.prank(owner);
        anchorLog.setAnchorer(PROVIDER, gateway);
    }

    function _leaves(uint256 n, uint256 seed) internal view returns (bytes32[] memory digests, bytes32[] memory leaves) {
        digests = new bytes32[](n);
        leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            digests[i] = keccak256(abi.encode(seed, i));
            leaves[i] = anchorLog.leafOf(digests[i]);
        }
    }

    function test_SetAnchorer_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, gateway));
        vm.prank(gateway);
        anchorLog.setAnchorer(PROVIDER, gateway);
    }

    function test_Anchor_RevertsForNonAnchorer() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(ReceiptAnchor.NotAnchorer.selector, PROVIDER, stranger));
        vm.prank(stranger);
        anchorLog.anchor(PROVIDER, 0, bytes32(uint256(1)), 1);
    }

    function test_Anchor_SequentialBatchesTrackFirstReceipt() public {
        vm.startPrank(gateway);
        anchorLog.anchor(PROVIDER, 0, bytes32(uint256(1)), 10);
        vm.warp(1_790_000_000);
        anchorLog.anchor(PROVIDER, 1, bytes32(uint256(2)), 5);
        vm.stopPrank();

        assertEq(anchorLog.batchCount(PROVIDER), 2);
        ReceiptAnchor.Batch memory b = anchorLog.batch(PROVIDER, 1);
        assertEq(b.root, bytes32(uint256(2)));
        assertEq(b.firstReceipt, 10);
        assertEq(b.count, 5);
        assertEq(b.anchoredAt, 1_790_000_000);
    }

    function test_Anchor_RetryOfLandedBatchReverts() public {
        vm.startPrank(gateway);
        anchorLog.anchor(PROVIDER, 0, bytes32(uint256(1)), 1);
        vm.expectRevert(abi.encodeWithSelector(ReceiptAnchor.UnexpectedBatchIndex.selector, 1, 0));
        anchorLog.anchor(PROVIDER, 0, bytes32(uint256(1)), 1);
        vm.expectRevert(abi.encodeWithSelector(ReceiptAnchor.UnexpectedBatchIndex.selector, 1, 2));
        anchorLog.anchor(PROVIDER, 2, bytes32(uint256(3)), 1);
        vm.stopPrank();
    }

    function test_Anchor_RejectsEmptyBatchAndZeroRoot() public {
        vm.startPrank(gateway);
        vm.expectRevert(ReceiptAnchor.EmptyBatch.selector);
        anchorLog.anchor(PROVIDER, 0, bytes32(uint256(1)), 0);
        vm.expectRevert(ReceiptAnchor.ZeroRoot.selector);
        anchorLog.anchor(PROVIDER, 0, bytes32(0), 1);
        vm.stopPrank();
    }

    function test_RotateAnchorer_KeepsHistory() public {
        vm.prank(gateway);
        anchorLog.anchor(PROVIDER, 0, bytes32(uint256(1)), 1);

        address newGateway = makeAddr("newGateway");
        vm.prank(owner);
        anchorLog.setAnchorer(PROVIDER, newGateway);

        vm.expectRevert(abi.encodeWithSelector(ReceiptAnchor.NotAnchorer.selector, PROVIDER, gateway));
        vm.prank(gateway);
        anchorLog.anchor(PROVIDER, 1, bytes32(uint256(2)), 1);

        vm.prank(newGateway);
        anchorLog.anchor(PROVIDER, 1, bytes32(uint256(2)), 1);
        assertEq(anchorLog.batch(PROVIDER, 0).root, bytes32(uint256(1)));
        assertEq(anchorLog.batchCount(PROVIDER), 2);
    }

    function test_Batch_RevertsForMissingIndex() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiptAnchor.NoSuchBatch.selector, PROVIDER, 0));
        anchorLog.batch(PROVIDER, 0);
    }

    function testFuzz_VerifyReceipt(uint8 size, uint256 seed) public {
        uint256 n = bound(size, 1, 64);
        (bytes32[] memory digests, bytes32[] memory leaves) = _leaves(n, seed);
        bytes32 root = MerkleHelper.root(leaves);

        vm.prank(gateway);
        anchorLog.anchor(PROVIDER, 0, root, uint32(n));

        for (uint256 i; i < n; ++i) {
            bytes32[] memory p = MerkleHelper.proof(leaves, i);
            assertTrue(anchorLog.verifyReceipt(PROVIDER, 0, digests[i], p), "member must verify");
            assertFalse(anchorLog.verifyReceipt(PROVIDER, 1, digests[i], p), "unanchored batch must fail");
        }
        bytes32[] memory p0 = MerkleHelper.proof(leaves, 0);
        assertFalse(anchorLog.verifyReceipt(PROVIDER, 0, keccak256("not a member"), p0), "non-member must fail");
    }

    /// Cross-implementation vector: the anchorer (anchorer/test/merkle.test.ts)
    /// computes the same root from the same inputs.
    function test_VectorRoot_MatchesAnchorer() public view {
        (, bytes32[] memory leaves) = _leaves(5, 42);
        assertEq(MerkleHelper.root(leaves), 0x2d6f32c5a43b671f25120af26b4db005c4ef0bb359ac0f25b1720e7c64e9bf92);
    }

    /// An inner node cannot be passed off as a receipt digest: leaves are
    /// double-hashed, so the inner node's value never equals a leaf.
    function test_VerifyReceipt_RejectsInnerNodeAsLeaf() public {
        (, bytes32[] memory leaves) = _leaves(4, 7);
        bytes32 root = MerkleHelper.root(leaves);
        vm.prank(gateway);
        anchorLog.anchor(PROVIDER, 0, root, 4);

        bytes32 inner = MerkleHelper.hashPair(leaves[0], leaves[1]);
        bytes32[] memory p = new bytes32[](1);
        p[0] = MerkleHelper.hashPair(leaves[2], leaves[3]);
        assertFalse(anchorLog.verifyReceipt(PROVIDER, 0, inner, p));
    }
}
