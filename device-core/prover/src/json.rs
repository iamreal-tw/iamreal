//! JSON read with one reading: an object with a key twice is not read
//! (`serde_json::Value` would keep the last one). Numbers are kept as
//! `f64`, as a JavaScript client reads them, so that `1.0` is the integer 1
//! here as it is in `web/`.

use std::collections::BTreeMap;

use serde::de::{Deserialize, Deserializer, Error, MapAccess, SeqAccess, Visitor};

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

impl Json {
    /// Reads `bytes`: UTF-8, one JSON value with nothing but whitespace around it.
    pub fn parse(bytes: &[u8]) -> Option<Json> {
        serde_json::from_slice(bytes).ok()
    }

    pub fn as_object(&self) -> Option<&BTreeMap<String, Json>> {
        match self {
            Json::Object(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    /// A number with no fraction from 0 to `max`.
    pub fn as_count(&self, max: u32) -> Option<u32> {
        match self {
            Json::Number(n) if n.fract() == 0.0 && (0.0..=f64::from(max)).contains(n) => {
                Some(*n as u32)
            }
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = Json;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E: Error>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E: Error>(self, b: bool) -> Result<Json, E> {
                Ok(Json::Bool(b))
            }
            fn visit_u64<E: Error>(self, n: u64) -> Result<Json, E> {
                Ok(Json::Number(n as f64))
            }
            fn visit_i64<E: Error>(self, n: i64) -> Result<Json, E> {
                Ok(Json::Number(n as f64))
            }
            fn visit_f64<E: Error>(self, n: f64) -> Result<Json, E> {
                Ok(Json::Number(n))
            }
            fn visit_str<E: Error>(self, s: &str) -> Result<Json, E> {
                Ok(Json::String(s.to_owned()))
            }
            fn visit_string<E: Error>(self, s: String) -> Result<Json, E> {
                Ok(Json::String(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut object = BTreeMap::new();
                while let Some(key) = map.next_key::<String>()? {
                    let value = map.next_value()?;
                    if object.insert(key, value).is_some() {
                        return Err(A::Error::custom("a key twice"));
                    }
                }
                Ok(Json::Object(object))
            }
        }
        deserializer.deserialize_any(Any)
    }
}
