//! Structural walk over a MOICA end-entity TBSCertificate.
//!
//! Every offset is derived from the DER structure, starting at byte 0. The
//! prover supplies the TBS bytes and nothing else; no offset is an input.
//! Byte-for-byte the same layout as `SPEC.md` §"Structural walk" of the circom
//! circuit it is compared against.
//!
//! Unlike the circom circuit, `tbs` is the raw DER, not the SHA-256-padded
//! message. Bytes at or after `tbs_len` are ignored by the hash, so they are
//! prover-controlled: every read below must stay under `tbs_len`. Offsets only
//! grow along the walk, so the single bound on the last read covers them all.

pub global MAX_TBS_LEN: u32 = 1536;
// The circom circuit takes the SHA-256-padded TBS in a 1536-byte buffer, and
// padding adds at least 9 bytes. Accept no longer a TBS than it does.
pub global MAX_SIGNED_LEN: u32 = MAX_TBS_LEN - 9;
pub global MAX_SERIAL_LEN: u32 = 20;
pub global SUBJECT_MODULUS_BYTES: u32 = 256;

// [0] EXPLICIT version: v3.
global VERSION: [u8; 5] = [0xa0, 0x03, 0x02, 0x01, 0x02];

// AlgorithmIdentifier { sha256WithRSAEncryption, NULL }
global SIG_ALG: [u8; 15] =
    [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00];

// SubjectPublicKeyInfo of a 2048-bit RSA key, up to and including the header
// of the modulus INTEGER:
//   30 82 01 22                                   SubjectPublicKeyInfo (290)
//   30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00  rsaEncryption, NULL
//   03 82 01 0f 00                                BIT STRING (271), 0 unused bits
//   30 82 01 0a                                   RSAPublicKey (266)
//   02 82 01 01 00                                modulus INTEGER (257), sign byte
global SPKI_HEAD: [u8; 33] = [
    0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0f, 0x00, 0x30, 0x82, 0x01, 0x0a, 0x02, 0x82, 0x01, 0x01,
    0x00,
];

// publicExponent 65537
global EXPONENT: [u8; 5] = [0x02, 0x03, 0x01, 0x00, 0x01];

// authorityKeyIdentifier (keyIdentifier only); 20 bytes of key id follow.
global AKI_HEAD: [u8; 13] =
    [0x30, 0x1f, 0x06, 0x03, 0x55, 0x1d, 0x23, 0x04, 0x18, 0x30, 0x16, 0x80, 0x14];

// subjectKeyIdentifier; 20 bytes of key id follow.
global SKI_HEAD: [u8; 11] = [0x30, 0x1d, 0x06, 0x03, 0x55, 0x1d, 0x0e, 0x04, 0x16, 0x04, 0x14];

// keyUsage, critical, digitalSignature only.
global KEY_USAGE: [u8; 16] = [
    0x30, 0x0e, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x07, 0x80,
];

// certificatePolicies with the single policy 2.16.886.101.0.3.3, then
// subjectDirectoryAttributes with exactly two attributes: subjectType =
// citizen (2.16.886.1.100.3.1.1) and tailOfPersonalID as a 4-byte UTF8String.
// The 4 value bytes that follow are not read.
global HOLDER_EXTENSIONS: [u8; 71] = [
    0x30, 0x14, 0x06, 0x03, 0x55, 0x1d, 0x20, 0x04, 0x0d, 0x30, 0x0b, 0x30, 0x09, 0x06, 0x07, 0x60,
    0x86, 0x76, 0x65, 0x00, 0x03, 0x03, 0x30, 0x33, 0x06, 0x03, 0x55, 0x1d, 0x09, 0x04, 0x2c, 0x30,
    0x2a, 0x30, 0x15, 0x06, 0x07, 0x60, 0x86, 0x76, 0x01, 0x64, 0x02, 0x01, 0x31, 0x0a, 0x06, 0x08,
    0x60, 0x86, 0x76, 0x01, 0x64, 0x03, 0x01, 0x01, 0x30, 0x11, 0x06, 0x07, 0x60, 0x86, 0x76, 0x01,
    0x64, 0x02, 0x33, 0x31, 0x06, 0x0c, 0x04,
];

/// What the circuit takes from the certificate.
pub struct Certificate {
    /// Serial number as a big-endian integer.
    pub serial: Field,
    /// Subject public key modulus, big-endian.
    pub modulus: [u8; SUBJECT_MODULUS_BYTES],
}

fn expect<let N: u32>(tbs: [u8; MAX_TBS_LEN], offset: u32, expected: [u8; N]) {
    for i in 0..N {
        assert(tbs[offset + i] == expected[i]);
    }
}

/// 12 ASCII digits `YYMMDDHHMMSS` at `offset` as a decimal integer. YY must be
/// below 50: UTCTime years 50..99 mean 1950..1999 and would compare as later
/// than any 20YY date.
fn utc_time(tbs: [u8; MAX_TBS_LEN], offset: u32) -> u64 {
    let mut value: u64 = 0;
    for i in 0..12 {
        let byte = tbs[offset + i];
        assert((byte >= 48) & (byte <= 57));
        value = value * 10 + (byte - 48) as u64;
    }
    assert(tbs[offset] < 53);
    value
}

