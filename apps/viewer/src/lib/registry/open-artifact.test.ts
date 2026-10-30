/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { finishRegistryLaunch, prepareRegistryLaunch } from './open-artifact-oauth';
import { IFC_STEP_PROFILE, REGISTRY_LAUNCH_CALLBACK, REGISTRY_LAUNCH_CLIENT, launchAllows, openArtifactContext } from './open-artifact-contract';
import { RegistryTransport } from './transport';
import { RegistryError } from './protocol';
import { parseGrants } from './grants';

const issuer = 'http://127.0.0.1:5000';
const source = { registry: issuer, repository: 'project/model', digest: `sha256:${'a'.repeat(64)}`, profile: IFC_STEP_PROFILE };
const originalFetch = globalThis.fetch;
const clients: RegistryTransport[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.logout(); sessionStorage.clear(); globalThis.fetch = originalFetch; });
function context() { return { protocol: 'open-artifact/1', source, intent: 'edit', expires_at: Math.floor(Date.now() / 1000) + 3600 }; }
function permissions() { return [{ repositories: [source.repository], actions: ['pull'], digests: [source.digest] }, { repositories: ['reviews/model'], actions: ['push'], tags: ['review-*'] }]; }
function reply() { return { ...registryTokenReply(), authorization_type: 'session', permissions: permissions(), access: [{ type: 'registry', name: 'catalog', actions: ['read'] }] }; }
function config() { return { ...registryOAuthConfig(issuer), client_id: REGISTRY_LAUNCH_CLIENT, issuer, open_artifact_protocol: 'open-artifact/1',
  refresh_cookie_name: 'oci_registry_refresh_client_specific', redirect_uris: [window.location.origin + REGISTRY_LAUNCH_CALLBACK] }; }
function client() { const result = new RegistryTransport(window.location.origin, issuer); clients.push(result); return result; }
async function begin() {
  const href = `${window.location.origin}/open-artifact?issuer=${encodeURIComponent(issuer)}&request_id=${'1'.repeat(32)}`;
  const request = new URL(await prepareRegistryLaunch(href, new AbortController().signal));
  const callback = new URL(request.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', request.searchParams.get('state')!); callback.searchParams.set('iss', issuer); callback.searchParams.set('code', 'one-use-code');
  return { request, callback };
}

test('Open Artifact uses registered PKCE, consumes callback state, and retains the digest and write permissions (#8310)', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    if (url.pathname === '/oauth/config') { assert.equal(url.searchParams.get('client_id'), REGISTRY_LAUNCH_CLIENT); return Response.json(config()); }
    assert.equal(url.pathname, '/oauth/token'); const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('client_id'), REGISTRY_LAUNCH_CLIENT); assert(body.get('code_verifier')); assert.equal(body.get('code'), 'one-use-code');
    return Response.json({ ...reply(), open_artifact: context() });
  };
  const { request, callback } = await begin();
  assert.equal(request.origin, issuer); assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(request.searchParams.get('launch_request'), '1'.repeat(32));
  assert(!sessionStorage.getItem('ifc-lite:registry-launch-pkce')?.includes('test-refresh-only'));
  const transport = client(); await transport.finishLaunch(callback.href, new AbortController().signal);
  assert.equal(sessionStorage.length, 0); assert.equal(transport.session?.remembered, false);
  assert.deepEqual(transport.session?.permissions?.[0].digests, [source.digest]);
  assert(transport.can('pull', source.repository, source.digest)); assert(!transport.can('pull', source.repository, 'other'));
  assert(!transport.can('pull', 'reviews/model')); assert(transport.can('push', 'reviews/model', 'review-2'));
  assert(!transport.can('push', 'reviews/model', 'issued')); assert(!transport.can('push', source.repository, 'review-2'));
  await assert.rejects(transport.shareRequest('/shares'), /account/);
  await assert.rejects(finishRegistryLaunch(callback.href, new AbortController().signal), /open this model again/);
  assert.deepEqual(calls, ['/oauth/config', '/oauth/config', '/oauth/token'], 'launches never need catalog or tag listing');
});

