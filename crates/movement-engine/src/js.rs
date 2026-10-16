//! JavaScript's values, and the JavaScript semantics the TypeScript engine
//! leans on without saying so: `String()`, `Number()`, `===`, truthiness,
//! property order, `Math.round`, `toFixed`, `trim`, UTF-16 lengths and
//! comparisons, `JSON.stringify`. Each is written out here because Rust's own
//! version differs somewhere (see the README's list), and the engine has to
//! compute what the TypeScript engine computed, byte for byte.
//!
//! Objects and arrays are shared (`Rc`), because `===` compares them by
//! identity: `x == x` is true for a dict, and two equal-looking literals are
//! not equal.

use std::rc::Rc;

pub use crate::js_string::JsString;

#[derive(Debug, Clone)]
pub enum Js {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    /// A string, lone surrogates and all (crate::js_string).
    String(JsString),
    Array(Rc<JsArray>),
    Object(Rc<JsObject>),
    /// A record held as a value: the binding object the TypeScript engine
    /// puts on the value plane (a walk's landings, a list of records, a
    /// collection op's answer), which `bindingOf` reads back as the record.
    /// To every other JavaScript operation it is a plain object.
    Record(Rc<crate::bindings::Binding>),
    /// A file the engine holds (crate::file): an opaque handle onto a file
    /// the host keeps, with what a reader may print of it. To JavaScript it
    /// is an object that is no dict (an instance of the TypeScript engine's
    /// file class): its printable members read, a spread refuses it.
    File(Rc<crate::file::FileHandle>),
}

/// `map[key]`: its own entry, else `undefined`. A map is a map: no key is
/// inherited, `__proto__` and `constructor` included.
pub fn object_property(object: &JsObject, key: &str) -> Js {
    object.get(key).cloned().unwrap_or(Js::Undefined)
}

/// `isDictValue`: a map. Every check of whether a value is a dict asks here.
pub fn is_dict(value: &Js) -> bool {
    matches!(value, Js::Object(_))
}

#[derive(Debug, Default)]
pub struct JsArray {
    /// Its members.
    cells: std::cell::RefCell<Vec<Js>>,
}

impl JsArray {
    pub fn new(items: Vec<Js>) -> JsArray {
        JsArray { cells: std::cell::RefCell::new(items) }
    }

    /// Its members as they are now.
    pub fn items(&self) -> std::cell::Ref<'_, Vec<Js>> {
        self.cells.borrow()
    }

    /// `list.push(item)`.
    pub fn push(&self, item: Js) {
        self.cells.borrow_mut().push(item);
    }
}

/// A plain object: own keys in JavaScript's order (array-index keys
/// ascending first, then the rest as inserted).
#[derive(Debug, Default)]
pub struct JsObject {
    entries: Vec<(String, Js)>,
}

impl JsObject {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn entries(&self) -> &[(String, Js)] {
        &self.entries
    }

