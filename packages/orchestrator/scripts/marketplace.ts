/**
 * Tools for a marketplace's repository.
 *
 *   pnpm marketplace index <folder>   check every package and write the folder's index.json
 *   pnpm marketplace seed <folder>    start a marketplace: Sentinel, the shipped integrations, a crew
 *
 * `index` is what a marketplace's CI runs on every pull request and every merge: it fails, saying
 * why, if any package wouldn't be installed by the app as it is.
 */
import { INDEX_FILE, buildIndex } from '@clanks/marketplace';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageChecker, seedMarketplace } from '../src/marketplace/check';
import { DEFAULT_MARKETPLACE_REPO } from '../src/marketplace/service';

const crewDir = fileURLToPath(new URL('../../../crew', import.meta.url));
const integrationsDir = fileURLToPath(new URL('../../../integrations', import.meta.url));

const [command, target] = process.argv.slice(2);
if ((command !== 'index' && command !== 'seed') || !target) {
  console.error('Usage: pnpm marketplace <index|seed> <folder>');
  process.exit(2);
}
// pnpm runs scripts from the package's folder; a relative path is meant from where it was typed.
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), target);

if (command === 'seed') {
  if (existsSync(dir) && readdirSync(dir).some((name) => name !== '.git')) {
    console.error(`${dir} isn't empty. Seed a new folder.`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const [owner = 'clanks'] = DEFAULT_MARKETPLACE_REPO.split('/');
  seedMarketplace(
    dir,
    { crewDir, integrationsDir },
    { name: 'clanks marketplace', repo: DEFAULT_MARKETPLACE_REPO, publisher: owner },
  );
}

const { index, problems } = buildIndex(dir, { check: packageChecker(crewDir) });
for (const problem of problems) console.error(`✗ ${problem}`);
if (problems.length > 0) {
  console.error(
    `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}. No index was written.`,
  );
  process.exit(1);
}
writeFileSync(join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
const versions = index.packages.reduce((sum, pkg) => sum + pkg.versions.length, 0);
console.log(
  `${index.name}: ${index.packages.length} packages, ${versions} versions. Wrote ${join(dir, INDEX_FILE)}`,
);
