//! Memory this library gives back is overwritten with zeros first.
//!
//! The core wipes what it holds of a certificate or a signature when it
//! is done with it (`iamreal_device_checks::wipe`). That does not reach
//! the copies made on the way by code that is not ours: `barretenberg-rs`
//! copies the inputs of a Poseidon2 into vectors and a message buffer and
//! drops them as they are, and `serde_json` does the same with the name
//! it writes. Every allocation of the Rust in this library goes through
//! the allocator below, so those copies are zeros once they are freed.
//!
//! What it does not reach: memory Barretenberg (C++) allocates for itself,
//! and the stack (README, "清掉").

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{Ordering, compiler_fence};

/// An allocator that overwrites a block with zeros before it gives it
/// back to `A`.
pub struct ZeroOnFree<A>(pub A);

/// Writes `size` zeros at `ptr`, in a way the compiler does not drop even
/// though the memory is freed next.
///
/// # Safety
/// `ptr` points to `size` bytes this caller may write.
unsafe fn zero(ptr: *mut u8, size: usize) {
    const WORD: usize = size_of::<usize>();
    let mut at = 0;
    // SAFETY: every write is inside the `size` bytes; the word writes are
    // at addresses that are multiples of the word size.
    unsafe {
        while at < size && !(ptr.add(at) as usize).is_multiple_of(WORD) {
            ptr.add(at).write_volatile(0);
            at += 1;
        }
        while size - at >= WORD {
            ptr.add(at).cast::<usize>().write_volatile(0);
            at += WORD;
        }
        while at < size {
            ptr.add(at).write_volatile(0);
            at += 1;
        }
    }
    compiler_fence(Ordering::SeqCst);
}

// SAFETY: every block comes from `A` and goes back to `A` with the layout
// it was asked with; this only writes inside a block before it is freed.
unsafe impl<A: GlobalAlloc> GlobalAlloc for ZeroOnFree<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's promise, passed on.
        unsafe { self.0.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's promise, passed on.
        unsafe { self.0.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` is a block of `layout.size()` bytes, the caller's
        // to free.
        unsafe {
            zero(ptr, layout.size());
            self.0.dealloc(ptr, layout);
        }
    }

    /// Never in place: `A` could move the block and leave the old bytes
    /// where they were.
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller promises `new_size` is a valid size for the
        // alignment; `ptr` is a block of `layout`.
        unsafe {
            let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
            let new = self.0.alloc(new_layout);
            if !new.is_null() {
                std::ptr::copy_nonoverlapping(ptr, new, layout.size().min(new_size));
                self.dealloc(ptr, layout);
            }
            new
        }
    }
}

#[global_allocator]
static ALLOCATOR: ZeroOnFree<System> = ZeroOnFree(System);

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Gives out blocks of the system and, when one comes back, records
    /// whether it was all zeros.
    struct Watching {
        all_zero: Cell<Option<bool>>,
    }

    // SAFETY: passes everything on to `System`.
    unsafe impl GlobalAlloc for Watching {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            // SAFETY: the caller's promise.
            unsafe { System.alloc(layout) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            // SAFETY: the block is still allocated here.
            unsafe {
                let bytes = std::slice::from_raw_parts(ptr, layout.size());
                self.all_zero.set(Some(bytes.iter().all(|b| *b == 0)));
                System.dealloc(ptr, layout);
            }
        }
    }

    // Used from one thread, in the tests below.
    unsafe impl Sync for Watching {}

    fn filled(allocator: &ZeroOnFree<Watching>, size: usize) -> (*mut u8, Layout) {
        let layout = Layout::from_size_align(size, 1).unwrap();
        // SAFETY: a block of `size` bytes, written inside its bounds.
        unsafe {
            let ptr = allocator.alloc(layout);
            assert!(!ptr.is_null());
            ptr.write_bytes(0xa5, size);
            (ptr, layout)
        }
    }

    #[test]
    fn a_freed_block_is_zeros() {
        for size in [1, 7, 8, 9, 31, 256, 4097] {
            let allocator = ZeroOnFree(Watching {
                all_zero: Cell::new(None),
            });
            let (ptr, layout) = filled(&allocator, size);
            // SAFETY: the block allocated above.
            unsafe { allocator.dealloc(ptr, layout) };
            assert_eq!(allocator.0.all_zero.get(), Some(true), "{size} bytes");
        }
    }

    #[test]
    fn a_block_that_grows_leaves_zeros_behind_and_keeps_its_bytes() {
        let allocator = ZeroOnFree(Watching {
            all_zero: Cell::new(None),
        });
        let (ptr, layout) = filled(&allocator, 100);
        // SAFETY: the block allocated above, grown and then freed.
        unsafe {
            let grown = allocator.realloc(ptr, layout, 1000);
            assert_eq!(allocator.0.all_zero.get(), Some(true), "the old block");
            assert!(
                std::slice::from_raw_parts(grown, 100)
                    .iter()
                    .all(|b| *b == 0xa5)
            );
            allocator.dealloc(grown, Layout::from_size_align(1000, 1).unwrap());
        }
    }
}
