//! Reading MOICA's CRL and deciding whether it is usable
//! (spec/revocation-tree.md, "Which CRLs"): the same rules and the same
//! reason codes, in the same order, as `crl/` (Go) and the web page.

use std::collections::HashSet;

use crate::der::{self, NotDer, Tlv};
use crate::hash::Sha256;
use crate::key::Key;
use crate::rsa::verify_pkcs1_sha256;

/// Why a file is not a usable CRL: the reason codes of the archive index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unusable {
    Der,
    Algorithm,
    Signature,
    TooManyExtensions,
    DuplicateExtension,
    CriticalExtension,
    Delta,
    Partitioned,
    CrlNumber,
    Serial,
    Collision,
}

impl Unusable {
    pub fn code(self) -> &'static str {
        match self {
            Unusable::Der => "not_usable_der",
            Unusable::Algorithm => "not_usable_algorithm",
            Unusable::Signature => "not_usable_signature",
            Unusable::TooManyExtensions => "not_usable_too_many_extensions",
            Unusable::DuplicateExtension => "not_usable_duplicate_extension",
            Unusable::CriticalExtension => "not_usable_critical_extension",
            Unusable::Delta => "not_usable_delta",
            Unusable::Partitioned => "not_usable_partitioned",
            Unusable::CrlNumber => "not_usable_crl_number",
            Unusable::Serial => "not_usable_serial",
            Unusable::Collision => "not_usable_collision",
        }
    }
}

impl From<NotDer> for Unusable {
    fn from(_: NotDer) -> Unusable {
        Unusable::Der
    }
}

/// A CRL number: a non-negative integer of any size, kept in decimal
/// without leading zeros, the way the archive index writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrlNumber(String);

impl CrlNumber {
    /// Reads decimal digits without a leading zero, or `0`.
    pub fn from_decimal(text: &str) -> Option<CrlNumber> {
        let well_formed = !text.is_empty()
            && text.bytes().all(|c| c.is_ascii_digit())
            && (text == "0" || !text.starts_with('0'));
        well_formed.then(|| CrlNumber(text.to_string()))
    }

