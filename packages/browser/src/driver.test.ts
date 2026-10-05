import { describe, expect, it } from 'vitest';
import { PageDriver } from './driver';
import { ax, axTree, fakeCdp } from './test/fake-cdp';

const tree = axTree(
  ax('RootWebArea', 'Shop', {
    children: [
      ax('textbox', 'Email', { backend: 100 }),
      ax('textbox', 'Password', { backend: 101 }),
      ax('button', 'Sign up', { backend: 102 }),
      ax('combobox', 'Size', { backend: 103 }),
    ],
  }),
);

interface Element {
  info: Record<string, unknown>;
  value: string;
  quads: number[][];
  /** What's on top of it at its middle, if something is. */
  coveredBy?: string;
}

/** A page with a form: an email field, a password field, a button and a drop-down. */
function page() {
  const elements: Record<number, Element> = {
    100: {
      info: { tag: 'input', type: 'email' },
      value: '',
      quads: [[10, 10, 110, 10, 110, 30, 10, 30]],
    },
    101: {
      info: { tag: 'input', type: 'password' },
      value: '',
      quads: [[10, 40, 110, 40, 110, 60, 10, 60]],
    },
    102: { info: { tag: 'button' }, value: '', quads: [[10, 70, 90, 70, 90, 90, 10, 90]] },
    103: { info: { tag: 'select' }, value: 'm', quads: [[10, 100, 90, 100, 90, 120, 10, 120]] },
  };
  let focused: number | null = null;
  const objectFor = (backendNodeId: number) => `obj-${backendNodeId}`;
  const nodeOf = (objectId: string) => Number(objectId.slice(4));
  const cdp = fakeCdp({
    'Page.getFrameTree': () => ({
      frameTree: { frame: { id: 'main', url: 'https://shop.test/' } },
    }),
    'Accessibility.getFullAXTree': () => ({ nodes: tree }),
    'Runtime.evaluate': (params) => {
      const expression = params.expression as string;
      if (expression.includes('document.title')) {
        return {
          result: {
            type: 'object',
            value: {
              title: 'Shop',
              url: 'https://shop.test/',
              top: 0,
              viewport: 600,
              height: 1800,
            },
          },
        };
      }
      if (expression.includes('activeElement')) {
        return { result: { type: 'boolean', value: focused === 101 } };
      }
      return { result: { type: 'object', value: { top: 0, viewport: 600, height: 1800 } } };
    },
    'DOM.resolveNode': (params) => {
      const id = params.backendNodeId as number;
      if (!(id in elements) && id !== 999) throw new Error('No node with given id found');
      return { object: { type: 'object', objectId: objectFor(id) } };
    },
    'DOM.getContentQuads': (params) => ({ quads: elements[params.backendNodeId as number]!.quads }),
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }),
    'DOM.getNodeForLocation': () => ({ backendNodeId: 999 }),
    'DOM.focus': (params) => {
      focused = params.backendNodeId as number;
      return {};
    },
    'Input.insertText': (params) => {
      if (focused !== null) elements[focused]!.value = params.text as string;
      return {};
    },
    'Runtime.callFunctionOn': (params) => {
      const fn = params.functionDeclaration as string;
      const element = elements[nodeOf(params.objectId as string)]!;
      if (fn.includes('getAttribute(name)')) {
        return {
          result: {
            type: 'object',
            value: {
              autocomplete: '',
              editable: false,
              disabled: false,
              readOnly: false,
              type: '',
              ...element.info,
            },
          },
        };
      }
      if (fn.includes('HTMLLabelElement')) {
        return { result: { type: 'string', value: element.coveredBy ?? '' } };
      }
      if (fn.includes('this.options')) {
        const wanted = (params.arguments as { value: string }[])[0]!.value;
        return {
          result: {
            type: 'object',
            value:
              wanted === 'Large'
                ? { picked: 'Large', options: [] }
                : { picked: null, options: ['Small', 'Large'] },
          },
        };
      }
      if (fn.includes('innerText : String(this.value')) {
        return { result: { type: 'string', value: element.value } };
      }
      return { result: { type: 'undefined' } };
    },
  });
  return { cdp, elements, focused: () => focused };
}

async function ready() {
  const fake = page();
  const driver = new PageDriver(fake.cdp.session, { sleep: () => Promise.resolve() });
  await driver.attach();
  const snapshot = await driver.snapshot();
  return { ...fake, driver, snapshot };
}

