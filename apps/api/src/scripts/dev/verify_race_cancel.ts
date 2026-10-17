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

runs = connect manual
questions = connect ask
chat = connect slack using \`Dev Loop Slack\`

function race_cancel_probe(go: <runs-[:Invocation]->>) {
  q = write questions-[:Provide]-> {
    Prompt: "Which way?"
    \`Answer Type\`: "text"
  }
  chat-[ch:Channels WHERE ch.\`Name\` == "general"]-> {
    write ch-[:Messages]-> {
      Message: "race: open \${q.Url}"
    }
  }

  r = race(
    () => {
      a = await first(q-[:Response]->)
      return a.Answer
    },
    () => { await sleep(30s) },
  )

  chat-[ch2:Channels WHERE ch2.\`Name\` == "general"]-> {
    write ch2-[:Messages]-> {
      Message: "race: answered=\${coalesce(r[0], "timeout")}"
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

runs = connect manual
chat = connect slack using \`Dev Loop Slack\`

type Thesis = <"Consumer" | "Infra" | "Health">

node FoundShape: "the relevant information in the content" {
  node finding: "each company mentioned" {
    headline: <text> "one line about it"
    thesis: <Thesis> "which thesis it fits"
  }
}

function lang_surface_probe(go: <runs-[:Invocation]->>) {
  found = extractOne([go.\`Text\`], FoundShape)
  if (found != null) {
    rows     = found-[f:finding]-> { return { thesis: coalesce(f.thesis, "Consumer"), line: coalesce(f.headline, "") } }
    by       = List.groupBy(rows, (r) => { return coalesce(r["thesis"], "Consumer") })
    theses   = members(<Thesis>)
    sections = map(theses, (th) => { return "\${th}=\${count(coalesce(by[th], []))}" })

    channel = only(chat-[ch:Channels WHERE ch.\`Name\` == "general"]->)
    if (channel == null) { fail("no #general channel") }
    write channel-[:Messages]-> {
      Message: "lang \${Date.format(@current_date, "MMMM D, YYYY")} | \${Text.join(sections, " ")}"
    }
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
