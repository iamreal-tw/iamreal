//! The cardholder's certificate, checked on the device before any PIN is
//! asked (spec/device-checks.md, "The certificate"): the same structural
//! walk as the circuit, its dates against today's date in Taiwan, and the
//! issuer's signature.

use crate::challenge::current_time;
use crate::date::Date;
use crate::der::{self, NotDer, Tlv};
use crate::hash::Sha256;
use crate::issuers::{IssuerKey, IssuerName};
use crate::key::{Key, MAX_SERIAL_BYTES};
use crate::rsa::verify_pkcs1_sha256;

/// Why no certificate of the card can make a card proof: the reason codes
/// of the specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertificateProblem {
    NoCertificate,
    Expired,
    NotYetValid,
    NotCitizenPrimary,
    UnsupportedFormat,
    UnknownIssuer,
    AmbiguousCertificate,
}

impl CertificateProblem {
    pub fn code(self) -> &'static str {
        match self {
            CertificateProblem::NoCertificate => "no_certificate",
            CertificateProblem::Expired => "expired",
            CertificateProblem::NotYetValid => "not_yet_valid",
            CertificateProblem::NotCitizenPrimary => "not_citizen_primary",
            CertificateProblem::UnsupportedFormat => "unsupported_format",
            CertificateProblem::UnknownIssuer => "unknown_issuer",
            CertificateProblem::AmbiguousCertificate => "ambiguous_certificate",
        }
    }
}

/// The circuit hashes at most 1536 bytes, SHA-256 padding included.
pub const MAX_TBS_LENGTH: usize = 1527;
pub const CARD_MODULUS_LENGTH: usize = 256;

const VERSION: &[u8] = &[0xa0, 0x03, 0x02, 0x01, 0x02];
const SIGNATURE_ALGORITHM: &[u8] = &[
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
];
const SUBJECT_KEY_HEAD: &[u8] = &[
    0x30, 0x82, 0x01, 0x22, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0f, 0x00, 0x30, 0x82, 0x01, 0x0a, 0x02, 0x82, 0x01, 0x01,
    0x00,
];
const EXPONENT: &[u8] = &[0x02, 0x03, 0x01, 0x00, 0x01];
const AUTHORITY_KEY_ID_HEAD: &[u8] = &[
    0x30, 0x1f, 0x06, 0x03, 0x55, 0x1d, 0x23, 0x04, 0x18, 0x30, 0x16, 0x80, 0x14,
];
const SUBJECT_KEY_ID_HEAD: &[u8] = &[
    0x30, 0x1d, 0x06, 0x03, 0x55, 0x1d, 0x0e, 0x04, 0x16, 0x04, 0x14,
];
const KEY_USAGE: &[u8] = &[
    0x30, 0x0e, 0x06, 0x03, 0x55, 0x1d, 0x0f, 0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x07, 0x80,
];
/// The certificate policy and subjectDirectoryAttributes of a citizen's
/// primary card (ADR-0011).
const HOLDER_EXTENSIONS: &[u8] = &[
    0x30, 0x14, 0x06, 0x03, 0x55, 0x1d, 0x20, 0x04, 0x0d, 0x30, 0x0b, 0x30, 0x09, 0x06, 0x07, 0x60,
    0x86, 0x76, 0x65, 0x00, 0x03, 0x03, 0x30, 0x33, 0x06, 0x03, 0x55, 0x1d, 0x09, 0x04, 0x2c, 0x30,
    0x2a, 0x30, 0x15, 0x06, 0x07, 0x60, 0x86, 0x76, 0x01, 0x64, 0x02, 0x01, 0x31, 0x0a, 0x06, 0x08,
    0x60, 0x86, 0x76, 0x01, 0x64, 0x03, 0x01, 0x01, 0x30, 0x11, 0x06, 0x07, 0x60, 0x86, 0x76, 0x01,
    0x64, 0x02, 0x33, 0x31, 0x06, 0x0c, 0x04,
];
/// commonName, 2.5.4.3.
const OID_COMMON_NAME: &[u8] = &[0x55, 0x04, 0x03];

