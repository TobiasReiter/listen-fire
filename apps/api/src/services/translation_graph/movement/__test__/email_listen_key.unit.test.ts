// An email listen without a `key` is refused at save.
//
// The key is the plus-suffix of the address mail is sent to, and inbound
// dispatch finds a listener by it and by nothing else. A keyless listen saved
// clean, provisioned a listener with no address, and could never fire. The
// requirement is declared by the adapter (its routing-key block), so the
// checker refuses it under every language version; listens that do have a
// delivery path without a key stay legal.

import { checkProgram, parseProgram } from 'movement-lang';

import { staticCatalogFromManifests } from '../catalog';

const catalog = staticCatalogFromManifests({
  credentials: { my_mailbox: { adapters: ['gmail'] } },
});

/** The listen-config refusals only: the static catalog's thin email schema
 *  is not what this test is about. */
function listenErrorsOf(source: string, languageVersion?: number) {
  const options = languageVersion !== undefined ? { languageVersion } : {};
  return checkProgram(parseProgram(source, options), catalog, options).filter(
    (d) => (d.severity ?? 'error') === 'error' && d.code === 'MOV_LISTEN_BAD_CONFIG',
  );
}

const EMAIL_PROGRAM = (listen: string) => `import { email } from adapters

inbox = email()

function \`Log Intro\`(m: <inbox-[:Email]->>) {
  return m.Subject
}

${listen}
`;

describe('an email listen needs a key', () => {
  it('the email adapter declares its routing key required, and says why', () => {
    const spec = catalog.adapter('email');
    expect(spec?.triggerConfigRequired).toEqual(['key']);
    expect(spec?.triggerConfigRequiredWhy?.key).toMatch(/address/);
  });

  it.each([1, 2, 3])('refuses a keyless listen under language version %s, with the fix', (version) => {
    const errors = listenErrorsOf(EMAIL_PROGRAM('listen to inbox {} fire `Log Intro`'), version);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("requires a 'key'");
    expect(errors[0].message).toContain('nothing can be sent to it');
    expect(errors[0].message).toContain('listen to inbox { key: "log-intro" } fire `Log Intro`');
  });

  it('accepts the same listen with a key', () => {
    expect(listenErrorsOf(EMAIL_PROGRAM('listen to inbox { key: "intros" } fire `Log Intro`'))).toEqual([]);
  });

  it('refuses a keyless listen whichever name the email adapter is constructed by', () => {
    const source = EMAIL_PROGRAM('listen to inbox {} fire `Log Intro`').replace(
      'import { email } from adapters\n\ninbox = email()',
      'import { mailgun } from adapters\n\ninbox = mailgun()',
    );
    expect(listenErrorsOf(source)).toHaveLength(1);
  });

  it('leaves a keyless Gmail listen legal — it reads a connected mailbox, no address involved', () => {
    const source = `import { gmail } from adapters
import { my_mailbox } from credentials

mail = gmail(credentials: my_mailbox)

function \`Log Mail\`(m: <mail-[:Message]->>) {
  return m.Subject
}

listen to mail {} fire \`Log Mail\`
`;
    expect(listenErrorsOf(source)).toEqual([]);
  });
});
