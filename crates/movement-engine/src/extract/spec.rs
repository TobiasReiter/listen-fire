//! The extraction keyword's spec, as extraction.ts `buildExtractSpec` and
//! `buildDeclarationSpec` build it per firing, and the calls a
//! materialisation of it makes (`planRegion`).
//!
//! A spec is RESOLVED: every field is typed (a primitive, a declared `type`,
//! a type borrowed from a live instance schema, or untyped), every
//! description is text, and every `node x: <Shape>` is the inline tree its
//! declaration spells, `extends` folded in. Each description is evaluated in
//! the scope that wrote it — the firing for the extraction's own words, the
//! declaring file for a declaration's — and each declared field reads its
//! own file's `type`s. Nothing downstream reads the program's AST again.

use std::future::Future;
use std::pin::Pin;

use movement_parser::ast::{self, ExprSlot};
use movement_parser::catalog::types::{Composite, FieldType, InstanceSchema, Scalar};
use movement_parser::lowering::expression::{Expression, StaticValue};
use serde_json::{Value as Json, json};

use crate::program::{DeclaredShape, Declarations, DeclaringFile, FileDeclarations};

/// The root node's name and words (extraction.ts `ROOT_EXTRACT_DESCRIPTION`).
pub const ROOT_NAME: &str = "extract result";
pub const ROOT_DESCRIPTION: &str =
    "the relevant information in the provided source content (exactly one entity carrying the requested fields)";