/// Walks `tbs[0..tbs_len]` and returns its serial number and subject modulus.
/// Fails unless the certificate
///   - is v3, signed with sha256WithRSAEncryption,
///   - is valid at `current_time` (decimal `YYMMDDHHMMSS`, UTC),
///   - carries a 2048-bit RSA key with exponent 65537,
///   - has keyUsage exactly digitalSignature,
///   - is a citizen's primary-card certificate.
pub fn check_certificate(tbs: [u8; MAX_TBS_LEN], tbs_len: u32, current_time: Field) -> Certificate {
    assert(tbs_len <= MAX_SIGNED_LEN);

    // Outer SEQUENCE with a two-byte length, which must be the whole TBS.
    assert(tbs[0] == 0x30);
    assert(tbs[1] == 0x82);
    assert(tbs[2] as u32 * 256 + tbs[3] as u32 + 4 == tbs_len);

    expect(tbs, 4, VERSION);

    // Serial INTEGER, 1..20 bytes.
    assert(tbs[9] == 0x02);
    let serial_len = tbs[10] as u32;
    assert(serial_len >= 1);
    assert(serial_len <= MAX_SERIAL_LEN);
    let mut serial: Field = 0;
    for i in 0..MAX_SERIAL_LEN {
        if i < serial_len {
            serial = serial * 256 + tbs[11 + i] as Field;
        }
    }

    let sig_alg = 11 + serial_len;
    expect(tbs, sig_alg, SIG_ALG);

    // Issuer Name: SEQUENCE with a short-form length.
    let issuer = sig_alg + 15;
    assert(tbs[issuer] == 0x30);
    let issuer_len = tbs[issuer + 1] as u32;
    assert(issuer_len < 128);

    // Validity ::= SEQUENCE { notBefore UTCTime, notAfter UTCTime }
    let validity = issuer + 2 + issuer_len;
    expect(tbs, validity, [0x30, 0x1e, 0x17, 0x0d]);
    let not_before = utc_time(tbs, validity + 4);
    expect(tbs, validity + 16, [0x5a, 0x17, 0x0d]);
    let not_after = utc_time(tbs, validity + 19);
    assert(tbs[validity + 31] == 0x5a);

    current_time.assert_max_bit_size::<40>();
    let now = current_time as u64;
    assert(not_before <= now);
    assert(now <= not_after);

    // Subject Name: SEQUENCE with a short-form length (< 128) or the one-byte
    // long form 0x81 LL (128..255).
    let subject = validity + 32;
    assert(tbs[subject] == 0x30);
    let b1 = tbs[subject + 1];
    let b2 = tbs[subject + 2];
    let is_long = b1 == 0x81;
    assert(is_long | (b1 < 128));
    assert(!is_long | (b2 >= 128));
    let subject_len = if is_long { b2 as u32 } else { b1 as u32 };

    // SubjectPublicKeyInfo.
    let spki = subject + 2 + (is_long as u32) + subject_len;
    expect(tbs, spki, SPKI_HEAD);
    let modulus_offset = spki + 33;
    let mut modulus = [0; SUBJECT_MODULUS_BYTES];
    for i in 0..SUBJECT_MODULUS_BYTES {
        modulus[i] = tbs[modulus_offset + i];
    }
    // Exactly 2048 bits. The pinned INTEGER header only fixes the length of
    // the encoding; a shorter key with leading zero bits fits it too.
    assert(modulus[0] >= 0x81);

    let exponent = modulus_offset + SUBJECT_MODULUS_BYTES;
    expect(tbs, exponent, EXPONENT);

    // [3] EXPLICIT Extensions and the SEQUENCE inside it, both with two-byte
    // lengths. The length bytes themselves are not read.
    expect(tbs, exponent + 5, [0xa3, 0x82]);
    expect(tbs, exponent + 9, [0x30, 0x82]);

    expect(tbs, exponent + 13, AKI_HEAD);
    expect(tbs, exponent + 46, SKI_HEAD);
    expect(tbs, exponent + 77, KEY_USAGE);
    expect(tbs, exponent + 93, HOLDER_EXTENSIONS);

    // The walk ends 168 bytes after the exponent: 164 pinned or skipped bytes
    // plus the 4-byte tailOfPersonalID value. All of it must be signed.
    assert(exponent + 168 <= tbs_len);

    Certificate { serial, modulus }
}

/// Big-endian modulus bytes as 18 limbs of 120 bits, least significant first:
/// the limb layout `bignum` uses for a 2048-bit modulus.
pub fn modulus_limbs(modulus: [u8; SUBJECT_MODULUS_BYTES]) -> [u128; 18] {
    let mut limbs: [u128; 18] = [0; 18];
    for i in 0..17 {
        let mut limb: u128 = 0;
        for j in 0..15 {
            limb = limb * 256 + modulus[SUBJECT_MODULUS_BYTES - 15 * (i + 1) + j] as u128;
        }
        limbs[i] = limb;
    }
    limbs[17] = modulus[0] as u128;
    limbs
}
