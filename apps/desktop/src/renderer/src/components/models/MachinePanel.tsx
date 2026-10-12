import { useMutation } from '@tanstack/react-query';
import { formatBytes } from '../../lib/format';
import { BACKEND_NAMES, useModels } from '../../lib/models';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, Dot, ErrorText, Panel, ProgressBar, Row } from '../ui';

/** What clanks found on this machine and which llama.cpp build runs the models. */
export function MachinePanel({ compact = false }: { compact?: boolean }) {
  const trpc = useTRPC();
  const snapshot = useModels();
  const refresh = useMutation(trpc.models.refreshHardware.mutationOptions());
  const hardware = snapshot?.hardware;
  const runtime = snapshot?.runtime;

  return (
    <Panel
      title="This computer"
      description="Models run here, on clanks' own copy of llama.cpp."
      testId="hardware"
      actions={
        !compact && (
          <Button
            size="sm"
            variant="ghost"
            disabled={refresh.isPending || !hardware}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? 'Checking…' : 'Check again'}
          </Button>
        )
      }
    >
      {!hardware || !runtime ? (
        <p className="flex items-center gap-2 text-sm text-dim">
          <Dot tone="lavender" live /> Checking the GPU and memory…
        </p>
      ) : (
        <>
          <dl className="divide-y divide-line text-sm">
            <Row label="Runs on">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={hardware.gpus.length > 0 ? 'mint' : 'dim'}>
                  <Dot tone={hardware.gpus.length > 0 ? 'mint' : 'dim'} />
                  {BACKEND_NAMES[hardware.backend]}
                </Badge>
                {hardware.gpus.length > 0
                  ? hardware.gpus.map((gpu) => (
                      <span key={gpu.id}>
                        {gpu.name} <span className="text-dim">· {formatBytes(gpu.totalBytes)}</span>
                      </span>
                    ))
                  : hardware.cpu.model}
              </span>
            </Row>
            <Row label="Memory">
              {formatBytes(hardware.memory.totalBytes)}
              {hardware.memory.unified ? ' unified' : ''}
            </Row>
            <Row label="For models">
              {hardware.memory.unified ? (
                formatBytes(hardware.budget.gpuBytes)
              ) : (
                <>
                  {hardware.gpus.length > 0 && `${formatBytes(hardware.budget.gpuBytes)} of GPU, `}
                  {formatBytes(hardware.budget.systemBytes)} of system memory
                </>
              )}
              <span className="text-dim"> · leaving the rest for everything else</span>
            </Row>
            {!compact && (
              <Row label="Runtime">
                llama.cpp {runtime.version}
                <span className="text-dim">
                  {' '}
                  · {runtime.builds.map((b) => BACKEND_NAMES[b.backend]).join(', ')} builds
                </span>
              </Row>
            )}
          </dl>
          <CudaOffer />
          {hardware.problems.length > 0 && (
            <ul className="flex flex-col gap-1 text-[13px] text-dim">
              {hardware.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {refresh.error && <ErrorText>{refresh.error.message}</ErrorText>}
    </Panel>
  );
}

/** NVIDIA cards run models fastest on the CUDA build, which is too big to ship with the app. */
function CudaOffer() {
  const trpc = useTRPC();
  const snapshot = useModels();
  const install = useMutation(trpc.models.installRuntime.mutationOptions());
  const cancel = useMutation(trpc.models.cancelInstall.mutationOptions());
  const hardware = snapshot?.hardware;
  const runtime = snapshot?.runtime;
  const cuda = runtime?.downloadable.find((d) => d.backend === 'cuda');
  if (!hardware?.nvidia || !runtime || !cuda || hardware.backend === 'cuda') return null;
  const progress = runtime.install?.backend === 'cuda' ? runtime.install : null;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-accent/20 bg-accent/[0.06] p-4">
      <div className="flex items-center justify-between gap-6">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">Your NVIDIA GPU runs models faster on CUDA</p>
          <p className="text-[13px] text-dim">
            A one-time download of {formatBytes(cuda.size)} from llama.cpp's releases, checked
            before it's used.
          </p>
        </div>
        {progress && progress.state !== 'failed' ? (
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => install.mutate('cuda')}>
            {progress?.state === 'failed' ? 'Try again' : 'Download'}
          </Button>
        )}
      </div>
      {progress && progress.state !== 'failed' && (
        <div className="flex flex-col gap-1.5">
          <ProgressBar value={progress.totalBytes ? progress.doneBytes / progress.totalBytes : 0} />
          <p className="text-[12px] text-dim">
            {progress.state === 'downloading'
              ? `${formatBytes(progress.doneBytes)} of ${formatBytes(progress.totalBytes)}`
              : progress.state === 'verifying'
                ? 'Checking the download…'
                : 'Unpacking…'}
          </p>
        </div>
      )}
      {progress?.error && <ErrorText>{progress.error}</ErrorText>}
    </div>
  );
}
