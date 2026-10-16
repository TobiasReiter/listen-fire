// Slack's conceptual authoring documentation — doc tier 3: what an author
// should know about Slack BEFORE instantiating it. Assembled into the
// automation handbook as the `system:slack` chapter, and bound by the same
// contract as every hand-written chapter (consumer-neutral prose, no internal
// vocabulary, every runnable example backed by a checked probe).
//
// Taught around `callback(…)` since the callback primitive: a tap carries one
// opaque id, on every control, and the id's body says what the tap MEANS. The
// `?answer=` idiom it replaces is no longer taught (the doors still recognise
// it while live automations are re-authored).

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const SLACK_HANDBOOK_SECTION: HandbookSection = {
  title: 'Slack — posts, Block Kit, and acting in the channel',
  content: `## Slack — posts, Block Kit, and acting in the channel

Posting to Slack is an ordinary write: a message written along a channel's \`Messages\` edge, or along an inbound message's \`Replies\` edge. Slack's message field is \`Message\`. There is no cold open — a post always hangs off a channel you traversed to or a message that arrived, and the thread comes from that parent, never from a field. Two things about Slack are worth deciding before you build one — a post comes in exactly **two shapes**, and the interactive shape is how a person acts without leaving the channel.

### two-shapes-of-post

A message you send is one of:

- **a file post** — \`Message\` text carrying a \`File\`. One visible message, the text captioning the file.
- **an interactive post** — \`Message\` text plus \`Blocks\`, Slack's own Block Kit.

\`\`\`
write ch-[:Messages]-> {
  Message: "This week's numbers."
  File:    report
}
\`\`\`

Never both shapes at once. An upload and Block Kit are different Slack endpoints, so a write that sets \`File\` and \`Blocks\` together is refused while you write it. Plain text on its own is the third, unremarkable case; what a message cannot be is empty of all three.

### blocks-are-verbatim

\`Blocks\` is Block Kit exactly as Slack's documentation spells it: a list of block objects, assembled and handed to Slack unchanged. Nothing wraps them, renames their keys, or checks inside them — so a malformed block surfaces as a loud Slack error when the run posts it, not when you save. Write them as literal objects, nested as deeply as Block Kit nests:

\`\`\`
write ch-[:Messages]-> {
  Message: "Ready to go out?"
  Blocks: [
    { type: "section", text: { type: "mrkdwn", text: "*\${release.Name}* is ready." } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Ship" }, value: "\${ship.id}" }
    ] }
  ]
}
\`\`\`

Keep writing the \`Message\` text alongside them: it is what a notification shows, and what a client that cannot render blocks falls back to.

### a-tap-that-acts

This is usually the reason to reach for \`Blocks\`. A control carries a callback id in its \`value\`, and a tap runs that callback — one per control, since the body is what the control means:

\`\`\`
a = write questions-[:Check]-> { Prompt: "Ship the release?" }
ship = callback({ write a-[:Response]-> { Answer: true } })
hold = callback({ write a-[:Response]-> { Answer: false } })

releases = only(team-[ch:Channels WHERE ch.Name == "releases"]->)
if (releases == null) { fail("no #releases channel") }
write releases-[:Messages]-> {
  Message: "Ship the release? \${a.Url}"
  Blocks: [
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Ship" },
        value: "\${ship.id}" },
      { type: "button", text: { type: "plain_text", text: "Hold" },
        value: "\${hold.id}" }
    ] }
  ]
}

answer = await first(a-[:Response]->)
\`\`\`

A select works the same way, one callback per option: \`value: "\${seed.id}"\` on one option, \`"\${growth.id}"\` on the next. And keep \`Url\` in the message text — anyone on a client that cannot tap a block still has a way to respond.

### a-value-picked-at-tap-time

A \`datepicker\`, a \`timepicker\` or a text input has nothing to pre-wire: its value does not exist until the tap, and those elements have no \`value\` field to carry an id anyway. Put the id in \`action_id\` instead, and declare what the tap will supply as a parameter — Slack hands back one value, and it binds to the first parameter you left for it:

\`\`\`
booked = callback((day: <date>) => {
  write msg-[:Replies]-> { Message: "Booked for \${day}." }
})

write msg-[:Replies]-> {
  Message: "When shall we book it?"
  Blocks: [
    { type: "actions", elements: [
      { type: "datepicker", action_id: "\${booked.id}" }
    ] }
  ]
}
\`\`\`

\`value\` is for controls whose meaning is fixed when you post them; \`action_id\` is for the ones whose value arrives with the tap. When a single-use callback is settled, Slack lets the message be edited, so its controls are replaced in place with a confirmation line.

### reacting-to-a-message

The lightest way to acknowledge a message is to react to it: an emoji written along the message's \`Reactions\` edge. It takes one field, the emoji's name without its colons, and the message it lands on is the one you wrote off — nothing addresses it by hand.

\`\`\`
write msg-[:Reactions]-> { Emoji: "eyes" }
\`\`\`

This is the natural "I've picked this up" before a slower step runs, and reacting twice with the same emoji is harmless — the second write finds it already there and changes nothing. Reactions only go on: you can add one, but you cannot read a message's reactions back or take one off.

### what-fires-a-run

Slack delivers only the events its app is subscribed to, so an automation reading Slack usually fires on the bot being mentioned rather than on every message in a channel; narrow further with \`events\` and \`channels\` on the listener. A run also needs the person who sent the message (or added the reaction) to be a known member of the team, matched on their Slack profile email — activity from guests, external members of a shared channel, other bots, and this platform's own posts is dropped before anything runs. Both facts are worth saying out loud when someone describes what they want, because both change what is possible.

### Common mistakes

- **Setting \`File\` and \`Blocks\` on one message.** Two shapes, one choice. Send the file, then post the interactive message as a reply if you need both.
- **A control with no \`id\` in it.** The post looks right and a tap does nothing. The id is the whole mechanism.
- **Trying to pre-wire a picked value.** A date is not known when you post the picker. Carry the id on \`action_id\` and declare a parameter for what the tap will supply.
- **Expecting a bad block to fail at save time.** The contents are passed through untouched; Slack is the one that validates them, at run time.
- **Promising every message in a channel.** What arrives depends on the workspace's subscription, and on the sender being a known member.`,
  engineClaims: [
    {
      construct: 'a Slack interactive post whose buttons carry callback ids, one per answer',
      status: 'runs',
      probe: `
import { \`@lf/slack\` as slack, \`@lf/ask\` as ask } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace
questions = connect ask

function sign_off(msg: <team-[:Message]->>) {
  a = write questions-[:Check]-> {
    Prompt: "Ship the release?"
    Detail: "\${msg.Message}"
  }
  ship = callback({ write a-[:Response]-> { Answer: true } })
  hold = callback({ write a-[:Response]-> { Answer: false } })

  write msg-[:Replies]-> {
    Message: "Ship the release? \${a.Url}"
    Blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*Ship the release?*" } },
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Ship" },
          value: "\${ship.id}" },
        { type: "button", text: { type: "plain_text", text: "Hold" },
          value: "\${hold.id}" }
      ] }
    ]
  }

  answer = await first(a-[:Response]->)
  if (answer.Answer) {
    general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
    if (general == null) { fail("no #general channel") }
    write general-[:Messages]-> { Message: "Shipping now." }
  }
}

listen to team { events: ["app_mention"] } fire sign_off
`,
    },
    {
      construct: 'a Slack datepicker carrying a parameterized callback id on action_id',
      status: 'runs',
      probe: `
import { \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace

function book_it(msg: <team-[:Message]->>) {
  booked = callback((day: <date>) => {
    write msg-[:Replies]-> { Message: "Booked for \${day}." }
  })

  write msg-[:Replies]-> {
    Message: "When shall we book it?"
    Blocks: [
      { type: "actions", elements: [
        { type: "datepicker", action_id: "\${booked.id}" }
      ] }
    ]
  }

  call = await first(booked-[:Called]->)
  write msg-[:Replies]-> { Message: "Picked \${call.day}." }
}

listen to team { events: ["app_mention"] } fire book_it
`,
    },
    {
      construct: 'a body-less callback awaited on Called — the minimal confirmation — plus a callback deferring a function by name',
      status: 'runs',
      probe: `
import { \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace

function announce(m: <team-[:Message]->>) {
  write m-[:Replies]-> { Message: "On it." }
}

function wait_for_go(msg: <team-[:Message]->>) {
  go = callback()
  again = callback(() => announce(msg), { once: false, ttl: 2d })

  write msg-[:Replies]-> {
    Message: "Ready when you are."
    Blocks: [
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Go" },
          value: "\${go.id}" },
        { type: "button", text: { type: "plain_text", text: "Remind the channel" },
          value: "\${again.id}" }
      ] }
    ]
  }

  tap = await first(go-[:Called]->)
  write msg-[:Replies]-> { Message: "Off we go (\${tap.At})." }
}

listen to team { events: ["app_mention"] } fire wait_for_go
`,
    },
  ],
};
