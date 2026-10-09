import { Command, command, metadata, option } from 'clime';
import { google } from 'googleapis';
import * as Sentry from '@sentry/node';

import { initSentry } from '../../../lib/sentry';
import { runInContext } from '../../../services/context/utils';
import { UserOptions } from '../options';
import { prismaClient } from '../../../prisma';

const gmail = google.gmail('v1');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_INBOXES_TO_WATCH = process.env.GOOGLE_INBOXES_TO_WATCH?.split(',');

async function main(startHistoryId: string) {
  for (const subject of GOOGLE_INBOXES_TO_WATCH ?? []) {
    if (subject) {
      await watch(subject, startHistoryId);
    }
  }
}

async function watch(subject: string, startHistoryId: string) {
  const credentials = {
    type: 'service_account',
    private_key: GOOGLE_PRIVATE_KEY,
    client_email: GOOGLE_CLIENT_EMAIL,
    client_id: GOOGLE_CLIENT_ID,
  };

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
    clientOptions: {
      subject,
    },
  });

  google.options({ auth });

  const list = await gmail.users.history.list({
    userId: 'me',
    startHistoryId,
    historyTypes: ['messageAdded'],
  });
  for (const historyItem of list.data.history ?? []) {
    for (const m of historyItem.messages ?? []) {
      if (!m.id) {
        continue;
      }

      // eslint-disable-next-line no-console
      console.log('Processing message:', m.id);
      const message = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
      });

      const body = message.data.payload?.body;
      const parts = message.data.payload?.parts;

      if (body?.data) {
        const bodyBuf = Buffer.from(body.data, 'base64');
        // eslint-disable-next-line no-console
        console.log(
          'Message headers: ',
          message.data.payload?.headers?.map((h) => [h.name, h.value].join(': ')).join('\n'),
        );
        // eslint-disable-next-line no-console
        console.log('Message body:', bodyBuf.toString('utf-8'));
      } else if (parts?.length) {
        for (const part of parts) {
          if (!part.body?.data) {
            continue;
          }

          const partBuf = Buffer.from(part.body.data, 'base64');
          // eslint-disable-next-line no-console
          console.log(
            'Message headers: ',
            message.data.payload?.headers?.map((h) => [h.name, h.value].join(': ')).join('\n'),
          );
          // eslint-disable-next-line no-console
          console.log('Message body:', partBuf.toString('utf-8'));
        }
      }
    }
  }

  google.options({ auth: undefined });
}

class CliOptions extends UserOptions {
  @option({
    flag: 'i',
    description: 'start history id',
  })
  startHistoryId!: string;
}

@command({ description: 'Get gmail messages since...' })
export default class extends Command {
  @metadata
  async execute(options: CliOptions): Promise<void> {
    initSentry();

    try {
      await runInContext(() => main(options.startHistoryId), { email: options.email });
    } catch (err) {
      Sentry.captureException(err);
      throw err;
    } finally {
      await Sentry.close();
      await prismaClient.$disconnect();
    }
  }
}
