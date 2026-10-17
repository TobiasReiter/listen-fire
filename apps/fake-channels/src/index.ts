import express from 'express';
import { EntityStore } from './store';
import { seedDefaults } from './seed';
import { affinityRoutes } from './routes/affinity';
import { attioRoutes } from './routes/attio';
import { slackRoutes } from './routes/slack';
import { sheetsRoutes } from './routes/sheets';
import { airtableRoutes } from './routes/airtable';
import { granolaRoutes } from './routes/granola';
import { evertraceRoutes } from './routes/evertrace';
import { dealroomRoutes } from './routes/dealroom';
import { emailRoutes } from './routes/email';
import { resendRoutes } from './routes/resend';
import { whatsappRoutes } from './routes/whatsapp';
import { telegramRoutes } from './routes/telegram';
import { webhookRoutes } from './routes/webhook';
import { gdriveRoutes } from './routes/gdrive';
import { gmailRoutes } from './routes/gmail';
import { dropboxRoutes } from './routes/dropbox';
import { oauthRoutes } from './routes/oauth';
import { adminRoutes } from './routes/admin';
import { openAiRoutes } from './routes/openai';
import { geminiRoutes } from './routes/gemini';

const PORT = Number(process.env.FAKE_CHANNELS_PORT || 5556);

const store = new EntityStore();
console.log('Seeding default data...');
seedDefaults(store);
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Mount fake service routes
app.use('/affinity', affinityRoutes(store));
app.use('/attio', attioRoutes(store));
app.use('/slack', slackRoutes(store));
app.use('/sheets', sheetsRoutes(store));
app.use('/airtable', airtableRoutes(store));
app.use('/granola', granolaRoutes(store));
app.use('/evertrace', evertraceRoutes(store));
app.use('/dealroom', dealroomRoutes(store));
app.use('/email', emailRoutes(store));
app.use('/resend', resendRoutes(store));
app.use('/whatsapp', whatsappRoutes(store));
app.use('/telegram', telegramRoutes(store));
app.use('/webhook', webhookRoutes(store));
// googleapis ignores any path prefix on its rootUrl, so Drive mounts at the
// host root (/drive/v3/*, /upload/drive/v3/*) — no collision with the
// service-prefixed routes above.
app.use('/', gdriveRoutes(store));
// Gmail mounts at the host root for the same reason (/gmail/v1/*), plus its
// own /fake-gmail/* control surface.
app.use('/', gmailRoutes(store));
app.use('/dropbox', dropboxRoutes(store));
app.use('/oauth', oauthRoutes(store));
app.use('/admin', adminRoutes(store));
app.use('/openai/v1', openAiRoutes());
app.use('/gemini', geminiRoutes());

app.listen(PORT, () => {
  console.log(`Fake channel server running on http://localhost:${PORT}`);
  console.log('Routes: /affinity, /attio, /slack, /sheets, /airtable, /granola, /evertrace, /dealroom, /email, /resend, /whatsapp, /telegram, /webhook, /gdrive, /gmail, /dropbox, /oauth, /admin, /openai/v1, /gemini');
});
