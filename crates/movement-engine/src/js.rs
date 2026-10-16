//! JavaScript's values, and the JavaScript semantics the TypeScript engine
//! leans on without saying so: `String()`, `Number()`, `===`, truthiness,
//! property order, `Math.round`, `toFixed`, `trim`, UTF-16 lengths and
//! comparisons, `JSON.stringify`. Each is written out here because Rust's own
//! version differs somewhere (see the README's list), and the engine has to
//! compute what the TypeScript engine computed, byte for byte.
//!
//! Objects and arrays are shared (`Rc`), because `===` compares them by
//! identity: `x == x` is true for a dict, and two equal-looking literals are
//! not equal. A value that came from the caller remembers its `origin`, so
//! handing it back hands back the caller's own object.

use std::cmp::Ordering;
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
    /// A function `Object.prototype` holds, or `Object` itself: what reading
    /// one of `OBJECT_PROTOTYPE_NAMES` off a plain object finds.
    Function(NativeFunction),
}

/// `Object.prototype`'s own names: a plain object reads each through its
/// prototype (`{}.toString` is a function), and `kind in describeBinding`
/// finds each on any object (so `{kind: "toString"}` is a record to the
/// TypeScript engine). The one table: the binding test, every field read
/// and the extraction validator read it.
pub const OBJECT_PROTOTYPE_NAMES: [&str; 12] = [
    "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
    "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString",
];

/// One of `Object.prototype`'s own names.
pub fn is_object_prototype_name(name: &str) -> bool {
    OBJECT_PROTOTYPE_NAMES.contains(&name)
}

/// A built-in function, by the name its `String()` prints: `Object`, or one
/// of `Object.prototype`'s methods. One per realm, so `===` is by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeFunction(pub &'static str);

/// `Array.prototype`'s methods (Node 22), named `Array#<name>` so a list's
/// `toString` is not `Object.prototype`'s: what an object whose prototype a
/// filing made a list reads under those names.
pub const ARRAY_PROTOTYPE_NAMES: [&str; 39] = ["Array#constructor", "Array#at", "Array#concat", "Array#copyWithin", "Array#fill", "Array#find", "Array#findIndex", "Array#findLast", "Array#findLastIndex", "Array#lastIndexOf", "Array#pop", "Array#push", "Array#reverse", "Array#shift", "Array#unshift", "Array#slice", "Array#sort", "Array#splice", "Array#includes", "Array#indexOf", "Array#join", "Array#keys", "Array#entries", "Array#values", "Array#forEach", "Array#filter", "Array#flat", "Array#flatMap", "Array#map", "Array#every", "Array#some", "Array#reduce", "Array#reduceRight", "Array#toReversed", "Array#toSorted", "Array#toSpliced", "Array#with", "Array#toLocaleString", "Array#toString"];

impl NativeFunction {
    /// `Function.prototype.toString` of a built-in.
    pub fn source_text(self) -> String {
        let name = match self.0 {
            "Array#constructor" => "Array",
            name => name.strip_prefix("Array#").unwrap_or(name),
        };
        format!("function {name}() {{ [native code] }}")
    }
}

thread_local! {
    /// `Object.prototype` itself (what `__proto__` reads off a plain object):
    /// one object, with no own enumerable key.
    static OBJECT_PROTOTYPE: Rc<JsObject> = Rc::new(JsObject::new());
}

/// `Object.prototype`.
pub fn object_prototype() -> Js {
    Js::Object(OBJECT_PROTOTYPE.with(Rc::clone))
}

pub fn is_object_prototype(object: &Rc<JsObject>) -> bool {
    OBJECT_PROTOTYPE.with(|prototype| Rc::ptr_eq(prototype, object))
}

/// `Object.prototype[name]`, for one of its own names. `__proto__` read off
/// `Object.prototype` itself is `null`; off any other plain object it is
/// `Object.prototype`.
pub fn prototype_member(name: &str, of: &Rc<JsObject>) -> Js {
    match name {
        "constructor" => Js::Function(NativeFunction("Object")),
        "__proto__" if is_object_prototype(of) => Js::Null,
        "__proto__" => object_prototype(),
        other => match OBJECT_PROTOTYPE_NAMES.iter().find(|n| **n == other) {
            Some(name) => Js::Function(NativeFunction(name)),
            None => Js::Undefined,
        },
    }
}

