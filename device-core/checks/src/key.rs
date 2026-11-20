//! The key of the revocation tree (spec/revocation-tree.md, "Tree"): a
//! serial number's content bytes read as an unsigned big-endian integer of
//! at most 20 bytes.

use crate::field::Fe;

pub const MAX_SERIAL_BYTES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    /// Bits 128 to 159.
    high: u32,
    /// Bits 0 to 127.
    low: u128,
}

impl Key {
    /// At most 20 bytes read as an unsigned big-endian integer, as the
    /// circuit reads a certificate's serial number: a leading `00` is one
    /// of the bytes, and no byte is a sign. `None` for more than 20 bytes.
    pub fn from_unsigned(bytes: &[u8]) -> Option<Key> {
        if bytes.len() > MAX_SERIAL_BYTES {
            return None;
        }
        let mut wide = [0u8; MAX_SERIAL_BYTES];
        wide[MAX_SERIAL_BYTES - bytes.len()..].copy_from_slice(bytes);
        let (high, low) = wide.split_at(4);
        Some(Key {
            high: u32::from_be_bytes(high.try_into().expect("4 bytes")),
            low: u128::from_be_bytes(low.try_into().expect("16 bytes")),
        })
    }

    /// The key of a CRL entry's serial number, from the content bytes of
    /// its DER INTEGER: in its shortest encoding, not negative, at most 20
    /// content bytes. `None` when it gives no key.
    pub fn from_crl_serial(content: &[u8]) -> Option<Key> {
        let first = *content.first()?;
        let negative = first & 0x80 != 0;
        let padded = content.len() > 1 && first == 0 && content[1] & 0x80 == 0;
        if negative || padded {
            return None;
        }
        Key::from_unsigned(content)
    }

    /// Bit `level` of the key, counting from the least significant: the
    /// side the key's path takes at that level. Levels run from 0 to 126.
    pub fn bit(&self, level: usize) -> bool {
        (self.low >> level) & 1 == 1
    }

    /// The lowest `count` bits (at most 127): what decides the key's path.
    pub fn low_bits(&self, count: usize) -> u128 {
        self.low & ((1u128 << count) - 1)
    }

    /// The key as a field element.
    pub fn to_fe(&self) -> Fe {
        let mut fe = [0u8; 32];
        fe[12..16].copy_from_slice(&self.high.to_be_bytes());
        fe[16..].copy_from_slice(&self.low.to_be_bytes());
        fe
    }
}
