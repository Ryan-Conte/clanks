import { OPEN_LICENCES, RESERVED_CLANK_IDS, looksSecret } from '@clanks/core';
import { GUIDE_FILE, MANIFEST_FILE, OPENAPI_FILE, loadIntegration } from '@clanks/integrations';
import {
  type BuildOptions,
  CLANK_FILE,
  CREW_FILE,
  MarketplaceError,
  type PackageMeta,
  crewFileSchema,
  packageYaml,
} from '@clanks/marketplace';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkCustomDoc } from '../crew/check';
import { CREW_RULES_FILE, PREMADE_CREW, parseClankDoc, parseCrewRules } from '../crew/docs';

/**
 * The check a marketplace's index is built with: the same ones the app makes before it installs
 * anything, so an index only ever lists what the app would take. `crewDir` holds CREW.md, which
 * every prompt's size is counted with.
 */
export function packageChecker(crewDir: string): BuildOptions['check'] {
  const rules = parseCrewRules(readFileSync(join(crewDir, CREW_RULES_FILE), 'utf8'));
  return (meta, files) => {
    for (const [name, text] of files) {
      if (looksSecret(text)) {
        throw new MarketplaceError(`${name} has something that looks like a secret in it`);
      }
    }
    if (meta.kind === 'clank') {
      const doc = parseClankDoc(files.get(CLANK_FILE) ?? '');
      const { id } = doc.frontmatter;
      if (id !== meta.id) throw new MarketplaceError(`its doc says its id is ${id}`);
      if (RESERVED_CLANK_IDS.includes(id) || (PREMADE_CREW as readonly string[]).includes(id)) {
        throw new MarketplaceError(`${id} is a name the app uses itself`);
      }
      checkCustomDoc(doc, rules);
      return {};
    }
    if (meta.kind === 'integration') {
      const integration = loadIntegration({
        manifest: files.get(MANIFEST_FILE) ?? '',
        openapi: files.get(OPENAPI_FILE) ?? null,
        guide: files.get(GUIDE_FILE) ?? null,
      });
      if (integration.manifest.id !== meta.id) {
        throw new MarketplaceError(`its manifest says its id is ${integration.manifest.id}`);
      }
      return { runsCode: integration.kind === 'mcp' };
    }
    if (meta.kind === 'crew') {
      crewFileSchema.parse(parseYaml(files.get(CREW_FILE) ?? ''));
    }
    return {};
  };
}

const lf = (text: string) => `${text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;

/** What a marketplace's repository says about itself: what's in it, and how to publish to it. */
function marketplaceReadme(name: string): string {
  const fence = '```';
  return [
    `# ${name}`,
    '',
    "Clanks, integrations and crews for [clanks](https://clanks.si), free to install and free to publish. There's no account: the app reads `index.json` from this repository as a plain file, and nothing counts who installs what.",
    '',
    "## What's here",
    '',
    fence,
    'marketplace.yaml                  its name, where pull requests go, and what its maintainers reviewed or took down',
    'index.json                        built from everything below: what the app reads',
    'packages/<kind>/<id>/<version>/',
    '  package.yaml                    kind, id, name, summary, version, publisher, licence',
    '  clank.md                        a clank: its priming doc',
    '  manifest.yaml                   an integration: its manifest,',
    '  openapi.yaml                      the calls it makes,',
    '  guide.md                          and what clanks are told about it',
    '  crew.yaml                       a crew: the clanks and integrations a kind of project wants',
    fence,
    '',
    "A version never changes once it's merged: a fix is a new version. The app checks every file against the sha256 the index gives for it, and uses nothing that doesn't match.",
    '',
    '## Publishing',
    '',
    'From the app: **Publish** on a clank you made, or on an integration you added from a folder. It checks the package, shows you exactly what would be sent, asks for an open licence, and opens a pull request here from your GitHub account.',
    '',
    "By hand: add `packages/<kind>/<id>/<version>/` with the files above and open a pull request. `publisher` is your GitHub account's name, and an id belongs to whoever published it first.",
    '',
    'A package is turned back when:',
    '',
    "- a clank's doc names a tool that doesn't exist, never says how it finishes, or is too long to be a prompt;",
    "- an integration calls a host it doesn't declare, an address rather than a name, or anything on the user's computer;",
    '- anything in it looks like a password, a key or a token;',
    "- it holds a file that a package of its kind isn't made of;",
    `- its licence isn't one of ${OPEN_LICENCES.join(', ')}.`,
    '',
    "Before anyone installs a package they see all of it: a clank's whole priming doc and every tool it asks for, or an integration's every host and operation. Whatever a clank's doc allows, nothing above read starts higher than \"ask\" on their machine.",
    '',
    '## The index',
    '',
    '`index.json` is built from this folder by the check in the clanks repository, the same one the app makes before it installs anything:',
    '',
    `${fence}bash`,
    'pnpm marketplace index <this folder>',
    fence,
    '',
    "It fails, saying why, if any package wouldn't be installed as it is, and writes nothing. Run it after every merge and commit the result.",
    '',
    '## Reviewed and taken down',
    '',
    '`marketplace.yaml` lists the packages a maintainer has read under `reviewed`, which gives them a badge in the app, and the ones taken down under `revoked`, each with why. A package taken down is turned off on every machine that installed it the next time the app reads the index, and shows the reason.',
    '',
    '## Line endings',
    '',
    'Files are kept with LF line endings (see `.gitattributes`). Checksums are of the bytes, so they have to be the same on every machine.',
  ].join('\n');
}

