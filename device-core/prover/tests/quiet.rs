//! A panic inside the core prints nothing (issue #94): Rust's own hook
//! would write the panic's message to stderr, which on a phone is the
//! system log.
//!
//! The test runs itself again as another process, to read what that
//! process wrote.

use iamreal_device_core::IDC_ERR_INTERNAL;
use iamreal_device_core::quiet::guarded;

const INSIDE: &str = "MARKER-OF-A-PANIC-INSIDE-THE-CORE";
const OUTSIDE: &str = "MARKER-OF-A-PANIC-OUTSIDE-THE-CORE";
const CHILD: &str = "IDC_TEST_PANICS";

/// What the other process does: a panic the way a C function would have
/// one, on this thread and on a thread of the tree, then one that is not
/// the core's.
fn panic_inside_and_outside() {
    let result: Result<(), i32> = guarded(|| panic!("{INSIDE}"));
    assert_eq!(result, Err(IDC_ERR_INTERNAL));
    // Index out of bounds: the message Rust writes has the numbers in it.
    let result: Result<u8, i32> = guarded(|| {
        let bytes = INSIDE.as_bytes();
        Ok(bytes[std::hint::black_box(bytes.len())])
    });
    assert_eq!(result, Err(IDC_ERR_INTERNAL));
    // The panic of another part of the program is still that part's to print.
    let outside = std::panic::catch_unwind(|| panic!("{OUTSIDE}"));
    assert!(outside.is_err());
}

#[test]
fn a_panic_inside_the_core_prints_nothing() {
    if std::env::var_os(CHILD).is_some() {
        panic_inside_and_outside();
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_panic_inside_the_core_prints_nothing",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "{printed}");
    assert!(
        printed.contains(OUTSIDE),
        "the test sees what is printed: {printed}"
    );
    assert!(!printed.contains(INSIDE), "{printed}");
    assert!(!printed.contains("out of bounds"), "{printed}");
}