#[derive(Debug, Clone, PartialEq)]
pub struct FieldSpec {
    pub name: String,
    pub description: String,
    /// The explicit annotation, resolved; `None` extracts untyped.
    pub type_: Option<FieldType>,
    /// `<text | null>`: the author's side only, the prompt never sees it.
    pub nullable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StageSpec {
    /// The pipeline that runs before this stage, per entity; the root's
    /// first stage's is the `from […] through […]` data pipeline.
    pub through: Vec<ast::PluginCall>,
    pub fields: Vec<FieldSpec>,
    pub children: Vec<NodeSpec>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeSpec {
    pub name: String,
    pub description: String,
    pub stages: Vec<StageSpec>,
    /// Every stage's field names in declaration order: once each for an
    /// inline node, as the declaration lists them for a declared one.
    pub exported: Vec<String>,
}

impl NodeSpec {
    /// `ExtractNodeSpec` as the TypeScript holds it.
    pub fn to_json(&self) -> Json {
        json!({
            "name": self.name,
            "description": self.description,
            "exported": self.exported,
            "stages": self.stages.iter().map(|stage| json!({
                "through": stage.through,
                "fields": stage.fields.iter().map(|field| {
                    let mut out = json!({ "name": field.name, "description": field.description });
                    if let Some(type_) = &field.type_ {
                        out["type"] = json!(type_);
                    }
                    if field.nullable {
                        out["nullable"] = json!(true);
                    }
                    out
                }).collect::<Vec<_>>(),
                "children": stage.children.iter().map(NodeSpec::to_json).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })
    }
}

/// Where a description is evaluated: the firing environment (the
/// extraction's own words), or the file that declared the words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WordsScope {
    Firing,
    File(DeclaringFile),
}

/// What only the firing knows: the live schemas a borrowed type resolves
/// against, and what a description that interpolates evaluates to.
pub trait Firing {
    type Error;

    /// The live schema of the instance `name` binds in the firing scope
    /// (run.ts `graphSchemaOf`): none for any other binding.
    fn instance_schema(&self, name: &str) -> Option<&InstanceSchema>;

    /// A description that is not a plain literal, as text (run.ts
    /// `describeIn`: a value that is not a string is `String(value ?? '')`).
    fn describe(&self, slot: &ExprSlot, scope: &WordsScope) -> impl Future<Output = Result<String, Self::Error>>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum SpecError<E> {
    /// MOVENG_RUNTIME, the message without its code.
    Runtime(String),
    /// Evaluating a description failed.
    Firing(E),
}

/// `buildExtractSpec`: the extraction's tree, resolved for this firing.
pub async fn build_extract_spec<F: Firing>(
    extract: &ast::ExtractExpression,
    declarations: &Declarations,
    firing: &F,
) -> Result<NodeSpec, SpecError<F::Error>> {
    let builder = Builder { declarations, firing };
    builder.node(ROOT_NAME.to_string(), ROOT_DESCRIPTION.to_string(), &extract.stages).await
}

/// `buildDeclarationSpec`: a declaration as the single-stage spec its inline
/// spelling builds, under the name `name` (the extraction call's form).
pub async fn build_declaration_spec<F: Firing>(
    name: &str,
    shape: &DeclaredShape,
    declarations: &Declarations,
    firing: &F,
) -> Result<NodeSpec, SpecError<F::Error>> {
    let builder = Builder { declarations, firing };
    let chain = builder.chain(shape)?;
    Ok(builder.declaration(name, &chain).await?.into_spec())
}

type Built<'a, E, T = NodeSpec> = Pin<Box<dyn Future<Output = Result<T, SpecError<E>>> + 'a>>;

/// A declaration's node as its inline spelling builds it: one stage.
struct DeclaredNode {
    name: String,
    description: String,
    exported: Vec<String>,
    stage: StageSpec,
}

impl DeclaredNode {
    fn into_spec(self) -> NodeSpec {
        NodeSpec { name: self.name, description: self.description, exported: self.exported, stages: vec![self.stage] }
    }
}

/// The scope one part of the tree reads: its words, and its `type`s.
#[derive(Clone)]
struct Reading<'a> {
    words: WordsScope,
    types: &'a FileDeclarations,
}

struct Builder<'a, F: Firing> {
    declarations: &'a Declarations,
    firing: &'a F,
}

impl<'a, F: Firing> Builder<'a, F> {
    fn firing_reading(&self) -> Reading<'a> {
        Reading { words: WordsScope::Firing, types: &self.declarations.root }
    }

    /// `buildNodeSpec`: an inline node, its words already resolved.
    fn node(&'a self, name: String, description: String, stages: &'a [ast::ExtractStage]) -> Built<'a, F::Error> {
        Box::pin(async move {
            let reading = self.firing_reading();
            let mut exported: Vec<String> = Vec::new();
            for field in stages.iter().flat_map(|stage| &stage.fields) {
                if !exported.contains(&field.name) {
                    exported.push(field.name.clone());
                }
            }
            let mut built = Vec::with_capacity(stages.len());
            for stage in stages {
                let mut fields = Vec::with_capacity(stage.fields.len());
                for field in &stage.fields {
                    fields.push(FieldSpec {
                        name: field.name.clone(),
                        description: self.describe(&field.description, &reading).await?,
                        type_: self.field_type(field.type_.as_deref(), &reading),
                        nullable: field.nullable == Some(true),
                    });
                }
                let mut children = Vec::with_capacity(stage.children.len());
                for child in &stage.children {
                    children.push(match child {
                        ast::ExtractNode::Inline(child) => {
                            let words = self.describe(&child.description, &reading).await?;
                            self.node(child.name.clone(), words, &child.stages).await?
                        }
                        ast::ExtractNode::Declared(child) => self.declared_node(child).await?,
                    });
                }
                built.push(StageSpec { through: stage.through.clone().unwrap_or_default(), fields, children });
            }
            Ok(NodeSpec { name, description, stages: built, exported })
        })
    }

    /// `buildDeclaredNodeSpec`: `node x: <Shape> "…" through […] { … }` —
    /// the declaration as the first stage, the stages written after it
    /// following, and the use site's words over the declaration's.
    fn declared_node(&'a self, node: &'a ast::DeclaredExtractNode) -> Built<'a, F::Error> {
        Box::pin(async move {
            let Some(shape) = self.declarations.root.shapes.get(&node.declared.type_) else {
                return Err(SpecError::Runtime(format!(
                    "'{}' is not a node declaration in scope, so '{}' has no shape to extract (the checker should have caught this)",
                    node.declared.type_, node.name
                )));
            };
            let chain = self.chain(shape)?;
            let declared = self.declaration(&node.name, &chain).await?.into_spec();
            let following = self.node(node.name.clone(), String::new(), &node.stages).await?;
            let description = match &node.description {
                Some(slot) => self.describe(slot, &self.firing_reading()).await?,
                None => declared.description,
            };
            let mut exported = declared.exported;
            for name in following.exported {
                if !exported.contains(&name) {
                    exported.push(name);
                }
            }
            let mut stages = declared.stages;
            stages.extend(following.stages);
            Ok(NodeSpec { name: node.name.clone(), description, stages, exported })
        })
    }

