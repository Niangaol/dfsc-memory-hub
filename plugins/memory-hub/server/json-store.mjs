/**
 * json-store.mjs — 通用 JSON 文件存储：锁 + 读-改-写 + 原子替换
 *
 * 这里没有任何记忆业务语义，只解决一个问题：多个 MCP 进程（宿主可能为每个会话
 * 各起一个）读写同一份文件时，不能用旧快照覆盖对方的写入。
 *
 * 约定：
 *   - read() 只读，损坏时返回 corrupt: true，绝不改文件
 *   - mutate(fn) 持锁读盘、fn 返回 { result, next }、写临时文件后 rename 替换
 *   - 锁超时报错（不静默继续写）；陈旧锁（默认 15 秒）可接管
 *   - fn 抛错时释放锁，不留下残锁
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 15_000;
const RETRY_MS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JsonStore {
  constructor(file, { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS, log = () => {} } = {}) {
    this.file = file;
    this.lockFile = `${file}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleMs = staleMs;
    this.log = log;
    this._cache = null;
    this._cachedRaw = null;
  }

  _parse(raw) {
    if (!raw) return { data: null, corrupt: false };
    try {
      const data = JSON.parse(raw);
      return { data: data && typeof data === 'object' ? data : null, corrupt: false };
    } catch {
      return { data: null, corrupt: true };
    }
  }

  async read() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 瞬时读错误不能伪装成空库：沿用最近一次成功的缓存。
        if (this._cache) return this._cache;
        this.log(`read failed: ${String(error?.message ?? error)}`);
      }
      const empty = { data: null, corrupt: false };
      this._cache = empty;
      this._cachedRaw = null;
      return empty;
    }
    if (raw === this._cachedRaw && this._cache) return this._cache;
    const parsed = this._parse(raw);
    this._cache = parsed;
    this._cachedRaw = raw;
    return parsed;
  }

  async _acquire() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await fs.promises.open(this.lockFile, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const info = await fs.promises.stat(this.lockFile);
          if (Date.now() - info.mtimeMs > this.staleMs) {
            await fs.promises.unlink(this.lockFile).catch(() => {});
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`lock timeout (${this.lockTimeoutMs}ms): ${this.lockFile}`);
        await sleep(RETRY_MS);
      }
    }
  }

  async _release() {
    await fs.promises.unlink(this.lockFile).catch(() => {});
  }

  async mutate(fn) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await this._acquire();
    try {
      let raw = null;
      try {
        raw = await fs.promises.readFile(this.file, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const parsed = raw === null ? { data: null, corrupt: false } : this._parse(raw);
      let current = parsed.data;
      if (parsed.corrupt) {
        // 损坏文件的备份只能在锁内做：锁外的 rename 会让两个进程互相覆盖备份。
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await fs.promises.rename(this.file, backup);
        this.log(`corrupt file backed up to ${backup}`);
        current = null;
      }
      const outcome = fn(current);
      const next = outcome && typeof outcome === 'object' && 'next' in outcome ? outcome.next : outcome;
      const serialized = JSON.stringify(next ?? {}, null, 2);
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await fs.promises.writeFile(tmp, serialized);
        await fs.promises.rename(tmp, this.file);
      } catch (error) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw error;
      }
      this._cache = { data: next ?? {}, corrupt: false };
      this._cachedRaw = serialized;
      return outcome && typeof outcome === 'object' && 'result' in outcome ? outcome.result : outcome;
    } finally {
      await this._release();
    }
  }
}
