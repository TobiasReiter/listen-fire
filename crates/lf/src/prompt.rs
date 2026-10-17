//! Questions on the terminal for `lf connect` and `lf credential`, as the
//! TypeScript lf asks them (apps/cli/src/prompt.ts). Answers are read a line
//! at a time, so a script (or a test) can pipe them in; on a terminal a
//! secret's answer is not echoed.

use std::io::{IsTerminal, Write};
use std::process::{Command, Stdio};

use tokio::io::{AsyncBufReadExt, BufReader, Lines, Stdin};

#[derive(Default, Clone, Copy)]
pub struct Ask<'a> {
    /// Shown after the question when the answer may be left empty.
    pub default: Option<&'a str>,
    /// Not echoed on a terminal.
    pub secret: bool,
    /// An empty answer is accepted (as the default, else '').
    pub optional: bool,
}

pub struct Prompter {
    lines: Lines<BufReader<Stdin>>,
    terminal: bool,
}

const INPUT_ENDED: &str = "the input ended before every question was answered";

impl Prompter {
    pub fn terminal() -> Prompter {
        Prompter { lines: BufReader::new(tokio::io::stdin()).lines(), terminal: std::io::stdin().is_terminal() }
    }

    pub async fn ask(&mut self, question: &str, ask: Ask<'_>) -> Result<String, String> {
        loop {
            let hint = match (ask.default, ask.optional) {
                (Some(_), _) if ask.secret => " [enter keeps the current one]".to_string(),
                (Some(default), _) => format!(" [{default}]"),
                (None, true) => " [optional]".to_string(),
                (None, false) => String::new(),
            };
            write_out(&format!("{question}{hint}: "));
            let muted = self.terminal && ask.secret && echo(false);
            let line = self.lines.next_line().await;
            if muted {
                echo(true);
                write_out("\n");
            }
            let answer = line.map_err(|e| e.to_string())?.ok_or(INPUT_ENDED)?.trim().to_string();
            if !self.terminal {
                write_out("\n");
            }
            if !answer.is_empty() {
                return Ok(answer);
            }
            if let Some(default) = ask.default {
                return Ok(default.to_string());
            }
            if ask.optional {
                return Ok(String::new());
            }
            write_out("an answer is needed\n");
        }
    }

    /// A line of progress, between questions.
    pub fn print(&self, line: &str) {
        write_out(&format!("{line}\n"));
    }
}

fn write_out(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// The terminal's echo on or off; false when it could not be changed.
fn echo(on: bool) -> bool {
    Command::new("stty").arg(if on { "echo" } else { "-echo" }).stdin(Stdio::inherit()).status().is_ok_and(|s| s.success())
}
