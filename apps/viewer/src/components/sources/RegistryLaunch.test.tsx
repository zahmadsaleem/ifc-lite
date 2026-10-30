/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { act, StrictMode } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, click, type, waitFor, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { registryTransport, useRegistryWorkspace, updateRegistryWorkspace, clearRegistrySession } from '@/lib/registry/workspace';
import { prepareRegistryLaunch } from '@/lib/registry/open-artifact-oauth';
import { IFC_STEP_PROFILE, REGISTRY_LAUNCH_CALLBACK, REGISTRY_LAUNCH_CLIENT } from '@/lib/registry/open-artifact-contract';
import { clearRegistryLaunchLocation, registryLaunchLocation } from '@/registry-launch-location';
import RegistryLaunchRoute from './RegistryLaunchRoute';
import { RegistrySource } from './RegistrySource';

const initialFetch = globalThis.fetch;
const issuer = 'http://127.0.0.1:5000';
const digest = `sha256:${'a'.repeat(64)}`;
afterEach(() => { cleanup(); clearRegistrySession(); useRegistryWorkspace.setState({ transport: null }); globalThis.fetch = initialFetch; sessionStorage.clear(); clearRegistryLaunchLocation(); window.history.replaceState(null, '', '/'); });

function config() { return { ...registryOAuthConfig(issuer), client_id: REGISTRY_LAUNCH_CLIENT, issuer, open_artifact_protocol: 'open-artifact/1',
  redirect_uris: [window.location.origin + REGISTRY_LAUNCH_CALLBACK] }; }
async function callback() {
  const url = new URL(await prepareRegistryLaunch(`${window.location.origin}/open-artifact?issuer=${encodeURIComponent(issuer)}&request_id=${'1'.repeat(32)}`, new AbortController().signal));
  const result = new URL(url.searchParams.get('redirect_uri')!); result.searchParams.set('code', 'code'); result.searchParams.set('state', url.searchParams.get('state')!); result.searchParams.set('iss', issuer);
  return result;
}
function token(intent = 'edit') { return { ...registryTokenReply(), authorization_type: 'session',
  permissions: [{ repositories: ['project/model'], actions: ['pull'], digests: [digest] }, { repositories: ['reviews/model'], actions: ['push'], tags: ['review-*'] }],
  access: [{ type: 'registry', name: 'catalog', actions: ['read'] }],
  open_artifact: { protocol: 'open-artifact/1', source: { registry: issuer, repository: 'project/model', digest, profile: IFC_STEP_PROFILE }, intent, expires_at: Math.floor(Date.now() / 1000) + 3600 } }; }

test('receiver clears callback credentials before startup, including malformed and disabled launches (#8310)', async () => {
  window.history.replaceState(null, '', `${REGISTRY_LAUNCH_CALLBACK}?code=secret&code=duplicate&state=state&iss=${encodeURIComponent(issuer)}`);
  const captured = registryLaunchLocation(); assert(captured.includes('code=secret'));
  assert.equal(window.location.search, ''); assert.equal(registryLaunchLocation(), captured, 'StrictMode initialization sees the same callback');
  globalThis.fetch = async () => { throw new Error('Disabled receivers cannot use the network'); };
  const ui = render(<RegistryLaunchRoute enabled={false} />);
  assert(ui.textContent?.includes('not enabled')); assert.equal(window.location.search, '');
  assert.equal(ui.querySelector('button'), null);
});

test('StrictMode exchanges a callback once and keeps malformed profiles out of the viewer (#8310)', async () => {
  let exchanges = 0;
  globalThis.fetch = async input => {
    if (new URL(String(input)).pathname === '/oauth/config') return Response.json(config());
    exchanges++; return Response.json({ ...token(), open_artifact: { ...token().open_artifact, source: { ...token().open_artifact.source, profile: 'urn:unsupported:1' } } });
  };
  window.history.replaceState(null, '', (await callback()).href);
  const ui = render(<StrictMode><RegistryLaunchRoute enabled /></StrictMode>);
  await waitFor(() => Boolean(ui.querySelector('[role="alert"]')), 'invalid profile should be explained');
  assert(ui.textContent?.includes('unsupported')); assert.equal(exchanges, 1); assert.equal(window.location.search, '');
});

