/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { useViewerStore } from '@/store';
import { sanitizeFilename } from '@/lib/export/download';
import { RegistryArtifacts } from '@/lib/registry/artifacts';
import { RegistryError } from '@/lib/registry/protocol';
import { updateRegistryWorkspace, useRegistryWorkspace } from '@/lib/registry/workspace';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

/** Pull the immutable source once, then pass it through the canonical model-loading path. */
export function RegistryLaunchLoader() {
  const { t } = useTranslation();
  const { loadFile } = useIfcLoader();
  const loader = useRef(loadFile); loader.current = loadFile;
  const translate = useRef(t); translate.current = t;
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      setBusy(true); setError('');
      void (async () => {
        const { transport, session } = useRegistryWorkspace.getState();
        const context = session?.openArtifact;
        if (!transport || !context) throw new RegistryError('Return to the registry and open this model again.');
        const received = await new RegistryArtifacts(transport).pull(context.source.repository, context.source.digest, controller.signal);
        controller.signal.throwIfAborted();
        await loader.current(new File([received.bytes], sanitizeFilename(received.filename, { fallback: 'model.ifc' }), { type: 'application/x-step' }));
        controller.signal.throwIfAborted();
        const state = useViewerStore.getState();
        if (state.error || !state.activeModelId) throw new RegistryError(state.error || 'The selected model could not be opened.');
        updateRegistryWorkspace({ launchModelId: state.activeModelId, repository: context.source.repository, release: context.source.digest, fingerprint: received.digest });
        state.setEditEnabled(context.intent === 'edit');
        state.setSourcesPanelVisible(true);
      })().catch((failure: unknown) => { if (!disposed) setError(failure instanceof Error ? failure.message : translate.current('registry.failed')); })
        .finally(() => { if (!disposed) setBusy(false); });
    });
    return () => { disposed = true; controller.abort(); };
  }, [attempt]);
  if (!busy && !error) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6">
    <div className="max-w-md space-y-3 rounded-lg border bg-background p-6">
      {busy && <output>{t('registry.launch.loading')}</output>}
      {error && <><p role="alert" className="text-sm text-destructive">{error}</p><Button onClick={() => setAttempt(value => value + 1)}>{t('registry.launch.retry')}</Button></>}
    </div>
  </div>;
}
