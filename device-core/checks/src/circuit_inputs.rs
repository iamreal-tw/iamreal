//! The circuit's inputs, and the public inputs the device expects the
//! proof to carry (spec/circuit-inputs.md). Every value is computed here
//! from what the device holds; none comes from a server.

use crate::certificate::CardCertificate;
use crate::declaration_code::DECLARATION_CODE_LENGTH;
use crate::field::{Fe, fe_of_u64, pack31};
use crate::scope::SCOPE_STRING_LENGTH;
use crate::scoped_id::SIGNATURE_LENGTH;
use crate::tree::{AbsenceProof, DEPTH};

/// The length of the circuit's `tbs` buffer.
pub const MAX_TBS_LENGTH: usize = 1536;
/// The longest `tbsCertificate` the circuit accepts: SHA-256 padding adds
/// at least 9 bytes.
const MAX_TBS_CONTENT: usize = MAX_TBS_LENGTH - 9;

/// A limb is 120 bits: 15 bytes.
const LIMB_BYTES: usize = 15;
/// The limbs of a 2048-bit number, and of a 4096-bit one.
const LIMBS_2048: usize = 18;
const LIMBS_4096: usize = 35;
/// The bits of the card's modulus.
const CARD_BITS: usize = 2048;

/// The input map of `card_proof_rs2048` and `card_proof_rs4096`, by the
/// names of the circuit's parameters. A list of limbs has 18 or 35 of
/// them, least significant first. The certificate's bytes and the limbs
/// of the signatures are overwritten with zeros when it is dropped.
pub struct CircuitInputs {
    pub tbs: Vec<u8>,
    pub tbs_len: u32,
    pub issuer_modulus: Vec<Fe>,
    pub issuer_redc: Vec<Fe>,
    pub issuer_signature: Vec<Fe>,
    pub smt_root: Fe,
    pub smt_siblings: Vec<Fe>,
    pub smt_old_key: Fe,
    pub smt_old_value: Fe,
    pub smt_is_old0: bool,
    pub current_time: Fe,
    pub card_redc: Vec<Fe>,
    pub scope: [u8; SCOPE_STRING_LENGTH],
    pub scope_signature: Vec<Fe>,
    pub declaration_code: [u8; DECLARATION_CODE_LENGTH],
    pub declaration_code_signature: Vec<Fe>,
}

impl Drop for CircuitInputs {
    fn drop(&mut self) {
        crate::wipe(&mut self.tbs);
        for limbs in [
            &mut self.issuer_signature,
            &mut self.card_redc,
            &mut self.scope_signature,
            &mut self.declaration_code_signature,
        ] {
            for limb in limbs.iter_mut() {
                crate::wipe(limb);
            }
        }
    }
}

/// The inputs of the circuit of the certificate's issuer.
///
/// - `issuer_modulus`: the key of the certificate's issuer, big-endian,
///   2048 or 4096 bits.
/// - `current_time`: of the challenge's date (spec/challenge.md).
/// - the two signatures: the card's, over `scope` and `declaration_code`.
///
/// `None` when the circuit has no such inputs: a `tbsCertificate` longer
/// than it accepts, an issuer key of another size, a path that is not
/// 128 siblings.
#[allow(clippy::too_many_arguments)]
pub fn circuit_inputs(
    certificate: &CardCertificate,
    issuer_modulus: &[u8],
    path: &AbsenceProof,
    current_time: u64,
    scope: &[u8; SCOPE_STRING_LENGTH],
    scope_signature: &[u8; SIGNATURE_LENGTH],
    declaration_code: &[u8; DECLARATION_CODE_LENGTH],
    declaration_code_signature: &[u8; SIGNATURE_LENGTH],
) -> Option<CircuitInputs> {
    let issuer_bits = issuer_modulus.len() * 8;
    let count = match issuer_bits {
        2048 => LIMBS_2048,
        4096 => LIMBS_4096,
        _ => return None,
    };
    let content = certificate.tbs();
    if content.len() > MAX_TBS_CONTENT || path.siblings.len() != DEPTH {
        return None;
    }
    let issuer_signature = certificate.issuer_signature();
    if issuer_signature.len() != issuer_modulus.len() {
        return None;
    }
    // What can fail comes first: nothing of the certificate or of a
    // signature is copied before it.
    let tbs_len = u32::try_from(content.len()).ok()?;
    let issuer_redc = redc(issuer_modulus, issuer_bits)?;
    let card_redc = redc(certificate.card_modulus(), CARD_BITS)?;
    let mut tbs = vec![0u8; MAX_TBS_LENGTH];
    tbs[..content.len()].copy_from_slice(content);
    Some(CircuitInputs {
        tbs,
        tbs_len,
        issuer_modulus: limbs(issuer_modulus, count),
        issuer_redc: limbs(&issuer_redc, count),
        issuer_signature: limbs(issuer_signature, count),
        smt_root: path.root,
        smt_siblings: path.siblings.clone(),
        smt_old_key: path.old_key,
        smt_old_value: path.old_value,
        smt_is_old0: path.is_old0,
        current_time: fe_of_u64(current_time),
        card_redc: limbs(&card_redc, LIMBS_2048),
        scope: *scope,
        scope_signature: limbs(scope_signature, LIMBS_2048),
        declaration_code: *declaration_code,
        declaration_code_signature: limbs(declaration_code_signature, LIMBS_2048),
    })
}

