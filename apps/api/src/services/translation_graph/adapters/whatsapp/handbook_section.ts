// WhatsApp's conceptual authoring documentation — doc tier 3: what an author
// should know about WhatsApp BEFORE instantiating it. Assembled into the
// automation handbook as the `system:whatsapp` chapter, and bound by the same
// contract as every hand-written chapter (consumer-neutral prose, no internal
// vocabulary, every runnable example backed by a checked probe).
//
// In-chat tapping is taught fresh here (WhatsApp never had a bespoke button
// encoding to retire): a callback id sits comfortably inside a reply button's
// 256-character id. The platform fact that shapes the rest of the chapter —
// WhatsApp cannot edit a sent message and has no toast — is taught plainly:
// the ack a tap gets IS a reply, never a silent edit.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const WHATSAPP_HANDBOOK_SECTION: HandbookSection = {
  title: 'WhatsApp — the shared number, and a tap that acts',
  content: `## WhatsApp — the shared number, and a tap that acts

A WhatsApp send is always written along an edge off the message that arrived: \`-[:Replies]->\` threads a reply, \`-[:Reactions]->\` adds an emoji, \`-[:Typing]->\` shows the typing indicator. The recipient is never a field — it comes from whatever the write hangs off, and only reaches someone inside Meta's 24-hour service window (they must have messaged the number recently). Three things are worth settling before you build one: what a reply carries, what an interactive send replaces, and what a tap can and can't do here.

### what-a-reply-carries

\`\`\`
write msg-[:Replies]-> {
  Body: "Here are the numbers you asked for."
  File: report
}
\`\`\`

\`Body\` is the message text and \`File\` the media to send (image, PDF, audio, video, routed by its content type). At least one of the two; set both and one message goes out with the \`Body\` captioning the file. Media arriving the other way is never on \`File\` — read it off \`msg-[:Attachments]->.File\`.

### reacting-and-showing-typing

\`\`\`
write msg-[:Reactions]-> { Emoji: "✅" }
write msg-[:Typing]-> {}
\`\`\`

A reaction is a record of the same kind you see arriving when somebody reacts to you: one \`Emoji\`, required.

Typing is an action rather than a record — nothing is created, so binding the write is refused. WhatsApp clears the indicator when your reply goes out, or by itself after about 25 seconds, which is exactly how to use it: show it, do the slow step, reply.

### buttons-are-verbatim

\`Interactive\` is WhatsApp's own \`interactive\` object, exactly as the Cloud API spells it, handed over unchanged — nothing wraps it or renames its keys, so a malformed object surfaces as a loud WhatsApp error when the send goes out, not when you save. Sending it REPLACES a plain-text send: the interactive type carries its own \`body.text\`, so the words live inside \`interactive.body.text\`, never in \`Body\` on the same send.

\`\`\`
write msg-[:Replies]-> {
  Interactive: {
    type: "button",
    body: { text: "Ship the release?" },
    action: { buttons: [
      { type: "reply", reply: { id: "yes", title: "Ship" } }
    ] }
  }
}
\`\`\`

Up to three reply buttons, each titled in 20 characters or fewer.

### a-tap-that-acts

A tapped reply button hands its \`id\` straight back, so the id to put there is a callback's — it fits comfortably inside the 256 characters WhatsApp allows. Each button gets its OWN callback, because the body is what the button means:

\`\`\`
q = write questions-[:Check]-> { Prompt: "Send the update?" }
send = callback({ write q-[:Response]-> { Answer: TRUE } })
hold = callback({ write q-[:Response]-> { Answer: FALSE } })

write msg-[:Replies]-> {
  Interactive: {
    type: "button",
    body: { text: "Send the update?" },
    action: { buttons: [
      { type: "reply", reply: { id: "\${send.id}", title: "Send" } },
      { type: "reply", reply: { id: "\${hold.id}", title: "Hold" } }
    ] }
  }
}

answer = await FIRST(q-[:Response]->)
\`\`\`

WhatsApp captures nothing at tap time — a button's id is fixed when the message is sent — so a button always fires a callback that takes no values. A picked date or a typed answer needs a plain reply instead, read off the next inbound message.

### the-only-feedback-is-a-reply

WhatsApp cannot edit a message it already sent, and there is nothing like a toast either — so the whole of a tap's acknowledgement is a reply, quoting the message the button was on. There is no keyboard to retire: a single-use callback's buttons stay exactly as they were sent, and a second tap on one just gets its own reply saying the request is already closed. Design around that — say what happened in words, not in a message that changes shape.

### Common mistakes

- **Setting both \`Body\` and \`Interactive\`.** They're mutually exclusive — put the words inside \`interactive.body.text\`.
- **More than three reply buttons, or a title over 20 characters.** Both are WhatsApp errors at send time.
- **Expecting a button to capture typed text or a picked date.** WhatsApp buttons carry only the id you wired in. Read anything typed off the next inbound reply.
- **Expecting the message to change, or a toast to appear.** Neither happens — the ack IS the reply that comes back.
- **Reading \`File\` off a message.** It only ever goes out; what arrived is on \`Attachments\`.
- **Binding the typing write.** It creates nothing, so there is nothing to name.
- **Sending to someone who hasn't messaged the number recently.** Free-form sends — Interactive included — only reach people inside the 24-hour service window.`,
  engineClaims: [
    {
      construct: 'a WhatsApp interactive reply-button send whose button ids carry callback ids, one per answer',
      status: 'runs',
      probe: `
import { whatsapp, ask } from adapters

wa = whatsapp()
questions = ask()

function confirm_send(msg: <wa-[:\`Message\`]->>) {
  q = write questions-[:Check]-> {
    Prompt: "Send the update?"
    Detail: "\${msg.\`Body\`}"
  }
  send = callback({ write q-[:Response]-> { Answer: TRUE } })
  hold = callback({ write q-[:Response]-> { Answer: FALSE } })

  write msg-[:Replies]-> {
    Interactive: {
      type: "button",
      body: { text: "Send the update?" },
      action: { buttons: [
        { type: "reply", reply: { id: "\${send.id}", title: "Send" } },
        { type: "reply", reply: { id: "\${hold.id}", title: "Hold" } }
      ] }
    }
  }

  answer = await FIRST(q-[:Response]->)
  if answer.Answer {
    write msg-[:Replies]-> { Body: "Sending now." }
  }
}

listen to wa {} fire confirm_send
`,
    },
    {
      construct: 'a WhatsApp interactive reply button that waits on a body-less callback (the minimal confirmation)',
      status: 'runs',
      probe: `
import { whatsapp } from adapters

wa = whatsapp()

function wait_for_go(msg: <wa-[:\`Message\`]->>) {
  go = callback()

  write msg-[:Replies]-> {
    Interactive: {
      type: "button",
      body: { text: "Ready when you are." },
      action: { buttons: [ { type: "reply", reply: { id: "\${go.id}", title: "Go" } } ] }
    }
  }

  tap = await FIRST(go-[:Called]->)
  write msg-[:Replies]-> { Body: "Off we go (\${tap.\`At\`})." }
}

listen to wa {} fire wait_for_go
`,
    },
  ],
};
