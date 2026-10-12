// @ts-check

/** Where docs outside the guides are read: the repository, as GitHub shows it. */
const REPO_DOCS = 'https://github.com/Ryan-Conte/clanks/blob/main/docs/';

/**
 * Turns a link between the guides in docs/guide, written for GitHub (`models.md#cuda`), into a
 * link between their pages here (`/docs/models/#cuda`). A link up out of the guides (`../PLAN.md`)
 * goes to that file on GitHub instead.
 *
 * @param {string} href
 * @returns {string}
 */
export function guideHref(href) {
  const sibling = /^(?:\.\/)?([\w-]+)\.md(#.*)?$/.exec(href);
  if (sibling) {
    const [, name = '', hash = ''] = sibling;
    return (name === 'README' ? '/docs/' : `/docs/${name}/`) + hash;
  }
  if (href.startsWith('../')) return REPO_DOCS + href.slice(3);
  return href;
}

/**
 * A rehype plugin that rewrites every link in a guide with `guideHref`.
 *
 * @typedef {{ type: string, tagName?: string, properties?: Record<string, unknown>, children?: Node[] }} Node
 * @returns {(tree: Node) => void}
 */
export function guideLinks() {
  /** @param {Node} node */
  const visit = (node) => {
    if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
      node.properties.href = guideHref(node.properties.href);
    }
    node.children?.forEach(visit);
  };
  return visit;
}