    /// From the bytes of an unsigned big-endian integer.
    pub fn from_magnitude(bytes: &[u8]) -> CrlNumber {
        let mut rest: Vec<u8> = bytes.to_vec();
        let mut digits: Vec<u8> = Vec::new();
        // Long division by 10, one decimal digit at a time.
        while rest.iter().any(|b| *b != 0) {
            let mut remainder = 0u32;
            for byte in rest.iter_mut() {
                let value = remainder * 256 + u32::from(*byte);
                *byte = (value / 10) as u8;
                remainder = value % 10;
            }
            digits.push(b'0' + remainder as u8);
        }
        if digits.is_empty() {
            digits.push(b'0');
        }
        digits.reverse();
        CrlNumber(String::from_utf8(digits).expect("digits"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Ord for CrlNumber {
    fn cmp(&self, other: &CrlNumber) -> std::cmp::Ordering {
        // Without leading zeros, the longer number is the larger.
        (self.0.len(), &self.0).cmp(&(other.0.len(), &other.0))
    }
}

impl PartialOrd for CrlNumber {
    fn partial_cmp(&self, other: &CrlNumber) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

struct Extension<'a> {
    /// The OID's content bytes.
    oid: &'a [u8],
    critical: bool,
    value: &'a [u8],
}

/// A DER `CertificateList`, split into what the checks read.
///
/// Nothing here grows with what an element holds but `serials`, one slice
/// (two words) an entry: the file is as long as the mirror stores (32 MiB),
/// and before its signature is checked its bytes are anyone's who is on
/// the way (README.md, "讀清冊的記憶體").
pub struct ParsedCrl<'a> {
    tbs: &'a [u8],
    tbs_signature_algorithm: &'a [u8],
    signature_algorithm: &'a [u8],
    signature: &'a [u8],
    /// thisUpdate, in seconds since 1970-01-01T00:00:00Z.
    this_update: i64,
    /// Each entry's serial number: its content bytes, as encoded.
    serials: Vec<&'a [u8]>,
    /// The first entry whose extensions make the CRL not usable, counted
    /// from 0, and why; of the later entries' extensions nothing is kept.
    entry_problem: Option<(usize, Unusable)>,
    /// The extensions of the CRL: at most `MAX_EXTENSIONS + 1` of them.
    extensions: Vec<Extension<'a>>,
}

/// sha256WithRSAEncryption with NULL parameters.
const SHA256_WITH_RSA: &[u8] = &[
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
];
/// cRLNumber, 2.5.29.20.
const OID_CRL_NUMBER: &[u8] = &[0x55, 0x1d, 0x14];
/// deltaCRLIndicator, 2.5.29.27.
const OID_DELTA: &[u8] = &[0x55, 0x1d, 0x1b];
/// issuingDistributionPoint, 2.5.29.28.
const OID_PARTITIONED: &[u8] = &[0x55, 0x1d, 0x1c];
const CONTEXT_0: u8 = 0xa0;

fn is_time(t: &Tlv) -> bool {
    t.tag == der::UTC_TIME || t.tag == der::GENERALIZED_TIME
}

/// The most extensions the CRL, and each entry, may have
/// (spec/revocation-tree.md, "Which CRLs").
pub const MAX_EXTENSIONS: usize = 16;

/// Reads `Extensions`. Every extension is read, so that one that is not DER
/// makes the file not DER, but only the first `MAX_EXTENSIONS + 1` are
/// kept: enough to tell there are too many.
fn read_extensions<'a>(der: &'a [u8], sequence: &Tlv) -> Result<Vec<Extension<'a>>, NotDer> {
    if sequence.tag != der::SEQUENCE {
        return Err(NotDer);
    }
    let mut extensions = Vec::new();
    let mut count = 0;
    for extension in der::children(der, sequence) {
        let extension = extension?;
        if extension.tag != der::SEQUENCE {
            return Err(NotDer);
        }
        // One part at a time: an extension has two or three, and a file
        // may write millions.
        let mut parts = der::children(der, &extension);
        let oid = parts.next().ok_or(NotDer)??;
        if oid.tag != der::OID || !der::is_oid(oid.content(der)) {
            return Err(NotDer);
        }
        let mut value = parts.next().ok_or(NotDer)??;
        let mut critical = false;
        if value.tag == der::BOOLEAN {
            // An explicit FALSE is not DER, but is accepted, as crl/ does.
            critical = match value.content(der) {
                [0x00] => false,
                [0xff] => true,
                _ => return Err(NotDer),
            };
            value = parts.next().ok_or(NotDer)??;
        }
        // Nothing after the value: seen where the value ends, without
        // walking what follows.
        if value.tag != der::OCTET_STRING || value.end != extension.end {
            return Err(NotDer);
        }
        if extensions.len() <= MAX_EXTENSIONS {
            extensions.push(Extension {
                oid: oid.content(der),
                critical,
                value: value.content(der),
            });
        }
        count += 1;
    }
    if count == 0 {
        return Err(NotDer);
    }
    Ok(extensions)
}

/// One entry: its serial number's content bytes, and what is wrong with its
/// extensions, if anything.
fn read_entry<'a>(der: &'a [u8], entry: &Tlv) -> Result<(&'a [u8], Option<Unusable>), NotDer> {
    if entry.tag != der::SEQUENCE {
        return Err(NotDer);
    }
    let mut fields = der::children(der, entry);
    let serial = fields.next().ok_or(NotDer)??;
    if serial.tag != der::INTEGER {
        return Err(NotDer);
    }
    let revocation_date = fields.next().ok_or(NotDer)??;
    der::read_time(der, &revocation_date)?;
    let problem = match fields.next() {
        Some(extensions) => {
            let extensions = extensions?;
            // Nothing after the extensions.
            if extensions.end != entry.end {
                return Err(NotDer);
            }
            check_extensions(&read_extensions(der, &extensions)?).err()
        }
        None => None,
    };
    Ok((serial.content(der), problem))
}

