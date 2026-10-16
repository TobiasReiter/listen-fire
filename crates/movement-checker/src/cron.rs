//! Five-field cron schedules as the checker judges them: the validity half
//! of packages/shared/cron (`cronScheduleError`), which the scheduler shares,
//! so a schedule this accepts is one the scheduler can run.

struct Field {
    name: &'static str,
    min: u32,
    max: u32,
    names: &'static [(&'static str, u32)],
}

const MONTH_NAMES: &[(&str, u32)] = &[
    ("jan", 1), ("feb", 2), ("mar", 3), ("apr", 4), ("may", 5), ("jun", 6),
    ("jul", 7), ("aug", 8), ("sep", 9), ("oct", 10), ("nov", 11), ("dec", 12),
];

const DOW_NAMES: &[(&str, u32)] = &[("sun", 0), ("mon", 1), ("tue", 2), ("wed", 3), ("thu", 4), ("fri", 5), ("sat", 6)];

const FIELDS: [Field; 5] = [
    Field { name: "minute", min: 0, max: 59, names: &[] },
    Field { name: "hour", min: 0, max: 23, names: &[] },
    Field { name: "day of month", min: 1, max: 31, names: &[] },
    Field { name: "month", min: 1, max: 12, names: MONTH_NAMES },
    Field { name: "day of week", min: 0, max: 7, names: DOW_NAMES },
];

/// Why `expression` is not a schedule, or `None` when it is one.
pub fn cron_schedule_error(expression: &str) -> Option<String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return Some(format!("a schedule has five fields (minute hour day-of-month month day-of-week), got {}", js_field_count(expression)));
    }
    fields.iter().zip(FIELDS.iter()).find_map(|(text, spec)| parse_field(text, spec).err())
}

/// `expression.trim().split(/\s+/).length`: an empty schedule is one field.
fn js_field_count(expression: &str) -> usize {
    expression.split_whitespace().count().max(1)
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn parse_value(token: &str, spec: &Field) -> Result<u32, String> {
    let lower = token.to_lowercase();
    if let Some((_, value)) = spec.names.iter().find(|(name, _)| *name == lower) {
        return Ok(*value);
    }
    if !is_digits(token) {
        let or_name = if spec.names.is_empty() { "" } else { " or a name" };
        return Err(format!("'{token}' is not a valid {} value (expected a number{or_name})", spec.name));
    }
    let value: f64 = token.parse().unwrap_or(f64::INFINITY);
    if value < f64::from(spec.min) || value > f64::from(spec.max) {
        return Err(format!("{} value {} is out of range ({}-{})", spec.name, movement_parser::util::js::number_to_string(value), spec.min, spec.max));
    }
    Ok(value as u32)
}


fn parse_field(field: &str, spec: &Field) -> Result<(), String> {
    for part in field.split(',') {
        if part.is_empty() {
            return Err(format!("empty entry in the {} field", spec.name));
        }
        let pieces: Vec<&str> = part.split('/').collect();
        if pieces.len() > 2 {
            return Err(format!("'{part}' has more than one '/' in the {} field", spec.name));
        }
        if let Some(step) = pieces.get(1)
            && (!is_digits(step) || step.bytes().all(|b| b == b'0'))
        {
            return Err(format!("'/{step}' is not a valid step in the {} field", spec.name));
        }
        let range = pieces[0];
        if range == "*" {
            continue;
        }
        if range.contains('-') {
            let ends: Vec<&str> = range.split('-').collect();
            if ends.len() > 2 || ends[0].is_empty() || ends[1].is_empty() {
                return Err(format!("'{range}' is not a valid range in the {} field", spec.name));
            }
            let (lo, hi) = (parse_value(ends[0], spec)?, parse_value(ends[1], spec)?);
            if lo > hi {
                return Err(format!("range {lo}-{hi} runs backwards in the {} field", spec.name));
            }
        } else {
            parse_value(range, spec)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::cron_schedule_error;

    #[test]
    fn judges_schedules_as_the_scheduler_does() {
        assert_eq!(cron_schedule_error("0 9 * * 1"), None);
        assert_eq!(cron_schedule_error("*/15 9-17 * jan-mar mon-fri"), None);
        assert_eq!(cron_schedule_error("0 9 * *").as_deref(), Some("a schedule has five fields (minute hour day-of-month month day-of-week), got 4"));
        assert_eq!(cron_schedule_error("61 9 * * 1").as_deref(), Some("minute value 61 is out of range (0-59)"));
        assert_eq!(cron_schedule_error("0 9 * * funday").as_deref(), Some("'funday' is not a valid day of week value (expected a number or a name)"));
        assert_eq!(cron_schedule_error("5-1 9 * * 1").as_deref(), Some("range 5-1 runs backwards in the minute field"));
    }
}
