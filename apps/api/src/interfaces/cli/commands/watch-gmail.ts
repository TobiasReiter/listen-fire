import { Command, command, metadata } from 'clime';
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

const GOOGLE_PUB_SUB_TOPIC = process.env.GOOGLE_PUB_SUB_TOPIC;

async function main() {
  for (const subject of GOOGLE_INBOXES_TO_WATCH ?? []) {
    if (subject) {
      await watch(subject);
    }
  }
}

async function watch(subject: string) {
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

  await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: GOOGLE_PUB_SUB_TOPIC,
    },
  });

  google.options({ auth: undefined });
}

class CliOptions extends UserOptions {}

@command({ description: 'Update Exchange Rate data with daily rates' })
export default class extends Command {
  @metadata
  async execute(options: CliOptions): Promise<void> {
    initSentry();

    try {
      await runInContext(() => main(), { email: options.email });
    } catch (err) {
      Sentry.captureException(err);
      throw err;
    } finally {
      await Sentry.close();
      await prismaClient.$disconnect();
    }
  }
}
