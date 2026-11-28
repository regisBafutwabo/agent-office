import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const KEY = 'ab'.repeat(32);
function runHook(relative, overrides = {}, args = [], { key = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-hooks-'));
  try {
    if (key) writeFileSync(path.join(dir, 'hook-token'), `X-Agent-Office-Token: ${KEY}\n`, { mode: 0o600 });
    const capture = path.join(dir, 'curl-args'), input = path.join(dir, 'payload');
    writeFileSync(path.join(dir, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOOK_CAPTURE"\ncat > "$HOOK_INPUT"\nprintf \'%s\' \'{"decision":"test"}\'\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, HOOK_CAPTURE: capture, HOOK_INPUT: input, AGENT_OFFICE_DATA: dir };
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

test('every hook passes on the T3 Code thread', () => {
  for (const [hook, args] of [['../plugin/hooks/send.sh', []], ['../plugin/hooks/permission.sh', []], ['../adapters/hook.sh', ['codex']]])
    assert.match(runHook(hook, { T3CODE_THREAD_ID: 'fceae35e-a7d0-4d26-b667-aa2413567acf' }, args).args, /X-Agent-Office-T3-Thread: fceae35e-a7d0-4d26-b667-aa2413567acf/);
});

test('the dedicated Codex adapter still reports once with the Codex identity', () => {
  const result = runHook('../adapters/hook.sh', { CODEX_THREAD_ID: 'codex-thread' }, ['codex']);
  assert.match(result.args, /X-Agent-Office-Agent: codex/);
  assert.equal(result.payload, result.original);
  assert.equal(result.stdout, '');
});

test('every hook sends the hook key from its file, never on the command line', () => {
  for (const [hook, args] of [['../plugin/hooks/send.sh', []], ['../plugin/hooks/permission.sh', []], ['../adapters/hook.sh', ['codex']]]) {
    const result = runHook(hook, {}, args);
    assert.match(result.args, /^@.*\/hook-token$/m);
    assert.ok(!result.args.includes(KEY));
  }
});

test('with no hook key (the office never ran) hooks stay silent and Claude Code asks as usual', () => {
  for (const [hook, args, stdout] of [['../plugin/hooks/send.sh', [], ''], ['../plugin/hooks/permission.sh', [], ''], ['../adapters/hook.sh', ['cursor'], '{}\n'],
      ['../adapters/hook.sh', ['antigravity', 'PostToolUse'], '{}\n'], ['../adapters/hook.sh', ['antigravity', 'Stop'], '{"decision":""}\n']]) {   // Antigravity's Stop needs a decision
    const result = runHook(hook, {}, args, { key: false });
    assert.equal(result.args, null);
    assert.equal(result.stdout, stdout);
  }
});
