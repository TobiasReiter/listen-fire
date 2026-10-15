// Telegram's conceptual authoring documentation — doc tier 3: what an author
// should know about Telegram BEFORE instantiating it. Assembled into the
// automation handbook as the `system:telegram` chapter, and bound by the same
// contract as every hand-written chapter (consumer-neutral prose, no internal
// vocabulary, every runnable example backed by a checked probe).
//
// In-chat tapping is taught again, around `callback(…)`: a callback id sits
// comfortably inside `callback_data`'s 64 bytes, which is what the ask `Token`
// (deleted in callback-primitive layer 3) used to be squeezed for. The
// `?answer=` link idiom is no longer taught; the door still recognises it while
// live automations are re-authored.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const TELEGRAM_HANDBOOK_SECTION: HandbookSection = {
  title: 'Telegram — bot chats, keyboards, and acting in the chat',
  content: `## Telegram — bot chats, keyboards, and acting in the chat

A Telegram message is always written along an edge: \`-[:Messages]->\` off a linked person, which sends into their private chat with the bot, or \`-[:Replies]->\` off a message that arrived, which threads under it. The chat is never a field — it comes from whatever the write hangs off. Three things about Telegram are worth settling before you build one: what a send can carry, how little the bot can see, and how a keyboard turns a message into something a person can act on with one tap.

### what-a-send-carries

\`\`\`
person = ONLY(tg-[u:\`Linked Users\` WHERE \`Email\` == "ops@example.com"]->)
if person == null { ERROR("ops@example.com hasn't linked Telegram") }
write person-[:Messages]-> { Text: "The nightly run finished clean." }
\`\`\`

\`Text\` is the message, and it is required — a send carries no file, so anything you would have attached goes in the words or in a link inside them. (Media coming the other way is ordinary: read it off \`msg-[:Attachments]->.File\`.)

The write above starts a conversation from nothing: nobody has to message the bot first, as long as that person has linked. Reaching them is a traversal to \`Linked Users\`, and their private chat comes from the parent you land on.

### what-the-bot-can-see

Far less than "a chat app" suggests. In a one-to-one chat with the bot it sees every message sent to it. In a group it sees only direct replies to it and messages that @-mention it. It has no access to a person's other conversations at all — Telegram at large is never read.

So the natural framing is the bot chat as a deliberate capture channel: someone messages the bot, or forwards something to it, and that is the trigger surface. Never promise "everything posted in a group": that needs the bot's owner to turn privacy mode off, which the shared built-in bot cannot do — only somebody running their own bot can. And on the shared bot a person must complete the one-time linking step before anything they send reaches a run at all; their own bot has no such gate. Both facts change what is possible, so say them out loud while someone is describing what they want.

### keyboards-are-verbatim

\`Reply Markup\` is Telegram's own \`reply_markup\`, exactly as its documentation spells it, handed over unchanged. Nothing wraps it, renames its keys, or looks inside it — so a malformed keyboard surfaces as a loud Telegram error when the run sends it, not when you save. It is a single object, and the buttons live in rows inside it:

\`\`\`
write person-[:Messages]-> {
  Text: "Deploy is ready."
  \`Reply Markup\`: {
    inline_keyboard: [
      [ { text: "Release notes", url: "\${release.Url}" } ]
    ]
  }
}
\`\`\`

\`inline_keyboard\` is a list of ROWS and each row is a list of buttons, so two buttons in one row sit side by side and two rows of one stack vertically. A keyboard rides along with whatever else the message carries; nothing on a Telegram send excludes it.

### a-tap-that-acts

This is usually the reason to reach for a keyboard. A button either opens a link (\`url\`) or hands a payload back to the bot (\`callback_data\`), and that payload is a callback id — comfortably inside the 64 bytes Telegram allows there. Each button gets its OWN callback, because the body is what the button means:

\`\`\`
q = write questions-[:Check]-> { Prompt: "Send the update?" }
send = callback({ write q-[:Response]-> { Answer: TRUE } })
hold = callback({ write q-[:Response]-> { Answer: FALSE } })

write msg-[:Replies]-> {
  Text: "Send the update? \${q.Url}"
  \`Reply Markup\`: {
    inline_keyboard: [
      [ { text: "Send", callback_data: "\${send.id}" },
        { text: "Hold", callback_data: "\${hold.id}" } ]
    ]
  }
}

answer = await FIRST(q-[:Response]->)
\`\`\`

Put the bare \`Url\` in the message text as well, so the question is still answerable wherever the buttons are not.

Telegram captures nothing at tap time — a keyboard's buttons are fixed when the message is sent — so a Telegram button always fires a callback that takes no values. A picked date or a typed answer needs the question's own page (its \`Url\`, on a \`url\` button), not a keyboard. When a single-use callback is settled the keyboard is retired, since Telegram lets a sent message be edited.

### Common mistakes

- **A flat list of buttons.** \`inline_keyboard\` is rows, so every button belongs inside a row list — a flat list is a Telegram error, not a single row.
- **A button with neither a link nor an id in it.** The keyboard looks right and a tap does nothing. One or the other is the whole mechanism.
- **Attaching a file to a send.** There is no field for one — put a link in the \`Text\`.
- **Expecting a keyboard to capture a date or free text.** Telegram buttons carry only what you wired in. Send the link for anything the person has to fill in.
- **Expecting a bad keyboard to fail at save time.** Its contents are passed through untouched; Telegram is the one that validates them, at run time.
- **Promising every message in a group.** What the bot sees depends on privacy mode and on being addressed, and on the shared bot the sender must have linked first.`,
  engineClaims: [
    {
      construct: 'a Telegram inline keyboard whose callback_data carries callback ids, one per answer',
      status: 'runs',
      probe: `
import { telegram, ask } from adapters
import { team_telegram } from credentials

tg = telegram(credentials: team_telegram)
questions = ask()

function confirm_send(msg: <tg-[:\`Message\`]->>) {
  q = write questions-[:Check]-> {
    Prompt: "Send the update?"
    Detail: "\${msg.\`Text\`}"
  }
  send = callback({ write q-[:Response]-> { Answer: TRUE } })
  hold = callback({ write q-[:Response]-> { Answer: FALSE } })

  write msg-[:Replies]-> {
    Text: "Send the update? \${q.Url}"
    \`Reply Markup\`: {
      inline_keyboard: [
        [ { text: "Send", callback_data: "\${send.id}" },
          { text: "Hold", callback_data: "\${hold.id}" } ]
      ]
    }
  }

  answer = await FIRST(q-[:Response]->)
  if answer.Answer {
    write msg-[:Replies]-> { Text: "Sending now." }
  }
}

listen to tg {} fire confirm_send
`,
    },
    {
      construct: 'a Telegram keyboard whose button waits on a body-less callback (the minimal confirmation)',
      status: 'runs',
      probe: `
import { telegram } from adapters
import { team_telegram } from credentials

tg = telegram(credentials: team_telegram)

function wait_for_go(msg: <tg-[:\`Message\`]->>) {
  go = callback()

  write msg-[:Replies]-> {
    Text: "Ready when you are."
    \`Reply Markup\`: {
      inline_keyboard: [ [ { text: "Go", callback_data: "\${go.id}" } ] ]
    }
  }

  tap = await FIRST(go-[:Called]->)
  write msg-[:Replies]-> { Text: "Off we go (\${tap.\`At\`})." }
}

listen to tg {} fire wait_for_go
`,
    },
  ],
};