/// The step of the walk at which it stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Structure,
    KeyUsage,
    Holder,
}

/// What the walk read before it passed or stopped.
#[derive(Default)]
struct Walk {
    serial: Option<Key>,
    not_before: Option<u64>,
    not_after: Option<u64>,
    /// Where the subject lies in the tbs.
    subject: Option<(usize, usize)>,
    /// Where the card's modulus lies in the tbs.
    modulus: Option<usize>,
}

struct Tbs<'a>(&'a [u8]);

impl Tbs<'_> {
    /// A byte past the end stops the walk at `structure`.
    fn at(&self, offset: usize) -> Result<u8, Step> {
        self.0.get(offset).copied().ok_or(Step::Structure)
    }

    /// Compares byte by byte, in order: the first byte past the end stops
    /// at `structure`, the first that differs at `step`.
    fn expect(&self, offset: usize, expected: &[u8], step: Step) -> Result<(), Step> {
        for (i, byte) in expected.iter().enumerate() {
            if self.at(offset + i)? != *byte {
                return Err(step);
            }
        }
        Ok(())
    }

    /// 12 ASCII digits, the first below `5`, as the integer `YYMMDDHHMMSS`.
    fn utc_time(&self, offset: usize) -> Result<u64, Step> {
        let mut value = 0u64;
        for i in 0..12 {
            let b = self.at(offset + i)?;
            if !b.is_ascii_digit() {
                return Err(Step::Structure);
            }
            value = value * 10 + u64::from(b - b'0');
        }
        if self.at(offset)? >= b'5' {
            return Err(Step::Structure);
        }
        Ok(value)
    }
}

fn require(condition: bool) -> Result<(), Step> {
    if condition {
        Ok(())
    } else {
        Err(Step::Structure)
    }
}

/// The walk of spec/device-checks.md, row by row. What it read up to the
/// row where it stopped is in `walk`.
fn walk_tbs(tbs: &[u8], walk: &mut Walk) -> Result<(), Step> {
    let n = tbs.len();
    let tbs = Tbs(tbs);
    // Row 1.
    require(n <= MAX_TBS_LENGTH)?;
    // Row 2.
    require(tbs.at(0)? == 0x30 && tbs.at(1)? == 0x82)?;
    require(usize::from(tbs.at(2)?) * 256 + usize::from(tbs.at(3)?) + 4 == n)?;
    // Row 3.
    tbs.expect(4, VERSION, Step::Structure)?;
    // Row 4.
    require(tbs.at(9)? == der::INTEGER)?;
    let serial_length = usize::from(tbs.at(10)?);
    require((1..=MAX_SERIAL_BYTES).contains(&serial_length))?;
    let mut serial = [0u8; MAX_SERIAL_BYTES];
    for (i, byte) in serial[..serial_length].iter_mut().enumerate() {
        *byte = tbs.at(11 + i)?;
    }
    walk.serial = Key::from_unsigned(&serial[..serial_length]);
    // Row 5.
    let algorithm = 11 + serial_length;
    tbs.expect(algorithm, SIGNATURE_ALGORITHM, Step::Structure)?;
    // Row 6.
    let issuer = algorithm + 15;
    require(tbs.at(issuer)? == der::SEQUENCE)?;
    let issuer_length = usize::from(tbs.at(issuer + 1)?);
    require(issuer_length < 128)?;
    // Row 7.
    let validity = issuer + 2 + issuer_length;
    tbs.expect(validity, &[0x30, 0x1e, 0x17, 0x0d], Step::Structure)?;
    let not_before = tbs.utc_time(validity + 4)?;
    tbs.expect(validity + 16, &[0x5a, 0x17, 0x0d], Step::Structure)?;
    let not_after = tbs.utc_time(validity + 19)?;
    require(tbs.at(validity + 31)? == 0x5a)?;
    walk.not_before = Some(not_before);
    walk.not_after = Some(not_after);
    // Row 8.
    let subject = validity + 32;
    require(tbs.at(subject)? == der::SEQUENCE)?;
    let b1 = tbs.at(subject + 1)?;
    let b2 = tbs.at(subject + 2)?;
    let long = b1 == 0x81;
    require(long || b1 < 128)?;
    require(!long || b2 >= 128)?;
    let subject_length = usize::from(if long { b2 } else { b1 });
    let subject_key = subject + 2 + usize::from(long) + subject_length;
    walk.subject = Some((subject, subject_key));
    // Row 9.
    tbs.expect(subject_key, SUBJECT_KEY_HEAD, Step::Structure)?;
    let modulus = subject_key + 33;
    // Every byte of the modulus is inside the tbs.
    tbs.at(modulus + CARD_MODULUS_LENGTH - 1)?;
    require(tbs.at(modulus)? >= 0x80)?;
    walk.modulus = Some(modulus);
    // Row 10.
    let exponent = modulus + CARD_MODULUS_LENGTH;
    tbs.expect(exponent, EXPONENT, Step::Structure)?;
    // Row 11.
    tbs.expect(exponent + 5, &[0xa3, 0x82], Step::Structure)?;
    tbs.expect(exponent + 9, &[0x30, 0x82], Step::Structure)?;
    // Rows 12 and 13.
    tbs.expect(exponent + 13, AUTHORITY_KEY_ID_HEAD, Step::Structure)?;
    tbs.expect(exponent + 46, SUBJECT_KEY_ID_HEAD, Step::Structure)?;
    // Row 14.
    tbs.expect(exponent + 77, KEY_USAGE, Step::KeyUsage)?;
    // Row 15.
    tbs.expect(exponent + 93, HOLDER_EXTENSIONS, Step::Holder)?;
    // Row 16.
    require(n >= exponent + 168)
}

