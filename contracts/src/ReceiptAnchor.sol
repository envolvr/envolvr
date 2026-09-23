// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title ReceiptAnchor
/// @notice Append-only log of receipt batch roots, one chain per provider.
///
/// A provider's gateway collects signed ACI receipts, builds a Merkle tree over
/// their digests at a fixed interval, and anchors the root here. Anyone can then
/// prove that a receipt was issued, and when, without trusting envolvr.
///
/// Leaf encoding: `keccak256(bytes.concat(keccak256(abi.encode(receiptDigest))))`,
/// where `receiptDigest` is the SHA-256 of the receipt's JCS bytes. Leaves are
/// double-hashed so a leaf can never be confused with an inner node. Inner nodes
/// use OpenZeppelin's sorted-pair keccak256.
contract ReceiptAnchor is Ownable2Step {
    struct Batch {
        bytes32 root;
        /// Sequence number of the batch's first receipt within the provider's log.
        uint64 firstReceipt;
        uint32 count;
        uint64 anchoredAt;
    }

    /// The only address allowed to append to a provider's log. At launch this is
    /// the gateway's enclave-held anchoring key, registered by envolvr.
    mapping(bytes32 providerId => address anchorer) public anchorerOf;

    mapping(bytes32 providerId => Batch[] batches) private _batches;

    event AnchorerSet(bytes32 indexed providerId, address indexed anchorer);
    event BatchAnchored(
        bytes32 indexed providerId, uint256 indexed batchIndex, bytes32 root, uint64 firstReceipt, uint32 count
    );

    error NotAnchorer(bytes32 providerId, address caller);
    error UnexpectedBatchIndex(uint256 expected, uint256 given);
    error EmptyBatch();
    error ZeroRoot();
    error NoSuchBatch(bytes32 providerId, uint256 batchIndex);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Register or rotate the anchoring key for a provider. Rotation does
    /// not touch batches already anchored.
    function setAnchorer(bytes32 providerId, address anchorer) external onlyOwner {
        anchorerOf[providerId] = anchorer;
        emit AnchorerSet(providerId, anchorer);
    }

    /// @notice Append the next batch root to a provider's log.
    /// @param batchIndex Must equal the current batch count. A retry of a batch that
    /// already landed reverts instead of anchoring it twice, and no gap can be left.
    function anchor(bytes32 providerId, uint256 batchIndex, bytes32 root, uint32 count) external {
        if (msg.sender != anchorerOf[providerId]) revert NotAnchorer(providerId, msg.sender);
        Batch[] storage log = _batches[providerId];
        if (batchIndex != log.length) revert UnexpectedBatchIndex(log.length, batchIndex);
        if (count == 0) revert EmptyBatch();
        if (root == bytes32(0)) revert ZeroRoot();

        uint64 firstReceipt;
        if (log.length != 0) {
            Batch storage prev = log[log.length - 1];
            firstReceipt = prev.firstReceipt + prev.count;
        }
        log.push(Batch({root: root, firstReceipt: firstReceipt, count: count, anchoredAt: uint64(block.timestamp)}));
        emit BatchAnchored(providerId, batchIndex, root, firstReceipt, count);
    }

    function batchCount(bytes32 providerId) external view returns (uint256) {
        return _batches[providerId].length;
    }

    function batch(bytes32 providerId, uint256 batchIndex) external view returns (Batch memory) {
        Batch[] storage log = _batches[providerId];
        if (batchIndex >= log.length) revert NoSuchBatch(providerId, batchIndex);
        return log[batchIndex];
    }

    /// @notice True when `receiptDigest` is included in the given anchored batch.
    function verifyReceipt(bytes32 providerId, uint256 batchIndex, bytes32 receiptDigest, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Batch[] storage log = _batches[providerId];
        if (batchIndex >= log.length) return false;
        return MerkleProof.verifyCalldata(proof, log[batchIndex].root, leafOf(receiptDigest));
    }

    function leafOf(bytes32 receiptDigest) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(receiptDigest))));
    }
}
