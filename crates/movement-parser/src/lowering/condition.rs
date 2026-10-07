//! An `if` condition: its top-level `AND` conjuncts, each an `IS` type
//! guard or an expression (lower.ts `MovementCondition`).

use serde::Serialize;

use super::expression::Expression;
use super::{Lowered, Lowering, TOP, contains_is, js, plain_identifier, refuse};
use crate::tree::{Arrow, BinaryOp, Direction, MExpr, TypeExpr};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum MovementCondition {
    #[serde(rename = "and")]
    And { conjuncts: Vec<MovementCondition> },
    #[serde(rename = "isTest")]
    IsTest {
        #[serde(rename = "subjectRaw")]
        subject_raw: String,
        #[serde(rename = "type")]
        type_: IsType,
    },
    #[serde(rename = "expr")]
    Expr { expr: Expression },
}

/// `position`: the single unpinned hop's name (`<crm-[:company]->>`).
/// `hopsRaw`: the raw hop text when the marker carries a WHERE — an event
/// ADDRESS, resolved by the checker/engine via `eventAddressOfHops`. Exactly
/// one of the two is set for a hop-form marker; neither for `<graph>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IsType {
    pub graph: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(rename = "hopsRaw", skip_serializing_if = "Option::is_none")]
    pub hops_raw: Option<String>,
}

const IS_EXPECTS: &str = "IS expects a position type in angle brackets like <graph> or <graph-[:position]->>";

impl Lowering {
    pub(super) fn condition(&self, expr: &MExpr) -> Lowered<MovementCondition> {
        let mut conjuncts: Vec<&MExpr> = Vec::new();
        split(expr, &mut conjuncts);
        let mut lowered = conjuncts.into_iter().map(|c| self.conjunct(c)).collect::<Lowered<Vec<_>>>()?;
        Ok(if lowered.len() == 1 { lowered.remove(0) } else { MovementCondition::And { conjuncts: lowered } })
    }

    fn conjunct(&self, expr: &MExpr) -> Lowered<MovementCondition> {
        if let MExpr::Is { subject, type_, .. } = expr {
            // A name is spelled from the tree: a nested call's bound name
            // stands where the call's text is (checker/nested_calls.ts).
            let subject_raw = match subject.as_ref() {
                MExpr::Name { name, .. } if name.quoted => format!("`{}`", name.text),
                MExpr::Name { name, .. } => name.text.clone(),
                subject => {
                    let at = subject.at();
                    js::trim(&self.slice(at.start, at.end))
                }
            };
            return Ok(MovementCondition::IsTest { subject_raw, type_: self.is_type(type_)? });
        }
        if contains_is(expr) {
            return refuse(
                "IS type tests under OR/NOT (or nested in parentheses) are not yet supported — use IS only as a top-level AND conjunct",
            );
        }
        Ok(MovementCondition::Expr { expr: self.lower(expr, TOP)? })
    }

    /// An IS marker: `<graph>`, `<graph-[:position]->>` (one plain hop), or
    /// an ADDRESS kept as its raw hop text for `eventAddressOfHops`.
    fn is_type(&self, type_: &TypeExpr) -> Lowered<IsType> {
        let TypeExpr::Named { name, hops, field: None, array: false, .. } = type_ else {
            return refuse(IS_EXPECTS);
        };
        let graph = name.text.clone();
        let (Some(first), Some(last)) = (hops.first(), hops.last()) else {
            return Ok(IsType { graph, position: None, hops_raw: None });
        };
        if first.direction != Direction::Out || last.arrow != Arrow::Full {
            return refuse(IS_EXPECTS);
        }
        let plain = hops.len() == 1
            && first.alias.is_none()
            && first.where_.is_none()
            && first.config.is_none()
            && first.order_by.is_none()
            && first.limit.is_none()
            && (first.label.quoted || plain_identifier(&first.label.text));
        if plain {
            return Ok(IsType { graph, position: Some(first.label.text.clone()), hops_raw: None });
        }
        Ok(IsType { graph, position: None, hops_raw: Some(self.slice(first.at.start, last.at.end)) })
    }
}

fn split<'a>(e: &'a MExpr, out: &mut Vec<&'a MExpr>) {
    match e {
        MExpr::Binary { op: BinaryOp::And, left, right, .. } => {
            split(left, out);
            split(right, out);
        }
        e => out.push(e),
    }
}