    /// A fresh object with `other`'s own entries (`{...other}`).
    pub fn clone_of(other: &JsObject) -> JsObject {
        JsObject { entries: other.entries.clone() }
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// An entry, whatever the key (`__proto__` is a key like any other).
    /// A key already there keeps its place.
    pub fn set(&mut self, key: String, value: Js) {
        insert_in_object_order(&mut self.entries, key, value);
    }
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`: a name written bare.
pub fn is_identifier(raw: &str) -> bool {
    let mut chars = raw.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `object[key] = value` over any keyed list: array-index keys ascending
/// first, then the rest as inserted; a key already there keeps its place.
pub fn insert_in_object_order<V>(entries: &mut Vec<(String, V)>, key: String, value: V) {
    if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = value;
        return;
    }
    match array_index(&key) {
        Some(index) => {
            let at = entries.iter().position(|(k, _)| array_index(k).is_none_or(|other| other > index)).unwrap_or(entries.len());
            entries.insert(at, (key, value));
        }
        None => entries.push((key, value)),
    }
}

/// A key that is an array index (`"0"`, `"17"`, below 2³² − 1), which an
/// object lists before its other keys, in numeric order.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) || (bytes[0] == b'0' && bytes.len() > 1) {
        return None;
    }
    key.parse::<u64>().ok().filter(|&n| n < u64::from(u32::MAX)).map(|n| n as u32)
}

impl Js {
    pub fn str(text: impl Into<JsString>) -> Js {
        Js::String(text.into())
    }

    pub fn array(items: Vec<Js>) -> Js {
        Js::Array(Rc::new(JsArray::new(items)))
    }

    pub fn object(object: JsObject) -> Js {
        Js::Object(Rc::new(object))
    }

    /// `null` or `undefined` — what `== null` and `??` test for.
    pub fn is_nullish(&self) -> bool {
        matches!(self, Js::Undefined | Js::Null)
    }

    pub fn truthy(&self) -> bool {
        match self {
            Js::Undefined | Js::Null => false,
            Js::Bool(b) => *b,
            Js::Number(n) => !(n.is_nan() || *n == 0.0),
            Js::String(s) => !s.is_empty(),
            Js::Array(_) | Js::Object(_) | Js::Record(_) | Js::File(_) => true,
        }
    }

    /// `typeof`, as an error message prints it.
    pub fn type_of(&self) -> &'static str {
        match self {
            Js::Undefined => "undefined",
            Js::Null | Js::Array(_) | Js::Object(_) | Js::Record(_) | Js::File(_) => "object",
            Js::Bool(_) => "boolean",
            Js::Number(_) => "number",
            Js::String(_) => "string",
        }
    }

    /// `String(value)`.
    pub fn to_js_string(&self) -> String {
        match self {
            Js::Undefined => "undefined".into(),
            Js::Null => "null".into(),
            Js::Bool(b) => b.to_string(),
            Js::Number(n) => number_to_string(*n),
            Js::String(s) => s.to_string(),
            // Array.prototype.join: a null or undefined member is empty, and a
            // list already being joined (a cycle) is empty too.
            Js::Array(array) => joining(Rc::as_ptr(array).cast(), String::new, || {
                array.items().iter().map(|item| if item.is_nullish() { String::new() } else { item.to_js_string() }).collect::<Vec<_>>().join(",")
            }),
            Js::Object(_) | Js::Record(_) | Js::File(_) => "[object Object]".into(),
        }
    }

    /// `String(value)`: a map is `[object Object]`, whatever keys it holds.
    pub fn to_text(&self) -> Result<String, Thrown> {
        match self {
            Js::Array(array) => joining(Rc::as_ptr(array).cast(), || Ok(String::new()), || {
                let items = array.items().clone();
                let mut parts = Vec::with_capacity(items.len());
                for item in &items {
                    parts.push(if item.is_nullish() { String::new() } else { item.to_text()? });
                }
                Ok(parts.join(","))
            }),
            Js::Object(_) => Ok("[object Object]".into()),
            other => Ok(other.to_js_string()),
        }
    }

    /// `Number(value)`.
    pub fn to_number(&self) -> f64 {
        match self {
            Js::Undefined => f64::NAN,
            Js::Null => 0.0,
            Js::Bool(b) => f64::from(u8::from(*b)),
            Js::Number(n) => *n,
            Js::String(s) => string_to_number(s.as_form()),
            Js::Array(_) => string_to_number(&self.to_js_string()),
            Js::Object(_) | Js::Record(_) | Js::File(_) => f64::NAN,
        }
    }
}

/// What a built-in throws: its class (`TypeError`, `RangeError`) and words.
#[derive(Debug, Clone, PartialEq)]
pub struct Thrown {
    pub class: &'static str,
    pub message: String,
}

thread_local! {
    /// V8's join stack: the lists (and list-like objects) being joined now.
    static JOINING: std::cell::RefCell<Vec<*const ()>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// `join` of the object at `address`: what `cycle` makes when it is already
/// being joined further up (V8 answers the empty text), else `join`'s.
fn joining<T>(address: *const (), cycle: impl FnOnce() -> T, join: impl FnOnce() -> T) -> T {
    if JOINING.with(|stack| stack.borrow().contains(&address)) {
        return cycle();
    }
    JOINING.with(|stack| stack.borrow_mut().push(address));
    let out = join();
    JOINING.with(|stack| stack.borrow_mut().pop());
    out
}

/// `a === b`: numbers by value (`NaN` is not itself, `-0` is `0`), objects
/// and arrays by identity.
pub fn strict_equals(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Undefined, Js::Undefined) | (Js::Null, Js::Null) => true,
        (Js::Bool(x), Js::Bool(y)) => x == y,
        (Js::Number(x), Js::Number(y)) => x == y,
        (Js::String(x), Js::String(y)) => x == y,
        (Js::Array(x), Js::Array(y)) => Rc::ptr_eq(x, y),
        (Js::Object(x), Js::Object(y)) => Rc::ptr_eq(x, y),
        (Js::Record(x), Js::Record(y)) => x.is(y),
        (Js::File(x), Js::File(y)) => Rc::ptr_eq(x, y),
        _ => false,
    }
}

/// SameValueZero — what `includes` and `Set` use: `===`, except `NaN` is
/// itself.
pub fn same_value_zero(a: &Js, b: &Js) -> bool {
    match (a, b) {
        (Js::Number(x), Js::Number(y)) if x.is_nan() && y.is_nan() => true,
        _ => strict_equals(a, b),
    }
}

// ── Strings ───────────────────────────────────────────────────────────────────

/// A text without the whitespace (Rust's `char::is_whitespace`) at either end.
pub fn trim(s: &str) -> &str {
    s.trim()
}

/// `.length`: UTF-16 code units, not bytes or chars.
pub fn utf16_len(s: &str) -> usize {
    crate::js_string::utf16_len(s)
}

// ── Case ──────────────────────────────────────────────────────────────────────

/// Lower case, by Rust's own Unicode tables (`str::to_lowercase`, a final
/// sigma included).
pub fn to_lower_case(s: &str) -> String {
    s.to_lowercase()
}

/// Upper case, by Rust's own Unicode tables (`str::to_uppercase`).
pub fn to_upper_case(s: &str) -> String {
    s.to_uppercase()
}

// ── Numbers ───────────────────────────────────────────────────────────────────

/// A text as a number: trimmed, then read as a decimal (`12`, `-1.5e3`,
/// `.5`, `5.`) or `Infinity`; an empty text is 0, anything else (`0x10`,
/// `inf`, `1_0`) NaN.
pub fn string_to_number(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if !body.starts_with(|c: char| c.is_ascii_digit() || c == '.') || body.starts_with(['0']) && body[1..].starts_with(['x', 'X', 'o', 'O', 'b', 'B']) {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

/// A number as text: the shortest digits that read back as the same number,
/// laid out positionally between 1e-7 and 1e21, else `1.5e+21`. One
/// formatter serves the parser, the checker and the engine.
pub use movement_parser::util::js::number_to_string;

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Math.sign`.
pub fn math_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 { x } else { x.signum() }
}

/// A number with exactly `digits` decimals: Rust's `{:.N}`, which rounds
/// the double's exact value half to even (`0.25` → `0.2`).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_finite() { format!("{x:.digits$}") } else { number_to_string(x) }
}

