//! The static library as an app gets it: a C program (tests/smoke.c) built
//! against the hand-written header and linked with
//! `libiamreal_device_core.a`, then run. It fails when the header and the
//! library disagree, and when the C functions are not in the library (what
//! issue #88 saw with `strip = "symbols"`).

use std::path::{Path, PathBuf};
use std::process::Command;

/// The libraries of the system a program linking the static library names
/// (`cargo rustc -- --print native-static-libs`): libc++ for Barretenberg,
/// the rest for Rust's standard library.
#[cfg(target_os = "macos")]
const SYSTEM_LIBRARIES: &[&str] = &["-lc++", "-liconv", "-lSystem", "-lc", "-lm"];
#[cfg(target_os = "linux")]
const SYSTEM_LIBRARIES: &[&str] = &[
    "-lc++",
    "-lc++abi",
    "-lgcc_s",
    "-lutil",
    "-lrt",
    "-lpthread",
    "-lm",
    "-ldl",
    "-lc",
];

/// `target/<profile>/`: this test's executable is in its `deps/`.
fn profile_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("the path of this test");
    exe.parent()
        .and_then(Path::parent)
        .expect("target/<profile>/deps/<test>")
        .to_path_buf()
}

/// Builds the static library with the profile of this test, as
/// `cargo build` leaves it for an app: `target/<profile>/libiamreal_device_core.a`.
/// `cargo test` alone does not put it there.
fn static_library() -> PathBuf {
    let dir = profile_dir();
    let mut build = Command::new(env!("CARGO"));
    build.args([
        "build",
        "--locked",
        "--package",
        "iamreal-device-core",
        "--lib",
    ]);
    match dir.file_name().and_then(|name| name.to_str()) {
        Some("debug") => {}
        Some("release") => {
            build.arg("--release");
        }
        other => panic!("a profile this test does not know: {other:?}"),
    }
    let status = build
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .expect("cargo build");
    assert!(status.success(), "cargo build of the static library");
    let library = dir.join("libiamreal_device_core.a");
    assert!(
        library.exists(),
        "cargo build leaves the static library in target/<profile>/"
    );
    // Built without the feature `test-issuers`, as for an app that goes
    // out: the function that trusts other issuer keys is not in it.
    let bytes = std::fs::read(&library).expect("the static library");
    for mark in [
        &b"idc_testing_session_open"[..],
        b"iamreal-device-core:testing-issuer-keys",
    ] {
        assert!(
            !bytes.windows(mark.len()).any(|w| w == mark),
            "the library an app links has {}",
            String::from_utf8_lossy(mark)
        );
    }
    library
}

#[test]
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn a_c_program_links_the_static_library_and_gets_the_same_answers() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let library = static_library();
    let program = profile_dir().join("iamreal-device-core-smoke");

    let compiler = std::env::var("CC").unwrap_or_else(|_| "cc".to_string());
    let build = Command::new(compiler)
        .args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-I"])
        .arg(manifest.join("../include"))
        .arg(manifest.join("tests/smoke.c"))
        .arg(&library)
        .args(SYSTEM_LIBRARIES)
        .arg("-o")
        .arg(&program)
        .output()
        .expect("a C compiler (cc, or the one CC names)");
    assert!(
        build.status.success(),
        "building tests/smoke.c:\n{}",
        String::from_utf8_lossy(&build.stderr)
    );

    let run = Command::new(&program)
        .status()
        .expect("running the C program");
    assert_eq!(
        run.code(),
        Some(0),
        "the number is the check of tests/smoke.c that failed"
    );
}
