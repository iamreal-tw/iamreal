use crate::hash::{hash_2, hash_3};

pub global SMT_DEPTH: u32 = 128;

/// Non-membership of `key` in a sparse Merkle tree with circomlib's layout
/// (`circomlib/circuits/smt/smtverifier.circom`, `fnc = 1`), hashed with
/// Poseidon2 (`hash.nr`):
///   leaf   = H(key, value, 1)
///   branch = H(left, right)
///   an empty subtree is 0; the path follows the key's bits, least significant
///   first, and stops at the first subtree that holds at most one leaf.
///
/// `siblings` are the siblings along the key's path, zero-filled after the
/// last real one. The subtree the path ends in is either empty
/// (`is_old0 = true`) or a single leaf for another key (`old_key`, `old_value`).
pub fn assert_not_in_tree(
    root: Field,
    key: Field,
    siblings: [Field; SMT_DEPTH],
    old_key: Field,
    old_value: Field,
    is_old0: bool,
) {
    // A serial number is at most 20 bytes.
    let key_bits: [bool; 160] = key.to_le_bits();

    // The leaf found at the end of the path belongs to a different key.
    assert(is_old0 | (old_key != key));
    let mut node = if is_old0 {
        0
    } else {
        hash_3([old_key, old_value, 1])
    };

    // The path has as many levels as the index of the last non-zero sibling
    // plus one, and must end above the bottom of the tree.
    assert(siblings[SMT_DEPTH - 1] == 0);
    let mut on_path = false;
    for j in 0..SMT_DEPTH {
        let i = SMT_DEPTH - 1 - j;
        on_path = on_path | (siblings[i] != 0);
        let (left, right) = if key_bits[i] {
            (siblings[i], node)
        } else {
            (node, siblings[i])
        };
        let parent = hash_2([left, right]);
        node = if on_path { parent } else { node };
    }

    assert(node == root);
}
