/**
 * Provisioner for the live combinator-cancellation e2e: a `race` whose one arm
 * awaits an ask response and whose other is a SHORT sleep, so both outcomes are
 * drivable inside a dev-loop session (the handbook's 2d timeout is not).
 *
 * The point of the short timer is the LOSER'S PARK. When the timer wins, the
 * ask arm's park has to be withdrawn — and the only honest proof is that a LATE
 * answer to that ask resumes nothing. Unit tiers can assert the park row is
 * gone; only the live stack can show the answer arriving afterwards and the run
 * staying settled.
 *
 * Drive it with:
 *
 *   pnpm dev:movement run race_cancel_probe          # answered-wins leg
 *   pnpm dev:inspect slack                           # → "race: answered=<v>"
 *
 *   pnpm dev:movement run race_cancel_probe          # timer-wins leg
 *   # …wait out the sleep + the 30s timer scan…
 *   pnpm dev:inspect slack                           # → "race: answered=timeout"
 *   pnpm dev:inject ask-answer --token <the ask's>   # the LATE answer
 *   pnpm dev:inspect slack                           # → unchanged
 */
import './_profile_loader';
import '../../services';
import { ensureDevLoopTeam, ensureDevLoopSlackCredential } from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';

/**
 * `sleep(30s)` rather than a minute: the timer worker scans every 30s, so the
 * timer-wins leg settles inside a minute of wall clock while still leaving a
 * comfortable window to answer first on the other leg.
 */
const RACE_CANCEL = `
import { manual, ask, slack } from adapters
import { \`Dev Loop Slack\` } from credentials

runs = manual()
questions = ask()
chat = slack(credentials: \`Dev Loop Slack\`)

movement race_cancel_probe(go: <runs-[:Invocation]->>) {
  q = write questions-[:Provide]-> {
    Prompt: "Which way?"
    \`Answer Type\`: "text"
  }
  chat-[ch:Channels WHERE \`Name\` == "general"]-> {
    write ch-[:Messages]-> {
      Message: "race: open \${q.Url}"
    }
  }

  r = race(
    () => {
      a = await FIRST(q-[:Response]->)
      return a.Answer
    },
    () => { await sleep(30s) },
  )

  chat-[ch2:Channels WHERE \`Name\` == "general"]-> {
    write ch2-[:Messages]-> {
      Message: "race: answered=\${COALESCE(AT(r, 0), "timeout")}"
    }
  }
}

listen to runs {} fire race_cancel_probe
`;

/**
 * One movement over the final language surface: a declared refinement bound to
 * an extraction field, GROUPBY over the extracted rows, MEMBERS in declared
 * order, AT per member, DATE.FORMAT for the human-readable day, and ONLY for
 * the single record a WHERE narrows to.
 */
const LANG_SURFACE = `
import { manual, slack } from adapters
import { \`Dev Loop Slack\` } from credentials

runs = manual()
chat = slack(credentials: \`Dev Loop Slack\`)

type Thesis = <"Consumer" | "Infra" | "Health">

movement lang_surface_probe(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`] {
    node finding: "each company mentioned" {
      headline: <text> "one line about it"
      thesis:   <Thesis> "which thesis it fits"
    }
  }

  rows     = found-[f:finding]-> { return { thesis: COALESCE(f.thesis, "Consumer"), line: COALESCE(f.headline, "") } }
  by       = GROUPBY(rows, (r) => { return COALESCE(AT(r, "thesis"), "Consumer") })
  theses   = MEMBERS(<Thesis>)
  sections = MAP(theses, (th) => { return "\${th}=\${COUNT(COALESCE(AT(by, th), []))}" })

  channel = ONLY(chat-[ch:Channels WHERE \`Name\` == "general"]->)
  if channel == null { ERROR("no #general channel") }
  write channel-[:Messages]-> {
    Message: "lang \${DATE.FORMAT(@current_date, "MMMM D, YYYY")} | \${JOIN(sections, " ")}"
  }
}

listen to runs {} fire lang_surface_probe
`;

async function main() {
  const seed = await ensureDevLoopTeam();
  await ensureDevLoopSlackCredential(seed.teamId);

  for (const source of [RACE_CANCEL, LANG_SURFACE]) {
    const result = await saveMovement({ teamId: seed.teamId, source });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
