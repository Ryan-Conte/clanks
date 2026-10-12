import type { ModelId, Settings } from '@clanks/core';
import type { ModelManager } from '@clanks/models';
import type { SettingsService } from './settings';

/**
 * First run in one step: the model is pulled, the faster build for an NVIDIA card comes with it,
 * and the crew gets the model as soon as it's there. What's being set up is a setting, so it
 * carries on with the window closed and after a restart, as pulls do.
 */
export function startSetup(
  models: ModelManager,
  settings: SettingsService,
  modelId: ModelId,
): Settings {
  if (!models.library().some((m) => m.id === modelId)) {
    const going = models.pulls
      .list()
      .find((p) => p.modelId === modelId && p.state !== 'done' && p.state !== 'failed');
    if (going?.state === 'paused') models.pulls.resume(going.id);
    else if (!going) models.pull(modelId);
  }
  const hardware = models.hardware();
  const runtime = models.runtime();
  if (
    hardware?.nvidia &&
    hardware.backend !== 'cuda' &&
    runtime.downloadable.some((d) => d.backend === 'cuda') &&
    (!runtime.install || runtime.install.state === 'failed')
  ) {
    // The model runs without it, only slower, so a failed download doesn't hold setup up. The
    // Models screen shows what went wrong and offers it again.
    void models.installRuntime('cuda').catch(() => {});
  }
  settings.update({ setupModel: modelId });
  return finishSetup(models, settings);
}

/** Gives the crew the model being set up once it's pulled. Called whenever the models change. */
export function finishSetup(models: ModelManager, settings: SettingsService): Settings {
  const current = settings.get();
  const { setupModel } = current;
  if (!setupModel) return current;
  // A model is in the library once its pull is checked and done.
  if (!models.library().some((m) => m.id === setupModel)) return current;
  return settings.update({
    // A model the user picked for the crew meanwhile stays.
    crewModel: current.crewModel ?? setupModel,
    onboarded: true,
    setupModel: null,
  });
}