test('callback ambiguity, wrong issuer/state/path and expired transactions fail before token exchange (#8310)', async context => {
  for (const failure of ['issuer', 'state', 'path', 'duplicate-issuer', 'duplicate-code', 'code-and-error', 'expired']) await context.test(failure, async scenario => {
    let now = Date.now(); scenario.mock.method(Date, 'now', () => now); let exchanges = 0;
    globalThis.fetch = async input => { if (new URL(String(input)).pathname === '/oauth/token') exchanges++; return Response.json(config()); };
    const { callback } = await begin();
    if (failure === 'issuer') callback.searchParams.set('iss', 'http://localhost:5000');
    if (failure === 'state') callback.searchParams.set('state', 'wrong');
    if (failure === 'path') callback.pathname = '/other';
    if (failure === 'duplicate-issuer') callback.searchParams.append('iss', issuer);
    if (failure === 'duplicate-code') callback.searchParams.append('code', 'other');
    if (failure === 'code-and-error') callback.searchParams.set('error', 'denied');
    if (failure === 'expired') now += 300001;
    await assert.rejects(finishRegistryLaunch(callback.href, new AbortController().signal));
    assert.equal(exchanges, 0); assert.equal(sessionStorage.length, 0);
  });
});

test('untrusted or ambiguous launch addresses cannot start discovery (#8310)', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Unexpected discovery'); };
  const valid = new URL(`${window.location.origin}/open-artifact?issuer=${encodeURIComponent(issuer)}&request_id=${'1'.repeat(32)}`);
  for (const change of [(u: URL) => u.searchParams.set('issuer', 'https://foreign.example'), (u: URL) => u.searchParams.append('issuer', issuer),
    (u: URL) => u.searchParams.set('request_id', '../other'), (u: URL) => u.hash = '#secret']) {
    const input = new URL(valid); change(input);
    await assert.rejects(prepareRegistryLaunch(input.href, new AbortController().signal));
  }
  assert.equal(calls, 0);
});

test('renewal preserves the launch ceiling without another popup, and logout rejects a late code exchange (#8310)', async scenario => {
  let now = Date.now(); scenario.mock.method(Date, 'now', () => now);
  let rotations = 0; let late = false; let began!: () => void; let release!: (value: Response) => void;
  const exchanging = new Promise<void>(resolve => { began = resolve; });
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/oauth/config') return Response.json(config());
    if (path === '/token') return Response.json({ access_token: 'scoped', expires_in: 900, access: [{ type: 'repository', name: source.repository, actions: ['pull'] }] });
    if (path !== '/oauth/token') return Response.json({});
    const body = new URLSearchParams(String(init?.body));
    if (body.get('grant_type') === 'refresh_token') {
      rotations++;
      return Response.json({ ...reply(), permissions: [permissions()[0], { repositories: ['reviews/model', 'unapproved/model'], actions: ['push'], tags: ['*'] }] });
    }
    if (late) return new Promise<Response>(resolve => { release = resolve; began(); });
    return Response.json({ ...reply(), open_artifact: context() });
  };
  const transport = client(); const first = await begin(); await transport.finishLaunch(first.callback.href, new AbortController().signal);
  const selected = transport.session?.openArtifact; const deadline = transport.session?.sessionExpiresAt;
  now += 901000; await transport.request(`/v2/${source.repository}/manifests/${source.digest}`);
  assert.equal(rotations, 1); assert.equal(transport.session?.sessionExpiresAt, deadline); assert.deepEqual(transport.session?.openArtifact, selected);
  assert(!transport.can('pull', source.repository, 'other')); assert(transport.can('push', 'reviews/model', 'review-3'));
  assert(!transport.can('push', 'reviews/model', 'issued')); assert(!transport.can('push', 'unapproved/model', 'review-3'), 'refresh cannot widen the original write ceiling');
  const second = await begin(); late = true;
  const pending = transport.finishLaunch(second.callback.href, new AbortController().signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' }); await exchanging; transport.logout();
  release(Response.json({ ...reply(), open_artifact: context() })); await rejected; assert.equal(transport.session, null);
});

test('unsupported profiles, expired contexts, and write-capable digest rules are refused (#8310)', () => {
  for (const value of [{ ...context(), protocol: 'other' }, { ...context(), expires_at: 1 }, { ...context(), intent: 'delete' },
    { ...context(), source: { ...source, profile: 'urn:other:1' } }, { ...context(), source: { ...source, registry: 'https://other.example' } }]) {
    assert.throws(() => openArtifactContext(value, issuer), RegistryError);
  }
  const view = openArtifactContext({ ...context(), intent: 'view' }, issuer);
  assert(!launchAllows(view, source.repository, 'push', 'new'));
  assert.throws(() => parseGrants([{ repositories: [source.repository], actions: ['push'], digests: [source.digest] }]));
  assert.throws(() => parseGrants([{ repositories: [source.repository], actions: ['pull'], digests: [source.digest], tags: ['*'] }]));
});
