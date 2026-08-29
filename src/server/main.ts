// src/server/main.ts
//
// 独立 HTTP server 入口：
//   - 用 node:http 自带能力；不引 Express，避免增加产线体积
//   - 与 src/server/routes/*.ts 现有纯函数 handler 解耦：handler 仍然是
//     (params, query, body) → RouteResponse，主路径与 e2e 复用同一份 route
//   - startServer() 返回 ServerHandle（port + url + close()），供 e2e
//     harness 启停；prod 也走同一入口（Dockerfile CMD 已指向这里）
//   - 默认注册所有内置队列（writeback + heartbeat），使 GET /api/queue/status
//     在启动后立即可见
//
// 路由表（GET / POST / DELETE）：
//   GET    /api/health
//   GET    /api/instruments
//   GET    /api/instruments/:id
//   GET    /api/alarm-codes
//   GET    /api/calibrations
//   POST   /api/processing-records
//   GET    /api/processing-records/:id
//   POST   /api/processing-records/:id/confirm
//   POST   /api/processing-records/:id/retry
//   GET    /api/plugins
//   DELETE /api/plugins/:name
//   GET    /api/audit
//   GET    /api/audit/:eventId/replay
//   GET    /api/queue/status
//   GET    /api/queue/:name/jobs
//   POST   /api/queue/retry/:jobId
//
// 设计取舍：
//   - 路由匹配用顺序扫描的 RouteRecord 数组（route 数 ≤ 20，性能不是瓶颈）；
//     正则提取 :param 即可，代码 ≤ 100 行
//   - body 解析仅支持 application/json；其他返回 415
//   - 启动时仅调 registerAllTasks() 一次：observer 由 routes/queue.ts 自行挂载
//     （不在 main 里再 observe 一次，避免重复订阅）

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getInstrumentsRoute, getInstrumentByIdRoute } from './routes/instruments.js';
import { getAlarmCodesRoute } from './routes/alarmCodes.js';
import { getCalibrationsRoute } from './routes/calibrations.js';
import {
  postProcessingRecordRoute,
  getProcessingRecordByIdRoute,
  postProcessingRecordConfirmRoute,
  postProcessingRecordRetryRoute,
} from './routes/processing-records.js';
import { getPluginsRoute, deletePluginRoute } from './routes/plugins.js';
import { getAuditRoute, getAuditReplayRoute } from './routes/audit.js';
import {
  getQueueStatusRoute,
  getQueueJobsRoute,
  postQueueRetryRoute,
} from './routes/queue.js';
import { registerAllTasks } from './queue/register.js';
import type { ApiErrorBody } from './errors.js';

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';

interface RouteRecord {
  method: Method;
  regex: RegExp;
  paramNames: string[];
  handler: (
    params: Record<string, string>,
    query: Record<string, string>,
    body: unknown,
  ) => { status: number; body: unknown };
}

const ROUTES: RouteRecord[] = [
  {
    method: 'GET',
    regex: /^\/api\/instruments\/([^/]+)$/,
    paramNames: ['id'],
    handler: (p, q, b) => getInstrumentByIdRoute(p, q, b),
  },
  {
    method: 'GET',
    regex: /^\/api\/instruments$/,
    paramNames: [],
    handler: (_p, q, b) => getInstrumentsRoute({}, q, b),
  },
  {
    method: 'GET',
    regex: /^\/api\/alarm-codes$/,
    paramNames: [],
    handler: (_p, q, b) => getAlarmCodesRoute({}, q, b),
  },
  {
    method: 'GET',
    regex: /^\/api\/calibrations$/,
    paramNames: [],
    handler: (_p, q, b) => getCalibrationsRoute({}, q, b),
  },
  {
    method: 'POST',
    regex: /^\/api\/processing-records\/([^/]+)\/retry$/,
    paramNames: ['id'],
    handler: (p, _q, b) => postProcessingRecordRetryRoute(p, {}, b),
  },
  {
    method: 'POST',
    regex: /^\/api\/processing-records\/([^/]+)\/confirm$/,
    paramNames: ['id'],
    handler: (p, _q, b) => postProcessingRecordConfirmRoute(p, {}, b),
  },
  {
    method: 'GET',
    regex: /^\/api\/processing-records\/([^/]+)$/,
    paramNames: ['id'],
    handler: (p, _q, _b) => getProcessingRecordByIdRoute(p, {}, null),
  },
  {
    method: 'POST',
    regex: /^\/api\/processing-records$/,
    paramNames: [],
    handler: (_p, _q, b) => postProcessingRecordRoute({}, {}, b),
  },
  {
    method: 'DELETE',
    regex: /^\/api\/plugins\/([^/]+)$/,
    paramNames: ['name'],
    handler: (p, _q, _b) => deletePluginRoute(p, {}, null),
  },
  {
    method: 'GET',
    regex: /^\/api\/plugins$/,
    paramNames: [],
    handler: (_p, _q, _b) => getPluginsRoute({}, {}, null),
  },
  {
    method: 'GET',
    regex: /^\/api\/audit\/([^/]+)\/replay$/,
    paramNames: ['eventId'],
    handler: (p, q, _b) => getAuditReplayRoute(p, q, null),
  },
  {
    method: 'GET',
    regex: /^\/api\/audit$/,
    paramNames: [],
    handler: (_p, q, _b) => getAuditRoute({}, q, null),
  },
  {
    method: 'GET',
    regex: /^\/api\/queue\/retry\/([^/]+)$/,
    paramNames: ['jobId'],
    handler: (p, _q, _b) => postQueueRetryRoute(p, {}, null),
  },
  {
    method: 'GET',
    regex: /^\/api\/queue\/status$/,
    paramNames: [],
    handler: (_p, _q, _b) => getQueueStatusRoute({}, {}, null),
  },
  {
    method: 'GET',
    regex: /^\/api\/queue\/([^/]+)\/jobs$/,
    paramNames: ['name'],
    handler: (p, _q, _b) => getQueueJobsRoute(p, {}, null),
  },
];