/// Reads a DER `CertificateList` (RFC 5280 section 5) strictly.
pub fn parse_crl(der: &[u8]) -> Result<ParsedCrl<'_>, NotDer> {
    let list = der::read_tlv(der, 0, der.len())?;
    if list.tag != der::SEQUENCE || list.end != der.len() {
        return Err(NotDer);
    }
    let mut parts = der::children(der, &list);
    let tbs = parts.next().ok_or(NotDer)??;
    let algorithm = parts.next().ok_or(NotDer)??;
    let signature = parts.next().ok_or(NotDer)??;
    if signature.end != list.end {
        return Err(NotDer);
    }
    let tags = [tbs.tag, algorithm.tag, signature.tag];
    if tags != [der::SEQUENCE, der::SEQUENCE, der::BIT_STRING] {
        return Err(NotDer);
    }
    // The first content byte is the number of unused bits.
    let [0, signature_bytes @ ..] = signature.content(der) else {
        return Err(NotDer);
    };

    let mut fields = der::children(der, &tbs).peekable();
    let mut version = 1;
    if let Some(Ok(v)) = fields
        .peek()
        .filter(|f| matches!(f, Ok(t) if t.tag == der::INTEGER))
    {
        if v.content(der) != [1] {
            return Err(NotDer);
        }
        version = 2;
        fields.next();
    }
    let tbs_algorithm = fields.next().ok_or(NotDer)??;
    let issuer = fields.next().ok_or(NotDer)??;
    if tbs_algorithm.tag != der::SEQUENCE || issuer.tag != der::SEQUENCE {
        return Err(NotDer);
    }
    let this_update = der::read_time(der, &fields.next().ok_or(NotDer)??)?;
    if let Some(Ok(next_update)) = fields.peek().filter(|f| matches!(f, Ok(t) if is_time(t))) {
        der::read_time(der, next_update)?;
        fields.next();
    }
    let mut serials = Vec::new();
    let mut entry_problem = None;
    if let Some(Ok(list)) = fields
        .peek()
        .filter(|f| matches!(f, Ok(t) if t.tag == der::SEQUENCE))
    {
        for entry in der::children(der, list) {
            let (serial, problem) = read_entry(der, &entry?)?;
            if let (None, Some(problem)) = (&entry_problem, problem) {
                entry_problem = Some((serials.len(), problem));
            }
            serials.push(serial);
        }
        fields.next();
    }
    let mut extensions = Vec::new();
    if let Some(Ok(outer)) = fields
        .peek()
        .filter(|f| matches!(f, Ok(t) if t.tag == CONTEXT_0))
    {
        if version != 2 {
            return Err(NotDer);
        }
        let sequence = der::children(der, outer).next().ok_or(NotDer)??;
        if sequence.end != outer.end {
            return Err(NotDer);
        }
        extensions = read_extensions(der, &sequence)?;
        fields.next();
    }
    // Nothing else, and nothing that is not DER.
    if fields.next().is_some() {
        return Err(NotDer);
    }
    Ok(ParsedCrl {
        tbs: tbs.whole(der),
        tbs_signature_algorithm: tbs_algorithm.whole(der),
        signature_algorithm: algorithm.whole(der),
        signature: signature_bytes,
        this_update,
        serials,
        entry_problem,
        extensions,
    })
}

impl ParsedCrl<'_> {
    /// thisUpdate, in seconds since 1970-01-01T00:00:00Z.
    pub fn this_update(&self) -> i64 {
        self.this_update
    }
}

