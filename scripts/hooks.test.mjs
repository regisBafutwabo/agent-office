import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runHook(relative, overrides = {}, args = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-hooks-'));
  try {
    const capture = path.join(dir, 'curl-args'), input = path.join(dir, 'payload');
    writeFileSync(path.join(dir, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOOK_CAPTURE"\ncat > "$HOOK_INPUT"\nprintf \'%s\' \'{"decision":"test"}\'\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, HOOK_CAPTURE: capture, HOOK_INPUT: input };
    for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE']) delete env[name];
    Object.assign(env, overrides);
    const payload = JSON.stringify({ session_id: 'test-session', hook_event_name: 'UserPromptSubmit' });
    const result = spawnSync('/bin/sh', [fileURLToPath(new URL(relative, import.meta.url)), ...args], { env, input: payload, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return { stdout: result.stdout, args: existsSync(capture) ? readFileSync(capture, 'utf8') : null, payload: existsSync(input) ? readFileSync(input, 'utf8') : null, original: payload };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const hook of ['send', 'permission']) {
  test(`${hook}: imported Claude hooks ignore Codex without contacting the server`, () => {
    for (const name of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH']) {
      const result = runHook(`../plugin/hooks/${hook}.sh`, { [name]: 'codex-thread' });
      assert.equal(result.args, null);
      assert.equal(result.stdout, '');
    }
  });

  test(`${hook}: real Claude sessions still report, including Claude launched from Codex`, () => {
    for (const env of [{}, { CLAUDE_CODE_ENTRYPOINT: 'desktop' }, { CODEX_THREAD_ID: 'parent', CLAUDE_CODE_ENTRYPOINT: 'cli' }, { CODEX_APP_TOOLS_PIPE_PATH: '/tmp/codex-test', CLAUDE_CODE_ENTRYPOINT: 'desktop' }, { CODEX_SESSION_ID: 'parent', CLAUDECODE: '1' }]) {
      const result = runHook(`../plugin/hooks/${hook}.sh`, env);
      assert.ok(result.args.includes(hook === 'send' ? '/hook' : '/permission'));
      assert.equal(result.payload, result.original);
      assert.equal(result.stdout, hook === 'send' ? '' : '{"decision":"test"}');
    }
  });
}

test('the dedicated Codex adapter still reports once with the Codex identity', () => {
  const result = runHook('../adapters/hook.sh', { CODEX_THREAD_ID: 'codex-thread' }, ['codex']);
  assert.match(result.args, /X-Agent-Office-Agent: codex/);
  assert.equal(result.payload, result.original);
  assert.equal(result.stdout, '');
});