/** 找到匹配的 route；找不到 → null。 */
function matchRoute(method: Method, pathname: string): {
  route: RouteRecord;
  params: Record<string, string>;
} | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, idx) => {
      params[name] = decodeURIComponent(m[idx + 1] ?? '');
    });
    return { route, params };
  }
  return null;
}

/** 解析 query string 为 key→value map（无嵌套）。 */
function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!search) return out;
  const cleaned = search.startsWith('?') ? search.slice(1) : search;
  if (!cleaned) return out;
  for (const pair of cleaned.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const val = eq === -1 ? '' : pair.slice(eq + 1);
    out[decodeURIComponent(key)] = decodeURIComponent(val);
  }
  return out;
}

/** 读取 request body（限 1 MB，避免恶意大包）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const LIMIT = 1024 * 1024; // 1 MB
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code: code as ApiErrorBody['error']['code'], message } };
  sendJson(res, status, body);
}

export interface ServerHandle {
  url: string;
  port: number;
  host: string;
  /** 同步关闭底层 server。e2e 收尾时调。 */
  close(): Promise<void>;
}

export interface StartServerOptions {
  /** 监听端口；0 = 由 OS 分配（e2e 用）。 */
  port?: number;
  /** 监听 host；默认 127.0.0.1（仅本机，避免 SSRF 表面）。 */
  host?: string;
  /** 启动时是否调 registerAllTasks()；默认 true（写回 / heartbeat 默认 queue）。 */
  registerTasks?: boolean;
}

let tasksRegistered = false;

/**
 * 启动一个 HTTP server，绑定到 (host, port)。
 * 返回的 ServerHandle.close() 异步关闭。
 *
 * **不**自动 seed —— seed 由调用方（CLI / e2e）显式触发，避免主路径副作用。
 */
export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? 4000;
  const host = opts.host ?? '127.0.0.1';
  if (opts.registerTasks !== false && !tasksRegistered) {
    try {
      registerAllTasks();
      tasksRegistered = true;
    } catch {
      /* register 重复调用安全，忽略 */
    }
  }

  const server = createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase() as Method;
    const url = req.url ?? '/';
    const qIdx = url.indexOf('?');
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const search = qIdx === -1 ? '' : url.slice(qIdx);

    // 健康检查
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', ts: new Date().toISOString() });
      return;
    }

    const matched = matchRoute(method, pathname);
    if (!matched) {
      sendError(res, 404, 'NOT_FOUND', `no route for ${method} ${pathname}`);
      return;
    }

    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const contentType = (req.headers['content-type'] ?? '').toString().toLowerCase();
      if (!contentType.includes('application/json')) {
        sendError(res, 415, 'VALIDATION_ERROR', 'content-type must be application/json');
        return;
      }
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, 400, 'VALIDATION_ERROR', (err as Error).message);
        return;
      }
    }

    try {
      const result = matched.route.handler(matched.params, parseQuery(search), body);
      sendJson(res, result.status, result.body);
    } catch (err) {
      // 兜底：route 抛错时统一返 500；详细信息落 stderr，避免泄漏到响应
      // eslint-disable-next-line no-console
      console.error('[main] route handler threw', err);
      sendError(res, 500, 'VALIDATION_ERROR', 'internal server error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const actualHost = addr.address;
  const actualPort = addr.port;
  const url = `http://${actualHost}:${actualPort}`;

  return {
    url,
    port: actualPort,
    host: actualHost,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // 强制关闭长连接（Node 20 server.close 需要所有连接关闭才会回调）
        server.closeAllConnections?.();
      }),
  };
}

/** 标记 tasksRegistered 为 false（仅测试 reset 用）。 */
export function __resetServerState(): void {
  tasksRegistered = false;
}

/** 直接被 node 启动的入口（Dockerfile CMD / `pnpm start`）。 */
async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '4000', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const handle = await startServer({ port, host });
  // eslint-disable-next-line no-console
  console.log(`[main] lab-field-ops listening at ${handle.url}`);
}

const isDirectRun = (() => {
  try {
    if (typeof process === 'undefined' || !process.argv[1]) return false;
    const argv1 = process.argv[1];
    return argv1.endsWith('main.ts') || argv1.endsWith('main.js');
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[main] failed to start', err);
    process.exit(1);
  });
}