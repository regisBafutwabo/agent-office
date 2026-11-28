import { test, expect, open, row } from './office.mjs';

const cwd = '/tmp/e2e-delegated', boss = '18f504af-284e-4ee6-823f-f44f9cb7dd8c';
const handed = text => `[T3 Code: the agent in T3 thread "${boss}" sent this message, not the user.]\n\nAct as the research sub-agent for this task.\n\n${text}`;
const subs = page => page.evaluate(() => agents.filter(a => a.kind === 'sub' && !a.gone).map(a => ({ name: a.name, type: a.subType, tool: a.agentName, parent: a.parent.name })));
const mains = page => page.evaluate(() => agents.filter(a => a.kind === 'main' && !a.gone).map(a => a.name));

test('an agent T3 Code hands a task to shows as a subagent of the agent that handed it over, with its own tool', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'b1', cwd }, { 'X-Agent-Office-T3-Thread': boss, 'X-Agent-Office-Entrypoint': 't3-code' });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'b1', cwd, prompt: 'Test the office' }, { 'X-Agent-Office-T3-Thread': boss });
  await open(page, office);
  await expect(row(page, 'Test the office')).toBeVisible();

  // A Codex thread T3 Code started for it: its hooks report under the codex adapter.
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'x1', cwd }, { 'X-Agent-Office-Agent': 'codex', 'X-Agent-Office-T3-Thread': 'thread:delegated-task:x1' });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'x1', cwd, prompt: handed('Count the lines') }, { 'X-Agent-Office-Agent': 'codex' });
  await office.hook({ hook_event_name: 'PreToolUse', session_id: 'x1', cwd, tool_name: 'Bash', tool_input: { command: 'wc -l web/js/*' } }, { 'X-Agent-Office-Agent': 'codex' });
  await expect.poll(() => subs(page)).toEqual([{ name: 'Count the lines', type: 'Codex', tool: 'codex', parent: 'Test the office' }]);
  expect(await mains(page)).toEqual(['Test the office']);   // not a teammate of its own

  // Still a subagent after a reload, and done when its task is.
  await page.reload();
  await expect.poll(() => subs(page)).toEqual([{ name: 'Count the lines', type: 'Codex', tool: 'codex', parent: 'Test the office' }]);
  await office.hook({ hook_event_name: 'Stop', session_id: 'x1', cwd }, { 'X-Agent-Office-Agent': 'codex' });
  await expect.poll(() => page.evaluate(() => agents.find(a => a.kind === 'sub')?.awaitingReview || agents.find(a => a.kind === 'sub')?.gone)).toBeTruthy();
});

test('without the agent that handed it over in the office, a handed-over session is a teammate of its own', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'x2', cwd }, { 'X-Agent-Office-Agent': 'codex' });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'x2', cwd, prompt: handed('Write the guide') }, { 'X-Agent-Office-Agent': 'codex' });
  await open(page, office);
  await expect.poll(() => mains(page)).toEqual(['Write the guide']);
  expect(await subs(page)).toEqual([]);
});

test('a task handed on again joins the same team', async ({ page, office }) => {
  const mid = 'thread:delegated-task:m1';
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'b3', cwd }, { 'X-Agent-Office-T3-Thread': boss });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'b3', cwd, prompt: 'Lead the review' }, { 'X-Agent-Office-T3-Thread': boss });
  await open(page, office);
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'm1', cwd }, { 'X-Agent-Office-T3-Thread': mid });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'm1', cwd, prompt: handed('Plan the review') }, { 'X-Agent-Office-T3-Thread': mid });
  // Cursor's own hook names (see adapters.js).
  await office.hook({ hook_event_name: 'sessionStart', conversation_id: 'c3', workspace_roots: [cwd] }, { 'X-Agent-Office-Agent': 'cursor' });
  await office.hook({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c3', workspace_roots: [cwd], prompt: `[T3 Code: the agent in T3 thread "${mid}" sent this message, not the user.]\n\nRead the docs` }, { 'X-Agent-Office-Agent': 'cursor' });
  await expect.poll(async () => (await subs(page)).map(x => [x.name, x.parent]).sort()).toEqual([['Plan the review', 'Lead the review'], ['Read the docs', 'Lead the review']]);
  expect(await mains(page)).toEqual(['Lead the review']);
});

test("a tool with no app of its own keeps its letter badge under T3 Code, not T3 Code's logo", async ({ page, office }) => {
  const t3 = { 'X-Agent-Office-Agent': 'antigravity', 'X-Agent-Office-App': 'com.t3tools.t3code' };
  await office.hook({ conversationId: 'g1', cwd, hookEventName: 'SessionStart', lastUserInput: 'Count' }, t3);
  await office.hook({ conversationId: 'g1', cwd, hookEventName: 'PreInvocation', invocationNum: 0, lastUserInput: 'Count the lines' }, t3);
  await open(page, office);
  await expect(row(page, 'Count the lines').locator('.av-app')).toHaveText('Ag');
});
