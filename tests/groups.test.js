import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseTitle, claudeGroups, hashOldTitles, hashTitle, isClaudeGroup, markClaude, unmarkClaude,
} from '../extension/groups.js';
import { MCP, OTHER, fakeBrowser } from './fake-browser.js';

const names = async (api) => (await claudeGroups(api)).map((g) => g.id).sort((a, b) => a - b);

test('names are compared without the marks the Claude extension and status dots add', () => {
  assert.equal(baseTitle('⌛🟢 Fix the login page'), 'Fix the login page');
  assert.equal(baseTitle('✅ ⚪ Fix the login page'), 'Fix the login page');
  assert.equal(baseTitle('🔔Fix the login page'), 'Fix the login page');
  assert.equal(baseTitle('Fix the login page'), 'Fix the login page');
  assert.equal(baseTitle(undefined), '');
});

test("a group you mark is Claude's, and so is one with its name after a restart", async () => {
  const { api, state } = fakeBrowser({ groups: [MCP, OTHER, { id: 30, title: '🟢 Fix the login page' }] });
  await markClaude(api, state.groups[2]);
  assert.deepEqual(await names(api), [MCP.id, 30]);
  assert.deepEqual(state.local.titleHashes, [await hashTitle('Fix the login page')]);
  assert.equal(JSON.stringify(state.local).includes('login'), false, 'the name itself is never stored');

  // Brave restarted: new ids, the session's dot changed, and the Claude extension is mid-tool.
  state.session = {};
  state.groups = [OTHER, { id: 77, title: '⌛⚪ Fix the login page' }];
  assert.deepEqual(await names(api), [77]);
  assert.equal(await isClaudeGroup(api, 77), true);
  assert.equal(await isClaudeGroup(api, OTHER.id), false);
});

test('the plain name "Claude" is never remembered, so side panel groups stay out', async () => {
  const { api, state } = fakeBrowser({ groups: [{ id: 30, title: 'Claude' }, { id: 31, title: 'Claude' }] });
  await markClaude(api, state.groups[0]);
  assert.equal(state.local.titleHashes, undefined);
  assert.deepEqual(await names(api), [30]);
});

test('a group you unmark stays out, even the Claude (MCP) one', async () => {
  const { api, state } = fakeBrowser({ groups: [MCP, { id: 30, title: 'Fix the login page' }] });
  await markClaude(api, state.groups[1]);
  await unmarkClaude(api, state.groups[1]);
  await unmarkClaude(api, state.groups[0]);
  assert.deepEqual(await names(api), []);
  assert.deepEqual(state.local.titleHashes, []);
});

test('remembers the 100 most recent names', async () => {
  const groups = Array.from({ length: 105 }, (_, i) => ({ id: i + 1, title: `Session ${i + 1}` }));
  const { api, state } = fakeBrowser({ groups });
  for (const g of groups) await markClaude(api, g);
  assert.equal(state.local.titleHashes.length, 100);
  assert.equal(state.local.titleHashes[0], await hashTitle('Session 105'));
  assert.equal(state.local.titleHashes.at(-1), await hashTitle('Session 6'));
});

test('names stored as plain text by 0.5 are converted to hashes, and the plain list is removed', async () => {
  const { api, state } = fakeBrowser({
    groups: [{ id: 30, title: '🟢 Fix the login page' }],
    settings: { claudeTitles: ['Fix the login page', 'Recipes'], titleHashes: [await hashTitle('Recipes')] },
  });
  await hashOldTitles(api);
  assert.equal('claudeTitles' in state.local, false);
  assert.deepEqual(state.local.titleHashes.sort(), [await hashTitle('Fix the login page'), await hashTitle('Recipes')].sort());
  assert.deepEqual(await names(api), [30]);

  await hashOldTitles(api);
  assert.equal(state.local.titleHashes.length, 2, 'running it again changes nothing');
});