    /// run.ts `shapeChain`: the `extends` chain from `shape` to the
    /// declaration that stands on its own, `shape` first — each base found
    /// in the file that names it.
    fn chain(&self, shape: &'a DeclaredShape) -> Result<Vec<&'a DeclaredShape>, SpecError<F::Error>> {
        let mut chain: Vec<&'a DeclaredShape> = Vec::new();
        let mut at = shape;
        loop {
            if chain.iter().any(|c| c.file == at.file && c.declaration.name == at.declaration.name) {
                return Err(SpecError::Runtime(format!("'{}' extends itself — the checker should have caught this", shape.declaration.name)));
            }
            chain.push(at);
            let Some(base) = &at.declaration.extends else { return Ok(chain) };
            let found = self.declarations.of_file(&at.file).and_then(|file| file.shapes.get(&base.name));
            at = found.ok_or_else(|| {
                SpecError::Runtime(format!(
                    "'{}' extends '{}', which is not a node declaration in scope — the checker should have caught this",
                    at.declaration.name, base.name
                ))
            })?;
        }
    }

    /// `buildDeclarationSpec` over a chain (`chain[0]` the declaration,
    /// each next one its base): the base's members first, then its own,
    /// and its words or else the base's — each part read in the file that
    /// wrote it.
    fn declaration(&'a self, name: &'a str, chain: &'a [&'a DeclaredShape]) -> Built<'a, F::Error, DeclaredNode> {
        Box::pin(async move {
            let link = chain[0];
            let types = self.declarations.of_file(&link.file).ok_or_else(|| {
                let path = match &link.file {
                    DeclaringFile::Root => "the root file",
                    DeclaringFile::Library(path) => path,
                };
                SpecError::Runtime(format!("the file \"{path}\" that declares '{}' is not linked", link.declaration.name))
            })?;
            let reading = Reading { words: WordsScope::File(link.file.clone()), types };
            let own = self.shape_node(name.to_string(), &link.declaration.root, reading).await?;
            let Some(rest) = chain.get(1..).filter(|rest| !rest.is_empty()) else { return Ok(own) };
            let base = self.declaration(name, rest).await?;
            let description = if link.declaration.root.description.is_some() { own.description } else { base.description };
            let mut exported = base.exported;
            exported.extend(own.exported);
            let mut fields = base.stage.fields;
            fields.extend(own.stage.fields);
            let mut children = base.stage.children;
            children.extend(own.stage.children);
            Ok(DeclaredNode { name: name.to_string(), description, exported, stage: StageSpec { through: Vec::new(), fields, children } })
        })
    }

    /// `buildShapeNodeSpec`: one node of a declaration.
    fn shape_node(&'a self, name: String, shape: &'a ast::ShapeNode, reading: Reading<'a>) -> Built<'a, F::Error, DeclaredNode> {
        Box::pin(async move {
            let description = self.describe_optional(shape.description.as_ref(), &reading).await?;
            let mut fields = Vec::with_capacity(shape.fields.len());
            for field in &shape.fields {
                fields.push(FieldSpec {
                    name: field.name.clone(),
                    description: self.describe_optional(field.description.as_ref(), &reading).await?,
                    type_: self.field_type(Some(&field.type_), &reading),
                    nullable: field.nullable == Some(true),
                });
            }
            let mut children = Vec::with_capacity(shape.children.len());
            for child in &shape.children {
                children.push(self.shape_node(child.name.clone(), child, reading.clone()).await?.into_spec());
            }
            Ok(DeclaredNode {
                name,
                description,
                exported: shape.fields.iter().map(|f| f.name.clone()).collect(),
                stage: StageSpec { through: Vec::new(), fields, children },
            })
        })
    }

    /// `describeSlot`: a plain literal is its text; anything else is the
    /// firing's to evaluate, in the scope that wrote it.
    async fn describe(&self, slot: &ExprSlot, reading: &Reading<'_>) -> Result<String, SpecError<F::Error>> {
        let invalid = |message: String| SpecError::Runtime(format!("invalid extract description (the checker should have caught this): {message}"));
        let tree = movement_parser::expr::parse_expression(&slot.raw).map_err(|e| invalid(format!("{e:?}")))?;
        let expression = movement_parser::lowering::lower_expression(&tree, &slot.raw).map_err(|e| invalid(format!("{e:?}")))?;
        match expression {
            Expression::Static { value } => Ok(match value {
                StaticValue::String(text) => text,
                StaticValue::Number(n) => crate::js::number_to_string(n.0),
                StaticValue::Bool(b) => b.to_string(),
                StaticValue::Null => String::new(),
            }),
            _ => self.firing.describe(slot, &reading.words).await.map_err(SpecError::Firing),
        }
    }

    /// `describeOptional`: an undescribed declared field is extracted by its
    /// name alone.
    async fn describe_optional(&self, slot: Option<&ExprSlot>, reading: &Reading<'_>) -> Result<String, SpecError<F::Error>> {
        match slot {
            Some(slot) => self.describe(slot, reading).await,
            None => Ok(String::new()),
        }
    }

    /// `resolveFieldType`: explicit annotations only — a primitive name, a
    /// `type` the reading file declares, or `<instance>.<root>.<field>`
    /// borrowed from the instance's live schema.
    fn field_type(&self, written: Option<&str>, reading: &Reading<'_>) -> Option<FieldType> {
        let written = written?;
        if !written.contains('.') {
            return primitive(written).or_else(|| {
                reading.types.types.get(written).map(|options| FieldType::Composite(Composite::Enum { options: options.clone(), open: None }))
            });
        }
        let segments: Vec<&str> = written.split('.').collect();
        let [instance, root, field] = segments.as_slice() else { return None };
        borrowable_field(self.firing.instance_schema(instance)?, root, field)
    }
}

