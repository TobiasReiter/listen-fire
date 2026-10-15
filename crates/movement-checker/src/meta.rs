//! The did-you-mean every closed-vocabulary diagnostic appends
//! (checker/meta.ts `didYouMean`, `closestByEditDistance`).

/// ` — did you mean 'x'?` when a close candidate exists, else nothing.
pub fn did_you_mean<S: AsRef<str>>(value: &str, candidates: &[S]) -> String {
    match closest_by_edit_distance(value, candidates) {
        Some(closest) => format!(" — did you mean '{closest}'?"),
        None => String::new(),
    }
}

/// The candidate closest to `value`, when it is within a third of the longer
/// length (at least 2) or one contains the other. Lengths and distances are
/// in UTF-16 units, as JavaScript counts them.
pub fn closest_by_edit_distance<'a, S: AsRef<str>>(value: &str, candidates: &'a [S]) -> Option<&'a str> {
    let mut best: Option<(&str, usize)> = None;
    for candidate in candidates {
        let candidate = candidate.as_ref();
        let distance = edit_distance(value, candidate);
        if best.is_none_or(|(_, d)| distance < d) {
            best = Some((candidate, distance));
        }
    }
    let (best, distance) = best?;
    let longer = js_len(value).max(js_len(best));
    if distance <= 2.max(longer / 3) || value.contains(best) || best.contains(value) {
        return Some(best);
    }
    None
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        curr[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev.clone_from(&curr);
    }
    prev[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_a_near_candidate_only() {
        assert_eq!(did_you_mean("onec", &["once", "ttl"]), " — did you mean 'once'?");
        assert_eq!(did_you_mean("schedule", &["once", "ttl"]), "");
        assert_eq!(closest_by_edit_distance("user_email", &["current_user_email"]), Some("current_user_email"));
    }
}
