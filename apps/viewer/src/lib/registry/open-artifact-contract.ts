/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RegistryError, repositoryName, type RegistryAuthorization } from './protocol';

export const IFC_STEP_PROFILE = 'urn:ifc-lite:ifc-step:1';
export const REGISTRY_LAUNCH_CLIENT = 'ifc-lite-open-artifact';
export const REGISTRY_LAUNCH_PATH = '/open-artifact';
export const REGISTRY_LAUNCH_CALLBACK = '/open-artifact/callback';

export interface OpenArtifactContext {
  protocol: 'open-artifact/1';
  source: { registry: string; repository: string; digest: string; profile: typeof IFC_STEP_PROFILE };
  intent: 'view' | 'edit';
  expires_at: number;
}

/** Validate the registry-authenticated contract before using any artifact or publication address. */
export function openArtifactContext(value: unknown, issuer: string): OpenArtifactContext {
  if (!value || typeof value !== 'object' || !('protocol' in value) || value.protocol !== 'open-artifact/1' ||
    !('intent' in value) || (value.intent !== 'view' && value.intent !== 'edit') ||
    !('expires_at' in value) || typeof value.expires_at !== 'number' || !Number.isSafeInteger(value.expires_at) || value.expires_at * 1000 <= Date.now() ||
    !('source' in value) || !value.source || typeof value.source !== 'object') throw new RegistryError('This opening request is invalid or has expired.', 403);
  const source = value.source;
  if (!('registry' in source) || source.registry !== issuer || !('repository' in source) || typeof source.repository !== 'string' ||
    !('digest' in source) || typeof source.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(source.digest) ||
    !('profile' in source) || source.profile !== IFC_STEP_PROFILE) throw new RegistryError('This version uses an unsupported model profile or registry.', 403);
  return { protocol: 'open-artifact/1', intent: value.intent, expires_at: value.expires_at,
    source: { registry: issuer, repository: repositoryName(source.repository), digest: source.digest, profile: IFC_STEP_PROFILE } };
}

/** Retain the original launch ceiling when a refresh reply omits the opening context. */
export function bindOpenArtifact(authorization: RegistryAuthorization, context: OpenArtifactContext): void {
  if (authorization.session.remembered) throw new RegistryError('Opening a shared version requires a tab-only session.', 403);
  authorization.session.openArtifact = context;
  authorization.session.sessionExpiresAt = Math.min(authorization.session.sessionExpiresAt, context.expires_at * 1000);
  authorization.session.expiresAt = Math.min(authorization.session.expiresAt, authorization.session.sessionExpiresAt);
}

export function launchAllows(context: OpenArtifactContext, repository: string, action: 'pull' | 'push', reference?: string): boolean {
  if (context.expires_at * 1000 <= Date.now()) return false;
  if (action === 'pull') return repository === context.source.repository && (reference === undefined || reference === context.source.digest);
  // Saving location and version are chosen in IFClite; token permissions remain the write ceiling.
  return context.intent === 'edit';
}