/// `object[key]` on a plain object: its own entry, else what its prototype
/// holds under that name, else `undefined`.
pub fn object_property(object: &Rc<JsObject>, key: &str) -> Js {
    match (object.get(key), &object.proto) {
        (Some(value), _) => value.clone(),
        // `Object.create(null)` inherits no `__proto__` accessor.
        (None, Some(Js::Null)) => Js::Undefined,
        (None, Some(proto)) if key == "__proto__" => proto.clone(),
        (None, Some(proto)) => inherited(proto, key),
        (None, None) if is_object_prototype_name(key) => prototype_member(key, object),
        (None, None) => Js::Undefined,
    }
}

/// `object[key]` found on the prototype `proto` an object was given: a
/// list's member or length, an object's (and so on up its chain), a
/// record's own key, else `Object.prototype`'s member.
pub(crate) fn inherited(proto: &Js, key: &str) -> Js {
    let base = || if is_object_prototype_name(key) { prototype_member(key, &OBJECT_PROTOTYPE.with(Rc::clone)) } else { Js::Undefined };
    match proto {
        Js::Object(object) => object_property(object, key),
        Js::Array(list) if key == "length" => Js::Number(list.items().len() as f64),
        Js::Array(list) => match array_index(key).and_then(|i| list.items().get(i as usize).cloned()) {
            Some(item) => item,
            None => match ARRAY_PROTOTYPE_NAMES.iter().find(|n| n.strip_prefix("Array#") == Some(key)) {
                Some(name) => Js::Function(NativeFunction(name)),
                None => base(),
            },
        },
        Js::Record(record) => match crate::record::own_property(record, key) {
            Ok(Js::Null) | Err(_) => base(),
            Ok(found) => found,
        },
        // `Object.create(null)`'s: nothing to inherit.
        Js::Null => Js::Undefined,
        _ => base(),
    }
}

/// `isDictValue`: a plain keyed object, its prototype `Object.prototype` or
/// none at all (`null`, which a `__proto__: null` a spread assigns leaves).
/// Every check of whether an object is a dict asks here.
pub fn is_dict(value: &Js) -> bool {
    matches!(value, Js::Object(object) if matches!(object.proto, None | Some(Js::Null)))
}

/// `object[key]` on a plain object that is not `Object.prototype` itself.
pub fn plain_property(object: &JsObject, key: &str) -> Js {
    match (object.get(key), &object.proto) {
        (Some(value), _) => return value.clone(),
        // `Object.create(null)` inherits no `__proto__` accessor.
        (None, Some(Js::Null)) => return Js::Undefined,
        (None, Some(proto)) if key == "__proto__" => return proto.clone(),
        (None, Some(proto)) => return inherited(proto, key),
        (None, None) => {}
    }
    match object.get(key) {
        Some(value) => value.clone(),
        None if key == "__proto__" => object_prototype(),
        None if is_object_prototype_name(key) => prototype_member(key, &OBJECT_PROTOTYPE.with(Rc::clone)),
        None => Js::Undefined,
    }
}

#[derive(Debug, Default)]
pub struct JsArray {
    /// Its members; a GROUPBY filing pushes onto a list its answer's
    /// prototype holds, as JavaScript's `push` does, so every holder sees it.
    cells: std::cell::RefCell<Vec<Js>>,
    /// The caller's id for this array, when it came from the caller.
    pub origin: Option<u32>,
}