test('a launched model saves its actual edit to an allowed write-only destination without catalog or read probes (#8310)', async () => {
  const parser = new IfcParser();
  const bytes = new Uint8Array(await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url)));
  const store = await parser.parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const wall = store.entityIndex.byType.get('IFCWALL')?.[0] ?? store.entityIndex.byType.get('IFCWALLSTANDARDCASE')?.[0]; assert(wall);
  const id = 'opened-registry-version'; const view = new MutablePropertyView(store.properties ?? null, id);
  view.setAttribute(wall, 'Name', 'Receiver saved edit');
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel(id), ifcDataStore: store, schemaVersion: 'IFC4', name: 'edited.ifc' }),
    activeModelId: id, ifcDataStore: store, mutationViews: new Map([[id, view]]), mutationVersion: 1, georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null });
  const calls: string[] = []; let uploaded: Uint8Array<ArrayBuffer> | undefined; let upload = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth/config') return Response.json(config());
    if (url.pathname === '/oauth/token') return Response.json(token());
    if (url.pathname === '/token') return Response.json({ access_token: 'destination-only', expires_in: 900, access: [{ type: 'repository', name: 'reviews/model', actions: ['push'] }] });
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    assert.equal(init?.credentials, 'omit'); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer destination-only');
    if (init?.method === 'POST' && url.pathname.endsWith('/blobs/uploads/')) return new Response(null, { status: 202, headers: { Location: `/v2/reviews/model/blobs/uploads/${++upload}` } });
    if (init?.method === 'PUT' && url.pathname.includes('/blobs/uploads/')) {
      assert(init.body instanceof Uint8Array);
      if (new TextDecoder().decode(init.body.subarray(0, 64)).startsWith('ISO-10303-21;')) uploaded = new Uint8Array(init.body);
      return new Response(null, { status: 201 });
    }
    assert.equal(`${init?.method} ${url.pathname}`, 'PUT /v2/reviews/model/manifests/review-2');
    return new Response(null, { status: 201 });
  };
  const transport = registryTransport(window.location.origin); await transport.finishLaunch((await callback()).href, new AbortController().signal);
  updateRegistryWorkspace({ launchModelId: id });
  const ui = render(<RegistrySource expanded navigationDisabled={false} onToggle={() => {}} onBusyChange={() => {}} />);
  const fields = [...ui.querySelectorAll('input')]; assert.equal(fields.length, 2); assert.equal(fields[0].value, 'reviews/model');
  assert(ui.textContent?.includes('Allowed version names: review-*'));
  const save = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Publish edited model'); assert(save); assert(save.disabled);
  type(fields[1], 'review-2'); type(fields[0], 'private/model'); assert(save.disabled); type(fields[0], 'reviews/model'); assert(!save.disabled);
  const models = new Map(useViewerStore.getState().models);
  models.set('another-model', { ...fixtureModel('another-model'), ifcDataStore: store, schemaVersion: 'IFC4', name: 'another.ifc' });
  act(() => useViewerStore.setState({ models, activeModelId: 'another-model' }));
  assert(save.disabled, 'selecting another model must not publish it under this launch');
  act(() => useViewerStore.setState({ activeModelId: id })); assert(!save.disabled);
  click(save); await waitFor(() => Boolean(ui.textContent?.includes('new version was saved')), 'edited IFC should publish');
  assert(uploaded, 'the complete edited source was uploaded');
  const reopened = await parser.parseColumnar(uploaded.buffer, { disableWorkerScan: true });
  assert.equal(reopened.entities.getName(wall), 'Receiver saved edit');
  assert.equal(calls.length, 5); assert(calls.every(call => /^(POST|PUT) \/v2\/reviews\/model\//.test(call)), 'write-only launches never probe catalog, tags, blobs or the saved manifest');
  assert.equal(ui.querySelector('select'), null); assert(!ui.textContent?.includes('Manage shares'));
});

test('view intent hides publication even if a token contains write grants (#8310)', async () => {
  globalThis.fetch = async input => new URL(String(input)).pathname === '/oauth/config' ? Response.json(config()) : Response.json(token('view'));
  const transport = registryTransport(window.location.origin); await transport.finishLaunch((await callback()).href, new AbortController().signal);
  const ui = render(<RegistrySource expanded navigationDisabled={false} onToggle={() => {}} onBusyChange={() => {}} />);
  assert(ui.textContent?.includes('Read only')); assert(!ui.textContent?.includes('Publish edited model')); assert.equal(ui.querySelector('input'), null);
  assert(!transport.can('push', 'reviews/model', 'review-2'));
});
