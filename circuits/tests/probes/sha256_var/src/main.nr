use sha256::sha256_var;

// ONLY FOR TESTS: the library's variable-length SHA-256 on its own, over a
// 128-byte buffer. The card proof circuit bounds the length itself
// (`der.nr`: `tbs_len <= MAX_SIGNED_LEN`) before it gets here.
fn main(message: [u8; 128], length: u32) -> pub [u8; 32] {
    sha256_var(message, length)
}