impl JsArray {
    pub fn new(items: Vec<Js>) -> JsArray {
        JsArray { cells: std::cell::RefCell::new(items), origin: None }
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
    pub origin: Option<u32>,
    /// What `object.__proto__ = …` made its prototype (a GROUPBY or KEYBY
    /// filing a member under the key `__proto__`); `None` is
    /// `Object.prototype`. An object with one is no dict (`isDictValue`).
    pub proto: Option<Js>,
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
        JsObject { entries: other.entries.clone(), origin: None, proto: None }
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// An own entry, whatever the key, as `JSON.parse` and
    /// `Object.defineProperty` write one: a `__proto__` key is a key here
    /// (`assign` is `object[key] = value`, whose `__proto__` sets the
    /// prototype). A key already there keeps its place.
    pub fn set(&mut self, key: String, value: Js) {
        insert_in_object_order(&mut self.entries, key, value);
    }

    /// `object[key] = value` for any key: `__proto__` is
    /// `Object.prototype`'s setter, which makes an object the prototype,
    /// makes `null` none at all, and ignores anything else.
    pub fn assign(&mut self, key: String, value: Js) {
        if key != "__proto__" {
            return self.set(key, value);
        }
        if matches!(value, Js::Object(_) | Js::Array(_) | Js::Record(_) | Js::File(_) | Js::Function(_) | Js::Null) {
            self.proto = Some(value);
        }
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
            Js::Array(_) | Js::Object(_) | Js::Record(_) | Js::File(_) | Js::Function(_) => true,
        }
    }

    /// `typeof`, as an error message prints it.
    pub fn type_of(&self) -> &'static str {
        match self {
            Js::Undefined => "undefined",
            Js::Null | Js::Array(_) | Js::Object(_) | Js::Record(_) | Js::File(_) => "object",
            Js::Function(_) => "function",
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
            Js::Function(function) => function.source_text(),
        }
    }

    /// `String(value)` with ToPrimitive's reading of a plain object: its
    /// `toString`, then its `valueOf` — its own keys of those names, or its
    /// prototype's — called until one answers with a primitive. A dict whose
    /// own `toString` is no function cannot be made text (`TypeError`).
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
            Js::Object(object) => object_to_primitive(object, 0)?.to_text(),
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
            Js::Object(_) | Js::Record(_) | Js::File(_) | Js::Function(_) => f64::NAN,
        }
    }
}

/// What a built-in throws: its class (`TypeError`, `RangeError`) and words.
#[derive(Debug, Clone, PartialEq)]
pub struct Thrown {
    pub class: &'static str,
    pub message: String,
}

impl Thrown {
    fn type_error(message: &str) -> Thrown {
        Thrown { class: "TypeError", message: message.to_string() }
    }
}

/// `OrdinaryToPrimitive(object, "string")`. `depth` counts the calls
/// `toLocaleString` makes of `this.toString()`: one that calls itself runs
/// out of stack, as V8's does.
fn object_to_primitive(object: &Rc<JsObject>, depth: usize) -> Result<Js, Thrown> {
    // A list up the prototype chain answers `toString` with
    // `Array.prototype.toString`: a join over `this`.
    if array_up_chain(object) {
        return join_of(object).map(Js::str);
    }
    for name in ["toString", "valueOf"] {
        let Js::Function(method) = object_property(object, name) else { continue };
        if let Some(primitive) = call_on(method, object, depth)? {
            return Ok(primitive);
        }
    }
    Err(Thrown::type_error("Cannot convert object to primitive value"))
}