/// At most `MAX_EXTENSIONS`, then no extension twice, then no critical
/// extension.
fn check_extensions(extensions: &[Extension<'_>]) -> Result<(), Unusable> {
    if extensions.len() > MAX_EXTENSIONS {
        return Err(Unusable::TooManyExtensions);
    }
    for (i, extension) in extensions.iter().enumerate() {
        if extensions[..i].iter().any(|e| e.oid == extension.oid) {
            return Err(Unusable::DuplicateExtension);
        }
    }
    if extensions.iter().any(|e| e.critical) {
        return Err(Unusable::CriticalExtension);
    }
    Ok(())
}

/// The most content bytes a `cRLNumber` may have, a leading 00 included
/// (RFC 5280 section 5.2.3).
pub const MAX_CRL_NUMBER_BYTES: usize = 20;

/// The value of a `cRLNumber` extension: a non-negative DER INTEGER in its
/// shortest encoding, of at most `MAX_CRL_NUMBER_BYTES` content bytes.
fn read_crl_number(value: &[u8]) -> Option<CrlNumber> {
    let integer = der::read_tlv(value, 0, value.len()).ok()?;
    if integer.tag != der::INTEGER || integer.end != value.len() {
        return None;
    }
    let content = integer.content(value);
    if content.len() > MAX_CRL_NUMBER_BYTES {
        return None;
    }
    let first = *content.first()?;
    let negative = first & 0x80 != 0;
    let padded = content.len() > 1 && first == 0 && content[1] & 0x80 == 0;
    (!negative && !padded).then(|| CrlNumber::from_magnitude(content))
}

/// A usable CRL: what the device takes from it.
pub struct UsableCrl {
    pub crl_number: CrlNumber,
    /// thisUpdate, in seconds since 1970-01-01T00:00:00Z.
    pub this_update: i64,
    /// One key per distinct serial number, in order of first appearance.
    pub keys: Vec<Key>,
}

const TAIWAN_OFFSET_SECONDS: i64 = 8 * 3600;
const SECONDS_PER_DAY: i64 = 86_400;

impl UsableCrl {
    /// The CRL date as a number of days from 1970-01-01: `thisUpdate` as a
    /// date in Taiwan.
    pub fn crl_day(&self) -> i64 {
        (self.this_update + TAIWAN_OFFSET_SECONDS).div_euclid(SECONDS_PER_DAY)
    }

    /// The CRL date, `YYYY-MM-DD`.
    pub fn crl_date(&self) -> String {
        let (year, month, day) = crate::date::civil_from_days(self.crl_day());
        format!("{year:04}-{month:02}-{day:02}")
    }
}

/// Whether the CRL is usable under the issuer key with `issuer_modulus`,
/// and its keys; otherwise the first reason code that applies.
pub fn check_crl(
    crl: &ParsedCrl<'_>,
    issuer_modulus: &[u8],
    sha256: &mut impl Sha256,
) -> Result<UsableCrl, Unusable> {
    if crl.tbs_signature_algorithm != SHA256_WITH_RSA || crl.signature_algorithm != SHA256_WITH_RSA
    {
        return Err(Unusable::Algorithm);
    }
    let digest = sha256.sha256(crl.tbs);
    if !verify_pkcs1_sha256(issuer_modulus, crl.signature, &digest) {
        return Err(Unusable::Signature);
    }
    check_extensions(&crl.extensions)?;
    // Of the two, the one that comes first in the CRL decides.
    for extension in &crl.extensions {
        if extension.oid == OID_DELTA {
            return Err(Unusable::Delta);
        }
        if extension.oid == OID_PARTITIONED {
            return Err(Unusable::Partitioned);
        }
    }
    let crl_number = crl
        .extensions
        .iter()
        .find(|e| e.oid == OID_CRL_NUMBER)
        .and_then(|e| read_crl_number(e.value))
        .ok_or(Unusable::CrlNumber)?;

    // From here on the bytes are MOICA's: the signature verified.
    // Entries in order: the first entry with a problem decides, its
    // extensions before its serial number.
    let mut keys = Vec::with_capacity(crl.serials.len());
    let mut seen = HashSet::with_capacity(crl.serials.len());
    for (index, serial) in crl.serials.iter().enumerate() {
        if let Some((_, problem)) = crl.entry_problem.filter(|(at, _)| *at == index) {
            return Err(problem);
        }
        let key = Key::from_crl_serial(serial).ok_or(Unusable::Serial)?;
        // The same serial number listed twice is one key.
        if seen.insert(key) {
            keys.push(key);
        }
    }
    let mut paths = HashSet::with_capacity(keys.len());
    if !keys.iter().all(|key| paths.insert(key.low_bits(127))) {
        return Err(Unusable::Collision);
    }
    Ok(UsableCrl {
        crl_number,
        this_update: crl.this_update,
        keys,
    })
}

/// Reads and checks in one step; a file that is not a DER
/// `CertificateList` is `not_usable_der`.
pub fn usable_crl(
    der: &[u8],
    issuer_modulus: &[u8],
    sha256: &mut impl Sha256,
) -> Result<UsableCrl, Unusable> {
    check_crl(&parse_crl(der)?, issuer_modulus, sha256)
}
