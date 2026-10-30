// Builds the ZIP for the Chrome Web Store, then unpacks it and loads that copy in headless Brave.
// Usage: node store/build.js
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, start } from '../tests/headless.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '..', 'extension');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const { version } = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
const zip = join(HERE, `clauidle-tabs-${version}.zip`);
await rm(zip, { force: true });
execFileSync('tar', ['-a', '-c', '-f', zip, '-C', EXT, ...await readdir(EXT)]);

const work = await mkdtemp(join(tmpdir(), 'idle-tabs-check-'));
const unpacked = join(work, 'ext');
const profile = join(work, 'profile');
await mkdir(unpacked);
execFileSync('tar', ['-x', '-f', zip, '-C', unpacked]);

const listing = execFileSync('tar', ['-t', '-f', zip], { encoding: 'utf8' }).trim().split(/\r?\n/);
const manifest = JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8'));
check('manifest.json is at the top of the ZIP', listing.includes('manifest.json'));
check('no backslashes in the ZIP paths', !listing.some((name) => name.includes('\\')));
check('name fits the 75 character limit', manifest.name.length <= 75, `${manifest.name.length}`);
check('description fits the 132 character limit', manifest.description.length <= 132, `${manifest.description.length}`);
const referenced = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), manifest.background.service_worker,
  manifest.options_ui.page, manifest.action.default_popup.split('?')[0]];
check('every file the manifest names is in the ZIP', referenced.every((name) => listing.includes(name)));

const browser = await start(profile, unpacked);
try {
  check('the unpacked ZIP runs, on the right version', (await browser.sw(() => chrome.runtime.getManifest().version)) === version);
  const icon = await browser.sw(async () => (await fetch(chrome.runtime.getURL('icons/icon-128.png'))).status);
  check('its icon loads', icon === 200, `${icon}`);
} finally {
  await browser.stop();
  await sleep(500);
  await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
console.log(`${zip}: ${listing.length} entries, ${(await stat(zip)).size} bytes`);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
