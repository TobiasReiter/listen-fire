import { linesStartingInString, tokenizeDocument, type MvtToken } from "../movement-language";

// The user's SyncToAttio script — the regression fixture for statement
// keyword highlighting (listen/to/fire after a top-level `}`, `as`
// inside an import clause, extract trees, traversals).
const SYNC_TO_ATTIO = `# Sync companies mentioned in Slack to Attio

import { slack, attio } from adapters
import { slack_team, attio as AttioCred } from credentials

slackSource = slack(credentials: slack_team)
crm = attio(credentials: AttioCred)

movement SyncToAttio(item: <slackSource-[:message]->>) {
  mentioned = extract from [item.\`text\`] {
    node company: "each company mentioned in the message" {
      name: "the company's name"
    }
  }

  mentioned-[c:company]-> {
    write crm-[:company]-> {
      unique by (\`name\`)
      name: c-[:company]->.\`name\`
    }
  }
}

listen to slackSource fire SyncToAttio
`;

// Statement keywords in the gnarlier state-machine positions: after a
// multiline string binding, around `\${…}` interpolation islands, and in
// node/if/parallel/through/run clauses.
const FULL_SPAN = `import { email, slack } from adapters
import { dealflow_inbox, acme_workspace as TeamCred } from credentials
import { files_to_dropbox, Files } from "lib/file-routines"

inbox = email(credentials: dealflow_inbox)
team  = slack(credentials: TeamCred)

company_prompt = "the company name this email is about.
  Prefer the legal entity name over the brand name;
  ignore the sender's own firm."

node Deal {
  name: <text>
  node participants {
    name: <text>
  }
}

movement dealflow_intake(msg: <inbox-[:message]->>) {
  deals = extract from [msg.\`text\`] through [scrub_sensitive] {
    node company: "each company seeking investment" {
      name: "the company's name"
    }
  }

  if msg.\`subject\` CONTAINS "deal" {
    parallel {
      write team-[:message]-> {
        channel: "#dealflow"
        text: "New deal from \${msg-[:sender]->.\`name\`}: \${COUNT(deals-[:company]->)}"
      }
      files_to_dropbox(f: msg)
    }
  } else {
    edge champion -[:led]-> part
  }
}

listen to inbox fire dealflow_intake
`;

function styleOf(tokens: MvtToken[][], text: string, line: number): string | null {
  const hit = tokens[line].find((t) => t.text.trim() === text);
  if (!hit) throw new Error(`No token "${text}" on line ${line}: ${JSON.stringify(tokens[line])}`);
  return hit.style;
}

