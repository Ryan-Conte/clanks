import { BrowserError } from './cdp';

/** A key as `Input.dispatchKeyEvent` takes it. */
export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** What it types, if anything. */
  text?: string;
}

const NAMED: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/** Other names models use for the same keys. */
const ALIASES: Record<string, string> = {
  return: 'Enter',
  esc: 'Escape',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  pagedown: 'PageDown',
  pageup: 'PageUp',
  ' ': 'Space',
};

/** `Input.dispatchKeyEvent`'s modifier bits. */
const MODIFIERS: Record<string, { bit: number; key: KeyDefinition }> = {
  Alt: { bit: 1, key: { key: 'Alt', code: 'AltLeft', keyCode: 18 } },
  Control: { bit: 2, key: { key: 'Control', code: 'ControlLeft', keyCode: 17 } },
  Meta: { bit: 4, key: { key: 'Meta', code: 'MetaLeft', keyCode: 91 } },
  Shift: { bit: 8, key: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 } },
};

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
};

/** A key with the modifiers held while it's pressed, such as Control+A. */
export interface KeyPress {
  modifiers: KeyDefinition[];
  /** The `modifiers` bit mask. */
  mask: number;
  key: KeyDefinition;
  /** It types a character, rather than being a shortcut or a named key. */
  printable: boolean;
  /** F5 or Control+R: the browser's own reload, which a page never sees. */
  reload: boolean;
}

function lookup(name: string): KeyDefinition | null {
  const named = NAMED[name] ?? NAMED[ALIASES[name.toLowerCase()] ?? ''];
  if (named) return named;
  const match = Object.keys(NAMED).find((k) => k.toLowerCase() === name.toLowerCase());
  if (match) return NAMED[match]!;
  if (name.length === 1) {
    const char = name;
    const upper = char.toUpperCase();
    if (/[a-z]/i.test(char)) {
      return { key: char, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: char };
    }
    if (/[0-9]/.test(char)) {
      return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
    }
    return { key: char, code: '', keyCode: 0, text: char };
  }
  const fn = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fn) {
    const n = Number(fn[1]);
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
  }
  return null;
}

/**
 * Keys as a clank writes them: one press such as `Enter` or `Control+A`, or several separated by
 * spaces, such as `Tab Tab Enter`.
 */
export function parseKeys(input: string): KeyPress[] {
  const tokens = input.trim() === '' ? [] : input.trim().split(/\s+/);
  // "Control r" means Control+R: a modifier on its own goes with the key after it.
  const combos: string[] = [];
  for (const token of tokens) {
    const last = combos.at(-1);
    const held = last?.split('+').every((part) => MODIFIER_ALIASES[part.toLowerCase()]);
    if (last !== undefined && held && !last.endsWith('+'))
      combos[combos.length - 1] = `${last}+${token}`;
    else combos.push(token);
  }
  if (combos.length === 0) throw new BrowserError('Say which key to press, such as Enter.');
  if (combos.length > 20) throw new BrowserError('Press at most 20 keys at a time.');
  return combos.map((combo) => {
    // "+" on its own is a key, not a separator.
    const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/);
    const keyName = parts.pop()!;
    const modifiers: KeyDefinition[] = [];
    let mask = 0;
    for (const part of parts) {
      const name = MODIFIER_ALIASES[part.toLowerCase()];
      if (!name)
        throw new BrowserError(`${part} isn't a modifier key. Use Control, Alt, Shift or Meta.`);
      const modifier = MODIFIERS[name]!;
      if (!(mask & modifier.bit)) {
        mask |= modifier.bit;
        modifiers.push(modifier.key);
      }
    }
    const key = lookup(keyName);
    if (!key) {
      throw new BrowserError(
        `${keyName} isn't a key this can press. Use a letter, a digit or a key such as Enter, Tab, Escape, Backspace, ArrowDown or PageDown.`,
      );
    }
    const shortcut =
      (mask & (MODIFIERS.Control!.bit | MODIFIERS.Meta!.bit | MODIFIERS.Alt!.bit)) !== 0;
    const printable = key.text !== undefined && key.key.length === 1 && !shortcut;
    const reload =
      key.key === 'F5' ||
      (key.code === 'KeyR' && (mask & (MODIFIERS.Control!.bit | MODIFIERS.Meta!.bit)) !== 0);
    return { modifiers, mask, key, printable, reload };
  });
}