/**
 * Writes the start of a marketplace into a folder: Sentinel, the worked custom clank; the
 * integrations that ship with the app, so they can be updated without waiting for an app release;
 * and a crew that uses both. The public marketplace's repository began as this.
 */
export function seedMarketplace(
  dir: string,
  source: { crewDir: string; integrationsDir: string },
  about: { name: string; repo: string | null; publisher: string },
): void {
  const write = (path: string, text: string) => {
    const file = join(dir, ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, lf(text));
  };
  const pack = (
    meta: Omit<PackageMeta, 'publisher' | 'licence'>,
    files: Record<string, string>,
  ) => {
    const folder = `packages/${meta.kind}/${meta.id}/${meta.version}`;
    write(
      `${folder}/package.yaml`,
      packageYaml({ ...meta, publisher: about.publisher, licence: 'MIT' }),
    );
    for (const [name, text] of Object.entries(files)) write(`${folder}/${name}`, text);
  };

  write(
    'marketplace.yaml',
    [
      `name: ${JSON.stringify(about.name)}`,
      `repo: ${about.repo ?? 'null'}`,
      '# Packages a maintainer has read, as kind/id.',
      'reviewed:',
      '  - clank/sentinel',
      ...readdirSync(source.integrationsDir).map((id) => `  - integration/${id}`),
      '  - crew/storefront',
      '# Packages taken down, as kind/id, each with why. Installed copies are turned off.',
      'revoked: {}',
    ].join('\n'),
  );
  // Checksums are of the bytes, so every checkout has to have the same ones.
  write('.gitattributes', '* text=auto eol=lf');
  write('README.md', marketplaceReadme(about.name));

  const sentinel = readFileSync(join(source.crewDir, 'examples', 'sentinel.md'), 'utf8');
  const doc = parseClankDoc(sentinel);
  pack(
    {
      kind: 'clank',
      id: doc.frontmatter.id,
      name: doc.frontmatter.name,
      summary: doc.frontmatter.summary,
      version: '1.0.0',
    },
    { [CLANK_FILE]: sentinel },
  );

  const integrations: string[] = [];
  for (const id of readdirSync(source.integrationsDir).sort()) {
    const read = (file: string) => {
      const path = join(source.integrationsDir, id, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    };
    const manifest = read(MANIFEST_FILE);
    if (manifest === null) continue;
    const integration = loadIntegration({
      manifest,
      openapi: read(OPENAPI_FILE),
      guide: read(GUIDE_FILE),
    });
    const files: Record<string, string> = { [MANIFEST_FILE]: manifest };
    for (const file of [OPENAPI_FILE, GUIDE_FILE]) {
      const text = read(file);
      if (text !== null) files[file] = text;
    }
    pack(
      {
        kind: 'integration',
        id,
        name: integration.manifest.name,
        summary: integration.manifest.summary,
        version: '1.0.0',
      },
      files,
    );
    integrations.push(id);
  }

  pack(
    {
      kind: 'crew',
      id: 'storefront',
      name: 'Storefront',
      summary:
        'A crew for an online shop: the software crew, with Sentinel checking every pull request for security problems, and Stripe for payments.',
      version: '1.0.0',
    },
    {
      [CREW_FILE]: [
        'clanks: [atlas, scribe, prism, forge, gauge, sentinel]',
        `integrations: [${integrations.includes('stripe') ? 'stripe' : ''}]`,
      ].join('\n'),
    },
  );
}
