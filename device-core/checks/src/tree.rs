//! The revocation tree (spec/revocation-tree.md, "Tree"): circomlib's
//! sparse Merkle tree over the keys, hashed with Poseidon2.
//!
//! ```text
//! node(S, l) = 0                         if S is empty
//!            = Poseidon2(k, 1, 1)        if S = {k}
//!            = Poseidon2(node(S0, l+1), node(S1, l+1))   otherwise
//! ```
//!
//! The tree can be built in `2^d` parts, by the `d` low bits of the keys,
//! and joined by [`combine`]: the parts are independent, so each can run
//! on its own thread with its own Poseidon2.

use crate::field::{Fe, fe_of_u64};
use crate::hash::{HashFailed, Poseidon2};
use crate::key::Key;

/// The depth of the circuit's tree: a path has 128 siblings, the last one
/// zero.
pub const DEPTH: usize = 128;

const ZERO: Fe = [0u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeError {
    /// The caller's Poseidon2 did not give a result.
    Hash,
    /// Two different keys share their lowest 127 bits. A usable CRL has
    /// no such keys.
    Collision,
}

impl From<HashFailed> for TreeError {
    fn from(_: HashFailed) -> TreeError {
        TreeError::Hash
    }
}

/// Where the target's path ends.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PathEnd {
    Empty,
    Leaf(Key),
    InTree,
}

/// One part of the tree: the subtree of the keys that share their low
/// bits, and the target's path inside it.
pub struct Part {
    root: Fe,
    /// The siblings on the target's path, by level; zero where the path
    /// does not go.
    siblings: Vec<Fe>,
    end: Option<PathEnd>,
}

struct Builder<'a, H: Poseidon2> {
    hash: &'a mut H,
    target: Option<Key>,
    siblings: Vec<Fe>,
    end: Option<PathEnd>,
}

impl<H: Poseidon2> Builder<'_, H> {
    fn node(&mut self, keys: &mut [Key], level: usize, on_path: bool) -> Result<Fe, TreeError> {
        match keys {
            [] => {
                if on_path {
                    self.end = Some(PathEnd::Empty);
                }
                Ok(ZERO)
            }
            [key] => {
                if on_path {
                    self.end = Some(if Some(*key) == self.target {
                        PathEnd::InTree
                    } else {
                        PathEnd::Leaf(*key)
                    });
                }
                Ok(self
                    .hash
                    .poseidon2(&[key.to_fe(), fe_of_u64(1), fe_of_u64(1)])?)
            }
            _ => {
                // The path uses bits 0 to 126.
                if level >= DEPTH - 1 {
                    return Err(TreeError::Collision);
                }
                // The keys whose bit is 0 first.
                let mut zeros = 0;
                for i in 0..keys.len() {
                    if !keys[i].bit(level) {
                        keys.swap(zeros, i);
                        zeros += 1;
                    }
                }
                let (left_keys, right_keys) = keys.split_at_mut(zeros);
                let goes_right = self.target.filter(|_| on_path).map(|t| t.bit(level));
                let left = self.node(left_keys, level + 1, goes_right == Some(false))?;
                let right = self.node(right_keys, level + 1, goes_right == Some(true))?;
                match goes_right {
                    Some(false) => self.siblings[level] = right,
                    Some(true) => self.siblings[level] = left,
                    None => {}
                }
                Ok(self.hash.poseidon2(&[left, right])?)
            }
        }
    }
}

/// The subtree, from `level` down, over `keys` (which share their `level`
/// low bits and are distinct in their lowest 127), and the path of
/// `target` in it if one is given. The keys are reordered.
pub fn build_part(
    keys: &mut [Key],
    level: usize,
    target: Option<Key>,
    hash: &mut impl Poseidon2,
) -> Result<Part, TreeError> {
    let mut builder = Builder {
        hash,
        target,
        siblings: vec![ZERO; DEPTH],
        end: None,
    };
    let root = builder.node(keys, level, target.is_some())?;
    Ok(Part {
        root,
        siblings: builder.siblings,
        end: builder.end,
    })
}

/// The keys in `2^split_bits` groups, by their `split_bits` low bits.
pub fn partition(keys: &[Key], split_bits: usize) -> Vec<Vec<Key>> {
    let mut groups = vec![Vec::new(); 1 << split_bits];
    for key in keys {
        groups[key.low_bits(split_bits) as usize].push(*key);
    }
    groups
}

