// src/cli/index.ts
// `lab-field-ops` CLI 入口：commander 子命令 router。
//
// 设计原则（来自 spec.md 与 outline 的 cli 模式）：
// 1. 默认子命令 = `plugin`（信息科最常用入口）
// 2. plugin add <manifest.json> | plugin remove <name> | plugin list
// 3. 失败用 process.exit(1)；成功用 process.exit(0)
// 4. 输出全部 stdout/stderr，CLI 可被 shell pipe / CI 消费
// 5. 导出 buildProgram() / runCli(argv) 便于测试在进程内调用（避免 ts-node ESM 解析问题）
//
// 领养的调用链（参考 outline/server/commands 命令行注册形态）：
//   commander.parse(process.argv) → 路由到 addPlugin/removePlugin/listPlugins → 格式化输出

import { Command } from 'commander';
import {
  addPlugin,
  removePlugin,
  listPlugins,
  renderPluginTable,
  formatAddOutput,
  formatRemoveOutput,
} from './plugin.js';

/** package.json 的 version（由构建期注入；这里给一个 fallback）。 */
const VERSION = (() => {
  try {
    // ts-node + 编译后都能用：尝试读 package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
})();

/** 构造 commander program 实例（纯函数，无 IO；可被测试 in-process 调用）。 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('lab-field-ops')
    .description('检验业务现场作业系统 · 信息科 CLI 入口')
    .version(VERSION);

  /** plugin 子命令组 */
  const pluginCmd = program.command('plugin').description('注册 / 卸载 / 列出 plugin');

  pluginCmd
    .command('add <manifest>')
    .description('注册一个新 plugin（manifest 文件路径）')
    .action((manifestPath: string) => {
      const result = addPlugin(manifestPath);
      const out = formatAddOutput(result);
      if (result.ok) {
        console.log(out);
        process.exit(0);
      } else {
        console.error(out);
        process.exit(1);
      }
    });

  pluginCmd
    .command('remove <name>')
    .description('卸载一个已注册 plugin')
    .action((name: string) => {
      const result = removePlugin(name);
      const out = formatRemoveOutput(result);
      if (result.ok) {
        console.log(out);
        process.exit(0);
      } else {
        console.error(out);
        process.exit(1);
      }
    });

  pluginCmd
    .command('list')
    .description('列出已注册的 plugin（name/version/type/queue/installed_at）')
    .action(() => {
      const rows = listPlugins();
      console.log(renderPluginTable(rows));
      process.exit(0);
    });

  /** 默认行为：未指定子命令时打印帮助并退出非零（避免静默）。 */
  program.action(() => {
    program.help({ error: true });
  });

  return program;
}

/**
 * 在进程内执行 CLI 命令（无子进程）。
 * - argv: 与 process.argv 同形态；argv[0]=node, argv[1]=script, argv[2..]=子命令
 * - 返回 {status, stdout, stderr}；status 是 process.exit 的目标码（0/1）
 * - 真正调用 process.exit 由调用方决定（CLI 默认会 exit；测试会拦截）
 */
export function runCli(
  argv: string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void } = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
): number {
  const program = buildProgram();

  // 拦截 console.log / console.error 让输出流到 io.stdout / io.stderr
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...parts: unknown[]) => {
    io.stdout(parts.map(String).join(' ') + '\n');
  };
  console.error = (...parts: unknown[]) => {
    io.stderr(parts.map(String).join(' ') + '\n');
  };

  // 拦截 process.exit：把退出码收集起来，不真正退出进程
  let capturedStatus = 0;
  const savedExit = process.exit;
  process.exit = ((code?: number) => {
    capturedStatus = code ?? 0;
    throw new Error(`__EXIT_${capturedStatus}__`);
  }) as never;

  try {
    program.parse(argv);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('__EXIT_')) {
      capturedStatus = Number(msg.match(/__EXIT_(\d+)__/)?.[1] ?? '0');
    }
    // commander.help({error:true}) 会抛 CommanderError（包含 helpDisplayed），吞掉即可
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = savedExit;
  }

  return capturedStatus;
}

/** CLI 直接执行入口（ts-node / dist/cli/index.js 都走这里）。 */
function main(): void {
  runCli(process.argv);
}

// 当文件作为 CLI 入口执行时（ts-node 或 node dist/cli/index.js）才走 main
// 通过 process.argv[1] 末段匹配判断
const argv1 = process.argv[1] ?? '';
const isCliEntry =
  argv1.endsWith('cli/index.js') ||
  argv1.endsWith('cli/index.ts') ||
  argv1.endsWith('dist/cli/index.js');
if (isCliEntry) {
  main();
}
