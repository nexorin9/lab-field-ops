// src/app/routes.tsx
//
// 应用路由：Dashboard / 仪器详情 / 报警码详情 / 校准详情 + 受保护守卫 + 离线兜底。
//
// 设计原则：
//  1) lazy + retry：每个 page 单独 chunk；chunk 加载失败可重试一次
//  2) Authenticated 守卫：检查 localStorage.authToken；缺失则跳 /login
//  3) Offline fallback：navigator.onLine = false 时显示离线兜底页
//  4) data-testid / data-route 命名稳定，便于 e2e 断言
//
// 领养的调用链（参考 outline/app/routes/index.tsx 的 Switch/Route + lazyWithRetry）：
//   URL → Authenticated 守卫 → Suspense(lazy(Page)) → Page → SplitView 出口

import * as React from 'react';
import { Routes, Route, Navigate, useLocation, Link } from 'react-router-dom';
import { DashboardPage } from './components/DashboardPage/index.js';

/** 简易 lazyWithRetry：chunk 加载失败重试一次，再失败才抛错。 */
export function lazyWithRetry<T extends React.ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
  retries = 1,
): React.LazyExoticComponent<T> {
  return React.lazy(async () => {
    let lastError: unknown = null;
    for (let i = 0; i <= retries; i++) {
      try {
        return await factory();
      } catch (err) {
        lastError = err;
        if (i === retries) break;
        // 短暂 backoff 再重试（避免强循环占用 CPU）
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw lastError;
  });
}

/** 受保护路由：检查 localStorage.authToken；缺失则跳 /login（保留 redirect 参数）。 */
export function Authenticated(props: { children: React.ReactNode }): React.ReactElement {
  const location = useLocation();
  // 默认占位 token = 'demo'（spec.md 要求极简 Bearer Token；正式环境由 /login 注入）
  const token = (() => {
    try {
      return typeof window !== 'undefined' ? window.localStorage?.getItem('authToken') : null;
    } catch {
      return null;
    }
  })();
  if (!token) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{props.children}</>;
}

/** 离线兜底页：navigator.onLine=false 时显示。 */
export function OfflineFallback(): React.ReactElement {
  return (
    <div
      data-testid="routes-offline"
      data-status="offline"
      style={{ padding: 24, textAlign: 'center' }}
    >
      <h2>当前离线</h2>
      <p>请检查网络连接后重试。本地缓存的处理记录仍可查看。</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ padding: '6px 16px' }}
      >
        重试
      </button>
    </div>
  );
}

/** 简易 /login 占位页：写入 localStorage.authToken='demo' 后跳 redirect。 */
export function LoginPage(): React.ReactElement {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const redirect = params.get('redirect') ?? '/';
  const handleLogin = (): void => {
    try {
      window.localStorage.setItem('authToken', 'demo');
    } catch {
      /* ignore */
    }
    window.location.assign(redirect);
  };
  return (
    <div data-testid="routes-login" style={{ padding: 24 }}>
      <h2>登录</h2>
      <p>当前为占位登录：点击下方按钮后写入 demo token 进入看板。</p>
      <button
        type="button"
        onClick={handleLogin}
        data-testid="login-submit"
        style={{ padding: '6px 16px' }}
      >
        进入看板
      </button>
    </div>
  );
}

/** 404 兜底。 */
export function NotFound(): React.ReactElement {
  return (
    <div data-testid="routes-not-found" data-status="404" style={{ padding: 24 }}>
      <h2>404</h2>
      <p>
        页面不存在。<Link to="/">返回看板</Link>
      </p>
    </div>
  );
}

/** 仪器详情页占位（占位实现，等 Task 18 替换为真实 InstrumentPage）。 */
const InstrumentDetail = lazyWithRetry(async () => ({
  default: function InstrumentDetail(): React.ReactElement {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id') ?? '';
    return (
      <div data-testid="routes-instrument-detail" data-instrument-id={id} style={{ padding: 16 }}>
        <h2>仪器详情</h2>
        <p>
          ID：<code>{id}</code>
        </p>
        <p>
          <Link to="/">返回看板</Link>
        </p>
      </div>
    );
  },
}));

/** 报警码详情页占位。 */
const AlarmCodeDetail = lazyWithRetry(async () => ({
  default: function AlarmCodeDetail(): React.ReactElement {
    const params = new URLSearchParams(window.location.search);
    const key = params.get('key') ?? '';
    return (
      <div data-testid="routes-alarm-detail" data-alarm-key={key} style={{ padding: 16 }}>
        <h2>报警码 SOP</h2>
        <p>
          联合主键：<code>{key}</code>
        </p>
        <p>
          <Link to="/">返回看板</Link>
        </p>
      </div>
    );
  },
}));

/** 校准详情页占位。 */
const CalibrationDetail = lazyWithRetry(async () => ({
  default: function CalibrationDetail(): React.ReactElement {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id') ?? '';
    return (
      <div data-testid="routes-calibration-detail" data-calibration-id={id} style={{ padding: 16 }}>
        <h2>校准详情</h2>
        <p>
          ID：<code>{id}</code>
        </p>
        <p>
          <Link to="/">返回看板</Link>
        </p>
      </div>
    );
  },
}));

/** AuditDrawer 入口占位（drawer 由 Task 14 AuditDrawer 实现；此处仅提供路由）。 */
const AuditRoute = lazyWithRetry(async () => ({
  default: function AuditRoute(): React.ReactElement {
    return (
      <div data-testid="routes-audit" style={{ padding: 16 }}>
        <h2>审计抽屉</h2>
        <p>
          审计事件请从看板顶部「审计」按钮打开抽屉。
          <Link to="/">返回看板</Link>
        </p>
      </div>
    );
  },
}));

/** 顶层路由组件。 */
export function AppRoutes(): React.ReactElement {
  const [online, setOnline] = React.useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  React.useEffect(() => {
    const handleOnline = (): void => setOnline(true);
    const handleOffline = (): void => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!online) return <OfflineFallback />;

  return (
    <React.Suspense
      fallback={
        <div data-testid="routes-loading" style={{ padding: 24 }}>
          页面加载中…
        </div>
      }
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <Authenticated>
              <DashboardPage />
            </Authenticated>
          }
        />
        <Route
          path="/dashboard"
          element={
            <Authenticated>
              <DashboardPage />
            </Authenticated>
          }
        />
        <Route
          path="/instruments"
          element={
            <Authenticated>
              <InstrumentDetail />
            </Authenticated>
          }
        />
        <Route
          path="/alarm-codes"
          element={
            <Authenticated>
              <AlarmCodeDetail />
            </Authenticated>
          }
        />
        <Route
          path="/calibrations"
          element={
            <Authenticated>
              <CalibrationDetail />
            </Authenticated>
          }
        />
        <Route
          path="/audit"
          element={
            <Authenticated>
              <AuditRoute />
            </Authenticated>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </React.Suspense>
  );
}

export default AppRoutes;
