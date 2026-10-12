import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';

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

/** A page's opening lines: what it is, in a sentence anyone can read, and what to do there. */
export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-end justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">{props.title}</h1>
        {props.description && (
          <p className="max-w-2xl text-[15px] leading-relaxed text-dim">{props.description}</p>
        )}
      </div>
      {props.actions && <div className="flex shrink-0 items-center gap-2">{props.actions}</div>}
    </header>
  );
}

/** A titled group on a page: a count beside the title, and amber when it's waiting on the user. */
export function SectionCard(props: {
  title: string;
  tone?: 'amber' | undefined;
  count?: number | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex flex-col gap-3 rounded-3xl border p-5 ${props.tone === 'amber' ? 'border-amber-300/20 bg-amber-300/[0.04]' : 'border-line bg-panel/60'}`}
    >
      <header className="flex items-center justify-between gap-3">
        <h2
          className={`flex items-center gap-2 text-sm font-medium ${props.tone === 'amber' ? 'text-amber-100' : 'text-white'}`}
        >
          {props.tone === 'amber' && <Dot tone="amber" live />}
          {props.title}
          {props.count !== undefined && props.count > 0 && (
            <span className="tabular font-normal text-dim">{props.count}</span>
          )}
        </h2>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

/** Something there's none of yet, said kindly, with what to do about it. */
export function EmptyState(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-line px-8 py-10 text-center">
      <p className="font-medium">{props.title}</p>
      {props.children && <p className="max-w-md text-sm text-dim">{props.children}</p>}
      {props.action}
    </div>
  );
}

/** Details most people never need, folded away under a line that says what's in there. */
export function Disclosure(props: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details open={props.defaultOpen} className={`group/disclosure ${props.className ?? ''}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-dim transition-colors select-none hover:text-white [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open/disclosure:rotate-90">
          <ChevronIcon />
        </span>
        {props.summary}
      </summary>
      <div className="pt-4">{props.children}</div>
    </details>
  );
}

/** A choice among a few, as a pill that's on or off. */
export function Chip({
  active = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...props}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 ${active ? 'border-accent/60 bg-accent/15 text-white' : 'border-line text-white/70 hover:border-white/20 hover:bg-white/[0.04] hover:text-white'} ${className}`}
    />
  );
}

/**
 * A picture that opens large, over the window, when it's clicked: a design, a page as a clank saw
 * it, a screenshot the user sent. Escape, or a click anywhere, puts it away.
 */
export function Zoomable(props: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open]);
  return (
    <>
      <button
        type="button"
        title="Look closer"
        onClick={() => setOpen(true)}
        className="block w-full cursor-zoom-in rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <img src={props.src} alt={props.alt} className={props.className} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={props.alt}
          onClick={() => setOpen(false)}
          className="animate-pop fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center overflow-auto bg-black/85 p-8 pt-14 backdrop-blur-sm"
        >
          <img
            src={props.src}
            alt={props.alt}
            className="max-h-full max-w-full rounded-xl border border-line object-contain shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

export interface MenuItem {
  label: string;
  /** A line under it, for an item that needs saying more about. */
  hint?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A button that opens a short list of things to do, for what doesn't earn a button of its own. */
export function Menu(props: {
  label: string;
  items: (MenuItem | null | false | undefined)[];
  children?: ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const items = props.items.filter((item): item is MenuItem => Boolean(item));
  if (items.length === 0) return null;

  return (
    <div ref={root} className="relative">
      <IconButton
        label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={open ? 'bg-white/[0.08] text-white' : ''}
      >
        {props.children ?? <MoreIcon />}
      </IconButton>
      {open && (
        <ul
          role="menu"
          className={`animate-pop absolute top-9 z-40 flex min-w-56 flex-col gap-0.5 rounded-2xl border border-line bg-raised p-1.5 shadow-2xl shadow-black/60 ${props.align === 'left' ? 'left-0' : 'right-0'}`}
        >
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-40 ${item.danger ? 'text-rose-300' : 'text-white/90'}`}
              >
                {item.icon && <span className="mt-0.5 shrink-0 text-dim">{item.icon}</span>}
                <span className="flex min-w-0 flex-col">
                  <span>{item.label}</span>
                  {item.hint && <span className="text-[12px] text-dim">{item.hint}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
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
  const sizes = {
    sm: 'h-8 px-3 text-[13px]',
    md: 'h-10 px-5 text-sm',
    lg: 'h-12 px-7 text-[15px]',
  };
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

/** Shelves with things on them: the marketplace. */
export function ShelfIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 2.5v11m11-11v11m-11-6.5h11m-11 5h11M5 7V4.5h2.5V7m2 0V5.5H11V7m-5.5 5V9.5H8V12m2.5 0v-1.5h1V12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
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

/** A picture in a frame: add a screenshot or a photo to a message. */
export function ImageIcon() {
  return (
    <Icon>
      <rect x="2.5" y="3" width="11" height="10" rx="2" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="m3 11.5 3-3 2.5 2.5 2-2 2.5 2.5" />
    </Icon>
  );
}

export function HomeIcon() {
  return (
    <Icon>
      <path d="M2.5 7.5 8 2.5l5.5 5v5a1 1 0 0 1-1 1H10V10H6v3.5H3.5a1 1 0 0 1-1-1z" />
    </Icon>
  );
}

export function ChevronIcon() {
  return (
    <Icon size={14}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Icon>
  );
}

export function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

/** An eye: watch a clank work. */
export function EyeIcon() {
  return (
    <Icon>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Icon>
  );
}

export function PauseIcon() {
  return (
    <Icon>
      <path d="M5.5 3.5v9m5-9v9" />
    </Icon>
  );
}

export function PlayIcon() {
  return (
    <Icon>
      <path d="M5 3.5v9l7.5-4.5z" />
    </Icon>
  );
}

/** A four-pointed star: something made for you, or a place to start. */
export function SparkIcon() {
  return (
    <Icon>
      <path d="M8 2c.5 3.2 2.3 5 6 6-3.7 1-5.5 2.8-6 6-.5-3.2-2.3-5-6-6 3.7-1 5.5-2.8 6-6z" />
    </Icon>
  );
}

export function BoardIcon() {
  return (
    <Icon>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M6.2 2.5v8m3.6-8v5" />
    </Icon>
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

export function CodeIcon() {
  return (
    <Icon>
      <path d="m5.5 4.5-3.5 3.5 3.5 3.5m5-7 3.5 3.5-3.5 3.5M9 3l-2 10" />
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

export function BackIcon() {
  return (
    <Icon>
      <path d="M13 8H3m0 0 4-4M3 8l4 4" />
    </Icon>
  );
}

export function ForwardIcon() {
  return (
    <Icon>
      <path d="M3 8h10m0 0-4-4m4 4-4 4" />
    </Icon>
  );
}

export function GlobeIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.6 5.9 5.6 8s.8 3.9 2.4 5.5" />
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
