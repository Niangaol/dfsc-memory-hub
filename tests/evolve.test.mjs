import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveWeight, score, findMergeCandidate, applyDecay, evictOverflow,
  MERGE_THRESHOLD, DECAY_DAYS, PROJECT_CAP,
} from '../plugins/memory-hub/server/evolve.mjs';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 23);

function memory(overrides = {}) {
  return {
    id: 'm_1', type: 'fact', text: 'alpha beta', tags: [], importance: 0.5,
    status: 'active', createdAt: new Date(now - 5 * DAY).toISOString(),
    updatedAt: new Date(now - 5 * DAY).toISOString(),
    hits: 0, lastHitAt: null, source: 'test', ...overrides,
  };
}

test('effectiveWeight grows with hits but stays bounded', () => {
  const cold = effectiveWeight(memory({ hits: 0 }), now);
  const warm = effectiveWeight(memory({ hits: 10 }), now);
  const hot = effectiveWeight(memory({ hits: 1000 }), now);
  assert.ok(cold < warm, 'recalled memories weigh more');
  assert.ok(warm < hot);
  assert.ok(hot <= 1, `weight must stay <= 1, got ${hot}`);
});

test('effectiveWeight prefers the stored importance when nothing was recalled', () => {
  const low = effectiveWeight(memory({ importance: 0.2 }), now);
  const high = effectiveWeight(memory({ importance: 0.9 }), now);
  assert.ok(high > low);
});

test('score ranks an exact match above an unrelated memory', () => {
  const query = 'build uses pnpm';
  const hit = score(memory({ text: 'build uses pnpm for everything' }), query, now);
  const miss = score(memory({ text: 'unrelated deployment trivia' }), query, now);
  assert.ok(hit > miss, `expected ${hit} > ${miss}`);
});

test('score rewards tag overlap', () => {
  const plain = score(memory({ text: 'zzz', tags: [] }), '构建', now, { queryTags: ['构建'] });
  const tagged = score(memory({ text: 'zzz', tags: ['构建'] }), '构建', now, { queryTags: ['构建'] });
  assert.ok(tagged > plain);
});

test('findMergeCandidate merges identical normalised text', () => {
  const existing = [memory({ id: 'm_a', text: 'Build   uses pnpm' })];
  const found = findMergeCandidate(existing, { text: 'build uses pnpm' });
  assert.equal(found?.id, 'm_a');
});

test('findMergeCandidate merges near-duplicates above the threshold', () => {
  const existing = [memory({ id: 'm_a', text: 'run the test suite with node --test before commit' })];
  const found = findMergeCandidate(existing, { text: 'run the test suite with node --test, before commit' });
  assert.equal(found?.id, 'm_a');
  assert.ok(MERGE_THRESHOLD > 0.5 && MERGE_THRESHOLD < 1);
});

test('findMergeCandidate keeps distinct memories apart', () => {
  const existing = [memory({ id: 'm_a', text: 'the build uses pnpm workspaces' })];
  assert.equal(findMergeCandidate(existing, { text: '部署走 GitHub Actions 的 ubuntu runner' }), null);
});

test('findMergeCandidate ignores invalidated and archived memories', () => {
  const existing = [memory({ id: 'm_a', status: 'invalidated' })];
  assert.equal(findMergeCandidate(existing, { text: 'alpha beta' }), null);
});

test('findMergeCandidate keeps contradictory values apart', () => {
  // 这两条只差一个词，但结论相反；合并会静默丢掉一次改主意的历史。
  const existing = [memory({ id: 'm_a', type: 'fact', text: '构建用 pnpm' })];
  assert.equal(findMergeCandidate(existing, { type: 'fact', text: '构建用 npm' }), null);
});

test('findMergeCandidate does not merge across memory types', () => {
  const existing = [memory({ id: 'm_a', type: 'fact', text: 'run tests before commit' })];
  assert.equal(findMergeCandidate(existing, { type: 'lesson', text: 'run tests before commit' }), null);
});

test('applyDecay archives only stale active memories', () => {
  const memories = [
    memory({ id: 'stale', hits: 0, updatedAt: new Date(now - (DECAY_DAYS + 10) * DAY).toISOString() }),
    memory({ id: 'used', hits: 3, updatedAt: new Date(now - (DECAY_DAYS + 10) * DAY).toISOString() }),
    memory({ id: 'fresh', hits: 0, updatedAt: new Date(now - DAY).toISOString() }),
  ];
  const { archived } = applyDecay(memories, now, DECAY_DAYS);
  assert.deepEqual(archived, ['stale']);
  assert.equal(memories.find((m) => m.id === 'stale').status, 'archived');
  assert.equal(memories.find((m) => m.id === 'used').status, 'active');
});

test('evictOverflow archives the weakest memories until the cap holds', () => {
  const memories = Array.from({ length: 5 }, (_, index) =>
    memory({ id: `m_${index}`, importance: index / 10, text: `memory number ${index}` }));
  const { evicted } = evictOverflow(memories, 3, now);
  assert.equal(evicted.length, 2);
  const active = memories.filter((m) => m.status === 'active');
  assert.equal(active.length, 3);
  assert.ok(!active.some((m) => m.id === 'm_0'), 'the weakest entry is archived first');
  assert.ok(PROJECT_CAP >= 100);
});

test('evictOverflow reports nothing when under the cap', () => {
  const memories = [memory({ id: 'm_a' })];
  assert.deepEqual(evictOverflow(memories, 10, now).evicted, []);
});
