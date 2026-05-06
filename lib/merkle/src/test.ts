import { buildTree, generateProof, getRoot, addDeposit, emptyTree } from './tree.js';

function main() {
    console.log('Building tree with three deposits: 1, 2, 3');
    const tree = buildTree([1n, 2n, 3n]);

    const root = getRoot(tree);
    console.log('Root:', root.toString());

    console.log('\nGenerating proof for deposit 2');
    const proof = generateProof(tree, 2n);
    console.log('  Leaf index:', proof.leafIndex);
    console.log('  Siblings:');
    proof.siblings.forEach((s, i) => {
        console.log(`    [${i}]`, s.toString());
    });

    console.log('\nAdding deposit 4 to the tree');
    const newTree = addDeposit(tree, 4n);
    const newRoot = getRoot(newTree);
    console.log('New root:', newRoot.toString());
    console.log('Old root:', root.toString());
    console.log('Roots are different:', !root.equals(newRoot));

    console.log('\nGenerating proof for deposit 4');
    const proof4 = generateProof(newTree, 4n);
    console.log('  Leaf index:', proof4.leafIndex);
    console.log('  Siblings count:', proof4.siblings.length);
}

main();