/// Whether `toString` reaches a list's before any object owns one.
fn array_up_chain(object: &Rc<JsObject>) -> bool {
    if object.get("toString").is_some() {
        return false;
    }
    match &object.proto {
        Some(Js::Array(_)) => true,
        Some(Js::Object(proto)) => array_up_chain(proto),
        _ => false,
    }
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

/// `Array.prototype.join.call(object, ",")`: `this.length` members read
/// through the chain, an absent one empty.
fn join_of(object: &Rc<JsObject>) -> Result<String, Thrown> {
    joining(Rc::as_ptr(object).cast(), || Ok(String::new()), || join_members(object))
}

fn join_members(object: &Rc<JsObject>) -> Result<String, Thrown> {
    let length = object_property(object, "length").to_number();
    let length = if length.is_nan() || length <= 0.0 { 0 } else { length.min(1e7) as usize };
    let mut parts = Vec::with_capacity(length);
    for i in 0..length {
        let item = object_property(object, &i.to_string());
        parts.push(if item.is_nullish() { String::new() } else { item.to_text()? });
    }
    Ok(parts.join(","))
}

/// A built-in called with `this` the object and no argument: the primitive
/// it answers, or `None` for an object.
fn call_on(method: NativeFunction, object: &Rc<JsObject>, depth: usize) -> Result<Option<Js>, Thrown> {
    Ok(match method.0 {
        "toString" => Some(Js::str("[object Object]")),
        // `valueOf` hands the object back; `Object()` makes a new one.
        "valueOf" | "Object" => None,
        // Each reads its argument, `undefined`, as the key "undefined".
        "hasOwnProperty" | "propertyIsEnumerable" => Some(Js::Bool(object.get("undefined").is_some())),
        "isPrototypeOf" => Some(Js::Bool(false)),
        "__lookupGetter__" | "__lookupSetter__" => Some(Js::Undefined),
        "__defineGetter__" | "__defineSetter__" => return Err(Thrown::type_error(&format!("Object.prototype.{}: Expecting function", method.0))),
        // `this.toString()`.
        "toLocaleString" => {
            if depth > 64 {
                return Err(Thrown { class: "RangeError", message: "Maximum call stack size exceeded".into() });
            }
            match object_property(object, "toString") {
                Js::Function(inner) => call_on(inner, object, depth + 1)?,
                _ => return Err(Thrown::type_error("Cannot convert object to primitive value")),
            }
        }
        _ => None,
    })
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
        (Js::Function(x), Js::Function(y)) => x == y,
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

/// JavaScript's WhiteSpace and LineTerminator, which `trim` and `\s` strip.
/// Not Rust's `char::is_whitespace`: that one has U+0085 and lacks U+FEFF.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `.length`: UTF-16 code units, not bytes or chars.
pub fn utf16_len(s: &str) -> usize {
    crate::js_string::utf16_len(s)
}

/// `a < b` on strings: UTF-16 code-unit order, which differs from Rust's
/// code-point order where an astral character meets one above U+E000.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    crate::js_string::units_of(a).cmp(crate::js_string::units_of(b))
}

// ── Case ──────────────────────────────────────────────────────────────────────

/// `toLowerCase()`, as Node's ICU reads it (crate::case_mapping): Rust's
/// tables follow the toolchain's Unicode, which runs ahead of Node's, so they
/// are not used for text. The root locale's one contextual mapping is kept:
/// a capital sigma with a cased letter before it and none after it (case
/// ignorable letters skipped on both sides) lowers to `ς`.
pub fn to_lower_case(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (at, &c) in chars.iter().enumerate() {
        if c == 'Σ' {
            let final_sigma = cased_neighbour(chars[..at].iter().rev()) && !cased_neighbour(chars[at + 1..].iter());
            out.push(if final_sigma { 'ς' } else { 'σ' });
        } else {
            map_case(&crate::case_mapping::LOWER, c, &mut out);
        }
    }
    out
}

/// `toUpperCase()`, as Node's ICU reads it: no context in the root locale.
pub fn to_upper_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        map_case(&crate::case_mapping::UPPER, c, &mut out);
    }
    out
}

fn map_case(mapping: &crate::case_mapping::Mapping, c: char, out: &mut String) {
    let code = c as u32;
    let run = mapping.runs.partition_point(|&(start, ..)| start <= code).checked_sub(1).map(|i| mapping.runs[i]);
    if let Some((start, count, stride, delta)) = run
        && (code - start).is_multiple_of(stride)
        && (code - start) / stride < count
    {
        out.push(char::from_u32(code.wrapping_add_signed(delta)).expect("a case run maps to a scalar value"));
    } else if let Ok(i) = mapping.expansions.binary_search_by_key(&code, |&(from, _)| from) {
        out.push_str(mapping.expansions[i].1);
    } else {
        out.push(c);
    }
}

/// ICU's final-sigma test on one side: the first neighbour that is not case
/// ignorable is cased.
fn cased_neighbour<'c>(mut side: impl Iterator<Item = &'c char>) -> bool {
    side.find(|&&c| !in_ranges(crate::case_mapping::IGNORABLE, c)).is_some_and(|&c| in_ranges(crate::case_mapping::CASED, c))
}

