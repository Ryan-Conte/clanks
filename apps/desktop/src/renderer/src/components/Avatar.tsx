import type { Avatar as AvatarColour } from '@clanks/core';
import { AVATAR_GRADIENTS } from '../lib/crew';

const SIZES = {
  xs: 'size-5',
  sm: 'size-7',
  md: 'size-9',
  lg: 'size-14',
  xl: 'size-20',
} as const;

/** A clank: a gradient disc with one dark eye, like the crew on clanks.si. */
export function Avatar({
  colour,
  size = 'sm',
  live = false,
}: {
  colour: AvatarColour;
  size?: keyof typeof SIZES;
  /** Working right now: the eye pulses, and a ring breathes around it. */
  live?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`relative grid shrink-0 place-items-center rounded-full bg-gradient-to-br ${AVATAR_GRADIENTS[colour]} ${SIZES[size]} ${live ? 'animate-breathe' : ''}`}
    >
      <span
        className={`h-[38%] w-[38%] rounded-full bg-black/70 ${live ? 'animate-pulse-dot' : ''}`}
      />
    </span>
  );
}
