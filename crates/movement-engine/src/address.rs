//! Lexical addresses (packages/movement-engine/services/movement_engine/address.ts): the
//! path of steps from the movement body's root to a statement, encoded as
//! the text a park keys on (`s1.i0.s0.b0.s0`).
//!
//! - `s i`: the i-th statement of the current sequence;
//! - `i j`: a fan-out body's iteration j (a traversal block's j-th landing);
//! - `b k`: an `if` arm (or, later, a parallel branch) k;
//! - `c k`: what runs inside a statement's k-th call (a callee's body).
//!
//! A `suspendAt` naming a `c` step is refused at admission: a statement is
//! re-run by a journal of its finished calls, which this engine keeps none of.

/// A lexical address: `s1.b0.s2`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Address(Vec<(char, usize)>);

impl Address {
    /// `childStmt`.
    pub fn stmt(&self, index: usize) -> Address {
        self.child('s', index)
    }

    /// `childBranch`.
    pub fn branch(&self, index: usize) -> Address {
        self.child('b', index)
    }

    /// `childIter`: a fan-out iteration, positional in the order its head
    /// yielded the landings.
    pub fn iter(&self, index: usize) -> Address {
        self.child('i', index)
    }

    /// `childCall`: what runs inside a statement's k-th call.
    pub fn call(&self, index: usize) -> Address {
        self.child('c', index)
    }

    fn child(&self, kind: char, index: usize) -> Address {
        let mut steps = self.0.clone();
        steps.push((kind, index));
        Address(steps)
    }

    /// `parseAddress`, `None` for a text that does not read.
    pub fn parse(text: &str) -> Option<Address> {
        if text.is_empty() {
            return Some(Address::default());
        }
        text.split('.')
            .map(|step| {
                let mut chars = step.chars();
                let kind = chars.next()?;
                let digits = chars.as_str();
                (matches!(kind, 's' | 'b' | 'i' | 'c') && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok().map(|n| (kind, n)))?
            })
            .collect::<Option<Vec<_>>>()
            .map(Address)
    }

    /// `encodeAddress`.
    pub fn encode(&self) -> String {
        self.0.iter().map(|(kind, index)| format!("{kind}{index}")).collect::<Vec<_>>().join(".")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_encode_as_address_ts_does() {
        let root = Address::default();
        assert_eq!(root.encode(), "");
        assert_eq!(root.stmt(1).branch(0).stmt(2).encode(), "s1.b0.s2");
        assert_eq!(root.stmt(1).iter(0).stmt(0).branch(0).stmt(0).encode(), "s1.i0.s0.b0.s0");
        // A nested block's iteration, inside its enclosing block's.
        assert_eq!(root.stmt(1).iter(2).stmt(3).iter(0).stmt(1).encode(), "s1.i2.s3.i0.s1");
    }
}