fn in_ranges(ranges: &[(u32, u32)], c: char) -> bool {
    let code = c as u32;
    ranges.partition_point(|&(from, _)| from <= code).checked_sub(1).is_some_and(|i| code <= ranges[i].1)
}

// ── Numbers ───────────────────────────────────────────────────────────────────

/// `Number(text)`: StringToNumber. Rust's `parse::<f64>` disagrees in both
/// directions (it reads `inf`, `nan` and `1_0`-free forms but not `0x10`, and
/// refuses `""`), so the grammar is checked here and only the decimal digits
/// are handed to it.
pub fn string_to_number(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|p| t.strip_prefix(p)) {
            return radix_digits(digits, radix);
        }
    }
    let (negative, body) = match t.as_bytes()[0] {
        b'+' => (false, &t[1..]),
        b'-' => (true, &t[1..]),
        _ => (false, t),
    };
    let magnitude = if body == "Infinity" { f64::INFINITY } else { decimal(body) };
    if negative { -magnitude } else { magnitude }
}

/// `StrUnsignedDecimalLiteral`: `1`, `1.`, `.5`, `1.5e-3`; anything else NaN.
fn decimal(body: &str) -> f64 {
    let bytes = body.as_bytes();
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let int = digits(0);
    let mut at = int;
    let mut frac = 0;
    if bytes.get(at) == Some(&b'.') {
        frac = digits(at + 1);
        at += 1 + frac;
    }
    if int + frac == 0 {
        return f64::NAN;
    }
    let mantissa_end = at;
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(at + 1), Some(b'+' | b'-')));
        let exp = digits(at + 1 + sign);
        if exp == 0 {
            return f64::NAN;
        }
        at += 1 + sign + exp;
    }
    if at != bytes.len() {
        return f64::NAN;
    }
    let int_part = if int == 0 { "0" } else { &body[..int] };
    let frac_part = if frac == 0 { "0" } else { &body[int + 1..int + 1 + frac] };
    let exponent = &body[mantissa_end..];
    format!("{int_part}.{frac_part}{exponent}").parse().unwrap_or(f64::NAN)
}

/// A `0x`/`0o`/`0b` literal's digits, rounded once to the nearest double as
/// JavaScript rounds the mathematical value.
fn radix_digits(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let bits_per = radix.trailing_zeros();
    let mut bits: Vec<bool> = Vec::new();
    for c in digits.chars() {
        let Some(d) = c.to_digit(radix) else { return f64::NAN };
        for i in (0..bits_per).rev() {
            bits.push((d >> i) & 1 == 1);
        }
    }
    let first = bits.iter().position(|&b| b).unwrap_or(bits.len());
    let bits = &bits[first..];
    if bits.is_empty() {
        return 0.0;
    }
    let take = bits.len().min(64);
    let mut m: u64 = bits[..take].iter().fold(0, |acc, &b| (acc << 1) | u64::from(b));
    // The dropped bits only matter as "some were set": 64 kept bits are
    // well past the 53 of the mantissa, so a sticky low bit rounds right.
    if bits[take..].iter().any(|&b| b) {
        m |= 1;
    }
    let scale = (bits.len() - take) as i32;
    (m as f64) * 2f64.powi(scale)
}

/// `Number.prototype.toString()`: ECMAScript's Number::toString, from
/// `ryu-js`. Rust's own shortest form picks a different digit string on a
/// 17-digit tie (where JavaScript takes the closer one, then the even one),
/// so it is not used for text.
pub fn number_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_string()
}

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Math.round`: half toward +∞ (`Math.round(-2.5)` is `-2`), and a negative
/// that rounds to zero is `-0`. Not Rust's `round`, which goes half away
/// from zero.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Math.sign`.
pub fn math_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 { x } else { x.signum() }
}

