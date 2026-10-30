/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryArtifacts, IFC_ARTIFACT_TYPE } from './artifacts';
import { RegistryTransport } from './transport';
import { RegistryError } from './protocol';
import { prepareRegistryLaunch } from './open-artifact-oauth';
import { IFC_STEP_PROFILE, REGISTRY_LAUNCH_CALLBACK, REGISTRY_LAUNCH_CLIENT } from './open-artifact-contract';
import { REGISTRY_CALLBACK_PATH } from './oauth';
import { approveRegistryLogin, installRegistryPopup } from '@/test/registry-oauth-fixture';

const browser = new Window({ url: 'http://localhost:3033/' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: browser.DOMParser });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: browser.sessionStorage });

test('real registry launches pin the IFC source, renew limited access and save to a write-only destination (#8310)', { timeout: 60000 }, async context => {
  const binary = process.env.OCI_REGISTRY_BINARY;
  if (!binary) { context.skip('Set OCI_REGISTRY_BINARY to a registry supporting open-artifact/1.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ifclite-launch-')); const data = join(root, 'data');
  const applications = join(root, 'applications.json'); const password = 'launch-fixture-password';
  await writeFile(applications, JSON.stringify({ version: 1,
    profiles: [{ id: IFC_STEP_PROFILE, artifact_type: IFC_ARTIFACT_TYPE, config_media_type: 'application/vnd.oci.empty.v1+json' }],
    applications: [{ id: REGISTRY_LAUNCH_CLIENT, name: 'IFClite', launch_url: window.location.origin + '/open-artifact',
      redirect_uris: [window.location.origin + REGISTRY_LAUNCH_CALLBACK], cors_origins: [window.location.origin],
      supports: [{ profile: IFC_STEP_PROFILE, intents: ['view', 'edit'], publish: true }] }] }));
  execFileSync(binary, ['user', 'add', '--data', data, 'writer', '--grant', 'project/model:pull,push', '--grant', 'reviews/model:pull,push', '--password-stdin'], { input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  const server = spawn(binary, ['serve', '--data', data, '--listen', '127.0.0.1:0', '--applications', applications,
    '--oauth-client-id', 'ifc-lite', '--oauth-redirect-uri', window.location.origin + REGISTRY_CALLBACK_PATH], { stdio: ['ignore', 'ignore', 'pipe'] });
  const originalFetch = globalThis.fetch;
  const popup = installRegistryPopup(request => approveRegistryLogin(request, 'writer', password));
  const clients: RegistryTransport[] = []; let seedRoot = ''; let origin = ''; let receiving = false;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === window.location.origin) url = new URL(url.pathname + url.search, origin);
    if (receiving) calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const response = await originalFetch(url, init);
    if (url.pathname === '/oauth/token' && new URLSearchParams(String(init?.body)).get('client_id') === 'ifc-lite' && response.ok) {
      const value: unknown = await response.clone().json();
      if (value && typeof value === 'object' && 'access_token' in value && typeof value.access_token === 'string') seedRoot = value.access_token;
    }
    return response;
  };
  try {
    origin = await new Promise<string>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Registry did not start')), 5000);
      server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error(`Registry exited during startup: ${output}`)); });
    });
    const seed = new RegistryTransport(origin, origin); clients.push(seed); await seed.login(null); assert(seedRoot);
    const source = new Uint8Array(await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url)));
    const seedArtifacts = new RegistryArtifacts(seed);
    const digest = await seedArtifacts.publish('project/model', 'issued', source, 'hello-wall.ifc');
    const hidden = await seedArtifacts.publish('project/model', 'other', source, 'other.ifc'); assert.notEqual(digest, hidden);
    const launch = async (intent: 'view' | 'edit') => {
      const response = await originalFetch(origin + '/open-artifact/launches', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${seedRoot}` },
        body: JSON.stringify({ application_id: REGISTRY_LAUNCH_CLIENT, repository: 'project/model', reference: digest, intent, ttl: 1800,
          ...(intent === 'edit' ? { publish: { repository: 'reviews/model', allowed_tags: ['review-*'] } } : {}) }) });
      assert.equal(response.status, 200, await response.clone().text());
      const value: unknown = await response.json(); assert(value && typeof value === 'object' && 'launch_url' in value && typeof value.launch_url === 'string');
      const authorization = await prepareRegistryLaunch(value.launch_url, new AbortController().signal, origin);
      const callback = await approveRegistryLogin(new URL(authorization), 'writer', password);
      const receiver = new RegistryTransport(origin, origin); clients.push(receiver);
      await receiver.finishLaunch(callback, new AbortController().signal); return receiver;
    };
    receiving = true; const receiver = await launch('edit'); const artifacts = new RegistryArtifacts(receiver);
    assert.equal(receiver.session?.openArtifact?.source.digest, digest);
    assert.deepEqual((await artifacts.pull('project/model', digest)).bytes, source);
    await assert.rejects(artifacts.pull('project/model', hidden), (error: unknown) => error instanceof RegistryError && error.status === 403);
    assert(receiver.can('push', 'reviews/model', 'review-1')); assert(!receiver.can('push', 'reviews/model', 'issued'));
    assert(!receiver.can('pull', 'reviews/model'));
    const edited = new TextEncoder().encode(new TextDecoder().decode(source).replace('ISO-10303-21;', 'ISO-10303-21;\n/* revised in receiver */'));
    const saved = await artifacts.publish('reviews/model', 'review-1', edited, 'edited.ifc');
    await assert.rejects(artifacts.publish('reviews/model', 'issued', edited, 'edited.ifc'), (error: unknown) => error instanceof RegistryError && error.status === 403);
    const selected = receiver.session?.openArtifact; const deadline = receiver.session?.sessionExpiresAt;
    // Force access renewal through the real HTTP path without changing the session's absolute deadline.
    assert(receiver.session); receiver.session.expiresAt = Date.now() - 1;
    await artifacts.pull('project/model', digest); assert.deepEqual(receiver.session?.openArtifact, selected); assert.equal(receiver.session?.sessionExpiresAt, deadline);
    assert(!calls.some(call => /_catalog|tags\/list|HEAD \/v2\/reviews/.test(call)), 'receiving and saving need no catalog, version listing or destination read probes');
    receiving = false; assert.deepEqual((await seedArtifacts.pull('reviews/model', saved)).bytes, edited, 'an independent session can reopen the complete saved artifact');
    const viewer = await launch('view'); assert(!viewer.can('push', 'reviews/model', 'review-2'));
    assert.deepEqual((await new RegistryArtifacts(viewer).pull('project/model', digest)).bytes, source);
    await receiver.signOut(); assert.equal(receiver.session, null);
  } finally {
    globalThis.fetch = originalFetch; for (const client of clients) client.logout(); popup.restore(); sessionStorage.clear();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>(resolve => server.once('exit', () => resolve())); server.kill('SIGTERM'); await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