// ── JSON.stringify ────────────────────────────────────────────────────────────

/// `JSON.stringify(text)` (crate::js_string, a lone surrogate written
/// `\udXXX`).
pub fn json_quote(s: &str) -> String {
    crate::js_string::json_quote(s)
}

/// `JSON.stringify(value, null, indent)` over a value that is already JSON
/// data (no `undefined`, no non-finite numbers). `indent` 0 is the compact
/// form.
pub fn json_stringify(value: &Js, indent: usize) -> String {
    // A value that holds itself: `safeStringify`'s fallback, its text (the
    // prompt's writers are the ones a user's value reaches).
    if holds_itself(value) {
        return value.to_js_string();
    }
    let mut out = String::new();
    let mut held = None;
    write_json(value, indent, 0, &mut out, &mut held);
    out
}

/// `json_stringify` of a value that may hold a record: the text, or the kind
/// of the first record whose binding object this engine cannot write out as
/// the TypeScript's `JSON.stringify` would (its read seam, its computed
/// schema, its `Map`s are the TypeScript engine's).
pub fn try_json_stringify(value: &Js, indent: usize) -> Result<String, String> {
    let value = &acyclic(value);
    let mut out = String::new();
    let mut held = None;
    write_json(value, indent, 0, &mut out, &mut held);
    match held {
        Some(kind) => Err(kind),
        None => Ok(out),
    }
}

