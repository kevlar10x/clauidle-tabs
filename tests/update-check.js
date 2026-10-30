// Checks that names stored as plain text by 0.5 become hashes when a newer version starts, and settings survive.
// Usage: node tests/update-check.js
// Runs a copy with a lower version in headless Brave, then restarts on the real version number. Brave reports
// that relaunch as an install rather than an update, so this doesn't cover anything that needs reason 'update'.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, start } from './headless.js';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const work = await mkdtemp(join(tmpdir(), 'idle-tabs-check-'));
const profile = join(work, 'profile');
const ext = join(work, 'ext');
try {
  await cp(SOURCE, ext, { recursive: true });
  const manifestPath = join(ext, 'manifest.json');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(manifestPath, manifest.replace(/"version": "[^"]+"/, '"version": "0.0.1"'));

  let browser = await start(profile, ext);
  await browser.sw(() => chrome.storage.local.set({ claudeTitles: ['Fix the login page'], minutes: 45 }));
  await browser.stop();

  await writeFile(manifestPath, manifest);
  browser = await start(profile, ext);
  let stored;
  for (let i = 0; i < 40; i++) {
    stored = await browser.sw(() => chrome.storage.local.get(null));
    if (!('claudeTitles' in stored)) break;
    await sleep(250);
  }
  const expected = createHash('sha256').update('Fix the login page').digest('base64');
  check('the plain list is gone', !('claudeTitles' in stored), JSON.stringify(Object.keys(stored)));
  check('the name is kept as its hash', stored.titleHashes?.includes(expected));
  check('settings survive', stored.minutes === 45, String(stored.minutes));
  check('the new version is running', (await browser.sw(() => chrome.runtime.getManifest().version)) === JSON.parse(manifest).version);
  await browser.stop();
} finally {
  await sleep(500);
  await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