/// `parseFieldTypeName`.
fn primitive(name: &str) -> Option<FieldType> {
    let scalar = match name {
        "text" => Scalar::Text,
        "number" => Scalar::Number,
        "boolean" => Scalar::Boolean,
        "date" => Scalar::Date,
        "datetime" => Scalar::Datetime,
        "file" => Scalar::File,
        "json" => Scalar::Json,
        _ => return None,
    };
    Some(FieldType::Scalar(scalar))
}

/// `resolveBorrowedField`: the root's writable field, else the position's
/// property of that name (writable wins: select options live there).
pub fn borrowable_field(schema: &InstanceSchema, root: &str, field: &str) -> Option<FieldType> {
    let writable = schema.writable_roots.get(root).and_then(|r| r.fields.get(field));
    let readable = schema.positions.get(root).and_then(|p| p.properties.get(field));
    writable.or(readable).cloned()
}

// ── The calls a materialisation makes ────────────────────────────────────────

/// One planned model call (extraction.ts `CallSite`): a node's stage, and the
/// through-free descendants batched into the same call.
#[derive(Debug, Clone)]
pub struct Region<'s> {
    pub site_id: String,
    pub spec: &'s NodeSpec,
    pub stage_index: usize,
    /// Exactly one entity: the root, a node's continuation stage.
    pub single: bool,
    pub children: Vec<Region<'s>>,
}

impl<'s> Region<'s> {
    /// `planRegion`: the region at `spec`'s stage `stage_index`, its sites
    /// numbered by `next_site` as they are reached — its own first, then its
    /// unfenced children depth first. A fenced child (its first stage behind
    /// a pipeline) is a call of its own, planned by whoever runs the fence.
    pub fn plan(spec: &'s NodeSpec, stage_index: usize, single: bool, next_site: &mut dyn FnMut() -> u64) -> Region<'s> {
        // TypeScript also refuses a region rooted at a fenced first stage it
        // was not told to skip; every caller of either plans the stage behind
        // a fence only once the fence has run, and the children here are
        // filtered to the unfenced, so the refusal guards nothing.
        let site_id = format!("x:{}#{}", sanitize_site_name(&spec.name), next_site());
        let children = spec.stages[stage_index]
            .children
            .iter()
            .filter(|child| child.stages.first().is_none_or(|stage| stage.through.is_empty()))
            .map(|child| Region::plan(child, 0, false, next_site))
            .collect();
        Region { site_id, spec, stage_index, single, children }
    }

    /// The fields this call asks for: its stage's.
    pub fn fields(&self) -> &'s [FieldSpec] {
        &self.spec.stages[self.stage_index].fields
    }

    /// `countSites`: what the density heuristic picks a model by.
    pub fn sites(&self) -> usize {
        1 + self.children.iter().map(Region::sites).sum::<usize>()
    }

    /// `declaredKeys`: every key one of this node's records may carry.
    pub fn declares(&self, key: &str) -> bool {
        self.fields().iter().any(|f| f.name == key) || self.children.iter().any(|c| c.spec.name == key)
    }

    pub fn declares_nothing(&self) -> bool {
        self.fields().is_empty() && self.children.is_empty()
    }
}

/// `sanitizeSiteName`: lower case, every run of anything but `a-z0-9` one
/// `_`, none at either end, at most 40 characters.
pub fn sanitize_site_name(name: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push('_');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out.truncate(40);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_names_sanitise_as_the_typescript_does() {
        assert_eq!(sanitize_site_name("extract result"), "extract_result");
        assert_eq!(sanitize_site_name("  Big--Co!! "), "big_co");
        assert_eq!(sanitize_site_name("Ünï"), "n");
        assert_eq!(sanitize_site_name("___"), "");
        assert_eq!(sanitize_site_name(&"a".repeat(50)), "a".repeat(40));
    }
}
