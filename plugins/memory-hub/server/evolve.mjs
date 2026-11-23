/**
 * evolve.mjs — 记忆的「自进化」全部在这里，且全是纯函数
 *
 * 不调模型、不读时间以外的外部状态，因此可以在测试里用固定 now 精确验证：
 *   - findMergeCandidate：写入时与已有条目比对，重复则并入而不是新增
 *   - effectiveWeight + score：召回时按相似度、历史命中、新近度、标签排序
 *   - applyDecay：长期没人用的条目归档（保留历史，不删除）
 *   - evictOverflow：超过容量时先归档最弱的，并把归档清单回报给调用方
 *
 * 常数集中在此，改行为只改这里。
 */
import { cosine, normalize, tokens } from './text.mjs';

// 0.92 而不是更低：中文二元组让「构建用 pnpm」和「构建用 npm」相似度就到 0.83，
// 阈值一松就会把互相矛盾的结论并入同一条，等于丢掉「后来改主意了」这件事。
// 标点/空白差异的重复文本相似度为 1，仍会合并。
export const MERGE_THRESHOLD = 0.92;
export const DECAY_DAYS = 60;
export const HIT_BOOST = 0.05;
export const PROJECT_CAP = 600;
export const GLOBAL_CAP = 300;
export const MAX_TEXT = 2000;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 32;
export const RECALL_LIMIT_MAX = 20;

const DAY_MS = 86_400_000;
const WEIGHTS = { similarity: 0.45, weight: 0.25, recency: 0.2, tags: 0.1 };

function daysSince(iso, now) {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return 365;
  return Math.max(0, (now - time) / DAY_MS);
}

/** 有效权重：基础重要度 + 命中带来的对数增益，封顶 1。 */
export function effectiveWeight(memory, now = Date.now()) {
  const base = Number.isFinite(memory?.importance) ? Math.min(1, Math.max(0, memory.importance)) : 0.5;
  const hits = Number.isFinite(memory?.hits) ? Math.max(0, memory.hits) : 0;
  return Math.min(1, base + HIT_BOOST * Math.log1p(hits));
}

function recency(memory, now) {
  return 1 / (1 + daysSince(memory?.updatedAt ?? memory?.createdAt, now) / 30);
}

/** 召回打分。queryTags 命中时加标签分，其余按文本相似度。 */
export function score(memory, query, now = Date.now(), { queryTags = [] } = {}) {
  const similarity = cosine(tokens(query), tokens(memory?.text));
  const weight = effectiveWeight(memory, now);
  const fresh = recency(memory, now);
  const wanted = new Set(queryTags.map((tag) => normalize(tag)).filter(Boolean));
  const owned = new Set((memory?.tags ?? []).map((tag) => normalize(tag)));
  let tagHits = 0;
  for (const tag of wanted) if (owned.has(tag)) tagHits += 1;
  const tagScore = wanted.size === 0 ? 0 : tagHits / wanted.size;
  return WEIGHTS.similarity * similarity + WEIGHTS.weight * weight + WEIGHTS.recency * fresh + WEIGHTS.tags * tagScore;
}

/**
 * 找可以合并的条目：归一化文本相同，或同类型且相似度达到阈值。
 * 只在 active 里找；跨类型不合并——一条「事实」和一条「教训」讲同一件事时，
 * 两者的用途不同，合成一条会同时削弱两边。
 */
export function findMergeCandidate(memories, candidate, threshold = MERGE_THRESHOLD) {
  const text = normalize(candidate?.text);
  if (!text) return null;
  const candidateTokens = tokens(text);
  const sameType = candidate?.type === undefined;
  for (const memory of memories ?? []) {
    if (memory?.status !== 'active') continue;
    if (!sameType && memory.type !== candidate.type) continue;
    if (normalize(memory.text) === text) return memory;
    if (cosine(candidateTokens, tokens(memory.text)) >= threshold) return memory;
  }
  return null;
}

/** 过期归档：active + 从未命中 + 超过窗口。返回被归档的 id。 */
export function applyDecay(memories, now = Date.now(), days = DECAY_DAYS) {
  const archived = [];
  for (const memory of memories ?? []) {
    if (memory?.status !== 'active') continue;
    if ((memory.hits ?? 0) > 0) continue;
    const stamp = memory.lastHitAt ?? memory.updatedAt ?? memory.createdAt;
    if (daysSince(stamp, now) <= days) continue;
    memory.status = 'archived';
    memory.updatedAt = new Date(now).toISOString();
    archived.push(memory.id);
  }
  return { archived };
}

/** 容量淘汰：active 超过 cap 时按有效权重从低到高归档。 */
export function evictOverflow(memories, cap, now = Date.now()) {
  const active = (memories ?? []).filter((memory) => memory?.status === 'active');
  if (active.length <= cap) return { evicted: [] };
  const weakestFirst = [...active].sort((a, b) => {
    const delta = effectiveWeight(a, now) - effectiveWeight(b, now);
    if (delta !== 0) return delta;
    return String(a.updatedAt ?? a.createdAt).localeCompare(String(b.updatedAt ?? b.createdAt));
  });
  const evicted = [];
  for (const memory of weakestFirst.slice(0, active.length - cap)) {
    memory.status = 'archived';
    memory.updatedAt = new Date(now).toISOString();
    evicted.push(memory.id);
  }
  return { evicted };
}
