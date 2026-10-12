import type { UserProfile } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText, Panel, inputClass } from '../ui';

const zones = Intl.supportedValuesOf('timeZone');
const here = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What every clank knows about the user, in every project. */
export function ProfilePanel() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  if (!settings.data) return null;
  // Remount with the saved profile so the form starts from it.
  return <ProfileForm key={JSON.stringify(settings.data.profile)} saved={settings.data.profile} />;
}

function ProfileForm({ saved }: { saved: UserProfile }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState(saved);
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
    }),
  );
  const set = (patch: Partial<UserProfile>) => setProfile((p) => ({ ...p, ...patch }));
  const dirty = JSON.stringify(profile) !== JSON.stringify(saved);

  return (
    <Panel
      title="Your profile"
      description="Every clank knows this about you, in every project. Keep it short; it's in every prompt."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ profile });
        }}
      >
        <div className="grid grid-cols-2 gap-4">
          <Label text="Name" hint="What the clanks call you.">
            <input
              className={inputClass}
              value={profile.name}
              maxLength={60}
              placeholder="the user"
              onChange={(e) => set({ name: e.target.value })}
            />
          </Label>
          <Label text="Time zone" hint={`Empty uses this computer's: ${here}.`}>
            <input
              className={inputClass}
              list="time-zones"
              value={profile.timeZone}
              placeholder={here}
              onChange={(e) => set({ timeZone: e.target.value })}
            />
            <datalist id="time-zones">
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </Label>
        </div>
        <Label text="Language" hint="And spelling, such as Australian English.">
          <input
            className={inputClass}
            value={profile.language}
            maxLength={60}
            placeholder="English"
            onChange={(e) => set({ language: e.target.value })}
          />
        </Label>
        <Label text="How you like to work" hint="How you like replies, and things never to do.">
          <textarea
            className={`${inputClass} h-24 resize-y py-2.5 leading-relaxed`}
            value={profile.preferences}
            maxLength={1000}
            placeholder="Short answers. Ask before adding dependencies."
            onChange={(e) => set({ preferences: e.target.value })}
          />
        </Label>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!dirty || update.isPending}>
            Save
          </Button>
          {update.isSuccess && !dirty && <span className="text-sm text-dim">Saved.</span>}
        </div>
        {update.error && <ErrorText>{update.error.message}</ErrorText>}
      </form>
    </Panel>
  );
}

function Label(props: { text: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{props.text}</span>
        <span className="text-[12px] text-dim">{props.hint}</span>
      </span>
      {props.children}
    </label>
  );
}
