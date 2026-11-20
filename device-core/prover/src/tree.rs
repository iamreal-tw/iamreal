//! Building the revocation tree on four threads, each with its own
//! Barretenberg (ADR-0015; issue #88, "實作時要注意"). The tree itself is
//! `iamreal_device_checks::tree`; this is only what runs its parts side
//! by side.

use iamreal_device_checks::key::Key;
use iamreal_device_checks::tree::{Part, TreeError, TreeResult, build_part, combine, partition};

use crate::hashes::Barretenberg;

/// The tree is built in 2^2 = 4 parts, on 4 threads.
pub const SPLIT_BITS: usize = 2;

/// The tree of `keys` and the path of `target`, built in 4 parts on 4
/// threads. Returns when all of them are done.
pub fn build_tree(keys: &[Key], target: Key) -> Result<TreeResult, TreeError> {
    build_tree_in_parts(keys, target, SPLIT_BITS)
}

/// As [`build_tree`], in `2^split_bits` parts on as many threads.
pub fn build_tree_in_parts(
    keys: &[Key],
    target: Key,
    split_bits: usize,
) -> Result<TreeResult, TreeError> {
    let mut groups = partition(keys, split_bits);
    let target_group = target.low_bits(split_bits) as usize;
    let parts: Result<Vec<Part>, TreeError> = std::thread::scope(|scope| {
        let threads: Vec<_> = groups
            .iter_mut()
            .enumerate()
            .map(|(g, group)| {
                let target = (g == target_group).then_some(target);
                scope.spawn(move || {
                    // A panic on this thread prints nothing either.
                    let _quiet = crate::quiet::enter();
                    let mut hash = Barretenberg::new()?;
                    build_part(group, split_bits, target, &mut hash)
                })
            })
            .collect();
        threads
            .into_iter()
            // A thread that panicked gave no part.
            .map(|thread| thread.join().unwrap_or(Err(TreeError::Hash)))
            .collect()
    });
    combine(
        split_bits,
        &groups,
        &parts?,
        target,
        &mut Barretenberg::new()?,
    )
}
