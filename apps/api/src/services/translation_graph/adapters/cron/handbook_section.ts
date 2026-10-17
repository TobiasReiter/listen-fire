// Cron's conceptual authoring documentation — assembled into the automation
// handbook as the `system:cron` chapter, bound by the same prose contract as
// every hand-written chapter.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const CRON_HANDBOOK_SECTION: HandbookSection = {
  title: 'Schedules — time-triggered runs (cron)',
  content: `## Schedules — time-triggered runs (cron)

Use \`connect cron\` to run an automation on a schedule:

\`\`\`
import { \`@lf/cron\` as cron } from adapters

timer = connect cron

function \`Weekly Digest\`(t: <timer-[:Tick]->>) { … }

listen as "Weekly digest" to timer { schedule: "0 9 * * 1" } fire \`Weekly Digest\`
\`\`\`

- \`schedule\` (required): five-field cron — \`"0 9 * * 1"\` is 09:00 every Monday. UTC by default; add \`timezone: "Europe/London"\` (an IANA name, daylight-saving aware) for wall-clock time.
- The \`Tick\` carries \`Fired at\` and \`Schedule\`.
- Occurrences missed while the platform was down collapse into one tick — a digest that missed three Mondays sends one. A newly saved schedule waits for its next occurrence; it never fires retroactively.`,
  engineClaims: [
    {
      construct: 'cron-channel listeners (scheduled movements over the Tick position)',
      status: 'runs',
      probe: `
import { \`@lf/cron\` as cron, \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

timer = connect cron
team  = connect slack using team_workspace

function \`Weekly Digest\`(t: <timer-[:Tick]->>) {
  updates = only(team-[ch:Channels WHERE ch.Name == "updates"]->)
  if (updates == null) { fail("no #updates channel") }
  write updates-[:Messages]-> { Message: "Digest for \${t.\`Fired at\`}" }
}

listen to timer { schedule: "0 9 * * 1" } fire \`Weekly Digest\`
`,
    },
  ],
};
