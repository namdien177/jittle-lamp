use serde::{Deserialize, Deserializer, Serializer};

/// Writes whole floats as integers, the way `JSON.stringify` prints numbers.
pub fn num<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

pub fn opt_num<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => num(value, serializer),
        None => serializer.serialize_none(),
    }
}

/// `z.string().nullable().optional()`: distinguishes an absent key (`None`) from `null` (`Some(None)`).
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A unit type that (de)serializes as one fixed string, for `z.literal(...)` fields.
macro_rules! literal {
    ($name:ident, $value:literal) => {
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
        pub struct $name;

        impl $name {
            pub const VALUE: &'static str = $value;
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str($value)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                if value == $value {
                    Ok($name)
                } else {
                    Err(serde::de::Error::custom(format!(
                        "expected \"{}\", found \"{value}\"",
                        $value
                    )))
                }
            }
        }
    };
}

pub(crate) use literal;
