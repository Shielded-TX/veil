import { poseidon2Hash } from '@aztec/foundation/crypto/sync';
import { Fr } from '@aztec/foundation/curves/bn254';

/**
 * Depth of the Merkle tree. Must match MERKLE_DEPTH in the Veil contract.
 */
export const MERKLE_DEPTH = 8;

/**
 * Maximum number of leaves the tree can hold (2^MERKLE_DEPTH).
 */
export const MAX_LEAVES = 1 << MERKLE_DEPTH;

/**
 * The default value for empty leaf slots and internal nodes above them.
 */
const ZERO_FIELD = new Fr(0n);

/**
 * Represents a Merkle tree of approved deposits.
 *
 * - leaves: an array of MAX_LEAVES Fr values. Filled positions hold
 *   poseidon2_hash([deposit_id]). Empty positions hold ZERO_FIELD.
 * - layers: layers[0] is the leaves, layers[1] is the level above, etc.
 *   layers[MERKLE_DEPTH] is a single-element array containing the root.
 * - depositToIndex: maps a deposit ID to its leaf position in the tree.
 */
export interface ApprovedListTree {
    leaves: Fr[];
    layers: Fr[][];
    depositToIndex: Map<bigint, number>;
}

/**
 * Hashes a single deposit ID into a leaf value.
 * Must match the leaf hashing in the contract:
 *   poseidon2_hash([deposit_id as Field])
 */
function hashDepositId(depositId: bigint): Fr {
    return poseidon2Hash([new Fr(depositId)]);
}

/**
 * Hashes two child nodes into a parent node.
 * Order matters: left child first, right child second.
 * Must match the contract's hashing in _verify_merkle_proof.
 */
function hashPair(left: Fr, right: Fr): Fr {
    return poseidon2Hash([left, right]);
}

/**
 * Builds an empty tree with all leaves set to ZERO_FIELD.
 */
export function emptyTree(): ApprovedListTree {
    const leaves: Fr[] = new Array(MAX_LEAVES).fill(ZERO_FIELD);
    const layers = computeLayers(leaves);
    return {
        leaves,
        layers,
        depositToIndex: new Map(),
    };
}

/**
 * Builds a tree from a list of approved deposit IDs.
 * Each deposit ID is placed at the next available leaf position.
 */
export function buildTree(depositIds: bigint[]): ApprovedListTree {
    if (depositIds.length > MAX_LEAVES) {
        throw new Error(
            `Cannot fit ${depositIds.length} deposits in a tree of depth ${MERKLE_DEPTH}`,
        );
    }

    const leaves: Fr[] = new Array(MAX_LEAVES).fill(ZERO_FIELD);
    const depositToIndex = new Map<bigint, number>();

    for (let i = 0; i < depositIds.length; i++) {
        const depositId = depositIds[i];
        leaves[i] = hashDepositId(depositId);
        depositToIndex.set(depositId, i);
    }

    const layers = computeLayers(leaves);
    return { leaves, layers, depositToIndex };
}

/**
 * Adds a new deposit to an existing tree, returns the updated tree.
 * Throws if the tree is full.
 */
export function addDeposit(tree: ApprovedListTree, depositId: bigint): ApprovedListTree {
    const nextIndex = tree.depositToIndex.size;
    if (nextIndex >= MAX_LEAVES) {
        throw new Error('Tree is full');
    }

    const newLeaves = [...tree.leaves];
    newLeaves[nextIndex] = hashDepositId(depositId);

    const newLayers = computeLayers(newLeaves);
    const newDepositToIndex = new Map(tree.depositToIndex);
    newDepositToIndex.set(depositId, nextIndex);

    return {
        leaves: newLeaves,
        layers: newLayers,
        depositToIndex: newDepositToIndex,
    };
}

/**
 * Returns the Merkle root of the tree.
 * This is what the auditor publishes on-chain via update_approved_list_root.
 */
export function getRoot(tree: ApprovedListTree): Fr {
    return tree.layers[MERKLE_DEPTH][0];
}

/**
 * Generates an inclusion proof for a given deposit ID.
 * Returns the siblings array and leaf index that match the contract's
 * InnocenceProof struct.
 */
export interface InclusionProof {
    depositId: bigint;
    siblings: Fr[];
    leafIndex: number;
}

export function generateProof(tree: ApprovedListTree, depositId: bigint): InclusionProof {
    const leafIndex = tree.depositToIndex.get(depositId);
    if (leafIndex === undefined) {
        throw new Error(`Deposit ID ${depositId} is not in the approved list`);
    }

    const siblings: Fr[] = [];
    let index = leafIndex;

    for (let level = 0; level < MERKLE_DEPTH; level++) {
        // The sibling is the other child of our parent at this level.
        // If our index is even, sibling is at index+1; if odd, sibling is at index-1.
        const isRightChild = index % 2 === 1;
        const siblingIndex = isRightChild ? index - 1 : index + 1;
        siblings.push(tree.layers[level][siblingIndex]);

        // Move up to the parent for the next level
        index = Math.floor(index / 2);
    }

    return {
        depositId,
        siblings,
        leafIndex,
    };
}

/**
 * Internal helper: computes all layers of the tree from a leaves array.
 * layers[0] is the leaves, each subsequent layer has half as many nodes.
 * The final layer has exactly one node, the root.
 */
function computeLayers(leaves: Fr[]): Fr[][] {
    const layers: Fr[][] = [leaves];
    let current = leaves;

    for (let level = 0; level < MERKLE_DEPTH; level++) {
        const next: Fr[] = [];
        for (let i = 0; i < current.length; i += 2) {
            next.push(hashPair(current[i], current[i + 1]));
        }
        layers.push(next);
        current = next;
    }

    return layers;
}