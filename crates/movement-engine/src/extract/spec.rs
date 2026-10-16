//! A node declaration's extraction spec, as extraction.ts
//! `buildDeclarationSpec` builds it per firing for the extraction call.
//!
//! A spec is RESOLVED: every field is typed (a primitive, a declared `type`,
//! a type borrowed from a live instance schema, or untyped), every
//! description is text, and `extends` is folded in. Each description is
//! evaluated in the scope that wrote it (the declaring file, or the body that
//! declared the shape), and each declared field reads its own file's
//! `type`s. Nothing downstream reads the program's AST again.

use std::future::Future;
use std::pin::Pin;

use movement_parser::ast::{self, ExprSlot};
use movement_parser::catalog::types::{Composite, FieldType, InstanceSchema, Scalar};
use movement_parser::lowering::expression::{Expression, StaticValue};

use crate::executor::join_all;
use crate::program::{DeclaredShape, Declarations, DeclaringFile, FileDeclarations};

/// The root node's name and words (extraction.ts `ROOT_EXTRACT_DESCRIPTION`).
pub const ROOT_NAME: &str = "extract result";

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

/// Where a description is evaluated: the file that declared the words, or
/// the body that declared them (a shape declared in a body, or written in
/// place).
#[derive(Debug, Clone)]
pub enum WordsScope {
    File(DeclaringFile),
    Body(std::rc::Rc<crate::bindings::Scope>),
}

/// A node declaration as a use site resolves it: the declaration, the file
/// whose `type`s it reads, and the scope its words read.
#[derive(Debug, Clone)]
pub struct ShapeLink {
    pub declaration: ast::ShapeDeclaration,
    pub file: DeclaringFile,
    pub words: WordsScope,
}

impl ShapeLink {
    /// A declaration a file makes or imports: its words read its file.
    pub fn declared(shape: &DeclaredShape) -> ShapeLink {
        ShapeLink { declaration: shape.declaration.clone(), file: shape.file.clone(), words: WordsScope::File(shape.file.clone()) }
    }
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

    /// The base `name` an `extends` in `of` names (run.ts `shapeChain`):
    /// found where `of` was declared.
    fn base(&self, of: &ShapeLink, name: &str, declarations: &Declarations) -> Option<ShapeLink> {
        declarations.of_file(&of.file)?.shapes.get(name).map(ShapeLink::declared)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SpecError<E> {
    /// MOVENG_RUNTIME, the message without its code.
    Runtime(String),
    /// Evaluating a description failed.
    Firing(E),
}

/// `buildDeclarationSpec`: a declaration as the single-stage spec its inline
/// spelling builds, under the name `name` (the extraction call's form).
pub async fn build_declaration_spec<F: Firing>(
    name: &str,
    shape: &ShapeLink,
    declarations: &Declarations,
    firing: &F,
) -> Result<NodeSpec, SpecError<F::Error>> {
    let builder = Builder { declarations, firing };
    let chain = builder.chain(shape.clone())?;
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

    /// run.ts `shapeChain`: the `extends` chain from `shape` to the
    /// declaration that stands on its own, `shape` first — each base found
    /// in the file that names it.
    fn chain(&self, shape: ShapeLink) -> Result<Vec<ShapeLink>, SpecError<F::Error>> {
        let mut chain: Vec<ShapeLink> = Vec::new();
        let mut at = shape;
        loop {
            if chain.iter().any(|c| c.file == at.file && c.declaration.name == at.declaration.name) {
                return Err(SpecError::Runtime(format!("'{}' extends itself — the checker should have caught this", chain[0].declaration.name)));
            }
            let Some(base) = at.declaration.extends.clone() else {
                chain.push(at);
                return Ok(chain);
            };
            let found = self.firing.base(&at, &base.name, self.declarations);
            let next = found.ok_or_else(|| {
                SpecError::Runtime(format!(
                    "'{}' extends '{}', which is not a node declaration in scope — the checker should have caught this",
                    at.declaration.name, base.name
                ))
            })?;
            chain.push(std::mem::replace(&mut at, next));
        }
    }

    /// `buildDeclarationSpec` over a chain (`chain[0]` the declaration,
    /// each next one its base): the base's members first, then its own,
    /// and its words or else the base's — each part read in the file that
    /// wrote it.
    fn declaration<'b>(&'b self, name: &'b str, chain: &'b [ShapeLink]) -> Built<'b, F::Error, DeclaredNode>
    where
        'a: 'b,
    {
        Box::pin(async move {
            let link = &chain[0];
            let types = self.declarations.of_file(&link.file).ok_or_else(|| {
                let path = match &link.file {
                    DeclaringFile::Root => "the root file",
                    DeclaringFile::Library(path) => path,
                    DeclaringFile::Parked(_) => "parked code",
                };
                SpecError::Runtime(format!("the file \"{path}\" that declares '{}' is not linked", link.declaration.name))
            })?;
            let reading = Reading { words: link.words.clone(), types };
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

    /// `buildShapeNodeSpec`: one node of a declaration — its own words
    /// first, then its fields' together, then its children together.
    fn shape_node<'b>(&'b self, name: String, shape: &'b ast::ShapeNode, reading: Reading<'b>) -> Built<'b, F::Error, DeclaredNode>
    where
        'a: 'b,
    {
        Box::pin(async move {
            let description = self.describe_optional(shape.description.as_ref(), &reading).await?;
            let fields = join_all(
                shape
                    .fields
                    .iter()
                    .map(|field| {
                        let reading = reading.clone();
                        async move {
                            Ok(FieldSpec {
                                name: field.name.clone(),
                                type_: self.field_type(Some(&field.type_), &reading),
                                description: self.describe_optional(field.description.as_ref(), &reading).await?,
                                nullable: field.nullable == Some(true),
                            })
                        }
                    })
                    .collect(),
            )
            .await;
            let fields = settled(fields)?;
            let children = join_all(shape.children.iter().map(|child| self.shape_node(child.name.clone(), child, reading.clone())).collect()).await;
            let children = settled(children)?.into_iter().map(DeclaredNode::into_spec).collect();
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

/// `settledAll`'s answer once every one has settled: the values in order,
/// or the earliest one's failure.
fn settled<T, E>(outcomes: Vec<Result<T, E>>) -> Result<Vec<T>, E> {
    outcomes.into_iter().collect()
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
