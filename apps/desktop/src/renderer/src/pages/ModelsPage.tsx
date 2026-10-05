import { useRef, useState } from 'react';
import { CatalogPanel } from '../components/models/CatalogPanel';
import { LibraryPanel } from '../components/models/LibraryPanel';
import { LoadedPanel } from '../components/models/LoadedPanel';
import { MachinePanel } from '../components/models/MachinePanel';
import { PullPanel } from '../components/models/PullPanel';
import { StoragePanel } from '../components/models/StoragePanel';
import { TryPanel } from '../components/models/TryPanel';
import { useModels } from '../lib/models';

export function ModelsPage() {
  const snapshot = useModels();
  const [tryModel, setTryModel] = useState<string | null>(null);
  const tryRef = useRef<HTMLDivElement>(null);
  const crew = snapshot?.library.find((m) => m.id === snapshot.crewModel);

  return (
    <div className="relative mx-auto flex max-w-4xl flex-col gap-8 px-10 py-12">
      <header className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Models</h1>
          <p className="text-dim">Pulled and run on this machine. Nothing leaves it.</p>
        </div>
        {crew && (
          <p className="text-right text-sm text-dim">
            The crew runs on
            <br />
            <span className="font-medium text-white">{crew.title}</span>
          </p>
        )}
      </header>
      <MachinePanel />
      <LoadedPanel />
      <PullPanel />
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
      <StoragePanel />
    </div>
  );
}
