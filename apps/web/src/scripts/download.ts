import type { Platform } from '../lib/site';

/** The reader's computer, from what their browser says. A phone gets the Mac button. */
function platform(): Platform {
  const agent = navigator.userAgent;
  if (/Windows/i.test(agent)) return 'windows';
  if (/Linux|X11|CrOS/i.test(agent) && !/Android/i.test(agent)) return 'linux';
  return 'mac';
}

/**
 * Points each download button at the installer for the reader's computer. The page is rendered
 * for macOS; the buttons carry every platform's name and link in data attributes.
 */
export function pickDownloads() {
  const here = platform();
  for (const button of document.querySelectorAll<HTMLAnchorElement>('[data-download]')) {
    const href = button.dataset[`${here}Href`];
    const name = button.dataset[`${here}Name`];
    const label = button.querySelector('[data-download-name]');
    if (href) button.href = href;
    if (name && label) label.textContent = name;
  }
  // The line under it names the other two.
  for (const note of document.querySelectorAll<HTMLElement>('[data-also]')) {
    note.hidden = note.dataset.also !== here;
  }
}
