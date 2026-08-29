// tests/__setup__/supertest.d.ts
//
// supertest 7 没有官方 @types；这里声明最小子集满足 e2e 测试用法。
// 用法参考 tests/e2e.test.ts（http().get/.post/.delete/.send）。
//
// 实现方式：`export default` 形态（与 supertest@7 实际 CJS 行为一致），
// 同时 export 命名类型 SuperTest / Test 供 import { SuperTest, Test } 使用。

declare module 'supertest' {
  type Callback = (err: Error | null, res: Response) => void;

  interface Response {
    status: number;
    body: any;
    headers: Record<string, string>;
    text: string;
    type: string;
    ok: boolean;
  }

  interface Test {
    set(name: string, value: string): this;
    set(field: Record<string, string>): this;
    send(body: unknown): this;
    type(type: string): this;
    accept(type: string): this;
    query(query: Record<string, unknown>): this;
    expect(status: number, callback?: Callback): this;
    expect(callback: (res: Response) => void): this;
    end(callback: Callback): this;
    then(onfulfilled?: (res: Response) => unknown, onrejected?: (err: Error) => unknown): Promise<Response>;
  }

  type SuperTest<T extends Test> = {
    (urlOrApp: string | (() => unknown)): T;
    get(url: string): T;
    post(url: string): T;
    put(url: string): T;
    delete(url: string): T;
    patch(url: string): T;
    head(url: string): T;
  };

  function supertestFn(app: unknown): SuperTest<Test>;
  function supertestFn(url: string): SuperTest<Test>;

  export = supertestFn;
}