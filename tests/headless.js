// Starts headless Brave with the extension on a given profile, and talks to it over the DevTools protocol.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const BRAVE = process.env.BRAVE ?? 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome's built-in extensions can have a background.js too, so ours is picked out by its name.
export async function findWorker(send, ext) {
  const { name } = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await send('Target.getTargets');
    for (const target of targetInfos.filter((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))) {
      const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      const { result } = await send('Runtime.evaluate',
        { expression: 'globalThis.chrome?.runtime?.getManifest?.().name', returnByValue: true }, sessionId);
      await send('Target.detachFromTarget', { sessionId });
      if (result.value === name) return target;
    }
    await sleep(100);
  }
  return undefined;
}

export async function start(profile, ext, args = ['about:blank']) {
  const portFile = join(profile, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const brave = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run', '--no-default-browser-check', '--mute-audio', ...args,
  ], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let next = 0;
  const waiting = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++next;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 30_000);
      waiting.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
    });
  };
  const worker = await findWorker(send, ext);
  const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  // Right after attaching, the worker can answer before the extension's APIs are in place.
  const sw = async (fn, ...args2) => {
    for (let i = 0; i < 50; i++) {
      const { result, exceptionDetails } = await send('Runtime.evaluate',
        { expression: `(${fn})(...${JSON.stringify(args2)})`, awaitPromise: true, returnByValue: true }, sessionId);
      if (!exceptionDetails) return result.value;
      const text = exceptionDetails.exception?.description ?? exceptionDetails.text;
      if (!/chrome is not defined/.test(text)) throw new Error(text);
      await sleep(100);
    }
  };
  const stop = async () => {
    await send('Browser.close').catch(() => {});
    await new Promise((r) => { brave.once('exit', r); setTimeout(r, 10_000); });
    brave.kill();
  };
  return { send, sw, stop, extId: new URL(worker.url).host };
}