/// `tbsCertificate` (the whole element) and the issuer's signature, as
/// ranges of the certificate.
struct Split {
    tbs: (usize, usize),
    signature: (usize, usize),
}

fn split_certificate(certificate: &[u8]) -> Result<Split, NotDer> {
    let outer = der::read_tlv(certificate, 0, certificate.len())?;
    if outer.tag != der::SEQUENCE || outer.end != certificate.len() {
        return Err(NotDer);
    }
    let parts = der::all_children(certificate, &outer)?;
    let [tbs, algorithm, signature] = parts.as_slice() else {
        return Err(NotDer);
    };
    let tags = [tbs.tag, algorithm.tag, signature.tag];
    if tags != [der::SEQUENCE, der::SEQUENCE, der::BIT_STRING] {
        return Err(NotDer);
    }
    // The first content byte is the number of unused bits.
    if signature.content(certificate).first() != Some(&0) {
        return Err(NotDer);
    }
    Ok(Split {
        tbs: (tbs.start, tbs.end),
        signature: (signature.content_start + 1, signature.end),
    })
}

/// The value of the first commonName in the subject, or an empty name:
/// when there is none, and when the subject or the text cannot be read.
/// The name is shown, never checked or compared.
fn common_name(tbs: &[u8], subject: (usize, usize)) -> String {
    let read = || -> Result<Option<String>, NotDer> {
        let name = der::read_tlv(tbs, subject.0, subject.1)?;
        for rdn in der::children(tbs, &name) {
            for attribute in der::children(tbs, &rdn?) {
                let parts = der::all_children(tbs, &attribute?)?;
                let [oid, value, ..] = parts.as_slice() else {
                    continue;
                };
                if oid.tag != der::OID {
                    continue;
                }
                let oid = oid.content(tbs);
                if !der::is_oid(oid) {
                    return Err(NotDer);
                }
                if oid == OID_COMMON_NAME {
                    return Ok(text_of(value, tbs));
                }
            }
        }
        Ok(None)
    };
    read().ok().flatten().unwrap_or_default()
}

