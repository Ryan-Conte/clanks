import { useRef, useState } from 'react';
import { CatalogPanel } from '../components/models/CatalogPanel';
import { LibraryPanel } from '../components/models/LibraryPanel';
import { LoadedPanel } from '../components/models/LoadedPanel';
import { MachinePanel } from '../components/models/MachinePanel';
import { OllamaPanel } from '../components/models/OllamaPanel';
import { PullPanel, PullRow } from '../components/models/PullPanel';
import { StoragePanel } from '../components/models/StoragePanel';
import { TryPanel } from '../components/models/TryPanel';
import { Button, Disclosure, Dot, PageHeader, Panel } from '../components/ui';
import { formatBytes } from '../lib/format';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';

/**
 * The models the crew thinks with. What it runs on now comes first; how this computer runs them,
 * and the rest that only some people want, is folded away below.
 */
export function ModelsPage() {
  const snapshot = useModels();
  const { go } = useNav();
  const [tryModel, setTryModel] = useState<string | null>(null);
  const tryRef = useRef<HTMLDivElement>(null);
  const crew = snapshot?.library.find((m) => m.id === snapshot.crewModel);
  const loaded = snapshot?.runtime.loaded.find((l) => l.modelId === crew?.id);
  // A finished download shows up under "On this computer"; it needn't stay here too.
  const downloads = (snapshot?.pulls ?? []).filter((p) => p.state !== 'done');

  return (
    <div className="relative mx-auto flex max-w-4xl flex-col gap-8 px-10 py-12">
      <PageHeader
        title="Models"
        description="An AI model is what the crew thinks with. They're downloaded to this computer and run here, so nothing you make leaves it."
      />

      <section className="flex items-center justify-between gap-6 rounded-3xl border border-line bg-panel/60 p-7">
        {crew ? (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-sm text-dim">The crew runs on</p>
              <p className="flex items-center gap-2.5 text-lg font-medium tracking-tight">
                <Dot tone="mint" live={(loaded?.inUse ?? 0) > 0} /> {crew.title}
              </p>
              <p className="text-[13px] text-dim">
                {formatBytes(crew.size)} on this computer.{' '}
                {loaded
                  ? loaded.inUse > 0
                    ? 'Working right now.'
                    : 'Loaded and ready.'
                  : 'It wakes up when someone needs it.'}
              </p>
            </div>
            <p className="max-w-xs text-right text-[13px] text-dim">
              To change it, pick another below and choose "Use for the crew".
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-lg font-medium tracking-tight">The crew has no model yet</p>
              <p className="text-sm text-dim">
                One download sets it up with the model that suits this computer.
              </p>
            </div>
            <Button variant="primary" onClick={() => go({ page: 'setup' })}>
              Set up the crew
            </Button>
          </>
        )}
      </section>

      {downloads.length > 0 && (
        <Panel title="Downloading">
          <ul className="flex flex-col gap-4">
            {downloads.map((item) => (
              <PullRow key={item.id} item={item} />
            ))}
          </ul>
        </Panel>
      )}

      <LibraryPanel
        onTry={(id) => {
          setTryModel(id);
          tryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
      />
      <div ref={tryRef}>
        <TryPanel model={tryModel} onModel={setTryModel} />
      </div>
      <CatalogPanel />

      <Disclosure summary="Advanced: this computer, what's loaded, other ways to get models, and where they're kept">
        <div className="flex flex-col gap-8">
          <MachinePanel />
          <LoadedPanel />
          <PullPanel />
          <OllamaPanel />
          <StoragePanel />
        </div>
      </Disclosure>
    </div>
  );
}