fn write_json(value: &Js, indent: usize, depth: usize, out: &mut String, held: &mut Option<String>) {
    let newline = |out: &mut String, depth: usize| {
        if indent > 0 {
            out.push('\n');
            out.push_str(&" ".repeat(indent * depth));
        }
    };
    match value {
        Js::Undefined | Js::Null => out.push_str("null"),
        // `JSON.stringify` of the binding object: the event's is
        // `{kind: 'event'}`, a callback's, a shape position's and a
        // resource's their data (`record::data_object`), a block's returned
        // records the list of theirs. Any other's holds what only the
        // TypeScript engine has; the first met is named
        // (`try_json_stringify`), and written as `{}` for the writers no
        // record reaches (admission keeps them from a `from` datum; the rest
        // read one down to its fields first).
        Js::Record(record) => match (crate::record::data_object(record), record.as_ref()) {
            (Some(data), _) => write_json(&data, indent, depth, out, held),
            (None, crate::bindings::Binding::Positions(landings)) => {
                let landings = Js::array(landings.iter().cloned().map(crate::record::held).collect());
                let mut object = JsObject::new();
                object.set("kind".into(), Js::str("positions"));
                object.set("landings".into(), landings);
                write_json(&Js::object(object), indent, depth, out, held);
            }
            // The backstop: admission refuses each route it knows by which a
            // record this engine cannot write reaches a writer (by name:
            // `plugin_arg_record`, `builtin_arg_record`, …), and the checked
            // writers (`try_json_stringify`) refuse one. One that still
            // arrives here writes `{}`, never a binding object of its own.
            (None, other) => {
                held.get_or_insert_with(|| crate::record::kind_of(other));
                out.push_str("{}");
            }
        },
        // A file's members, as `JSON.stringify` writes a class instance's.
        // Its printable members: the engine holds no more of it.
        Js::File(file) => write_json(&crate::file::display(file), indent, depth, out, held),
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Number(n) => out.push_str(&if n.is_finite() { number_to_string(*n) } else { "null".into() }),
        Js::String(s) => out.push_str(&json_quote(s.as_form())),
        Js::Array(array) => {
            if array.items().is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in array.items().iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_json(item, indent, depth + 1, out, held);
            }
            newline(out, depth);
            out.push(']');
        }
        Js::Object(object) => {
            let entries: Vec<_> = object.entries().iter().filter(|(_, v)| !matches!(v, Js::Undefined)).collect();
            if entries.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                out.push_str(&json_quote(key));
                out.push(':');
                if indent > 0 {
                    out.push(' ');
                }
                write_json(item, indent, depth + 1, out, held);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}


/// Whether a value holds itself, through its lists and maps: every walker
/// of a value's members asks first, since a GROUPBY filing can make one.
pub fn holds_itself(value: &Js) -> bool {
    fn walk(value: &Js, stack: &mut Vec<*const ()>) -> bool {
        let (address, members): (*const (), Vec<Js>) = match value {
            Js::Array(list) => (Rc::as_ptr(list).cast(), list.items().clone()),
            Js::Object(object) => (Rc::as_ptr(object).cast(), object.entries().iter().map(|(_, item)| item.clone()).collect()),
            _ => return false,
        };
        if stack.contains(&address) {
            return true;
        }
        stack.push(address);
        let found = members.iter().any(|member| walk(member, stack));
        stack.pop();
        found
    }
    walk(value, &mut Vec::new())
}

/// `value` with each edge that closes a circle cut (`null` in its place): what
/// a walker that cannot fail reads, where the TypeScript would have thrown —
/// a backstop no checked program the engine runs is known to reach.
pub fn acyclic(value: &Js) -> Js {
    fn copy(value: &Js, stack: &mut Vec<*const ()>) -> Js {
        let address: *const () = match value {
            Js::Array(list) => Rc::as_ptr(list).cast(),
            Js::Object(object) => Rc::as_ptr(object).cast(),
            other => return other.clone(),
        };
        if stack.contains(&address) {
            return Js::Null;
        }
        stack.push(address);
        let out = match value {
            Js::Array(list) => Js::array(list.items().iter().map(|item| copy(item, stack)).collect()),
            Js::Object(object) => {
                let mut out = JsObject::new();
                for (key, item) in object.entries() {
                    out.set(key.clone(), copy(item, stack));
                }
                Js::object(out)
            }
            _ => unreachable!("matched above"),
        };
        stack.pop();
        out
    }
    copy(value, &mut Vec::new())
}

/// What a walker the TypeScript recurses through without a guard throws on
/// a value that holds itself.
pub fn stack_overflow() -> Thrown {
    Thrown { class: "RangeError", message: "Maximum call stack size exceeded".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A map is a map: `__proto__` is a key like any other, and no key is
    /// inherited.
    #[test]
    fn a_map_is_a_map() {
        let mut map = JsObject::new();
        map.set("__proto__".into(), Js::Number(1.0));
        assert!(matches!(object_property(&map, "__proto__"), Js::Number(n) if n == 1.0));
        for key in ["constructor", "toString", "hasOwnProperty"] {
            assert!(matches!(object_property(&map, key), Js::Undefined), "{key}");
        }
        assert_eq!(Js::object(map).to_text().unwrap(), "[object Object]");
    }

    #[test]
    fn an_unwritable_record_writes_the_backstop() {
        let instance = crate::bindings::InstanceBinding {
            name: "inbox".into(),
            adapter_slug: "email".into(),
            credential_name: None,
            construction_config: Vec::new(),
            schema: None,
        };
        let record = Js::Record(Rc::new(crate::bindings::Binding::Instance(Rc::new(instance))));
        let held = Js::array(vec![record.clone()]);
        assert_eq!(json_stringify(&held, 0), "[{}]");
        assert_eq!(try_json_stringify(&held, 0), Err("instance".to_string()));
        assert_eq!(crate::env::json_of_js(&crate::env::json_round_trip(&record)), serde_json::json!({}));
    }

    #[test]
    fn number_to_string_prints_shortest_digits() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (123e-7, "0.0000123"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (1234.5, "1234.5"),
            // A 17-digit tie: version 5 prints Rust's shortest digits, where
            // JavaScript took the closer ones (`…062`); both read back as the
            // same number.
            (16086.196899414062, "16086.196899414063"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(*x), *want, "{x:?}");
            if x.is_finite() {
                assert_eq!(want.parse::<f64>().unwrap(), *x, "{want} reads back");
            }
        }
    }

    #[test]
    fn string_to_number_matches_javascript() {
        let cases: &[(&str, f64)] = &[
            ("", 0.0),
            ("   ", 0.0),
            ("  12 ", 12.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+.5e1", 5.0),
            ("-12.25", -12.25),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("\u{a0}12\u{85}", 12.0),
        ];
        for (s, want) in cases {
            assert_eq!(string_to_number(s), *want, "{s:?}");
        }
        // Version 5 reads no radix prefix and Rust's whitespace (U+0085 in,
        // U+FEFF out).
        for s in ["infinity", "inf", "nan", "NaN", "1_0", "-0x10", "0x10", "0o17", "0b101", "0x", "1e", "e3", ".", "+", "12abc", "\u{feff}12", "1 2"] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
        assert!(string_to_number("-0").is_sign_negative());
    }

    /// Version 5 rounds the double's exact value half to even at the last
    /// place (JavaScript's `toFixed` rounded half up: `0.25` → `0.3`).
    #[test]
    fn to_fixed_is_rusts_fixed_point() {
        assert_eq!(to_fixed(0.25, 1), "0.2");
        assert_eq!(to_fixed(1.45, 1), "1.4");
        assert_eq!(to_fixed(2.5, 0), "2");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(1.2, 1), "1.2");
        assert_eq!(to_fixed(f64::INFINITY, 1), "Infinity");
    }

    #[test]
    fn strings_are_utf16_where_javascript_says_so() {
        assert_eq!(utf16_len("a😀"), 3);
        // Texts order by code point (JavaScript ordered UTF-16 units, so
        // U+FF61 sorted after an emoji).
        assert!("\u{FF61}" < "😀");
        assert_eq!(trim("\u{85} x \u{2028}"), "x");
        assert_eq!(trim("\u{FEFF}x"), "\u{FEFF}x");
    }

    #[test]
    fn objects_keep_javascript_key_order() {
        let mut o = JsObject::new();
        o.set("b".into(), Js::Number(1.0));
        o.set("10".into(), Js::Number(2.0));
        o.set("a".into(), Js::Number(3.0));
        o.set("2".into(), Js::Number(4.0));
        o.set("b".into(), Js::Number(5.0));
        o.set("01".into(), Js::Number(6.0));
        let keys: Vec<_> = o.entries().iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "b", "a", "01"]);
    }

    #[test]
    fn string_and_number_coercions_of_composites() {
        let list = Js::array(vec![Js::Number(1.0), Js::Null, Js::array(vec![Js::str("a"), Js::Undefined])]);
        assert_eq!(list.to_js_string(), "1,,a,");
        assert_eq!(Js::array(vec![]).to_number(), 0.0);
        assert_eq!(Js::array(vec![Js::str(" 5 ")]).to_number(), 5.0);
        assert!(Js::object(JsObject::new()).to_number().is_nan());
        assert_eq!(Js::object(JsObject::new()).to_js_string(), "[object Object]");
    }

    #[test]
    fn identity_not_shape_decides_equality() {
        let a = Js::array(vec![]);
        assert!(strict_equals(&a, &a.clone()));
        assert!(!strict_equals(&a, &Js::array(vec![])));
        assert!(!strict_equals(&Js::Number(f64::NAN), &Js::Number(f64::NAN)));
        assert!(same_value_zero(&Js::Number(f64::NAN), &Js::Number(f64::NAN)));
        assert!(strict_equals(&Js::Number(0.0), &Js::Number(-0.0)));
    }

    #[test]
    fn json_stringify_indents_as_javascript_does() {
        let mut inner = JsObject::new();
        inner.set("k".into(), Js::str("a\"\u{1}"));
        let value = Js::array(vec![Js::Number(1.0), Js::object(inner), Js::array(vec![]), Js::object(JsObject::new())]);
        assert_eq!(json_stringify(&value, 2), "[\n  1,\n  {\n    \"k\": \"a\\\"\\u0001\"\n  },\n  [],\n  {}\n]");
        assert_eq!(json_stringify(&value, 0), "[1,{\"k\":\"a\\\"\\u0001\"},[],{}]");
    }
}
