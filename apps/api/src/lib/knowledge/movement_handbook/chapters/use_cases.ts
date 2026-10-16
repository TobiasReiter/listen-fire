import type { Chapter } from '../types';

// the
// dealflow extraction playbook: ported scoping wording as authoring advice,
// surfaced through the existing handbook/library shelf (no runtime touch).
export const useCases: Chapter = {
  id: 'use-cases',
  title: 'Use-case playbooks — battle-tested scoping wording',
  content: `## Use-case playbooks

Copy the descriptions below when your brief matches one of these situations. A description is the only thing that scopes an extraction, and this wording is what survived contact with real messages — lift it as written, and trim only what your brief rules out.

Nothing here matches your brief? Then there is nothing extra to know: the extraction chapter's rules are the whole story.

### dealflow-extraction

A pitch, a forwarded intro, or a deck arrives, and you want the company being pitched and the people behind it. The same message name-drops competitors, quotes customers, and links to a file host — every clause below is there to keep one of those out.

#### the company and its team

\`\`\`
node Company: "Each company that is the primary subject of this message — the company being pitched or introduced for investment. Only extract organisations the message is ABOUT, not ones mentioned in passing as context, comparisons, competitors, or background. If several companies are being pitched, extract each one separately. Infer the company name from a website domain or an email address when it is not stated outright (joe@acme.com implies the company 'Acme' with website acme.com). Well-known file-hosting domains (docs.google.com, docsend.com, drive.google.com, pitch.com) are NOT company websites — never treat them as the company's site." {
  name:    <text> "the company's name"
  website: <text> "the company's official website (not a file-hosting link)"
  node founder: "Each senior member of this company's team named in the message: founders, co-founders, and C-suite (CEO, CTO, COO, CFO). Do NOT extract 'Head of X', 'X Lead', 'Senior X', or VP-level roles unless that person is also a founder. Do NOT extract advisors, consultants, or investors as team members. A person whose email is on the company's own domain is likely a team member rather than an external contact." {
    name: <text> "the person's full name"
    role: <text> "the person's title (CEO, CTO, Co-founder, …)"
  }
}
\`\`\`

- *"not ones mentioned in passing"* is what stops "we're the Stripe for X" importing Stripe. It is the single most common over-extraction.
- *"extract each one separately"* makes a two-startup forward yield two companies rather than one blended record.
- The file-hosting sentence is the clause people trim for brevity and then regret: without it, a DocSend link becomes the company's website.
- The team is nested inside the company, so each person lands attached to the right one. Without the seniority carve-out you import every "Head of Growth" the message names.

#### the sender

Only when the brief wants whoever sent it, which on a forward is not whoever wrote the pitch:

\`\`\`
node Introducer: "The person who sent or forwarded this message to us — the introducer or referrer, found in the message header, signature, or 'From' line. If the message is a forward, this is the person who forwarded it, NOT the original author of the pitch." {
  name:  <text> "their full name"
  email: <text | null> "their email address"
}

introducer = extractOne(content, Introducer)
\`\`\`

Read the message's \`From\` for this, not its \`To\` — on a forward, \`To\` is just the address it landed at.

#### both deck channels

The substance of a dealflow message is in the deck, and a deck arrives two ways. Read **both**:

\`\`\`
decks     = vcUrlRetrieval(msg.Body, { email: @user_email })
content   = [msg.Body, ...msg-[a:Attachments]->.File, ...map(decks, (d) => coalesce(d.text, ""))]
companies = extract(content, Company, { tier: "careful" })
\`\`\`

The content carries the body *and* the attached files (a PDF, a slide deck, a voice note whose spoken words are transcribed). \`vcUrlRetrieval\` covers the other channel — it finds the deck *links* in the body, works out which are decks, and loads them. Extract from the body alone and the deck never reaches the model.

The \`email\` argument gets past an *enter your email to view* gate. \`@user_email\` — the team member responsible for the run, resolved through forwarders — is right almost always; reach for \`@actor_email\`, the raw sender of the triggering message, only when the gated link was shared with that sender rather than with the team.

Everything after the extraction is the ordinary shape: each founder written along their company's own edge, names matched with \`FUZZY\`. The extraction and patterns chapters carry it.
`,
  engineClaims: [
    {
      construct: 'dealflow extraction (body, attachments and retrieved deck links as content → a nested tree → linked fuzzy writes, plus the sender by extractOne)',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { vcUrlRetrieval } from plugins
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

node Company: "each company this message is about — the one being pitched for investment, not competitors or customers named in passing" {
  name:    <text> "the company's name"
  website: <text> "the company's official website"
  node founder: "each founder or C-suite leader of this company named in the message" {
    name: <text> "the person's full name"
    role: <text> "the person's title"
  }
}

node Introducer: "the person who sent or forwarded this message to us" {
  name:  <text> "their full name"
  email: <text | null> "their email address"
}

function \`Log Dealflow\`(msg: <inbox-[:Email]->>) {
  decks     = vcUrlRetrieval(msg.Body, { email: @user_email })
  content   = [msg.Body, ...msg-[a:Attachments]->.File, ...map(decks, (d) => coalesce(d.text, ""))]
  companies = extract(content, Company, { tier: "careful" })
  introducer = extractOne(content, Introducer, { tier: "careful" })

  map(companies, (c) => {
    company = write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:    c.name
      Domains: c.website
      Description ?: "Introduced by \${introducer.name}"
    }
    c-[f:founder]-> {
      write company-[:Team]-> {
        unique by (FUZZY Name)
        Name:        f.name
        \`Job Title\`: f.role
      }
    }
  })
}
`,
    },
  ],
};