impl CircuitInputs {
    /// The public inputs the proof must carry, in the circuit's order
    /// (spec/circuit-inputs.md, "Public inputs the device expects"):
    /// the limbs of the issuer key, the root, `current_time`, the scoped
    /// ID, the scope packed, the declaration code packed. `scoped_id` is
    /// the one the device computed from the signature over the scope.
    pub fn expected_public_inputs(&self, scoped_id: &Fe) -> Vec<Fe> {
        let mut list = self.issuer_modulus.clone();
        list.extend([
            self.smt_root,
            self.current_time,
            *scoped_id,
            pack31(&self.scope),
            pack31(&self.declaration_code),
        ]);
        list
    }
}

/// The `count` limbs of 120 bits of a big-endian integer, least
/// significant first. The integer fits in them.
fn limbs(bytes: &[u8], count: usize) -> Vec<Fe> {
    let mut limbs = vec![[0u8; 32]; count];
    let mut end = bytes.len();
    for limb in &mut limbs {
        let start = end.saturating_sub(LIMB_BYTES);
        limb[32 - (end - start)..].copy_from_slice(&bytes[start..end]);
        end = start;
    }
    debug_assert!(bytes[..end].iter().all(|b| *b == 0));
    limbs
}

/// The Barrett reduction parameter the circuit's RSA check takes next to
/// a modulus `n` of `bits` bits: `⌊2^(2·bits + 6) / n⌋`, big-endian. It
/// has at most `bits + 7` bits. `None` unless `n` has exactly `bits` bits.
fn redc(modulus: &[u8], bits: usize) -> Option<Vec<u8>> {
    if modulus.len() * 8 != bits || modulus[0] & 0x80 == 0 {
        return None;
    }
    // Schoolbook division, one bit of the quotient at a time. The
    // remainder stays below n, so it fits in one byte more than n.
    let width = modulus.len() + 1;
    let mut divisor = vec![0u8; width];
    divisor[1..].copy_from_slice(modulus);
    let mut remainder = vec![0u8; width];
    let dividend_bits = 2 * bits + 7;
    let mut quotient = vec![0u8; dividend_bits.div_ceil(8)];
    let padding = quotient.len() * 8 - dividend_bits;
    for i in 0..dividend_bits {
        // remainder = remainder · 2 + the next bit of 2^(2·bits + 6):
        // only its first bit is 1.
        let mut carry = u8::from(i == 0);
        for byte in remainder.iter_mut().rev() {
            let next = *byte >> 7;
            *byte = (*byte << 1) | carry;
            carry = next;
        }
        if remainder >= divisor {
            let mut borrow = false;
            for (r, d) in remainder.iter_mut().rev().zip(divisor.iter().rev()) {
                let (x, b1) = r.overflowing_sub(*d);
                let (x, b2) = x.overflowing_sub(u8::from(borrow));
                *r = x;
                borrow = b1 || b2;
            }
            let at = padding + i;
            quotient[at / 8] |= 0x80 >> (at % 8);
        }
    }
    Some(quotient)
}
