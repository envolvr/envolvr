// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title WeightsRegistry
/// @notice Reference weights roots for attested weights.
///
/// A model VM hashes its weight files at boot and records the Merkle root in its
/// attestation. Verifiers compare that root with the reference published here for
/// the same model repository and revision. Anyone can recompute a reference from
/// the public repository, so a wrong entry is publicly detectable.
///
/// Entries are write-once: a published reference can never be changed. A new
/// revision of a model is a new entry.
contract WeightsRegistry is Ownable2Step {
    struct Reference {
        bytes32 weightsRoot;
        uint64 publishedAt;
    }

    mapping(bytes32 key => Reference) private _references;

    event ReferencePublished(bytes32 indexed key, string repo, string revision, bytes32 weightsRoot);

    error AlreadyPublished(bytes32 key);
    error ZeroRoot();
    error EmptyIdentifier();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function publish(string calldata repo, string calldata revision, bytes32 weightsRoot) external onlyOwner {
        if (bytes(repo).length == 0 || bytes(revision).length == 0) revert EmptyIdentifier();
        if (weightsRoot == bytes32(0)) revert ZeroRoot();
        bytes32 key = keyOf(repo, revision);
        if (_references[key].weightsRoot != bytes32(0)) revert AlreadyPublished(key);
        _references[key] = Reference({weightsRoot: weightsRoot, publishedAt: uint64(block.timestamp)});
        emit ReferencePublished(key, repo, revision, weightsRoot);
    }

    /// @return weightsRoot Zero when no reference is published for this revision.
    function referenceOf(string calldata repo, string calldata revision)
        external
        view
        returns (bytes32 weightsRoot, uint64 publishedAt)
    {
        Reference storage r = _references[keyOf(repo, revision)];
        return (r.weightsRoot, r.publishedAt);
    }

    function keyOf(string calldata repo, string calldata revision) public pure returns (bytes32) {
        return keccak256(abi.encode(repo, revision));
    }
}
