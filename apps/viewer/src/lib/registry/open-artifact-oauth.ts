/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createAuthorizationRequest } from '@ifc-lite/oauth-pkce';
import { localRegistryAddress } from './connection';
import { validateRegistryCallback, validateRegistryOAuthConfig } from './oauth';
import { RegistryError, registryTokenSession } from './protocol';
import { registryJsonReply, registrySessionLock } from './session-exchange';
import { bindOpenArtifact, openArtifactContext, REGISTRY_LAUNCH_CALLBACK, REGISTRY_LAUNCH_CLIENT, REGISTRY_LAUNCH_PATH } from './open-artifact-contract';

const PENDING = 'ifc-lite:registry-launch-pkce';
const MAX_AGE = 5 * 60 * 1000;
interface Pending { issuer: string; clientId: string; redirectUri: string; state: string; verifier: string; created: number }

/** Launch URLs may identify only the explicitly configured registry, never a new proxy destination. */
export function trustedLaunchIssuer(input: string, allowed = localRegistryAddress): string {
  const url = new URL(input);
  const pinned = new URL(allowed);
  if (url.origin !== pinned.origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new RegistryError('Open this model from the configured local registry.');
  }
  return url.origin;
}

async function configuration(origin: string, issuer: string, signal: AbortSignal) {
  const url = new URL('/oauth/config', origin); url.searchParams.set('client_id', REGISTRY_LAUNCH_CLIENT);
  const value = await registryJsonReply(await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal }));
  if (!value || typeof value !== 'object' || !('issuer' in value) || value.issuer !== issuer ||
    !('open_artifact_protocol' in value) || value.open_artifact_protocol !== 'open-artifact/1') throw new RegistryError('The registry does not support this opening request.');
  const config = validateRegistryOAuthConfig(value, issuer, new URL(REGISTRY_LAUNCH_CALLBACK, window.location.origin).href, true);
  if (config.clientId !== REGISTRY_LAUNCH_CLIENT) throw new RegistryError('Register IFClite as an external application at this registry.');
  return config;
}

/** Keep only PKCE transaction material across the redirect; access and refresh tokens stay in memory. */
export async function prepareRegistryLaunch(href: string, signal: AbortSignal, allowed = localRegistryAddress): Promise<string> {
  sessionStorage.removeItem(PENDING);
  const input = new URL(href);
  if (input.origin !== window.location.origin || input.pathname !== REGISTRY_LAUNCH_PATH || input.hash ||
    input.searchParams.getAll('issuer').length !== 1 || input.searchParams.getAll('request_id').length !== 1 ||
    [...input.searchParams.keys()].some(key => key !== 'issuer' && key !== 'request_id')) throw new RegistryError('Return to the registry and open this model again.');
  const issuer = trustedLaunchIssuer(input.searchParams.get('issuer')!, allowed);
  const requestId = input.searchParams.get('request_id')!;
  if (!/^[a-f0-9]{32}$/.test(requestId)) throw new RegistryError('The opening request is invalid.');
  const config = await configuration(window.location.origin, issuer, signal);
  const redirectUri = new URL(REGISTRY_LAUNCH_CALLBACK, window.location.origin).href;
  const request = await createAuthorizationRequest({ authorizationEndpoint: config.authorizationEndpoint, clientId: config.clientId,
    redirectUri, scope: config.sessionScope, extraParams: { launch_request: requestId } });
  signal.throwIfAborted();
  const pending: Pending = { issuer, clientId: config.clientId, redirectUri, state: request.state, verifier: request.codeVerifier, created: Date.now() };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  return request.url;
}

function takePending(allowed: string): Pending {
  const stored = sessionStorage.getItem(PENDING); sessionStorage.removeItem(PENDING);
  if (!stored || stored.length > 4096) throw new RegistryError('Return to the registry and open this model again.');
  const p: unknown = JSON.parse(stored);
  if (!p || typeof p !== 'object' || !('issuer' in p) || typeof p.issuer !== 'string' ||
    !('clientId' in p) || p.clientId !== REGISTRY_LAUNCH_CLIENT || !('redirectUri' in p) || p.redirectUri !== new URL(REGISTRY_LAUNCH_CALLBACK, window.location.origin).href ||
    !('state' in p) || typeof p.state !== 'string' || !/^[A-Za-z0-9_-]{22,256}$/.test(p.state) ||
    !('verifier' in p) || typeof p.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.verifier) ||
    !('created' in p) || typeof p.created !== 'number' || !Number.isSafeInteger(p.created) || Date.now() < p.created || Date.now() - p.created > MAX_AGE) {
    throw new RegistryError('The opening request expired or could not be verified.');
  }
  return { issuer: trustedLaunchIssuer(p.issuer, allowed), clientId: p.clientId, redirectUri: p.redirectUri, state: p.state, verifier: p.verifier, created: p.created };
}

/** Redeem one callback, bound to its issuer, callback path, state, client and PKCE verifier. */
export async function finishRegistryLaunch(href: string, signal: AbortSignal, allowed = localRegistryAddress, origin = window.location.origin) {
  const pending = takePending(allowed);
  const callback = new URL(href);
  if (callback.searchParams.getAll('iss').length !== 1 || callback.searchParams.get('iss') !== pending.issuer) throw new RegistryError('The opening response came from another registry.');
  const code = validateRegistryCallback(href, pending.redirectUri, pending.state);
  await configuration(origin, pending.issuer, signal);
  const reply = await registrySessionLock(pending.issuer, async () => {
    signal.throwIfAborted();
    return registryJsonReply(await fetch(new URL('/oauth/token', origin), {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: pending.clientId, redirect_uri: pending.redirectUri, code, code_verifier: pending.verifier }),
    }));
  }, signal);
  signal.throwIfAborted();
  if (!reply || typeof reply !== 'object' || !('open_artifact' in reply)) throw new RegistryError('The registry omitted the selected model.');
  const context = openArtifactContext(reply.open_artifact, pending.issuer);
  const authorization = registryTokenSession(reply, context.source.repository, pending.clientId);
  bindOpenArtifact(authorization, context);
  return authorization;
}
