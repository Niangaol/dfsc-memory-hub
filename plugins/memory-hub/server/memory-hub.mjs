#!/usr/bin/env node
/**
 * memory-hub — 本地项目记忆（MCP stdio server，零依赖）
 *
 * 分层：
 *   server/json-store.mjs  锁 + 原子读写（无业务语义）
 *   server/evolve.mjs      自进化纯函数：合并、打分、衰减、淘汰
 *   server/store.mjs       记忆语义层：分库与条目生命周期
 *   server/digest.mjs      会话素材摘录（有界读取）
 *   server/tools.mjs       七个工具的定义与分发
 *   server/memory-hub.mjs  协议层（本文件）：MCP over stdio 的 JSON-RPC 2.0
 *
 * 协议：换行分隔的 JSON-RPC 2.0。stdout 只走协议，日志走 stderr。
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool, createToolContext } from './tools.mjs';

const PROTOCOL_FALLBACK = '2024-11-05';
const SERVER_VERSION = '0.1.0';

function log(...args) {
  process.stderr.write(`[memory-hub] ${args.join(' ')}\n`);
}

// 宿主提前关闭 stdio 管道时安静退出，不抛未捕获的 EPIPE
for (const stream of [process.stdout, process.stdin]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    log('stream error:', String(error?.message ?? error));
  });
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const ctx = createToolContext({ log });

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      send(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'memory-hub', version: SERVER_VERSION },
      });
      return;
    case 'ping':
      send(id, {});
      return;
    case 'tools/list':
      send(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) {
        sendError(id, -32602, `unknown tool: ${String(name)}`);
        return;
      }
      try {
        const result = await callTool(name, args, ctx);
        send(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        // 工具错误回给模型，让它自己决定改参数重试还是告诉用户，而不是直接断开连接。
        log('tool failed:', String(error?.stack ?? error));
        send(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(error?.message ?? error) }) }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (id !== undefined && id !== null) sendError(id, -32601, `method not found: ${String(method)}`);
  }
}

const lines = createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();

lines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    // 一行坏输入不能拖垮整个连接：记一笔，继续读下一行。
    log('ignored a malformed JSON-RPC line');
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    log('ignored a non-object JSON-RPC message');
    return;
  }
  // 串行处理：记忆写入必须按到达顺序生效，否则同一会话的 retain 会互相覆盖。
  queue = queue
    .then(() => handleRequest(message))
    .catch((error) => {
      log('request failed:', String(error?.stack ?? error));
      if (message.id !== undefined && message.id !== null) sendError(message.id, -32603, 'internal error');
    });
});

lines.on('close', () => {
  queue.finally(() => process.exit(0));
});
