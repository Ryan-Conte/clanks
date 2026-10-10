import type { ReactNode } from 'react';

/** A titled group in one of Studio's side panels. */
export function Section(props: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-line px-3 py-3">
      <header className="flex h-5 items-center justify-between">
        <h3 className="text-[11px] font-medium tracking-[0.12em] text-dim uppercase">
          {props.title}
        </h3>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

/** A labelled control. `short` is for a one-letter label, as beside X, Y, W and H. */
export function Row({
  label,
  children,
  short = false,
}: {
  label: string;
  children: ReactNode;
  short?: boolean;
}) {
  return (
    <label
      className={`grid items-center gap-2 text-[12px] ${short ? 'grid-cols-[0.75rem_1fr]' : 'grid-cols-[4.25rem_1fr]'}`}
    >
      <span className="truncate text-dim">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </label>
  );
}

export const fieldClass =
  'h-7 w-full min-w-0 rounded-md border border-line bg-black/30 px-2 text-[12px] text-white placeholder:text-white/25 focus:border-accent/60 focus:outline-none disabled:opacity-50';

/**
 * A text box that saves when it's left or Enter is pressed, and goes back on Escape. It shows the
 * value it's given until the user types, so a change from elsewhere shows up in it.
 */
export function Input(props: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  /** A datalist of suggestions, such as the tokens that fit. */
  list?: string;
  mono?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <input
      // A new value from outside replaces what's shown.
      key={props.value}
      defaultValue={props.value}
      placeholder={props.placeholder}
      list={props.list}
      disabled={props.disabled}
      aria-label={props.label}
      spellCheck={false}
      className={`${fieldClass} ${props.mono ? 'font-mono text-[11px]' : ''}`}
      onBlur={(event) => {
        if (event.target.value !== props.value) props.onCommit(event.target.value.trim());
      }}
      onKeyDown={(event) => {
        // Keys typed here are text, not canvas shortcuts.
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.currentTarget.value = props.value;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function Select(props: {
  value: string;
  options: readonly (readonly [value: string, label: string])[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <select
      value={props.value}
      disabled={props.disabled}
      aria-label={props.label}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => event.stopPropagation()}
      className={`${fieldClass} appearance-none pr-6`}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function Check(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-white/85">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="size-3.5 accent-[#b9a7ff]"
      />
      {props.children}
    </label>
  );
}

/** A row of small buttons, one of them pressed. */
export function Segments<T extends string>(props: {
  value: T | null;
  options: readonly (readonly [value: T, label: string, title?: string])[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <span className="flex w-full rounded-md border border-line bg-black/30 p-0.5">
      {props.options.map(([value, label, title]) => (
        <button
          key={value}
          type="button"
          title={title ?? label}
          aria-pressed={props.value === value}
          disabled={props.disabled}
          onClick={() => props.onChange(value)}
          className={`h-6 min-w-0 flex-1 truncate rounded px-1 text-[11px] transition-colors disabled:opacity-40 ${props.value === value ? 'bg-white/[0.12] text-white' : 'text-dim hover:text-white'}`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** A small button for a panel's header or a toolbar. */
export function Mini(props: {
  onClick: () => void;
  title: string;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`grid h-6 min-w-6 shrink-0 place-items-center rounded-md px-1.5 text-[12px] transition-colors disabled:pointer-events-none disabled:opacity-35 ${props.active ? 'bg-accent/20 text-accent' : 'text-dim hover:bg-white/[0.07] hover:text-white'}`}
    >
      {props.children}
    </button>
  );
}
