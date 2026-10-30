/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import type { FileSourceProviderFactory } from '@/services/sources/source-host';
import { ViewerRoot } from '@/components/viewer/ViewerRoot';
import { useTranslation } from '@/i18n';
import { prepareRegistryLaunch } from '@/lib/registry/open-artifact-oauth';
import { REGISTRY_LAUNCH_CALLBACK, REGISTRY_LAUNCH_PATH } from '@/lib/registry/open-artifact-contract';
import { registryTransport } from '@/lib/registry/workspace';
import { RegistryError } from '@/lib/registry/protocol';
import { RegistryLaunchLoader } from './RegistryLaunchLoader';
import { registryLaunchLocation, clearRegistryLaunchLocation } from '@/registry-launch-location';

/** Receive authorization before mounting the viewer or analytics on a callback URL. */
export default function RegistryLaunchRoute({ sourceProviders, enabled = import.meta.env?.VITE_REGISTRY_ENABLED === 'true' }: {
  sourceProviders?: readonly FileSourceProviderFactory[]; enabled?: boolean;
}) {
  const { t } = useTranslation();
  const [href] = useState(registryLaunchLocation);
  const callback = new URL(href).pathname === REGISTRY_LAUNCH_CALLBACK;
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(enabled);
  const [error, setError] = useState('');
  const translate = useRef(t); translate.current = t;
  useEffect(() => {
    // Even malformed or disabled callbacks must not retain codes in history.
    window.history.replaceState(null, '', REGISTRY_LAUNCH_PATH);
    clearRegistryLaunchLocation();
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(new RegistryError('Opening the registry model timed out. Return to the registry and try again.')), 15000);
    // React StrictMode cleans up its first effect before the microtask. Redeem the code only once.
    queueMicrotask(() => {
      if (disposed || !enabled) return;
      const opening = callback
        ? registryTransport(window.location.origin).finishLaunch(href, controller.signal).then(() => { if (!disposed) setReady(true); })
        : prepareRegistryLaunch(href, controller.signal).then(url => { controller.signal.throwIfAborted(); window.location.assign(url); });
      void opening
        .catch((failure: unknown) => { if (!disposed) setError(failure instanceof Error ? failure.message : translate.current('registry.failed')); })
        .finally(() => { clearTimeout(timer); if (!disposed) setBusy(false); });
    });
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [callback, enabled, href]);

  if (ready) return <ViewerRoot sourceProviders={sourceProviders}><RegistryLaunchLoader /></ViewerRoot>;
  return <main className="flex min-h-screen items-center justify-center bg-background p-6">
    <div className="w-full max-w-md space-y-4 rounded-lg border p-6">
      <h1 className="text-xl font-semibold">{t('registry.launch.title')}</h1>
      <p className="text-sm text-muted-foreground">{t(enabled ? 'registry.launch.explain' : 'registry.launch.disabled')}</p>
      {busy && <output className="block text-sm">{t('registry.working')}</output>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <a className="block text-sm underline" href="/">{t('registry.launch.viewer')}</a>
    </div>
  </main>;
}
