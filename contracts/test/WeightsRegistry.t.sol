// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WeightsRegistry} from "../src/WeightsRegistry.sol";

contract WeightsRegistryTest is Test {
    WeightsRegistry internal registry;
    address internal owner = makeAddr("owner");
    string internal constant REPO = "zai-org/GLM-5.3";
    string internal constant REV = "3f2a9c1e0b7d4a65c8e2f1b09d7a3c5e4f6b8a21";
    bytes32 internal constant ROOT = keccak256("glm-5.3 weights root");

    function setUp() public {
        registry = new WeightsRegistry(owner);
    }

    function test_PublishAndRead() public {
        vm.warp(1_790_000_000);
        vm.prank(owner);
        registry.publish(REPO, REV, ROOT);
        (bytes32 root, uint64 publishedAt) = registry.referenceOf(REPO, REV);
        assertEq(root, ROOT);
        assertEq(publishedAt, 1_790_000_000);
    }

    function test_UnpublishedRevisionReadsZero() public view {
        (bytes32 root, uint64 publishedAt) = registry.referenceOf(REPO, REV);
        assertEq(root, bytes32(0));
        assertEq(publishedAt, 0);
    }

    function test_PublishedReferenceCannotChange() public {
        vm.startPrank(owner);
        registry.publish(REPO, REV, ROOT);
        vm.expectRevert(abi.encodeWithSelector(WeightsRegistry.AlreadyPublished.selector, registry.keyOf(REPO, REV)));
        registry.publish(REPO, REV, keccak256("different"));
        vm.stopPrank();
    }

    function test_NewRevisionIsNewEntry() public {
        vm.startPrank(owner);
        registry.publish(REPO, REV, ROOT);
        registry.publish(REPO, "next-revision", keccak256("next"));
        vm.stopPrank();
        (bytes32 root,) = registry.referenceOf(REPO, REV);
        assertEq(root, ROOT);
    }

    function test_OnlyOwnerPublishes() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        registry.publish(REPO, REV, ROOT);
    }

    function test_RejectsZeroRootAndEmptyIdentifiers() public {
        vm.startPrank(owner);
        vm.expectRevert(WeightsRegistry.ZeroRoot.selector);
        registry.publish(REPO, REV, bytes32(0));
        vm.expectRevert(WeightsRegistry.EmptyIdentifier.selector);
        registry.publish("", REV, ROOT);
        vm.expectRevert(WeightsRegistry.EmptyIdentifier.selector);
        registry.publish(REPO, "", ROOT);
        vm.stopPrank();
    }

    /// abi.encode keeps (repo, revision) pairs unambiguous: "a/b" + "c" and
    /// "a/" + "bc" map to different keys.
    function test_KeysAreUnambiguous() public view {
        assertTrue(registry.keyOf("a/b", "c") != registry.keyOf("a/", "bc"));
    }
}
