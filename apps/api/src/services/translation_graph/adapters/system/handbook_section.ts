// The system adapter's conceptual authoring documentation — assembled into the
// automation handbook as the `system:system` chapter, bound by the same prose
// contract as every hand-written chapter.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const SYSTEM_HANDBOOK_SECTION: HandbookSection = {
  title: 'Platform events — when an automation fails (system)',
  content: `## Platform events — when an automation fails (system)

Use \`connect system\` to run an automation when something happens to your other automations. Post a failure to Slack:

\`\`\`
import { \`@lf/system\` as system, \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

sys  = connect system
team = connect slack using team_workspace

function \`Report Failure\`(failed: <sys-[:\`Run Failed\`]->>) {
  alerts = only(team-[ch:Channels WHERE ch.Name == "alerts"]->)
  if (alerts == null) { fail("no #alerts channel") }
  write alerts-[:Messages]-> {
    Message: "\${failed.Automation} failed: \${failed.Reason} \${failed.Url}"
  }
}

listen as "Report failures" to sys { events: ["Run Failed"] } fire \`Report Failure\`
\`\`\`

- Every event carries \`Automation\`, \`Automation Id\`, \`Run Id\`, \`Version\`, \`Reason\`, \`Url\` (a link to the automation's failed runs) and \`At\`.
- \`Run Failed\` arrives within a couple of minutes of a run ending failed, once per run. An automation is never told about its own failures, and a rehearsal failing is not reported.
- \`Validation Issue\`, \`Deprecated Version\` and \`Release Applied\` arrive when a new release is deployed. The first two fire once per automation that stays on an older language version (\`Version\` names it, \`Reason\` says what to repair); \`Release Applied\` fires once per workspace, with the release and its counts in \`Reason\` and \`Automation\` empty. Listen to them with \`events: ["Validation Issue"]\`, and so on.
- \`Run Paused\` arrives when a run reaches the deployment's cost limit and pauses instead of failing. \`Reason\` says what it spent and the limit, and \`Url\` links to the automation's runs. The run waits until someone resumes it, which resets its usage.
- Going live never replays earlier events: the first look sets the mark.`,
  engineClaims: [
    {
      construct: 'system-channel listeners (runs over the Run Failed position)',
      status: 'runs',
      probe: `
import { \`@lf/system\` as system, \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

sys  = connect system
team = connect slack using team_workspace

function \`Report Failure\`(failed: <sys-[:\`Run Failed\`]->>) {
  alerts = only(team-[ch:Channels WHERE ch.Name == "alerts"]->)
  if (alerts == null) { fail("no #alerts channel") }
  write alerts-[:Messages]-> {
    Message: "\${failed.Automation} failed: \${failed.Reason} \${failed.Url}"
  }
}

listen as "Report failures" to sys { events: ["Run Failed"] } fire \`Report Failure\`
`,
    },
  ],
};
