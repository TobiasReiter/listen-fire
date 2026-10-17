// The fake-channels Granola, booted on its own throwaway database with a fixed
// set of notes, for RECORDING the parity fixture only (replay needs no
// provider). A child process under fake-channels' own tsx, because that app is
// not a dependency of this one and its store needs better-sqlite3.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const FAKE_CHANNELS = resolve(__dirname, '../../../../../../../../fake-channels');

/** Four notes that walk the adapter's branches: a full note (calendar event,
 *  folder, markdown summary, transcript, a nameless attendee), a note with no
 *  title and no calendar event, a note with nothing in it (skipped), and a
 *  later note in another folder. The timestamps are fixed. */
const NOTES = [
  {
    id: 'note-parity-1',
    object: 'note',
    title: 'Series A sync',
    owner: { name: 'Priya Owner', email: 'priya@fund.com' },
    created_at: '2026-06-19T09:00:00.000Z',
    updated_at: '2026-06-19T10:00:00.000Z',
    calendar_event: {
      event_title: 'Series A sync (calendar)',
      invitees: [{ email: 'ceo@acme.com' }],
      organiser: 'priya@fund.com',
      calendar_event_id: 'cal-1',
      scheduled_start_time: '2026-06-19T09:00:00.000Z',
      scheduled_end_time: '2026-06-19T09:30:00.000Z',
    },
    attendees: [
      { name: 'Acme CEO', email: 'ceo@acme.com' },
      { name: null, email: 'cfo@acme.com' },
    ],
    folder_membership: [{ id: 'f1', name: 'Dealflow' }],
    summary_text: 'They want $2M.',
    summary_markdown: '## Notes\nThey want **$2M**.',
    transcript: [
      { speaker: { source: 'microphone' }, text: 'Hi', start_time: '0', end_time: '1' },
      { speaker: { source: 'speaker' }, text: 'Hello', start_time: '1', end_time: '2' },
    ],
  },
  {
    id: 'note-parity-2',
    object: 'note',
    title: null,
    owner: { name: null, email: 'sam@fund.com' },
    created_at: '2026-07-02T14:00:00.000Z',
    updated_at: '2026-07-02T15:30:00.000Z',
    calendar_event: null,
    attendees: [],
    folder_membership: [],
    summary_text: 'Intro call, no follow-up.',
    summary_markdown: null,
    transcript: null,
  },
  {
    id: 'note-parity-3',
    object: 'note',
    title: 'Empty',
    owner: { name: 'Priya Owner', email: 'priya@fund.com' },
    created_at: '2026-07-10T08:00:00.000Z',
    updated_at: '2026-07-10T08:05:00.000Z',
    calendar_event: null,
    attendees: [],
    folder_membership: [],
    summary_text: '',
    summary_markdown: null,
    transcript: [],
  },
  {
    id: 'note-parity-4',
    object: 'note',
    title: 'Portfolio review',
    owner: { name: 'Priya Owner', email: 'priya@fund.com' },
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T11:00:00.000Z',
    calendar_event: {
      event_title: 'Portfolio review',
      invitees: [],
      organiser: 'sam@fund.com',
      calendar_event_id: 'cal-4',
      scheduled_start_time: '2026-08-01T09:00:00.000Z',
      scheduled_end_time: '2026-08-01T10:00:00.000Z',
    },
    attendees: [{ name: 'Sam Fund', email: 'sam@fund.com' }],
    folder_membership: [
      { id: 'f2', name: 'Portfolio' },
      { id: 'f1', name: 'Dealflow' },
    ],
    summary_text: 'Quarterly review.',
    summary_markdown: null,
    transcript: [{ speaker: { source: 'speaker' }, text: 'Numbers are up.', start_time: '0', end_time: '4' }],
  },
];

const BOOT = `
const express = require('express');
const { EntityStore } = require('./src/store');
const { granolaRoutes } = require('./src/routes/granola');
const store = new EntityStore(process.env.PARITY_DB);
for (const note of JSON.parse(process.env.PARITY_NOTES)) store.create('granola', 'note', note, note.id);
const app = express();
app.use(express.json());
app.use('/granola', granolaRoutes(store));
const server = app.listen(0, '127.0.0.1', () => console.log('listening ' + server.address().port));
`;

export async function bootFakeGranola(): Promise<{ baseUrl: string; stop(): void }> {
  const db = join(mkdtempSync(join(tmpdir(), 'granola-parity-')), 'fake-channels.db');
  const child = spawn(join(FAKE_CHANNELS, 'node_modules/.bin/tsx'), ['--eval', BOOT], {
    cwd: FAKE_CHANNELS,
    env: { ...process.env, PARITY_DB: db, PARITY_NOTES: JSON.stringify(NOTES) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('fake granola did not start within 20s')), 20_000);
    child.once('exit', (code) => reject(new Error(`fake granola exited (${code})`)));
    if (child.stdout === null) return;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const match = /^listening (\d+)/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}/granola`, stop: () => child.kill() };
}
