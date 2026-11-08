import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker.js';

// ---------------------------------------------------------------------------
// 最小 D1 模拟：只实现 worker.js 用到的 5 条 SQL
// ---------------------------------------------------------------------------
class MockDB {
  constructor() {
    /** @type {Map<string, {code: string, url: string, created_at: number, hits: number}>} */
    this.rows = new Map();
  }

  prepare(sql) {
    const db = this;
    return {
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async run() {
        if (sql.includes('INSERT OR IGNORE INTO links')) {
          const [code, url, createdAt] = this.args;
          if (db.rows.has(code)) return { meta: { changes: 0 } };
          db.rows.set(code, { code, url, created_at: createdAt, hits: 0 });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE links SET hits = hits + 1')) {
          const [code] = this.args;
          const row = db.rows.get(code);
          if (!row) return { meta: { changes: 0 } };
          row.hits += 1;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('DELETE FROM links')) {
          const [code] = this.args;
          return { meta: { changes: db.rows.delete(code) ? 1 : 0 } };
        }
        throw new Error('Unexpected SQL (run): ' + sql);
      },
      async first() {
        if (sql.startsWith('SELECT url FROM links')) {
          const row = db.rows.get(this.args[0]);
          return row ? { url: row.url } : null;
        }
        throw new Error('Unexpected SQL (first): ' + sql);
      },
      async all() {
        if (sql.startsWith('SELECT code, url, created_at, hits FROM links')) {
          const limit = this.args[0];
          const results = [...db.rows.values()]
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, limit);
          return { results };
        }
        throw new Error('Unexpected SQL (all): ' + sql);
      }
    };
  }
}

const PASSWORD = 'test-password';

function makeEnv() {
  return {
    DB: new MockDB(),
    ADMIN_PASSWORD: PASSWORD
  };
}

/** 调用 worker.fetch，并收集 waitUntil 里的 promise */
async function call(env, request) {
  const promises = [];
  const ctx = { waitUntil: (p) => promises.push(p) };
  const res = await worker.fetch(request, env, ctx);
  await Promise.all(promises);
  return res;
}

const req = (path, init) => new Request('https://short.example' + path, init);

async function createLink(env, url, customCode) {
  return call(
    env,
    req('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, customCode, password: PASSWORD })
    })
  );
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------
test('GET / 返回页面', async () => {
  const env = makeEnv();
  const res = await call(env, req('/'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /短链生成器/);
});

test('登录：密码错误 401，密码正确 ok', async () => {
  const env = makeEnv();

  const bad = await call(
    env,
    req('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    })
  );
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, '密码错误');

  const ok = await call(
    env,
    req('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD })
    })
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
});

test('创建短链：未授权 401，非法 URL 400，自定义短码重复 409', async () => {
  const env = makeEnv();

  const unauthorized = await call(
    env,
    req('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    })
  );
  assert.equal(unauthorized.status, 401);

  const invalid = await createLink(env, 'not-a-url');
  assert.equal(invalid.status, 400);

  const created = await createLink(env, 'https://example.com/a', 'abc');
  assert.equal(created.status, 201);
  assert.equal((await created.json()).shortUrl, 'https://short.example/abc');

  const dup = await createLink(env, 'https://example.com/b', 'abc');
  assert.equal(dup.status, 409);
});

test('创建短链：随机短码格式合法且唯一', async () => {
  const env = makeEnv();
  const codes = new Set();
  for (let i = 0; i < 20; i++) {
    const res = await createLink(env, 'https://example.com/' + i);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.match(data.code, /^[A-Za-z0-9]{6}$/);
    codes.add(data.code);
  }
  assert.equal(codes.size, 20);
});

test('列表：未登录不含 hits，携带正确密码才含 hits', async () => {
  const env = makeEnv();
  await createLink(env, 'https://example.com/a', 'aaa');
  await createLink(env, 'https://example.com/b', 'bbb');

  const anon = await call(env, req('/api/links'));
  assert.equal(anon.status, 200);
  const anonData = await anon.json();
  assert.equal(anonData.authorized, false);
  assert.equal(anonData.links.length, 2);
  for (const link of anonData.links) {
    assert.equal('hits' in link, false);
    assert.ok(link.code && link.url && link.shortUrl && link.createdAt);
  }

  const authorized = await call(
    env,
    req('/api/links', { headers: { 'X-Admin-Password': PASSWORD } })
  );
  const authData = await authorized.json();
  assert.equal(authData.authorized, true);
  for (const link of authData.links) {
    assert.equal(link.hits, 0);
  }

  const wrongPwd = await call(
    env,
    req('/api/links', { headers: { 'X-Admin-Password': 'nope' } })
  );
  assert.equal((await wrongPwd.json()).authorized, false);
});

test('跳转：302 到原地址并累加点击数', async () => {
  const env = makeEnv();
  await createLink(env, 'https://example.com/target', 'go');

  const res = await call(env, req('/go'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/target');

  const list = await call(
    env,
    req('/api/links', { headers: { 'X-Admin-Password': PASSWORD } })
  );
  assert.equal((await list.json()).links[0].hits, 1);
});

test('不存在的短码 404，非法路径 404', async () => {
  const env = makeEnv();
  assert.equal((await call(env, req('/missing'))).status, 404);
  assert.equal((await call(env, req('/a/b'))).status, 404);
});

test('删除：未授权 401，正确密码删除成功，重复删除 404', async () => {
  const env = makeEnv();
  await createLink(env, 'https://example.com/x', 'del');

  const unauthorized = await call(
    env,
    req('/api/links/del', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    })
  );
  assert.equal(unauthorized.status, 401);

  const ok = await call(
    env,
    req('/api/links/del', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD })
    })
  );
  assert.equal(ok.status, 200);

  const again = await call(
    env,
    req('/api/links/del', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD })
    })
  );
  assert.equal(again.status, 404);
});

test('未配置 ADMIN_PASSWORD 时登录/创建/删除返回 500', async () => {
  const env = makeEnv();
  delete env.ADMIN_PASSWORD;

  const login = await call(
    env,
    req('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'x' })
    })
  );
  assert.equal(login.status, 500);

  const shorten = await call(
    env,
    req('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    })
  );
  assert.equal(shorten.status, 500);

  const del = await call(
    env,
    req('/api/links/x', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'x' })
    })
  );
  assert.equal(del.status, 500);
});
