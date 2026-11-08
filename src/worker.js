const SHORT_CODE_LENGTH = 6;
const MAX_RANDOM_ATTEMPTS = 5;
const LIST_LIMIT = 100;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

function buildShortUrl(request, code) {
  return `${new URL(request.url).origin}/${code}`;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getAdminPassword(env) {
  return env.ADMIN_PASSWORD || env.DELETE_PASSWORD || '';
}

async function tryInsert(env, code, url) {
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO links (code, url, created_at, hits) VALUES (?, ?, ?, 0)'
  ).bind(code, url, Date.now()).run();
  return result.meta.changes > 0;
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }
  const adminPassword = getAdminPassword(env);
  if (!adminPassword) {
    return json({ error: '服务端未配置管理密码' }, 500);
  }
  if (!safeEqual(body.password, adminPassword)) {
    return json({ error: '密码错误' }, 401);
  }
  return json({ ok: true });
}

async function handleShorten(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }

  const adminPassword = getAdminPassword(env);
  if (!adminPassword) {
    return json({ error: '服务端未配置管理密码' }, 500);
  }
  if (!safeEqual(body.password, adminPassword)) {
    return json({ error: '未登录或登录已失效' }, 401);
  }

  const { url, customCode } = body || {};
  if (!url || !isValidUrl(url)) {
    return json({ error: '请提供有效的 http/https URL' }, 400);
  }

  if (customCode) {
    const code = String(customCode).trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) {
      return json({ error: '自定义短码只能包含字母、数字、-、_，长度 1–32' }, 400);
    }
    const ok = await tryInsert(env, code, url);
    if (!ok) {
      return json({ error: '自定义短码已被占用' }, 409);
    }
    return json({ shortUrl: buildShortUrl(request, code), code, url }, 201);
  }

  for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
    const code = generateCode();
    const ok = await tryInsert(env, code, url);
    if (ok) {
      return json({ shortUrl: buildShortUrl(request, code), code, url }, 201);
    }
  }
  return json({ error: '短码生成失败，请重试' }, 500);
}

async function handleRedirect(code, env, ctx) {
  const row = await env.DB.prepare(
    'SELECT url FROM links WHERE code = ?'
  ).bind(code).first();

  if (!row) {
    return new Response('短链接不存在', { status: 404 });
  }

  ctx.waitUntil(
    env.DB.prepare('UPDATE links SET hits = hits + 1 WHERE code = ?')
      .bind(code)
      .run()
      .catch((err) => console.error('hits update failed', code, err))
  );

  return Response.redirect(row.url, 302);
}

async function handleListLinks(request, env) {
  const adminPassword = getAdminPassword(env);
  const provided = request.headers.get('X-Admin-Password') || '';
  const authorized = !!adminPassword && safeEqual(provided, adminPassword);

  const { results } = await env.DB.prepare(
    'SELECT code, url, created_at, hits FROM links ORDER BY created_at DESC LIMIT ?'
  ).bind(LIST_LIMIT).all();

  const origin = new URL(request.url).origin;
  return json({
    authorized,
    links: results.map((r) => {
      const item = {
        code: r.code,
        url: r.url,
        shortUrl: `${origin}/${r.code}`,
        createdAt: r.created_at
      };
      if (authorized) item.hits = r.hits;
      return item;
    })
  });
}

async function handleDelete(request, env, code) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }

  const adminPassword = getAdminPassword(env);
  if (!adminPassword) {
    return json({ error: '服务端未配置管理密码' }, 500);
  }
  if (!safeEqual(body.password, adminPassword)) {
    return json({ error: '未登录或登录已失效' }, 401);
  }

  const result = await env.DB.prepare(
    'DELETE FROM links WHERE code = ?'
  ).bind(code).run();

  if (result.meta.changes === 0) {
    return json({ error: '短链不存在' }, 404);
  }

  return json({ ok: true, code });
}

// 诊断接口：只暴露「有没有配置密码」「D1 是否可用」和绑定名，不返回任何值
async function handleHealth(request, env) {
  let db = 'ok';
  try {
    await env.DB.prepare('SELECT 1').first();
  } catch (err) {
    db = 'error';
    console.error('health: D1 query failed', err);
  }
  return json({
    ok: true,
    passwordConfigured: !!getAdminPassword(env),
    db,
    envKeys: Object.keys(env).sort()
  });
}

const HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>短链生成器</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; }
    h1 { font-size: 1.6rem; }
    input, button { width: 100%; padding: 12px; font-size: 1rem; box-sizing: border-box; margin-top: 10px; }
    button { background: #111; color: #fff; border: none; cursor: pointer; }
    #result { margin-top: 20px; padding: 14px; background: #f4f4f4; border-radius: 8px; display: none; }
    #result a { word-break: break-all; }
    #error { color: #c00; margin-top: 12px; }
    .hint { font-size: 0.85rem; color: #666; margin-top: 6px; }

    .menu-btn {
      position: fixed; top: 16px; left: 16px;
      width: 40px; height: 40px; padding: 0;
      border: none; border-radius: 8px; background: #fff;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; z-index: 100;
      box-shadow: 0 1px 4px rgba(0,0,0,0.12);
      margin: 0;
    }
    .menu-btn:hover { background: #f4f4f4; }
    .menu-btn svg { width: 20px; height: 20px; fill: #333; }

    .auth-btn {
      position: fixed; top: 16px; right: 16px;
      width: auto; margin: 0; padding: 8px 16px;
      font-size: 0.9rem; border-radius: 8px;
      background: #111; color: #fff; border: none;
      cursor: pointer; z-index: 100;
      box-shadow: 0 1px 4px rgba(0,0,0,0.12);
    }
    .auth-btn.logged-in { background: #fff; color: #333; }
    .auth-btn:hover { opacity: 0.85; }

    .menu-panel {
      position: fixed; top: 64px; left: 16px;
      width: min(420px, calc(100vw - 32px));
      max-height: 70vh;
      background: #fff; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.18);
      display: none; flex-direction: column;
      overflow: hidden; z-index: 99;
    }
    .menu-panel.open { display: flex; }
    .menu-header {
      padding: 14px 16px; font-weight: 600; font-size: 0.95rem;
      border-bottom: 1px solid #eee; flex-shrink: 0;
    }
    .link-list { overflow-y: auto; }
    .link-item {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 12px 16px; border-bottom: 1px solid #f0f0f0;
    }
    .link-item:last-child { border-bottom: none; }
    .link-main { flex: 1; min-width: 0; }
    .link-short { color: #111; font-weight: 600; font-size: 0.95rem; text-decoration: none; }
    .link-short:hover { text-decoration: underline; }
    .link-url {
      font-size: 0.82rem; color: #666; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .link-meta { font-size: 0.75rem; color: #999; margin-top: 4px; }

    .link-delete {
      flex-shrink: 0; width: 30px; height: 30px;
      margin: 0; padding: 6px;
      background: none; color: #999;
      border-radius: 6px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .link-delete:hover { background: #fee; color: #c00; }
    .link-delete svg { width: 16px; height: 16px; }

    .loading, .empty { padding: 24px 16px; text-align: center; color: #888; font-size: 0.9rem; }

    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.4);
      display: none; align-items: center; justify-content: center;
      z-index: 200;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: #fff; border-radius: 12px;
      padding: 20px;
      width: min(360px, calc(100vw - 40px));
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .modal-title { font-size: 1.05rem; font-weight: 600; }
    .modal-desc { font-size: 0.88rem; color: #555; margin-top: 8px; line-height: 1.5; }
    .modal-desc strong { color: #111; }
    .modal input { margin-top: 14px; }
    .modal-error { color: #c00; font-size: 0.85rem; margin-top: 8px; min-height: 1.2em; }
    .modal-actions { display: flex; gap: 10px; margin-top: 16px; }
    .modal-actions button {
      flex: 1; width: auto; margin-top: 0;
      padding: 10px; border-radius: 8px; font-size: 0.95rem;
    }
    .modal-cancel { background: #eee; color: #333; }
    .modal-confirm { background: #c00; color: #fff; }
    .modal-primary { background: #111; color: #fff; }
    .modal-actions button:disabled { opacity: 0.6; cursor: not-allowed; }
  </style>
</head>
<body>
  <button id="menuBtn" class="menu-btn" aria-label="查看所有短链">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="2"></circle>
      <circle cx="12" cy="12" r="2"></circle>
      <circle cx="19" cy="12" r="2"></circle>
    </svg>
  </button>

  <button id="authBtn" class="auth-btn">登录</button>

  <div id="menuPanel" class="menu-panel">
    <div class="menu-header">全部短链</div>
    <div id="linkList" class="link-list"></div>
  </div>

  <h1>短链生成器</h1>
  <input id="url" type="url" placeholder="粘贴长链接 https://..." />
  <input id="custom" type="text" placeholder="自定义短码（可选，留空自动生成）" />
  <button onclick="shorten()">生成短链</button>
  <div id="error"></div>
  <div id="result"></div>

  <div id="loginModal" class="modal-overlay">
    <div class="modal">
      <div class="modal-title">管理员登录</div>
      <div class="modal-desc">登录后可以创建、删除短链并查看点击次数。</div>
      <input id="loginPassword" type="password" placeholder="输入密码" autocomplete="off" />
      <div id="loginError" class="modal-error"></div>
      <div class="modal-actions">
        <button class="modal-cancel" id="loginCancelBtn">取消</button>
        <button class="modal-primary" id="loginConfirmBtn">登录</button>
      </div>
    </div>
  </div>

  <div id="deleteModal" class="modal-overlay">
    <div class="modal">
      <div class="modal-title">删除短链</div>
      <div class="modal-desc">确定要删除 <strong id="deleteCodeLabel"></strong> 吗？删除后该短链将立即失效，此操作不可撤销。</div>
      <div id="deleteError" class="modal-error"></div>
      <div class="modal-actions">
        <button class="modal-cancel" id="deleteCancelBtn">取消</button>
        <button class="modal-confirm" id="deleteConfirmBtn">删除</button>
      </div>
    </div>
  </div>

  <script>
    var PASSWORD_KEY = 'shortlink_admin_password';

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function getSavedPassword() {
      try { return sessionStorage.getItem(PASSWORD_KEY) || ''; } catch (e) { return ''; }
    }
    function savePassword(p) {
      try { if (p) sessionStorage.setItem(PASSWORD_KEY, p); } catch (e) {}
    }
    function clearPassword() {
      try { sessionStorage.removeItem(PASSWORD_KEY); } catch (e) {}
    }

    var adminPassword = getSavedPassword();

    var menuBtn = document.getElementById('menuBtn');
    var menuPanel = document.getElementById('menuPanel');
    var linkList = document.getElementById('linkList');
    var panelOpen = false;

    var authBtn = document.getElementById('authBtn');
    var loginModal = document.getElementById('loginModal');
    var loginPassword = document.getElementById('loginPassword');
    var loginError = document.getElementById('loginError');
    var loginConfirmBtn = document.getElementById('loginConfirmBtn');
    var loginCancelBtn = document.getElementById('loginCancelBtn');

    var deleteModal = document.getElementById('deleteModal');
    var deleteCodeLabel = document.getElementById('deleteCodeLabel');
    var deleteError = document.getElementById('deleteError');
    var deleteConfirmBtn = document.getElementById('deleteConfirmBtn');
    var deleteCancelBtn = document.getElementById('deleteCancelBtn');
    var pendingDeleteCode = null;

    function updateAuthUI() {
      if (adminPassword) {
        authBtn.textContent = '退出';
        authBtn.classList.add('logged-in');
      } else {
        authBtn.textContent = '登录';
        authBtn.classList.remove('logged-in');
      }
      if (panelOpen) openPanel();
    }

    authBtn.addEventListener('click', function () {
      if (adminPassword) {
        adminPassword = '';
        clearPassword();
        updateAuthUI();
      } else {
        openLoginModal();
      }
    });

    function openLoginModal() {
      loginPassword.value = '';
      loginError.textContent = '';
      loginConfirmBtn.disabled = false;
      loginModal.classList.add('open');
      loginPassword.focus();
    }
    function closeLoginModal() {
      loginModal.classList.remove('open');
    }
    loginCancelBtn.addEventListener('click', closeLoginModal);
    loginModal.addEventListener('click', function (e) {
      if (e.target === loginModal) closeLoginModal();
    });
    loginPassword.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
    loginConfirmBtn.addEventListener('click', doLogin);

    function doLogin() {
      var pwd = loginPassword.value;
      if (!pwd) { loginError.textContent = '请输入密码'; return; }
      loginConfirmBtn.disabled = true;
      loginError.textContent = '';
      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      })
        .then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || '登录失败');
            return data;
          });
        })
        .then(function () {
          adminPassword = pwd;
          savePassword(pwd);
          closeLoginModal();
          updateAuthUI();
        })
        .catch(function (err) {
          loginError.textContent = err.message;
          loginConfirmBtn.disabled = false;
        });
    }

    function logout() {
      adminPassword = '';
      clearPassword();
      updateAuthUI();
    }

    menuBtn.addEventListener('click', function () {
      if (panelOpen) closePanel(); else openPanel();
    });

    document.addEventListener('click', function (e) {
      if (panelOpen && !menuPanel.contains(e.target) && !menuBtn.contains(e.target)) {
        closePanel();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (loginModal.classList.contains('open')) closeLoginModal();
        else if (deleteModal.classList.contains('open')) closeDeleteModal();
        else closePanel();
      }
    });

    function openPanel() {
      panelOpen = true;
      menuPanel.classList.add('open');
      linkList.innerHTML = '<div class="loading">加载中…</div>';

      var headers = {};
      if (adminPassword) headers['X-Admin-Password'] = adminPassword;

      fetch('/api/links', { headers: headers })
        .then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || '加载失败');
            return data;
          });
        })
        .then(function (data) {
          if (adminPassword && !data.authorized) {
            adminPassword = '';
            clearPassword();
            updateAuthUI();
            return;
          }
          renderLinks(data.links);
        })
        .catch(function (err) {
          linkList.innerHTML = '<div class="empty">' + escapeHtml(err.message) + '</div>';
        });
    }

    function closePanel() {
      panelOpen = false;
      menuPanel.classList.remove('open');
    }

    function renderLinks(links) {
      if (!links.length) {
        linkList.innerHTML = '<div class="empty">还没有短链</div>';
        return;
      }
      linkList.innerHTML = links.map(function (l) {
        var meta = (typeof l.hits === 'number')
          ? (l.hits + ' 次点击 · ' + new Date(l.createdAt).toLocaleString('zh-CN'))
          : ('创建于 ' + new Date(l.createdAt).toLocaleString('zh-CN'));

        var deleteBtn = '';
        if (adminPassword) {
          deleteBtn = '<button class="link-delete" data-code="' + escapeHtml(l.code) + '" aria-label="删除">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<polyline points="3 6 5 6 21 6"></polyline>' +
              '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
              '<path d="M10 11v6M14 11v6"></path>' +
              '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>' +
            '</svg>' +
          '</button>';
        }
        return '<div class="link-item">' +
          '<div class="link-main">' +
            '<a class="link-short" href="' + escapeHtml(l.shortUrl) + '" target="_blank" rel="noopener">' + escapeHtml(l.code) + '</a>' +
            '<div class="link-url" title="' + escapeHtml(l.url) + '">' + escapeHtml(l.url) + '</div>' +
            '<div class="link-meta">' + meta + '</div>' +
          '</div>' +
          deleteBtn +
        '</div>';
      }).join('');

      linkList.querySelectorAll('.link-delete').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openDeleteModal(btn.getAttribute('data-code'));
        });
      });
    }

    function openDeleteModal(code) {
      pendingDeleteCode = code;
      deleteCodeLabel.textContent = code;
      deleteError.textContent = '';
      deleteConfirmBtn.disabled = false;
      deleteModal.classList.add('open');
    }
    function closeDeleteModal() {
      pendingDeleteCode = null;
      deleteModal.classList.remove('open');
    }
    deleteCancelBtn.addEventListener('click', closeDeleteModal);
    deleteModal.addEventListener('click', function (e) {
      if (e.target === deleteModal) closeDeleteModal();
    });
    deleteConfirmBtn.addEventListener('click', doDelete);

    function doDelete() {
      if (!pendingDeleteCode) return;
      if (!adminPassword) { logout(); closeDeleteModal(); return; }
      deleteConfirmBtn.disabled = true;
      deleteError.textContent = '';
      fetch('/api/links/' + encodeURIComponent(pendingDeleteCode), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword })
      })
        .then(function (res) {
          return res.json().then(function (data) {
            if (res.status === 401) throw new Error('LOGIN_EXPIRED');
            if (!res.ok) throw new Error(data.error || '删除失败');
            return data;
          });
        })
        .then(function () {
          closeDeleteModal();
          openPanel();
        })
        .catch(function (err) {
          if (err.message === 'LOGIN_EXPIRED') {
            closeDeleteModal();
            logout();
            return;
          }
          deleteError.textContent = err.message;
          deleteConfirmBtn.disabled = false;
        });
    }

    async function shorten() {
      const url = document.getElementById('url').value.trim();
      const customCode = document.getElementById('custom').value.trim();
      const errorEl = document.getElementById('error');
      const resultEl = document.getElementById('result');
      errorEl.textContent = '';
      resultEl.style.display = 'none';

      if (!url) { errorEl.textContent = '请输入长链接'; return; }
      if (!adminPassword) { errorEl.textContent = '请先登录'; return; }

      const res = await fetch('/api/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, customCode: customCode || undefined, password: adminPassword })
      });

      if (res.status === 401) {
        logout();
        errorEl.textContent = '登录已失效，请重新登录';
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || '生成失败';
        return;
      }

      resultEl.style.display = 'block';
      resultEl.innerHTML = \`
        <div>短链接：<a href="\${data.shortUrl}" target="_blank" rel="noopener">\${data.shortUrl}</a></div>
        <div class="hint">原始链接：\${data.url}</div>
      \`;
    }

    updateAuthUI();
  </script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/api/login') {
      return handleLogin(request, env);
    }

    if (request.method === 'POST' && path === '/api/shorten') {
      return handleShorten(request, env);
    }

    if (request.method === 'GET' && path === '/api/links') {
      return handleListLinks(request, env);
    }

    if (request.method === 'GET' && path === '/api/health') {
      return handleHealth(request, env);
    }

    if (request.method === 'DELETE' && path.startsWith('/api/links/')) {
      const code = decodeURIComponent(path.slice('/api/links/'.length));
      if (code && !code.includes('/')) {
        return handleDelete(request, env, code);
      }
      return json({ error: '无效的短码' }, 400);
    }

    if (request.method === 'GET' && path === '/') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (request.method === 'GET') {
      const code = path.slice(1);
      if (code && !code.includes('/')) {
        return handleRedirect(code, env, ctx);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