/// A BMPString is UTF-16 big-endian; any other tag is read as UTF-8.
fn text_of(value: &Tlv, tbs: &[u8]) -> Option<String> {
    let bytes = value.content(tbs);
    if value.tag == der::BMP_STRING {
        // A byte left over after the last pair is not read.
        let (pairs, _) = bytes.as_chunks::<2>();
        let units: Vec<u16> = pairs.iter().map(|pair| u16::from_be_bytes(*pair)).collect();
        String::from_utf16(&units).ok()
    } else {
        String::from_utf8(bytes.to_vec()).ok()
    }
}

/// The certificate a card proof uses, with what the device read from it.
/// Its bytes and the name are overwritten with zeros when it is dropped.
pub struct CardCertificate {
    der: Vec<u8>,
    tbs: (usize, usize),
    issuer_signature: (usize, usize),
    issuer: IssuerName,
    serial: Key,
    card_modulus: usize,
    not_before: u64,
    not_after: u64,
    name: String,
}

impl CardCertificate {
    /// The whole certificate (DER).
    pub fn der(&self) -> &[u8] {
        &self.der
    }

    /// `tbsCertificate`, the whole element: the bytes the issuer signed
    /// and the circuit walks.
    pub fn tbs(&self) -> &[u8] {
        &self.der[self.tbs.0..self.tbs.1]
    }

    /// The issuer key under which the signature verifies.
    pub fn issuer(&self) -> IssuerName {
        self.issuer
    }

    /// The issuer's signature over the tbs, big-endian.
    pub fn issuer_signature(&self) -> &[u8] {
        &self.der[self.issuer_signature.0..self.issuer_signature.1]
    }

    /// The serial number: the key of the revocation tree.
    pub fn serial(&self) -> Key {
        self.serial
    }

    /// The card's RSA modulus, big-endian, exactly 2048 bits.
    pub fn card_modulus(&self) -> &[u8] {
        let start = self.tbs.0 + self.card_modulus;
        &self.der[start..start + CARD_MODULUS_LENGTH]
    }

    /// `YYMMDDHHMMSS`, UTC, as written in the certificate.
    pub fn not_before(&self) -> u64 {
        self.not_before
    }

    pub fn not_after(&self) -> u64 {
        self.not_after
    }

