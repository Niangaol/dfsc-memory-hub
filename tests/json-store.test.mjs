import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../plugins/memory-hub/server/json-store.mjs';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-hub-store-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('mutate persists and read returns the written value', async () => {
  await withDir(async (dir) => {
    const store = new JsonStore(join(dir, 'memory.json'));
    await store.mutate(() => ({ result: 'ok', next: { items: [1, 2] } }));
    const read = await store.read();
    assert.equal(read.corrupt, false);
    assert.deepEqual(read.data, { items: [1, 2] });
  });
});

test('read reports a corrupt file without touching it', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    await writeFile(file, '{ broken json');
    const store = new JsonStore(file);
    const read = await store.read();
    assert.equal(read.corrupt, true);
    assert.equal(read.data, null);
    assert.equal(await readFile(file, 'utf8'), '{ broken json', 'read must not rewrite or remove the file');
  });
});

test('mutate backs up a corrupt file before rebuilding', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    await writeFile(file, 'not json');
    const store = new JsonStore(file);
    await store.mutate(() => ({ result: 1, next: { rebuilt: true } }));
    const names = await readdir(dir);
    assert.ok(names.some((name) => name.startsWith('memory.json.corrupt-')), `expected a backup, saw ${names}`);
    assert.deepEqual((await store.read()).data, { rebuilt: true });
  });
});

test('concurrent writers keep both changes', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const a = new JsonStore(file);
    const b = new JsonStore(file);
    await Promise.all([
      a.mutate((data) => ({ result: null, next: { ...(data ?? {}), first: true } })),
      b.mutate((data) => ({ result: null, next: { ...(data ?? {}), second: true } })),
    ]);
    const read = await a.read();
    assert.deepEqual(read.data, { first: true, second: true });
  });
});

test('a stale lock is taken over instead of blocking forever', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file, { staleMs: 5, lockTimeoutMs: 2000 });
    await writeFile(`${file}.lock`, '{"pid":1}');
    const start = Date.now();
    await store.mutate(() => ({ result: null, next: { ok: true } }));
    assert.ok(Date.now() - start < 1500, 'should not wait for the full timeout');
    assert.deepEqual((await store.read()).data, { ok: true });
  });
});

test('a live lock times out with a clear error', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file, { staleMs: 60_000, lockTimeoutMs: 150 });
    await writeFile(`${file}.lock`, '{"pid":1}');
    await assert.rejects(store.mutate(() => ({ result: null, next: {} })), /lock timeout/i);
  });
});

test('a failed writer does not leave a lock behind', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'memory.json');
    const store = new JsonStore(file);
    await assert.rejects(store.mutate(() => { throw new Error('boom'); }), /boom/);
    const names = await readdir(dir);
    assert.ok(!names.includes('memory.json.lock'), `lock leaked: ${names}`);
  });
});
