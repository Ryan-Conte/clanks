import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Panel(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={props.testId}
      className="flex flex-col gap-5 rounded-3xl border border-line bg-panel/60 p-7 backdrop-blur-xl"
    >
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-medium tracking-tight">{props.title}</h2>
          {props.description && <p className="text-sm text-dim">{props.description}</p>}
        </div>
        {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
      </header>
      {props.children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-4 py-3 first:pt-0 last:pb-0">
      <dt className="text-dim">{label}</dt>
      <dd className="min-w-0 text-white/90">{children}</dd>
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const variants = {
    primary: 'bg-white text-black hover:bg-white/90',
    secondary: 'border border-line bg-white/5 text-white hover:bg-white/10',
    ghost: 'text-dim hover:bg-white/5 hover:text-white',
    danger: 'border border-rose-400/30 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20',
  };
  const sizes = { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-5 text-sm' };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}

export type Tone = 'mint' | 'lavender' | 'amber' | 'rose' | 'dim';

const tones: Record<Tone, string> = {
  mint: 'border-accent-2/25 bg-accent-2/10 text-accent-2',
  lavender: 'border-accent/25 bg-accent/10 text-accent',
  amber: 'border-amber-300/25 bg-amber-300/10 text-amber-200',
  rose: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  dim: 'border-line bg-white/5 text-dim',
};

export function Badge({ tone = 'dim', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** A status dot. Live ones pulse, like on clanks.si. */
export function Dot({ tone = 'mint', live = false }: { tone?: Tone; live?: boolean }) {
  const colors: Record<Tone, string> = {
    mint: 'bg-accent-2',
    lavender: 'bg-accent',
    amber: 'bg-amber-300',
    rose: 'bg-rose-400',
    dim: 'bg-white/30',
  };
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${colors[tone]} ${live ? 'animate-pulse-dot' : ''}`}
    />
  );
}

export function ProgressBar({
  value,
  tone = 'lavender',
}: {
  value: number;
  tone?: 'lavender' | 'mint';
}) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${tone === 'mint' ? 'bg-accent-2' : 'bg-accent'}`}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  );
}

export function Toggle(props: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-8">
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium">{props.label}</span>
        {props.description && <span className="text-sm text-dim">{props.description}</span>}
      </span>
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
        label={props.label}
      />
    </label>
  );
}

export function Switch(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-line bg-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 aria-checked:border-transparent aria-checked:bg-accent"
    >
      <span
        className={`absolute top-0.5 left-0.5 size-[18px] rounded-full bg-white shadow transition-transform ${props.checked ? 'translate-x-5' : ''}`}
      />
    </button>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-1 pb-2 text-[11px] font-medium tracking-[0.15em] text-dim uppercase">
      {children}
    </p>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-rose-300">{children}</p>;
}

export const inputClass =
  'h-10 rounded-xl border border-line bg-black/30 px-3.5 text-sm text-white placeholder:text-white/30 focus:border-accent/60 focus:outline-none disabled:opacity-50';

/** The clanks mark: a 2×2 grid on a white tile. */
export function Logo() {
  return (
    <div className="grid size-7 place-items-center rounded-lg bg-white">
      <div className="grid grid-cols-2 gap-[3px]">
        <span className="size-[5px] rounded-[1.5px] bg-black" />
        <span className="size-[5px] rounded-[1.5px] bg-black/40" />
        <span className="size-[5px] rounded-[1.5px] bg-black/40" />
        <span className="size-[5px] rounded-[1.5px] bg-black" />
      </div>
    </div>
  );
}

export function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5h6m3 0h2m-11 7h2m3 0h6M8.5 3v3m-3 4v3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.5 1.5v2m3-2v2m-3 9v2m3-2v2M1.5 6.5h2m-2 3h2m9-3h2m-2 3h2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ChatIcon() {
  return (
    <Icon>
      <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11A1.5 1.5 0 0 1 2.5 9.5z" />
    </Icon>
  );
}

export function UsersIcon() {
  return (
    <Icon>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5m1-9.2a2.25 2.25 0 0 1 0 4.4m1 1.6c1.1.5 1.8 1.6 2 3.2" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

export function FolderIcon() {
  return (
    <Icon>
      <path d="M2 4.5a1.5 1.5 0 0 1 1.5-1.5h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M2.5 4.5h11m-8.5 0V3h6v1.5m-7 0 .6 8.2a1.5 1.5 0 0 0 1.5 1.3h3.8a1.5 1.5 0 0 0 1.5-1.3l.6-8.2" />
    </Icon>
  );
}

export function PencilIcon() {
  return (
    <Icon>
      <path d="m10.5 3 2.5 2.5L6 12.5H3.5V10z" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path d="m3 8.5 3 3 7-7" />
    </Icon>
  );
}

export function RetryIcon() {
  return (
    <Icon>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" />
    </Icon>
  );
}

export function XIcon() {
  return (
    <Icon>
      <path d="m4 4 8 8m0-8-8 8" />
    </Icon>
  );
}

export function LayersIcon() {
  return (
    <Icon>
      <path d="M8 2.5 14 5.5 8 8.5 2 5.5zM2 8.5l6 3 6-3M2 11l6 3 6-3" />
    </Icon>
  );
}

export function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  );
}

/** A small square button holding just an icon. */
export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={`grid size-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}
