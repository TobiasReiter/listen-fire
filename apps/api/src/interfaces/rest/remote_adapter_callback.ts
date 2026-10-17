// A member's sign-in at a remote module's provider, coming back (begun by the
// `remoteAdapter.beginOAuthCredential` procedure). The tokens are stored as
// their credential and they land on the remote modules settings page, which
// says what was connected or why it was not. An attempt this server did not
// begin is refused here, as every connector callback refuses one.

import { logger } from 'movement-engine/public/log';
import { OAuth2ExchangeFailed, UnknownConnectAttempt } from 'movement-engine/public/secrets';

import type { RequestHandler } from 'express';

import { getFlowUserId } from '../../lib/oauthFlows';
import { CredentialNameTakenError } from '../../services/credentials/persist_credential';
import {
  completeRemoteModuleSignIn,
  remoteModuleSettingsUrl,
  RemoteModuleCredentialRefused,
} from '../../services/credentials/remote_module_connect';

export const remoteAdapterSignInCallbackHandler: RequestHandler = async (req, res) => {
  const state = req.query.state;
  if (typeof state !== 'string') {
    res.status(401).send('Invalid state parameter');
    return;
  }
  if (!getFlowUserId(state)) {
    res.status(401).send('Unknown OAuth flow');
    return;
  }
  if (req.query.error) {
    logger.error('[REMOTE_ADAPTER] the provider refused the sign-in', { error: req.query.error });
    res.redirect(remoteModuleSettingsUrl({ error: 'The provider did not grant access, so nothing was connected.' }));
    return;
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  try {
    const { name } = await completeRemoteModuleSignIn({ state, code });
    res.redirect(remoteModuleSettingsUrl({ connected: name }));
  } catch (err) {
    logger.error('[REMOTE_ADAPTER] completing a sign-in failed', { err });
    // Only a refusal written for the member travels in the URL; anything else
    // is logged above and named generically.
    const said =
      err instanceof RemoteModuleCredentialRefused ||
      err instanceof CredentialNameTakenError ||
      err instanceof OAuth2ExchangeFailed ||
      err instanceof UnknownConnectAttempt;
    res.redirect(remoteModuleSettingsUrl({ error: said ? err.message : 'The sign-in could not be completed.' }));
  }
};