/// `Number.prototype.toFixed(digits)`: the exact decimal value of the
/// double, rounded half UP at `digits` places (`(0.25).toFixed(1)` is `0.3`,
/// where Rust's `{:.1}` rounds half to even and prints `0.2`), and
/// `String(x)` from 1e21 up.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 || x.is_infinite() {
        return number_to_string(x);
    }
    let negative = x < 0.0;
    // 1100 places hold any double's exact expansion (at most 1074), so this
    // prints the value itself, unrounded.
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').expect("a fixed-point print has a point");
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    let rest = &frac.as_bytes()[digits..];
    if rest.first().is_some_and(|&d| d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let int_len = kept.len() - digits;
    let text = String::from_utf8(kept).expect("digits are ASCII");
    let body = if digits == 0 { text } else { format!("{}.{}", &text[..int_len], &text[int_len..]) };
    // `(-0.01).toFixed(1)` is `-0.0`: the sign is the input's, not the digits'.
    if negative { format!("-{body}") } else { body }
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
        Js::Undefined | Js::Null | Js::Function(_) => out.push_str("null"),
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
            let entries: Vec<_> = object.entries().iter().filter(|(_, v)| !matches!(v, Js::Undefined | Js::Function(_))).collect();
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
                out.proto = object.proto.clone();
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

    /// A reply's `"__proto__": null` leaves a record with no prototype at
    /// all: nothing is inherited, `__proto__` included (`undefined`, as
    /// `Object.create(null).__proto__` is), while `Object.prototype` is
    /// still found through an ordinary object.
    #[test]
    fn a_record_with_a_null_prototype_inherits_nothing() {
        let mut record = JsObject::new();
        record.assign("__proto__".into(), Js::Null);
        assert!(matches!(record.proto, Some(Js::Null)));
        for key in ["__proto__", "constructor", "toString", "x"] {
            assert!(matches!(plain_property(&record, key), Js::Undefined), "{key}");
        }
        let held = Rc::new(record);
        assert!(matches!(object_property(&held, "__proto__"), Js::Undefined));
        assert!(matches!(object_property(&held, "toString"), Js::Undefined));
        assert!(matches!(plain_property(&JsObject::new(), "toString"), Js::Function(_)));
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
    fn number_to_string_matches_javascript() {
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
            // A 17-digit tie: JavaScript prints the closer digits.
            (16086.196899414062, "16086.196899414062"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(*x), *want, "{x:?}");
        }
    }

    #[test]
    fn string_to_number_matches_javascript() {
        let cases: &[(&str, f64)] = &[
            ("", 0.0),
            ("   ", 0.0),
            ("  12 ", 12.0),
            ("1e3", 1000.0),
            ("0x10", 16.0),
            ("0X1f", 31.0),
            ("0o17", 15.0),
            ("0b101", 5.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+.5e1", 5.0),
            ("-12.25", -12.25),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("\u{a0}12\u{feff}", 12.0),
            ("0x1fffffffffffff1", 144115188075855860.0),
        ];
        for (s, want) in cases {
            assert_eq!(string_to_number(s), *want, "{s:?}");
        }
        for s in ["infinity", "inf", "nan", "NaN", "1_0", "-0x10", "0x", "1e", "e3", ".", "+", "12abc", "\u{85}12", "1 2"] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
        assert!(string_to_number("-0").is_sign_negative());
    }

    #[test]
    fn math_round_is_half_toward_positive_infinity() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(-2.6), -3.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert!(math_round(-0.4).is_sign_negative());
        assert_eq!(math_round(4503599627370497.0), 4503599627370497.0);
    }

    #[test]
    fn to_fixed_rounds_the_exact_value_half_up() {
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(1.45, 1), "1.4");
        assert_eq!(to_fixed(0.05, 1), "0.1");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(1.2, 1), "1.2");
        assert_eq!(to_fixed(1e21, 1), "1e+21");
    }

    #[test]
    fn strings_are_utf16_where_javascript_says_so() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_cmp("\u{FF61}", "😀"), Ordering::Greater);
        assert_eq!(trim("\u{FEFF} x \u{2028}"), "x");
        assert_eq!(trim("\u{85}x"), "\u{85}x");
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