    /// The subject's commonName: the name the screen shows before the PIN.
    /// Never sent anywhere.
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for CardCertificate {
    fn drop(&mut self) {
        crate::wipe(&mut self.der);
        let mut name = std::mem::take(&mut self.name).into_bytes();
        crate::wipe(&mut name);
    }
}

/// What checking one certificate gave.
enum Checked {
    Passes(CardCertificate),
    Fails {
        problem: CertificateProblem,
        signing: bool,
        not_before: Option<u64>,
        not_after: Option<u64>,
    },
}

fn check_certificate(
    certificate: &[u8],
    today: Date,
    issuers: &[IssuerKey<'_>],
    sha256: &mut impl Sha256,
) -> Checked {
    let fails = |problem, signing, walk: &Walk| Checked::Fails {
        problem,
        signing,
        not_before: walk.not_before,
        not_after: walk.not_after,
    };
    let mut walk = Walk::default();
    // 1. Split.
    let Ok(split) = split_certificate(certificate) else {
        return fails(CertificateProblem::UnsupportedFormat, false, &walk);
    };
    let tbs = &certificate[split.tbs.0..split.tbs.1];
    // 2. Walk.
    let stopped = walk_tbs(tbs, &mut walk).err();
    let signing = stopped != Some(Step::KeyUsage);
    // 3. Dates, before the walk's result: an expired card is the one
    // problem the cardholder can act on.
    if let (Some(not_before), Some(not_after), true) = (walk.not_before, walk.not_after, signing) {
        let now = current_time(today);
        if now > not_after {
            return fails(CertificateProblem::Expired, signing, &walk);
        }
        if now < not_before {
            return fails(CertificateProblem::NotYetValid, signing, &walk);
        }
    }
    // 4. The walk's result.
    match stopped {
        Some(Step::Holder) => {
            return fails(CertificateProblem::NotCitizenPrimary, signing, &walk);
        }
        Some(Step::KeyUsage | Step::Structure) => {
            return fails(CertificateProblem::UnsupportedFormat, signing, &walk);
        }
        None => {}
    }
    // 5. Issuer: the first key under which the signature verifies.
    let signature = &certificate[split.signature.0..split.signature.1];
    let digest = sha256.sha256(tbs);
    let issuer = issuers
        .iter()
        .find(|key| verify_pkcs1_sha256(key.modulus, signature, &digest));
    let Some(issuer) = issuer else {
        return fails(CertificateProblem::UnknownIssuer, signing, &walk);
    };
    // A walk that passed read all of these.
    let (Some(serial), Some(card_modulus), Some(subject), Some(not_before), Some(not_after)) = (
        walk.serial,
        walk.modulus,
        walk.subject,
        walk.not_before,
        walk.not_after,
    ) else {
        return fails(CertificateProblem::UnsupportedFormat, signing, &walk);
    };
    Checked::Passes(CardCertificate {
        der: certificate.to_vec(),
        tbs: split.tbs,
        issuer_signature: split.signature,
        issuer: issuer.name,
        serial,
        card_modulus,
        not_before,
        not_after,
        name: common_name(tbs, subject),
    })
}

/// The certificate a card proof uses, or why the card has none.
pub enum Selection {
    Chosen {
        /// Its place among the certificates the card returned.
        index: usize,
        certificate: CardCertificate,
    },
    Refused {
        problem: CertificateProblem,
        /// With `Expired`: the certificate's notAfter, `YYMMDDHHMMSS`.
        not_after: Option<u64>,
        /// With `NotYetValid`: its notBefore.
        not_before: Option<u64>,
    },
}

/// From the certificates a card returned, in its order, the one a card
/// proof uses (spec/device-checks.md, "Choosing the certificate").
/// `issuers` are tried in their order.
pub fn select_certificate(
    certificates: &[&[u8]],
    today: Date,
    issuers: &[IssuerKey<'_>],
    sha256: &mut impl Sha256,
) -> Selection {
    let refused = |problem| Selection::Refused {
        problem,
        not_after: None,
        not_before: None,
    };
    if certificates.is_empty() {
        return refused(CertificateProblem::NoCertificate);
    }
    let mut passing: Vec<(usize, CardCertificate)> = Vec::new();
    // The reason of the first signing certificate whose reason is not
    // `unsupported_format`.
    let mut reason: Option<Selection> = None;
    for (index, certificate) in certificates.iter().enumerate() {
        match check_certificate(certificate, today, issuers, sha256) {
            Checked::Passes(certificate) => passing.push((index, certificate)),
            Checked::Fails {
                problem,
                signing,
                not_before,
                not_after,
            } => {
                if reason.is_none() && signing && problem != CertificateProblem::UnsupportedFormat {
                    reason = Some(Selection::Refused {
                        problem,
                        not_after: not_after.filter(|_| problem == CertificateProblem::Expired),
                        not_before: not_before
                            .filter(|_| problem == CertificateProblem::NotYetValid),
                    });
                }
            }
        }
    }
    let mut passing = passing.into_iter();
    match passing.next() {
        Some((index, certificate)) => {
            // The same bytes more than once are one certificate; the
            // device does not choose between two that differ.
            if passing.all(|(_, other)| other.der() == certificate.der()) {
                Selection::Chosen { index, certificate }
            } else {
                refused(CertificateProblem::AmbiguousCertificate)
            }
        }
        None => reason.unwrap_or_else(|| refused(CertificateProblem::UnsupportedFormat)),
    }
}

/// Whether `signature` is the card's signature over `message`
/// (RSASSA-PKCS1-v1_5, SHA-256): the device checks each of the card's
/// signatures before it uses it.
pub fn is_card_signature(
    certificate: &CardCertificate,
    message: &[u8],
    signature: &[u8],
    sha256: &mut impl Sha256,
) -> bool {
    let digest = sha256.sha256(message);
    verify_pkcs1_sha256(certificate.card_modulus(), signature, &digest)
}
