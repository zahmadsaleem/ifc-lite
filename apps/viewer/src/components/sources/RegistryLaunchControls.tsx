/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useState } from 'react';
import { useViewerStore } from '@/store';
import { RegistryArtifacts } from '@/lib/registry/artifacts';
import { exportRegistryModel } from '@/lib/registry/export-model';
import type { RegistryTransport } from '@/lib/registry/transport';
import { RegistryError } from '@/lib/registry/protocol';
import { repositoryMatches } from '@/lib/registry/grants';
import { useRegistryWorkspace, updateRegistryWorkspace } from '@/lib/registry/workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';

/** Save As belongs to the receiving app; server-issued grants decide which destinations are allowed. */
export function RegistryLaunchControls({ transport, busy, run }: {
  transport: RegistryTransport; busy: boolean; run: (operation: (signal: AbortSignal) => Promise<void>) => void;
}) {
  const { t } = useTranslation(); const id = useId();
  const { session, launchModelId, version, published } = useRegistryWorkspace();
  const context = session?.openArtifact;
  const [destination, setDestination] = useState(() => {
    const source = context?.source.repository ?? '';
    return transport.can('push', source) ? source : session?.permissions?.filter(g => g.actions.includes('push')).flatMap(g => g.repositories).find(r => !r.includes('*')) ?? source;
  });
  const activeModel = useViewerStore(state => state.activeModelId ?? (state.models.size === 1 ? state.models.keys().next().value : undefined));
  const openedModel = useViewerStore(state => launchModelId ? state.models.get(launchModelId) : undefined);
  if (!context) return null;
  const writable = context.intent === 'edit' && session?.permissions?.some(g => g.actions.includes('push'));
  const patterns = [...new Set(session?.permissions?.filter(g => g.actions.includes('push') && g.repositories.some(p => repositoryMatches(p, destination))).flatMap(g => g.tags ?? ['*']) ?? [])];
  return <div className="grid gap-3">
    <p className="text-sm">{t('registry.launch.selected')}</p>
    <p className="text-xs text-muted-foreground">{t(writable ? 'registry.writable' : 'registry.readOnly')}</p>
    {writable && <>
      <p className="text-xs text-muted-foreground">{openedModel ? t('registry.activeModel', { name: openedModel.name }) : t('registry.noModel')}</p>
      <Label htmlFor={`${id}-destination`}>{t('registry.launch.destination')}</Label>
      <Input id={`${id}-destination`} autoComplete="off" value={destination} disabled={busy} onChange={event => setDestination(event.target.value)} />
      <Label htmlFor={`${id}-version`}>{t('registry.newVersion')}</Label>
      <Input id={`${id}-version`} value={version} disabled={busy} onChange={event => updateRegistryWorkspace({ version: event.target.value })} />
      <p className="text-xs text-muted-foreground">{patterns.length ? t('registry.launch.naming', { patterns: patterns.join(', ') }) : t('registry.launch.destinationDenied')}</p>
      <Button disabled={busy || !openedModel || activeModel !== launchModelId || !transport.can('push', destination, version) || !version} onClick={() => run(async signal => {
        const current = useRegistryWorkspace.getState();
        if (!current.launchModelId || useViewerStore.getState().activeModelId !== current.launchModelId) throw new RegistryError('Select the model opened from this registry before publishing.');
        const source = await exportRegistryModel(); signal.throwIfAborted();
        const digest = await new RegistryArtifacts(transport).publish(destination, version, source.bytes, source.filename, signal);
        signal.throwIfAborted(); updateRegistryWorkspace({ published: digest });
      })}>{t('registry.publish')}</Button>
      {published && <output className="text-sm">{t('registry.launch.saved')}</output>}
    </>}
    <details><summary className="cursor-pointer text-xs">{t('registry.details')}</summary>
      <p className="break-all text-xs">{context.source.registry}/{context.source.repository}@{context.source.digest}</p>
    </details>
  </div>;
}