describe('PageDriver', () => {
  it('blocks file pickers from the start, and reads the page with refs', async () => {
    const { cdp, snapshot } = await ready();
    expect(cdp.calls('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }]);
    expect(snapshot.lines).toEqual([
      '[1] text box "Email"',
      '[2] text box "Password"',
      '[3] button "Sign up"',
      '[4] combo box "Size"',
    ]);
    expect(snapshot.scroll).toEqual({ top: 0, viewport: 600, height: 1800 });
  });

  it('clicks the middle of an element like a person would', async () => {
    const { cdp, driver } = await ready();
    await driver.click(3);
    const mouse = cdp.calls('Input.dispatchMouseEvent');
    expect(mouse.map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(mouse[1]).toMatchObject({ x: 50, y: 80, button: 'left', clickCount: 1 });
  });

  it("won't click through something covering the element", async () => {
    const { cdp, driver, elements } = await ready();
    elements[102]!.coveredBy = 'div "We use cookies"';
    await expect(driver.click(3)).rejects.toThrow(/on top of \[3\].*We use cookies/);
    expect(cdp.calls('Input.dispatchMouseEvent')).toEqual([]);
  });

  it('says when a ref is unknown or gone', async () => {
    const { driver, elements } = await ready();
    await expect(driver.click(42)).rejects.toThrow(/no \[42\] on this page/);
    delete elements[102];
    await expect(driver.click(3)).rejects.toThrow(/\[3\] is gone/);
  });

  it('types into a text field, replacing what was there', async () => {
    const { cdp, driver } = await ready();
    expect(await driver.type(1, 'sam@example.com', true)).toBe('sam@example.com');
    expect(cdp.calls('DOM.focus')).toEqual([{ backendNodeId: 100 }]);
    const keys = cdp.calls('Input.dispatchKeyEvent');
    expect(keys[0]).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r' });
  });

  it('never types into a password field, by ref or by key', async () => {
    const { cdp, driver } = await ready();
    await expect(driver.type(2, 'hunter2', false)).rejects.toThrow(/password or payment field/);
    expect(cdp.calls('Input.insertText')).toEqual([]);
    await driver.click(2);
    // Focus moved by other means: printable keys are still refused, named keys aren't.
    await cdp.session.send('DOM.focus', { backendNodeId: 101 });
    await expect(driver.press('h i')).rejects.toThrow(/password or payment field/);
    await driver.press('Tab');
  });

  it('reloads for F5 and Control+R, which a page never sees', async () => {
    const { cdp, driver } = await ready();
    await driver.press('Control r');
    expect(cdp.calls('Page.reload')).toHaveLength(1);
    expect(cdp.calls('Input.dispatchKeyEvent')).toEqual([]);
  });

  it("leaves Electron's own warnings out of the console", async () => {
    const { cdp, driver } = await ready();
    cdp.emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [
        { type: 'string', value: '%cElectron Security Warning (Insecure Content-Security-Policy)' },
      ],
    });
    cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hi' }] });
    expect(driver.console().map((e) => e.text)).toEqual(['hi']);
  });

  it('picks a drop-down option by its label', async () => {
    const { driver } = await ready();
    expect(await driver.type(4, 'Large', false)).toBe('Large');
    await expect(driver.type(4, 'Huge', false)).rejects.toThrow(/no option "Huge".*Small \| Large/);
  });

  it('forgets refs when a new page loads, and keeps its console', async () => {
    const { cdp, driver } = await ready();
    cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'old' }] });
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.test/thanks' } });
    cdp.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [
        { type: 'string', value: 'Boom' },
        { type: 'number', value: 42 },
      ],
      stackTrace: { callFrames: [{ url: 'https://shop.test/app.js', lineNumber: 11 }] },
    });
    cdp.emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: x is undefined\n  at y' },
      },
    });
    expect(driver.currentUrl).toBe('https://shop.test/thanks');
    await expect(driver.click(3)).rejects.toThrow(/no \[3\]/);
    expect(driver.console().map((e) => [e.level, e.text, e.source])).toEqual([
      ['error', 'Boom 42', 'shop.test/app.js:12'],
      ['error', 'TypeError: x is undefined', null],
    ]);
  });

  it('answers page dialogs safely and says so', async () => {
    const { cdp, driver } = await ready();
    cdp.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete everything?' });
    cdp.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved' });
    expect(cdp.calls('Page.handleJavaScriptDialog')).toEqual([{ accept: false }, { accept: true }]);
    const notes = driver.takeNotes();
    expect(notes[0]).toMatch(/Delete everything\?.*answered Cancel/);
    expect(notes[1]).toMatch(/alert: "Saved"/);
    expect(driver.takeNotes()).toEqual([]);
  });

  it('waits for a load a click starts', async () => {
    const fake = page();
    let resolveSleep: () => void = () => {};
    const driver = new PageDriver(fake.cdp.session, {
      sleep: () => new Promise((resolve) => (resolveSleep = resolve)),
      loadTimeoutMs: 1000,
    });
    await driver.attach();
    fake.cdp.emit('Page.frameStartedLoading', { frameId: 'main' });
    expect(driver.loading).toBe(true);
    const settled = driver.settle();
    resolveSleep();
    await Promise.resolve();
    fake.cdp.emit('Page.frameStoppedLoading', { frameId: 'main' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveSleep();
    await settled;
    expect(driver.loading).toBe(false);
  });
});
