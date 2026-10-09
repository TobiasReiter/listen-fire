import { Command, Options, command, metadata, option } from 'clime';
import * as Sentry from '@sentry/node';

import { initSentry } from '../../../lib/sentry';
import { prismaClient } from '../../../prisma';
import { TESTING_TEAM_NAME, TESTING_USER_EMAIL } from '../../../constants';
import { runInContextUnauthorized } from '../../../services/context/utils';
import { TeamService } from '../../../services/team';
import { UserService } from '../../../services/user';
import { PermissionService } from '../../../services/permission';
import { currentContext } from '../../../services/context';

async function main({ email, teamName }: { email: string; teamName?: string }) {
  const ctx = currentContext();
  // Still needed for the authorised Prisma client's rules; the WRITABLE
  // connection now comes from `systemWritable` at the call below, said out loud
  // instead of implied by a rule set.

  // create objects
  const { id: teamId } = await TeamService.getFirstByNameOrCreate(teamName ?? email);
  const { id: userId } = await UserService.create({ email, teamId });

  // grant write access to the team
  await PermissionService.grantMembership({ userId, teamId, access: 'write' });
}

class UserOptions extends Options {
  @option({
    flag: 'u',
    description: 'user email',
  })
  email!: string;
  @option({
    flag: 't',
    description: 'team name',
  })
  teamName?: string;
}

@command({ description: 'Initialise default user and permissions' })
export default class extends Command {
  @metadata
  async execute(options: UserOptions): Promise<void> {
    initSentry();

    const email = options?.email ?? TESTING_USER_EMAIL;
    const teamName = email ? options?.teamName : TESTING_TEAM_NAME;

    try {
      // Bootstrap: this command creates the first team and the first user, so
      // there is no tenant for a principal to be scoped to and no membership to
      // derive write access from.
      await runInContextUnauthorized(async () => main({ email, teamName }), {
        systemWritable: true,
      });
    } catch (err) {
      Sentry.captureException(err);
      throw err;
    } finally {
      await Sentry.close();
      await prismaClient.$disconnect();
    }
  }
}
