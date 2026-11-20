//! A panic inside the core prints nothing. Rust's default panic hook
//! writes the panic's message and place to stderr before the C functions
//! catch it, and on a phone stderr ends up in the system log. The message
//! of a panic here is a fixed string, but a panic in a dependency could
//! carry what it was working on: a part of a certificate, a CRL or an
//! account (issue #94).

use std::cell::Cell;
use std::sync::Once;

thread_local! {
    /// Whether this thread is inside the core.
    static IN_CORE: Cell<bool> = const { Cell::new(false) };
}

static HOOK: Once = Once::new();

/// While it lives, a panic on this thread prints nothing.
pub struct Quiet {
    was: bool,
}

/// Marks this thread as inside the core until the value is dropped. The
/// first call puts the hook in place: a panic on a marked thread is not
/// passed on to the hook that was there before (Rust's, which prints).
pub fn enter() -> Quiet {
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !IN_CORE.get() {
                previous(info);
            }
        }));
    });
    Quiet {
        was: IN_CORE.replace(true),
    }
}

impl Drop for Quiet {
    fn drop(&mut self) {
        IN_CORE.set(self.was);
    }
}
