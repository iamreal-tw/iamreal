//! The scoped ID (spec/scoped-id.md): computed from the card's signature
//! over the scope string, written as text, and its short ID.

use crate::base32;
use crate::field::{Fe, is_field_element};
use crate::hash::{HashFailed, Poseidon2};

pub const SIGNATURE_LENGTH: usize = 256;
pub const SCOPED_ID_TEXT_LENGTH: usize = 52;
/// The length of the short ID.
pub const SHORT_ID_LENGTH: usize = 10;

const LIMBS: usize = 18;
/// A limb is 120 bits: 15 bytes.
const LIMB_BYTES: usize = 15;

/// The 18 limbs of 120 bits of a signature read as a big-endian integer,
/// least significant first.
pub fn signature_limbs(signature: &[u8; SIGNATURE_LENGTH]) -> [Fe; LIMBS] {
    let mut limbs = [[0u8; 32]; LIMBS];
    let mut end = SIGNATURE_LENGTH;
    for limb in &mut limbs {
        // The last limb has the one byte left: 17 × 15 = 255.
        let start = end.saturating_sub(LIMB_BYTES);
        limb[32 - (end - start)..].copy_from_slice(&signature[start..end]);
        end = start;
    }
    limbs
}

/// `state = 0; for each limb: state = Poseidon2(state, limb)`. The
/// signature must already be known to be below the card's modulus (the
/// circuit requires it; a larger one gives no proof).
pub fn scoped_id(
    signature: &[u8; SIGNATURE_LENGTH],
    hash: &mut impl Poseidon2,
) -> Result<Fe, HashFailed> {
    let mut limbs = signature_limbs(signature);
    let mut state: Result<Fe, HashFailed> = Ok([0u8; 32]);
    for limb in &limbs {
        state = state.and_then(|s| {
            let mut inputs = [s, *limb];
            let next = hash.poseidon2(&inputs);
            for input in &mut inputs {
                crate::wipe(input);
            }
            next
        });
    }
    // The limbs are the signature, and every state before the last is
    // computed from it. What the caller's hash copied is the caller's to
    // wipe; if that hash panics, nothing here is wiped.
    for limb in &mut limbs {
        crate::wipe(limb);
    }
    state
}

/// The text form: the 32 bytes little-endian, base32, 52 characters.
/// `None` if `id` is not a field element.
pub fn scoped_id_text(id: &Fe) -> Option<String> {
    if !is_field_element(id) {
        return None;
    }
    let mut le = *id;
    le.reverse();
    Some(base32::encode(&le))
}

/// The strict reading: 52 characters, one spelling, below the field modulus.
pub fn parse_scoped_id(text: &[u8]) -> Option<Fe> {
    let mut id: Fe = base32::decode_strict(text, 32)?.try_into().ok()?;
    id.reverse();
    is_field_element(&id).then_some(id)
}

/// The first 10 characters of a scoped ID's text form; `None` for a text
/// shorter than that, which is not a scoped ID (protocol/ returns the
/// shorter text as it is).
pub fn short_id(text: &str) -> Option<&str> {
    text.get(..SHORT_ID_LENGTH)
}

/// A short ID as typed in a URL: read without regard to case, with `O`
/// read as `0` and `I` and `L` as `1`. After that it must be exactly 10
/// characters of the alphabet. For URLs only, never for records.
pub fn read_short_id_in_url(typed: &[u8]) -> Option<String> {
    if typed.len() != SHORT_ID_LENGTH {
        return None;
    }
    typed
        .iter()
        .map(|c| {
            let read = match c.to_ascii_uppercase() {
                b'O' => b'0',
                b'I' | b'L' => b'1',
                upper => upper,
            };
            base32::value_of(read).map(|_| read as char)
        })
        .collect()
}
