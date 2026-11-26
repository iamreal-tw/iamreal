//! A measurement, not a test: reads one CRL file as the device does
//! (`crl::usable_crl`, under MOICA's first key) and prints what it made of
//! it and how long it took. For files made to cost a reader as much as a
//! file within the mirror's download limit can (#410; README.md,
//! "讀清冊的記憶體"), for example those `go run
//! ./crl/internal/crltest/makelarge -out DIR` writes.
//!
//! The process's peak memory is read from outside, one process to a file:
//!
//! ```sh
//! cargo build --release -p iamreal-device-checks --example crl_size
//! for f in DIR/*.crl; do /usr/bin/time -l target/release/examples/crl_size "$f"; done
//! ```
//!
//! (`/usr/bin/time -l` is macOS's; on Linux `/usr/bin/time -v`.)

use iamreal_device_checks::crl::usable_crl;
use iamreal_device_checks::hash::Sha256;
use iamreal_device_checks::issuers::MOICA_ISSUERS;

struct Sha256OfSha2;

impl Sha256 for Sha256OfSha2 {
    fn sha256(&mut self, data: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(data).into()
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: crl_size FILE");
    let der = std::fs::read(&path).expect("the file");
    let started = std::time::Instant::now();
    let result = match usable_crl(&der, MOICA_ISSUERS[0].modulus, &mut Sha256OfSha2) {
        Ok(usable) => format!("usable, {} keys", usable.keys.len()),
        Err(reason) => reason.code().to_string(),
    };
    println!(
        "{path}: {} bytes, {} ms, {result}",
        der.len(),
        started.elapsed().as_millis()
    );
}
