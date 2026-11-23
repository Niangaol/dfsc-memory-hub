import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestSessions } from '../plugins/memory-hub/server/digest.mjs';

const SLUG = '--D--AgentPrograms-demo--';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-hub-digest-'));
  const dir = join(root, SLUG);
  await mkdir(dir, { recursive: true });
  return { root, dir };
}

function line(role, text) {
  return JSON.stringify({
    type: 'message',
    id: 'x',
    parentId: null,
    timestamp: '2026-11-23T10:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  });
}

test('digest skips subagent sessions and keeps real ones', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, '2026-11-23T00-00-00-000Z_main.jsonl'), [
      JSON.stringify({ type: 'session', cwd: 'D:\\AgentPrograms\\demo' }),
      line('user', '构建用 pnpm'),
      line('assistant', '好的，记录一下。'),
    ].join('\n') + '\n');
    await writeFile(join(dir, '2026-11-23T00-00-01-000Z_subagent-abc.jsonl'), line('user', '子代理不该出现') + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 5000 });
    assert.equal(result.sessions.length, 1);
    assert.ok(result.text.includes('构建用 pnpm'));
    assert.ok(!result.text.includes('子代理不该出现'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest orders sessions newest first', async () => {
  const { root, dir } = await fixture();
  try {
    const older = join(dir, '2026-11-20T00-00-00-000Z_a.jsonl');
    const newer = join(dir, '2026-11-22T00-00-00-000Z_b.jsonl');
    await writeFile(older, line('user', '旧的会话') + '\n');
    await writeFile(newer, line('user', '新的会话') + '\n');
    const now = Date.now() / 1000;
    await utimes(older, now - 7200, now - 7200);
    await utimes(newer, now, now);
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 5000 });
    assert.ok(result.text.indexOf('新的会话') < result.text.indexOf('旧的会话'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest honours the session count', async () => {
  const { root, dir } = await fixture();
  try {
    for (let i = 0; i < 4; i++) {
      await writeFile(join(dir, `2026-11-2${i}T00-00-00-000Z_s.jsonl`), line('user', `会话 ${i}`) + '\n');
    }
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 2, maxChars: 50_000 });
    assert.equal(result.sessions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest redacts credentials and clips to the character budget', async () => {
  const { root, dir } = await fixture();
  try {
    const file = join(dir, '2026-11-23T00-00-00-000Z_main.jsonl');
    await writeFile(file, line('user', '我的 key 是 sk-live-abcdef1234567890') + '\n');
    for (let i = 0; i < 40; i++) await appendFile(file, line('assistant', `很长的回复 ${i} ${'填充'.repeat(60)}`) + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 1200 });
    assert.ok(!result.text.includes('sk-live-abcdef1234567890'));
    assert.ok(result.text.length <= 1200, `got ${result.text.length} characters`);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest returns an empty result when nothing exists', async () => {
  const { root } = await fixture();
  try {
    const result = await digestSessions({ sessionsRoot: root, slug: '--missing--', count: 3, maxChars: 1000 });
    assert.deepEqual(result.sessions, []);
    assert.equal(result.text, '');
    assert.equal(result.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('digest ignores tool output and malformed lines', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, '2026-11-23T00-00-00-000Z_main.jsonl'), [
      'not json',
      JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: '工具输出' }] } }),
      line('user', '人的提问'),
    ].join('\n') + '\n');
    const result = await digestSessions({ sessionsRoot: root, slug: SLUG, count: 5, maxChars: 5000 });
    assert.ok(result.text.includes('人的提问'));
    assert.ok(!result.text.includes('工具输出'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
