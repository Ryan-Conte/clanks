/**
 * Tabs: a list of buttons, each naming the panel it shows. Arrow keys move along them, as the
 * WAI-ARIA tabs pattern has it.
 */
export function wireTabs(root: HTMLElement) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (chosen: HTMLButtonElement, focus = false) => {
    for (const tab of tabs) {
      const on = tab === chosen;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !on;
    }
    if (focus) chosen.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      if (step && next) {
        event.preventDefault();
        select(next, true);
      }
    });
  });
}
