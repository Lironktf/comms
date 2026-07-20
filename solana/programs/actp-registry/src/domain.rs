//! Domain-name validation — a pure port of the Solidity `DomainLib`.
//!
//! Only normalized lowercase ASCII LDH (letters-digits-hyphen) domains with >= 2 labels are
//! accepted. Rejecting uppercase/unicode (rather than normalizing) keeps the derived vendor id
//! deterministic across clients and blocks trivial unicode-homograph impersonation at the
//! program boundary. This module has no Solana dependencies, so its unit tests run under a
//! plain `cargo test` (no SBF toolchain, no validator).

pub const MIN_LEN: usize = 4; // shortest real registrable domain, e.g. "a.co"
pub const MAX_LEN: usize = 253; // RFC 1035
pub const MAX_LABEL_LEN: usize = 63;

/// Returns true iff `domain` is a syntactically valid, normalized (lowercase ASCII) absolute
/// domain name with at least two labels.
pub fn is_valid(domain: &str) -> bool {
    let bytes = domain.as_bytes();
    let len = bytes.len();
    if len < MIN_LEN || len > MAX_LEN {
        return false;
    }

    let mut label_len = 0usize;
    let mut label_count = 0usize;
    let mut prev = b'.';

    for &c in bytes {
        if c == b'.' {
            if label_len == 0 || prev == b'-' {
                return false; // empty label or label ending in '-'
            }
            label_count += 1;
            label_len = 0;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            label_len += 1;
            if label_len > MAX_LABEL_LEN {
                return false;
            }
        } else if c == b'-' {
            if label_len == 0 {
                return false; // label cannot start with '-'
            }
            label_len += 1;
            if label_len > MAX_LABEL_LEN {
                return false;
            }
        } else {
            return false; // uppercase, unicode, or other character
        }
        prev = c;
    }

    if label_len == 0 || prev == b'-' {
        return false; // final label empty or ends with '-'
    }
    label_count += 1;

    label_count >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normalized_domains() {
        for d in ["acme.example", "a.co", "acme-api.example", "sub.acme.example", "x1.y2.z3"] {
            assert!(is_valid(d), "should accept {d}");
        }
    }

    #[test]
    fn rejects_malformed_domains() {
        for d in [
            "",
            "no-dot",
            "UPPER.example",   // uppercase must be rejected (normalization is offchain)
            "-bad.example",    // label starts with hyphen
            "bad-.example",    // label ends with hyphen
            "bad..example",    // empty label
            ".bad.example",    // leading dot
            "bad.example.",    // trailing dot
            "acmé.example",    // non-ascii
            "a.b",             // too short (< 4)
        ] {
            assert!(!is_valid(d), "should reject {d:?}");
        }
    }

    #[test]
    fn enforces_label_and_total_length() {
        let long_label = "a".repeat(64);
        assert!(!is_valid(&format!("{long_label}.example")));
        let ok_label = "a".repeat(63);
        assert!(is_valid(&format!("{ok_label}.co")));

        let too_long = format!("{}.example", "a".repeat(250));
        assert!(!is_valid(&too_long));
    }
}