/// A proof of absence, in the form of the circuit's inputs
/// (spec/circuit-inputs.md).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AbsenceProof {
    pub root: Fe,
    /// 128 siblings, from the root down, zero after the end of the path.
    pub siblings: Vec<Fe>,
    /// Whether the path ends in an empty subtree.
    pub is_old0: bool,
    /// The key of the leaf the path ends at; 0 if it ends in an empty
    /// subtree.
    pub old_key: Fe,
    /// 1 if the path ends at a leaf; 0 if it ends in an empty subtree.
    pub old_value: Fe,
}

/// The tree's root, and the target's proof of absence unless the target
/// is one of the keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeResult {
    Absent(AbsenceProof),
    InTree { root: Fe },
}

/// The whole tree from its `2^split_bits` parts. `parts[g]` is
/// [`build_part`] of `groups[g]` at level `split_bits`, with the target
/// given only to the group of the target's low bits.
pub fn combine(
    split_bits: usize,
    groups: &[Vec<Key>],
    parts: &[Part],
    target: Key,
    hash: &mut impl Poseidon2,
) -> Result<TreeResult, TreeError> {
    // levels[l][prefix]: the node of the keys whose l low bits are
    // `prefix`, and how many keys it holds.
    let mut levels: Vec<Vec<(Fe, usize)>> = vec![Vec::new(); split_bits + 1];
    levels[split_bits] = parts
        .iter()
        .zip(groups)
        .map(|(part, group)| (part.root, group.len()))
        .collect();
    for level in (0..split_bits).rev() {
        let mut nodes = Vec::with_capacity(1 << level);
        for prefix in 0..1usize << level {
            let left = levels[level + 1][prefix];
            let right = levels[level + 1][prefix | (1 << level)];
            // A subtree with at most one key is that key's leaf, or empty.
            nodes.push(match left.1 + right.1 {
                0 => (ZERO, 0),
                1 => (if left.1 == 1 { left.0 } else { right.0 }, 1),
                count => (hash.poseidon2(&[left.0, right.0])?, count),
            });
        }
        levels[level] = nodes;
    }
    let root = levels[0][0].0;

    // The top levels of the target's path.
    let mut siblings = vec![ZERO; DEPTH];
    let mut prefix = 0usize;
    let mut level = 0;
    while level < split_bits && levels[level][prefix].1 >= 2 {
        let bit = usize::from(target.bit(level));
        siblings[level] = levels[level + 1][prefix | ((1 - bit) << level)].0;
        prefix |= bit << level;
        level += 1;
    }
    let end = match levels[level][prefix].1 {
        0 => PathEnd::Empty,
        1 => {
            // The only key below this node is the one key of its group.
            let only = groups
                .iter()
                .enumerate()
                .filter(|(g, _)| g & ((1 << level) - 1) == prefix)
                .find_map(|(_, group)| group.first())
                .ok_or(TreeError::Hash)?;
            if *only == target {
                PathEnd::InTree
            } else {
                PathEnd::Leaf(*only)
            }
        }
        _ => {
            // The target's group holds two keys or more: its part has the
            // rest of the path.
            let part = &parts[prefix];
            siblings[split_bits..].copy_from_slice(&part.siblings[split_bits..]);
            part.end.ok_or(TreeError::Hash)?
        }
    };
    Ok(match end {
        PathEnd::InTree => TreeResult::InTree { root },
        PathEnd::Empty => TreeResult::Absent(AbsenceProof {
            root,
            siblings,
            is_old0: true,
            old_key: ZERO,
            old_value: ZERO,
        }),
        PathEnd::Leaf(key) => TreeResult::Absent(AbsenceProof {
            root,
            siblings,
            is_old0: false,
            old_key: key.to_fe(),
            old_value: fe_of_u64(1),
        }),
    })
}

/// Builds the tree in `2^split_bits` parts, one after the other, with one
/// Poseidon2. What runs the parts side by side is the caller's
/// (`prover/src/tree.rs`).
pub fn build_tree(
    keys: &[Key],
    target: Key,
    split_bits: usize,
    hash: &mut impl Poseidon2,
) -> Result<TreeResult, TreeError> {
    let mut groups = partition(keys, split_bits);
    let target_group = target.low_bits(split_bits) as usize;
    let mut parts = Vec::with_capacity(groups.len());
    for (g, group) in groups.iter_mut().enumerate() {
        let target = (g == target_group).then_some(target);
        parts.push(build_part(group, split_bits, target, hash)?);
    }
    combine(split_bits, &groups, &parts, target, hash)
}
