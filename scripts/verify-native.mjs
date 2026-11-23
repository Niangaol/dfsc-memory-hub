#!/usr/bin/env node
/**
 * DFSC 实机验收：隔离 profile + 本地市场，安装 memory-hub 并确认 MCP 真的挂上。
 *
 * 覆盖范围（都能被下面断言证明）：
 *   1. 临时 DESKTOP_TEST_USER_DATA 启动已安装的 StepCode，不碰真实配置
 *   2. 把本仓库当作本地市场加入，确认能发现 memory-hub
 *   3. 通过原生能力管理器安装，版本与包内清单一致
 *   4. 新建独立会话后，会话摘要里 `memory-hub__memory` 为 connected 且工具数为 8
 *   5. 运行时命令表里出现本插件的技能与命令
 *   6. 卸载并移除市场，回到初始状态
 *
 * 不覆盖（宿主没有对应接口，只能靠真实模型回合）：
 *   - 由模型实际调用 retain/recall 并落盘 —— 需要一次付费模型请求，本脚本刻意不发
 *   - 桌面入口 / 连接页 —— 本插件不声明 desktop
 *
 * 运行：
 *   node scripts/verify-native.mjs --exe "D:/StepCode/StepCode.exe" --playwright "D:/AgentPrograms/AtHand"
 * 缺参数时打印 SKIP 并以 0 退出。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const requestedExe = arg('exe') ?? process.env.STEPCODE_EXE;
if (!requestedExe) {
  console.log('SKIP: 未提供 --exe（或 STEPCODE_EXE）。实机验收需要已安装的 StepCode 可执行文件。');
  process.exit(0);
}
const playwrightHome = arg('playwright') ?? process.env.PLAYWRIGHT_HOME;
if (!playwrightHome) {
  console.log('SKIP: 未提供 --playwright（或 PLAYWRIGHT_HOME）——指向包含 node_modules/playwright 的目录。');
  process.exit(0);
}

const require = createRequire(join(resolve(playwrightHome), 'package.json'));
const { _electron: electron } = require('playwright');
const executablePath = await realpath(requestedExe);
const plugin = JSON.parse(await readFile(join(root, 'plugins/memory-hub/step.plugin.json'), 'utf8'));
const expectedTools = 8;
const MARKETPLACE = 'memory-hub-local';

const profile = await realpath(await mkdtemp(join(tmpdir(), 'memory-hub-native-')));
const memoryHome = join(profile, 'memory-home');
const evidence = {
  plugin: plugin.id, version: plugin.version, platform: process.platform, arch: process.arch,
  executablePath, profile, modelRequests: 0,
};

async function closeApp(app) {
  try {
    await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => {});
  } finally {
    await app.close().catch(() => {});
  }
}

let app;
try {
  await mkdir(join(profile, 'step-runtime'), { recursive: true });
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ language: 'zh', theme: 'dark', workspaces: [] }));
  const env = { ...process.env, DESKTOP_TEST_USER_DATA: profile, DESKTOP_TEST_NO_FOCUS: '1', MEMORY_HUB_HOME: memoryHome };
  // 去掉所有模型与账户凭据：本验收不允许发生一次付费请求。
  for (const key of Object.keys(env)) {
    if (/^(STEP|STEPCODE|STEPFUN|OPENAI|ANTHROPIC|OPENROUTER|GH_|GITHUB_)/iu.test(key)
      || /(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD)(?:_|$)/iu.test(key)) delete env[key];
  }
  // 代理 shell 常带 ELECTRON_RUN_AS_NODE=1，会让 Electron 以 Node 模式启动并拒绝
  // 所有 Electron 参数（表现为 "bad option: --remote-debugging-port"）。
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { DESKTOP_TEST_USER_DATA: profile, DESKTOP_TEST_NO_FOCUS: '1', MEMORY_HUB_HOME: memoryHome });

  app = await electron.launch({ executablePath, env, timeout: 90000 });
  app.process().stderr?.on('data', () => {});
  const page = await app.firstWindow({ timeout: 90000 });
  page.setDefaultTimeout(60000);
  await page.waitForFunction(() => document.querySelector('.new-chat')?.disabled === false, undefined, { timeout: 120000 });
  evidence.appVersion = await app.evaluate(({ app: instance }) => instance.getVersion());

  const catalog = () => page.evaluate(() => window.desktop.capabilityCatalog());
  const mutate = (input) => page.evaluate((value) => window.desktop.capabilityMutate(value), input);

  const before = await catalog();
  const added = await mutate({ action: 'marketplace-add', source: root });
  assert.deepEqual(added.warnings ?? [], [], '加入本地市场不应产生警告');
  const discovered = await catalog();
  const entry = discovered.available.find((item) => item.name === plugin.id);
  assert.ok(entry, `市场没有发现 ${plugin.id}；实际发现：${discovered.available.map((item) => item.name).join(',') || '(空)'}`);
  evidence.discovered = true;

  const market = discovered.marketplaces.find((item) => item.kind === 'local' && item.name !== 'builtin');
  await mutate({ action: 'plugin-install', name: plugin.id, marketplace: market?.name ?? MARKETPLACE });
  const installed = (await catalog()).plugins.find((item) => item.id === plugin.id);
  assert.ok(installed, '安装后目录里应有该插件');
  assert.equal(installed.version, plugin.version);
  evidence.installed = installed.version;
  evidence.iconKind = installed.icon?.kind ?? null;

  // 新会话：插件 MCP 在会话运行时启动阶段连接，与首条问题无关。
  const session = await page.evaluate(() => window.desktop.newIndependentSession());
  let server;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const summary = await page.evaluate((id) => window.desktop.summary(id), session.runtimeId).catch(() => null);
    server = summary?.mcp?.find((item) => item.name.startsWith(`${plugin.id}__`));
    if (server?.status === 'connected') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  evidence.mcpStatus = server?.status ?? 'missing';
  evidence.mcpToolCount = server?.toolCount ?? 0;
  assert.equal(server?.status, 'connected', `memory MCP 未连接：${JSON.stringify(server ?? null)}`);
  assert.equal(server.toolCount, expectedTools, `工具数应为 ${expectedTools}，实际 ${server.toolCount}`);

  const commands = await page.evaluate(async (id) => (await window.desktop.command('get_commands', undefined, id))?.commands ?? [], session.runtimeId);
  const names = commands.map((item) => item.name);
  evidence.skillsLoaded = names.filter((name) => name.startsWith('skill:memory-'));
  evidence.commandsLoaded = names.filter((name) => name === 'memory' || name === 'remember');
  assert.ok(evidence.skillsLoaded.length >= 2, `技能未加载：${names.join(',')}`);
  assert.ok(evidence.commandsLoaded.length >= 2, `命令未加载：${names.join(',')}`);

  // 卸载 + 移除市场，确认回到安装前的状态。
  await mutate({ action: 'plugin-remove', id: plugin.id });
  await mutate({ action: 'marketplace-remove', name: market?.name ?? MARKETPLACE });
  const after = await catalog();
  assert.deepEqual(after.plugins.map((item) => item.id).sort(), before.plugins.map((item) => item.id).sort());
  evidence.restoredBaseline = true;

  // 服务启动过但没有写入：不应凭空产生记忆文件。
  evidence.memoryHomeCreated = await access(memoryHome).then(() => true, () => false);
  assert.equal(evidence.memoryHomeCreated, false, '只启动服务、没有调用工具时不该写任何文件');

  evidence.passed = true;
  evidence.notCovered = [
    '模型实际调用 retain/recall 并落盘（需要一次付费模型请求，本脚本不发）',
    '桌面入口与连接页（本插件未声明 desktop）',
  ];
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (app) await closeApp(app).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