describe("movement language tokenizer", () => {
  const tokens = tokenizeDocument(SYNC_TO_ATTIO);

  it("colours single-quoted strings as strings, equivalently to double", () => {
    const toks = tokenizeDocument(`a = 'foo'\nb = "bar"\nc = "it's fine"`);
    const stringText = (line: number) =>
      toks[line].filter((t) => t.style === "string").map((t) => t.text).join("");
    expect(stringText(0)).toContain("foo"); // single-quoted reads as a string
    expect(stringText(1)).toContain("bar");
    expect(stringText(2)).toContain("it's fine"); // a ' inside a "…" doesn't close it
  });

  it("highlights every statement keyword position in the fixture", () => {
    expect(styleOf(tokens, "import", 2)).toBe("keyword");
    expect(styleOf(tokens, "from", 2)).toBe("keyword");
    expect(styleOf(tokens, "as", 3)).toBe("keyword");
    expect(styleOf(tokens, "movement", 8)).toBe("keyword");
    expect(styleOf(tokens, "extract", 9)).toBe("keyword");
    expect(styleOf(tokens, "from", 9)).toBe("keyword");
    expect(styleOf(tokens, "node", 10)).toBe("keyword");
    expect(styleOf(tokens, "write", 16)).toBe("keyword");
    expect(styleOf(tokens, "unique", 17)).toBe("keyword");
    expect(styleOf(tokens, "by", 17)).toBe("keyword");
    expect(styleOf(tokens, "listen", 23)).toBe("keyword");
    expect(styleOf(tokens, "to", 23)).toBe("keyword");
    expect(styleOf(tokens, "fire", 23)).toBe("keyword");
  });

  it("classifies non-keyword tokens on the listen line as plain names", () => {
    expect(styleOf(tokens, "slackSource", 23)).toBe("variableName");
    expect(styleOf(tokens, "SyncToAttio", 23)).toBe("variableName");
  });

  it("highlights type markers distinctly — an address marker's root reads as the type name", () => {
    // `<slackSource-[:message]->>` — the root is the type name; the hop
    // highlights as traversal punctuation (an address IS a walk).
    expect(styleOf(tokens, "<slackSource", 8)).toBe("typeName");
    expect(styleOf(tokens, "-[", 8)).toBe("angleBracket");
    // A single-name marker stays one token.
    const scalar = tokenizeDocument("movement m(x: <number>) {\n}\n");
    expect(styleOf(scalar, "<number>", 0)).toBe("typeName");
    // `<text | null>` is one marker too, as written.
    const nullable = tokenizeDocument('  name: <text | null> "the name"\n');
    expect(styleOf(nullable, "<text | null>", 0)).toBe("typeName");
  });

  describe("full-span fixture (multiline strings, interpolation, every statement clause)", () => {
    const full = tokenizeDocument(FULL_SPAN);

    it("keeps highlighting keywords after a multiline string binding", () => {
      expect(styleOf(full, "node", 11)).toBe("keyword");
      expect(styleOf(full, "node", 13)).toBe("keyword");
      expect(styleOf(full, "movement", 18)).toBe("keyword");
    });

    it("highlights as/through/if/parallel/write/else/listen/to/fire", () => {
      expect(styleOf(full, "as", 1)).toBe("keyword");
      expect(styleOf(full, "extract", 19)).toBe("keyword");
      expect(styleOf(full, "from", 19)).toBe("keyword");
      expect(styleOf(full, "through", 19)).toBe("keyword");
      expect(styleOf(full, "if", 25)).toBe("keyword");
      expect(styleOf(full, "parallel", 26)).toBe("keyword");
      expect(styleOf(full, "write", 27)).toBe("keyword");
      expect(styleOf(full, "else", 33)).toBe("keyword");
      // `shape` and `edge` are retired from the grammar, so they read as
      // ordinary names — the highlighter follows the language.
      expect(styleOf(full, "edge", 34)).toBe("variableName");
      expect(styleOf(full, "listen", 38)).toBe("keyword");
      expect(styleOf(full, "to", 38)).toBe("keyword");
      expect(styleOf(full, "fire", 38)).toBe("keyword");
    });

    it("treats multiline string continuation lines as string, and resumes code after", () => {
      expect(full[8].every((t) => t.style === "string")).toBe(true);
      expect(full[9][0].style).toBe("string");
    });

    it("tokenizes interpolation islands as code and closes them", () => {
      const line = full[29];
      expect(line.some((t) => t.text === "msg" && t.style === "variableName")).toBe(true);
      expect(line.some((t) => t.text === "COUNT" && t.style === "macroName")).toBe(true);
      // A backtick-quoted name is just a whitespace-safe identifier — it
      // highlights the same as a bare one (variableName), not a distinct color.
      expect(line.some((t) => t.text === "`name`" && t.style === "variableName")).toBe(true);
      // The line after the interpolated string is back to plain statement mode.
      expect(styleOf(full, "files_to_dropbox", 31)).toBe("variableName");
    });

    it("keeps UPPERCASE expression keywords distinct", () => {
      expect(styleOf(full, "CONTAINS", 25)).toBe("operatorKeyword");
    });
  });

  // Henry's reply-card prompt: a continuation line that opens with `> ` and
  // then an interpolation, a blank line, and a closing line that is mostly
  // interpolation.
  describe("multi-line string with interpolation (reply card)", () => {
    const REPLY_CARD = `write head-[:Replies]-> {
  Message: "Nemo's take:
> \${o.take}

\${card}"
}`;
    const card = tokenizeDocument(REPLY_CARD);
    const DELIM = "interpolationDelimiter";

    it("styles every string character on a continuation line as string, up to the delimiter", () => {
      // `> ` used to ride along inside the `${` token and lose the string style.
      expect(card[2][0]).toEqual({ text: "> ", style: "string" });
      expect(card[2][1]).toEqual({ text: "${", style: DELIM });
    });

    it("makes `${` and `}` delimiter tokens, never merged with neighbouring text", () => {
      for (const line of [card[2], card[4]]) {
        expect(line.filter((t) => t.style === DELIM).map((t) => t.text)).toEqual(["${", "}"]);
      }
      expect(card[4][card[4].length - 1]).toEqual({ text: '"', style: "string" });
    });

    it("tokenizes the expression inside `${…}` as code, not string", () => {
      expect(card[2].slice(2, 5)).toEqual([
        { text: "o", style: "variableName" },
        { text: ".", style: "punctuation" },
        { text: "take", style: "variableName" },
      ]);
      expect(card[4][1]).toEqual({ text: "card", style: "variableName" });
      const inner = [...card[2].slice(2, -1), card[4][1]];
      expect(inner.some((t) => t.style === "string")).toBe(false);
    });

    it("resumes code after the string closes", () => {
      expect(card[5]).toEqual([{ text: "}", style: "punctuation" }]);
    });

    it("marks every line that starts inside the string (blank and closing lines too) for the line wash", () => {
      expect(linesStartingInString(REPLY_CARD)).toEqual([false, false, true, true, true, false]);
    });

    it("does not wash the line after a single-line string", () => {
      expect(linesStartingInString('a = 1\nb = "x"\nc = 2')).toEqual([false, false, false]);
    });
  });

  it("tokenizes the @old hop label like a declared edge name", () => {
    const toks = tokenizeDocument("was = FIRST(org-[:@old]->)");
    expect(styleOf(toks, "@old", 0)).toBe(styleOf(tokenizeDocument("was = FIRST(org-[:message]->)"), "message", 0));
  });

  it("leaves `@x` outside a hop label an atom", () => {
    expect(styleOf(tokenizeDocument("k:@x"), "@x", 0)).toBe("atom");
  });

  // The keyword lists were hand-copied from the syntax sketch and drifted from
  // the parser's actual keyword set — `await`/`lazy` (and several others) were
  // never added. This pins the full sweep against parse.ts's own recognition.
  describe("keyword-list sweep against the parser's actual keywords", () => {
    it("highlights `await` and `lazy` (the reported gap)", () => {
      expect(styleOf(tokenizeDocument("x = await y-[:e]->"), "await", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("x = lazy y-[:e]->"), "lazy", 0)).toBe("keyword");
    });

    it("highlights the rest of the missing statement keywords", () => {
      expect(styleOf(tokenizeDocument("export movement m() {}"), "export", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("function m() {}"), "function", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("link a -[:e]-> b"), "link", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("x = match a-[:e]-> { unique by (`n`) }"), "match", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("unlink a -[:e]-> b"), "unlink", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("delete a"), "delete", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("refresh a"), "refresh", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("race({ x = 1 }, { x = 2 })"), "race", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("cb = callback({})"), "callback", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument('write a bind src { name: "x" }'), "bind", 0)).toBe(
        "keyword",
      );
      expect(styleOf(tokenizeDocument("x = await sleep(4h)"), "sleep", 0)).toBe("keyword");
      expect(styleOf(tokenizeDocument("x = await until(true)"), "until", 0)).toBe("keyword");
    });

    it("highlights the ERROR statement as a keyword, not a stdlib macro", () => {
      expect(styleOf(tokenizeDocument('ERROR("failed")'), "ERROR", 0)).toBe("operatorKeyword");
    });

    it("still treats retired words (shape, edge, run) as ordinary names — the highlighter follows the language", () => {
      expect(styleOf(tokenizeDocument("shape = 1"), "shape", 0)).toBe("variableName");
      expect(styleOf(tokenizeDocument("run = 1"), "run", 0)).toBe("variableName");
    });
  });
});
