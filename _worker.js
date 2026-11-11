// build: 2026-10-17 ghostfix redeploy nudge
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. 公开路由：访问文件与下载文件 (任何人可访问)
    const isWidgetRoute = path.startsWith('/widgets/');
    const isDownloadRoute = path.startsWith('/download/');
    
    if (method === 'GET' && (isWidgetRoute || isDownloadRoute)) {
      const filename = decodeURIComponent(path.replace(isWidgetRoute ? '/widgets/' : '/download/', ''));
      const fileContent = await env.FILE_KV.get(filename, { type: 'arrayBuffer' });

      if (fileContent === null) {
        return new Response('File not found', { status: 404 });
      }

      const headers = new Headers();
      if (isDownloadRoute) {
        headers.set('Content-Disposition', `attachment; filename="${filename}"`);
        headers.set('Content-Type', 'application/octet-stream');
      } else {
        headers.set('Content-Type', getContentType(filename));
        headers.set('Cache-Control', 'public, max-age=3600');
      }

      return new Response(fileContent, { headers });
    }


    // PWA 资源（公开）：manifest 与应用图标
    if (method === "GET") {
      if (path === "/manifest.webmanifest") {
        return new Response(JSON.stringify(APP_MANIFEST), {
          headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=86400" }
        });
      }
      if (path === "/icon-180.png" || path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png") return iconResponse(ICON_180_B64);
      if (path === "/icon-192.png") return iconResponse(ICON_192_B64);
      if (path === "/icon-512.png") return iconResponse(ICON_512_B64);
      if (path === "/favicon.ico" || path === "/favicon.png") return iconResponse(ICON_192_B64);
    }

    // =========================================================
    // 自定义 Cookie 鉴权逻辑
    // =========================================================
    
    // 解析 Cookie
    const cookieString = request.headers.get('Cookie') || '';
    const cookies = Object.fromEntries(cookieString.split(';').map(c => c.trim().split('=')));
    const isAuthenticated = cookies['auth_secret'] === env.ADMIN_SECRET;

    // API: 处理登录请求
    if (method === 'POST' && path === '/api/login') {
      const body = await request.json();
      if (body.secret === env.ADMIN_SECRET) {
        return Response.json({ success: true }, {
          headers: {
            // 设置 Cookie，有效期 30 天
            'Set-Cookie': `auth_secret=${env.ADMIN_SECRET}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`
          }
        });
      }
      return Response.json({ error: '密钥错误' }, { status: 401 });
    }

    // API: 处理退出登录
    if (method === 'POST' && path === '/api/logout') {
      return Response.json({ success: true }, {
        headers: {
          'Set-Cookie': `auth_secret=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`
        }
      });
    }

    // =========================================================
    // 路由拦截：未登录状态返回登录页面
    // =========================================================
    
    if (!isAuthenticated) {
      // 拦截页面访问
      if (path === '/' || path === '/admin') {
        return new Response(getLoginHTML(), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
      // 拦截 API 访问
      if (path.startsWith('/api/')) {
        return Response.json({ error: '未授权，请先登录' }, { status: 401 });
      }
    }

    // ---------------- 已登录状态下的管理端逻辑 ----------------

    // 返回管理面板页面
    if (method === 'GET' && (path === '/' || path === '/admin')) {
      return new Response(getAdminHTML(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // API: 获取文件列表
    if (method === 'GET' && path === '/api/files') {
      const { results } = await env.FILE_DB.prepare("SELECT * FROM files ORDER BY upload_time DESC").all();
      return Response.json(results);
    }

    // API: 上传文件（可带 folder 字段，传到指定文件夹）
    if (method === 'POST' && path === '/api/upload') {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) return new Response('No file uploaded', { status: 400 });

      const folderRaw = (formData.get('folder') || '').toString().trim();
      let folder = '';
      if (folderRaw) {
        folder = normalizeFolderPath(folderRaw);
        if (folder === null) return new Response('文件夹路径无效', { status: 400 });
      }
      const base = file.name.split('/').pop().split('\\').pop();
      if (!base || base === '.keep') return new Response('文件名无效', { status: 400 });
      const filename = folder ? folder + '/' + base : base;
      const content = await file.arrayBuffer();
      const size = content.byteLength;

      await env.FILE_KV.put(filename, content);
      await env.FILE_DB.prepare(
        "INSERT OR REPLACE INTO files (filename, size) VALUES (?, ?)"
      ).bind(filename, size).run();

      return Response.json({ success: true, filename });
    }

    // API: 删除文件
    if (method === 'DELETE' && path.startsWith('/api/delete/')) {
      const filename = decodeURIComponent(path.replace('/api/delete/', ''));
      await env.FILE_KV.delete(filename);
      await env.FILE_DB.prepare("DELETE FROM files WHERE filename = ?").bind(filename).run();

      return Response.json({ success: true });
    }

    // API: 新建文件夹（用 path/.keep 占位标记表示空文件夹存在）
    if (method === 'POST' && path === '/api/folder') {
      const body = await request.json();
      const folderPath = normalizeFolderPath(body.path || '');
      if (!folderPath) return Response.json({ error: '文件夹名无效' }, { status: 400 });
      const all = await listAllFiles(env.FILE_DB);
      const conflict = all.some(function (f) { return f.filename === folderPath || isUnder(f.filename, folderPath); });
      if (conflict) return Response.json({ error: '同名文件夹已存在' }, { status: 409 });
      const marker = folderPath + '/.keep';
      await env.FILE_KV.put(marker, new ArrayBuffer(0));
      await env.FILE_DB.prepare(
        "INSERT OR REPLACE INTO files (filename, size) VALUES (?, ?)"
      ).bind(marker, 0).run();
      return Response.json({ success: true });
    }

    // API: 删除文件夹及其中全部文件
    if (method === 'DELETE' && path.startsWith('/api/folder/')) {
      const folderPath = normalizeFolderPath(decodeURIComponent(path.replace('/api/folder/', '')));
      if (!folderPath) return Response.json({ error: '文件夹路径无效' }, { status: 400 });
      const all = await listAllFiles(env.FILE_DB);
      const targets = all.filter(function (f) { return isUnder(f.filename, folderPath); });
      for (const f of targets) {
        await env.FILE_KV.delete(f.filename);
        await env.FILE_DB.prepare("DELETE FROM files WHERE filename = ?").bind(f.filename).run();
      }
      return Response.json({ success: true, deleted: targets.length });
    }

    // API: 文件夹改名（批量搬移其中全部文件）
    if (method === 'POST' && path === '/api/rename-folder') {
      const body = await request.json();
      const oldPath = normalizeFolderPath(body.oldPath || '');
      const newPath = normalizeFolderPath(body.newPath || '');
      if (!oldPath || !newPath || oldPath === newPath) return Response.json({ error: '文件夹路径无效' }, { status: 400 });
      if (newPath.startsWith(oldPath + '/')) return Response.json({ error: '不能移到自身内部' }, { status: 400 });
      const all = await listAllFiles(env.FILE_DB);
      const targets = all.filter(function (f) { return isUnder(f.filename, oldPath); });
      if (!targets.length) return Response.json({ error: '文件夹不存在' }, { status: 404 });
      const conflict = all.some(function (f) { return f.filename === newPath || isUnder(f.filename, newPath); });
      if (conflict) return Response.json({ error: '目标位置已有同名文件夹' }, { status: 409 });
      for (const f of targets) {
        const newName = newPath + f.filename.slice(oldPath.length);
        const content = await env.FILE_KV.get(f.filename, { type: 'arrayBuffer' });
        if (content !== null) await env.FILE_KV.put(newName, content);
        await env.FILE_DB.prepare(
          "INSERT OR REPLACE INTO files (filename, size, upload_time) VALUES (?, ?, ?)"
        ).bind(newName, f.size, f.upload_time).run();
        await env.FILE_KV.delete(f.filename);
        await env.FILE_DB.prepare("DELETE FROM files WHERE filename = ?").bind(f.filename).run();
      }
      return Response.json({ success: true, moved: targets.length });
    }

    // API: 移动单个文件
    if (method === 'POST' && path === '/api/move') {
      const body = await request.json();
      const from = (body.from || '').toString();
      const to = (body.to || '').toString();
      if (!from || !to || from === to) return Response.json({ error: '路径无效' }, { status: 400 });
      if (from.split('/').some(function (s) { return s === '..' || s === '.'; }) || to.split('/').some(function (s) { return s === '..' || s === '.'; })) {
        return Response.json({ error: '路径无效' }, { status: 400 });
      }
      const content = await env.FILE_KV.get(from, { type: 'arrayBuffer' });
      if (content === null) return Response.json({ error: '源文件不存在' }, { status: 404 });
      const exists = await env.FILE_DB.prepare("SELECT filename FROM files WHERE filename = ?").bind(to).first();
      if (exists) return Response.json({ error: '目标位置已有同名文件' }, { status: 409 });
      const row = await env.FILE_DB.prepare("SELECT size, upload_time FROM files WHERE filename = ?").bind(from).first();
      await env.FILE_KV.put(to, content);
      await env.FILE_DB.prepare(
        "INSERT OR REPLACE INTO files (filename, size, upload_time) VALUES (?, ?, ?)"
      ).bind(to, row ? row.size : content.byteLength, row ? row.upload_time : null).run();
      await env.FILE_KV.delete(from);
      await env.FILE_DB.prepare("DELETE FROM files WHERE filename = ?").bind(from).run();
      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// 文件夹路径归一化：去首尾斜杠与空白段；含 . .. .keep 段或非字符串返回 null；根目录返回 ''
function normalizeFolderPath(p) {
  if (typeof p !== 'string') return null;
  const parts = p.split('/').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  for (const seg of parts) {
    if (seg === '.' || seg === '..' || seg === '.keep') return null;
  }
  return parts.join('/');
}

async function listAllFiles(db) {
  const { results } = await db.prepare("SELECT filename, size, upload_time FROM files").all();
  return results || [];
}

// filename 是否在 prefix 文件夹内（含 prefix 本身）
function isUnder(filename, prefix) {
  return filename === prefix || filename.indexOf(prefix + '/') === 0;
}

// 辅助函数：根据文件名推断 Content-Type
function getContentType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'js': 'application/javascript; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'txt': 'text/plain; charset=utf-8',
    'rex': 'text/plain; charset=utf-8',
    'fwd': 'text/plain; charset=utf-8',
    'html': 'text/html; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'xml': 'application/xml; charset=utf-8',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'mp4': 'video/mp4',
    'mp3': 'audio/mpeg',
    'pdf': 'application/pdf',
    'zip': 'application/zip'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}


// ------------------------------------------------------------------
// PWA 支持：添加到主屏幕后以独立应用窗口打开（图标已内嵌，无需外部文件）
// ------------------------------------------------------------------
const ICON_180_B64 = "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";
const ICON_192_B64 = "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";
const ICON_512_B64 = "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";

const APP_MANIFEST = {
  name: "文件管理",
  short_name: "文件管理",
  description: "小型文件储存面板",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#eef3f9",
  icons: [
    { src: "/icon-192.png?v=892bc065f8", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png?v=892bc065f8", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png?v=892bc065f8", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
};

function iconResponse(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" }
  });
}

// ------------------------------------------------------------------
// 前端页面：自定义登录页
// ------------------------------------------------------------------
function getLoginHTML() {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="文件管理">
    <meta name="theme-color" content="#eef3f9">
    <link rel="apple-touch-icon" href="/icon-180.png?v=892bc065f8">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=892bc065f8">
    <link rel="manifest" href="/manifest.webmanifest?v=892bc065f8">
    <title>登录 - 文件管理</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f3f4f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
      .login-card { background: white; padding: 2.5rem 2rem; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); width: 100%; max-width: 320px; text-align: center; }
      h2 { margin-top: 0; color: #111827; margin-bottom: 1.5rem; }
      input { width: 100%; padding: 0.875rem; margin-bottom: 1rem; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box; font-size: 1rem; outline: none; transition: border-color 0.2s; -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
      input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
      button { width: 100%; padding: 0.875rem; background-color: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; transition: background-color 0.2s; font-weight: 500; }
      button:hover { background-color: #2563eb; }
      .error { color: #ef4444; margin-bottom: 1rem; display: none; font-size: 0.875rem; }
    </style>
  </head>
  <body>
    <div class="login-card">
      <h2>🗂️ 验证身份</h2>
      <div id="errorMsg" class="error">密钥不正确，请重试</div>
      <input type="password" id="secretInput" placeholder="请输入登录密钥" onkeypress="if(event.key === 'Enter') login()">
      <button onclick="login()">进入控制台</button>
    </div>
    <script>
      async function login() {
        const secret = document.getElementById('secretInput').value;
        if(!secret) return;
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ secret })
        });
        if (res.ok) {
          window.location.reload(); // 登录成功后刷新页面，自动进入管理台
        } else {
          document.getElementById('errorMsg').style.display = 'block';
        }
      }
    </script>
  </body>
  </html>
  `;
}

// ------------------------------------------------------------------
// 前端页面：管理面板
// ------------------------------------------------------------------
function getAdminHTML() {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="文件管理">
    <meta name="theme-color" content="#eef3f9">
    <link rel="apple-touch-icon" href="/icon-180.png?v=892bc065f8">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=892bc065f8">
    <link rel="manifest" href="/manifest.webmanifest?v=892bc065f8">
    <title>文件管理控制台</title>
    <style>
      html { overscroll-behavior: none; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #eef3f9; margin: 0; padding: 0; color: #1f2937; height: 100vh; height: 100dvh; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
      input, textarea, select { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
      .app { max-width: 560px; margin: 0 auto; width: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 16px 0; box-sizing: border-box; }

      /* 搜索条 */
      .search-wrap { flex-shrink: 0; display: flex; align-items: center; background: #e6ebf2; border-radius: 999px; padding: 0 16px; }
      .search-wrap svg { width: 18px; height: 18px; flex-shrink: 0; color: #6b7280; }
      .search-wrap input { flex: 1; min-width: 0; box-sizing: border-box; border: none; outline: none; background: transparent; padding: 13px 8px; font-size: 15px; color: #111827; text-align: center; }
      .search-wrap input::placeholder { color: #6b7280; }

      /* 品牌与用量 */
      .brand-row { display: flex; justify-content: space-between; align-items: flex-end; margin: 20px 4px 0; flex-shrink: 0; }
      .brand { font-size: 27px; font-weight: 800; color: #111827; letter-spacing: -0.5px; display: flex; align-items: center; gap: 8px; }
      .brand svg { width: 26px; height: 26px; color: #ff5a3c; flex-shrink: 0; }
      .usage { font-size: 13px; color: #6b7280; margin-top: 4px; }
      .usage b { color: #ef4444; font-weight: 700; }

      /* 筛选 chips */
      .chips { display: flex; gap: 10px; margin: 16px 0 4px; flex-shrink: 0; }
      .chip { border: 1px solid #e5e7eb; background: #ffffff; color: #374151; border-radius: 999px; padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
      .chip svg { width: 16px; height: 16px; }
      .chip.active { background: #ff5a3c; border-color: transparent; color: #ffffff; }

      /* 面包屑 */
      .crumb-bar { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; flex-shrink: 0; min-height: 30px; }
      .back-btn { width: 24px; height: 24px; border-radius: 50%; border: 1px solid #e5e7eb; background: #ffffff; color: #374151; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 20px; line-height: 1; box-sizing: border-box; padding: 0; }
      .crumbs { display: flex; align-items: center; gap: 6px; font-size: 14px; color: #6b7280; overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
      .crumbs::-webkit-scrollbar { display: none; }
      .crumbs a { color: #3b82f6; text-decoration: none; font-weight: 600; cursor: pointer; flex-shrink: 0; }
      .crumbs .crumb-sep { color: #9ca3af; flex-shrink: 0; }
      .crumbs .crumb-now { color: #111827; font-weight: 700; overflow: hidden; text-overflow: ellipsis; }

      /* 滚动内容区 */
      .scroll-area { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: none; padding-bottom: 104px; }
      .sec-title { display: flex; justify-content: space-between; align-items: baseline; font-size: 17px; font-weight: 700; color: #111827; margin: 20px 2px 12px; }
      .sec-title .sec-more { font-size: 13px; font-weight: 500; color: #9ca3af; cursor: pointer; }

      /* 最近文件大卡 */
      .recent-card { background: linear-gradient(135deg, #7db9f2, #4a90e2); border-radius: 22px; padding: 22px; color: #ffffff; position: relative; overflow: hidden; cursor: pointer; }
      .recent-card .rc-icon { opacity: 0.85; color: #ffffff; }
      .recent-card .rc-icon svg { width: 34px; height: 34px; }
      .recent-card .rc-name { font-size: 24px; font-weight: 800; margin-top: 34px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .recent-card .rc-meta { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 14px; }
      .recent-card .rc-sub { font-size: 12px; opacity: 0.85; line-height: 1.5; }
      .recent-card .rc-open { background: #ffffff; color: #111827; border: none; border-radius: 999px; padding: 10px 22px; font-size: 14px; font-weight: 700; cursor: pointer; flex-shrink: 0; }

      /* 文件夹卡片 */
      .folder-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .folder-card { border-radius: 18px; padding: 18px 16px; display: flex; align-items: center; gap: 10px; cursor: pointer; min-height: 62px; box-sizing: border-box; position: relative; }
      .folder-card .fc-icon { flex-shrink: 0; color: #ffffff; display: flex; }
      .folder-card .fc-icon svg { width: 26px; height: 26px; }
      .folder-card .fc-name { font-weight: 700; color: #111827; font-size: 15px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; min-width: 0; }
      .folder-card .fc-count { font-size: 12px; color: #6b7280; flex-shrink: 0; }
      .folder-card .fc-more { background: none; border: none; color: #6b7280; font-size: 18px; cursor: pointer; padding: 4px; flex-shrink: 0; }
      .folder-card .fc-more.active { background: #dbeafe; color: #1d4ed8; border-radius: 8px; }
      .folder-card.fc-c0 .fc-more.active { background: #b3d1a8; color: #2d5a27; }
      .folder-card.fc-c1 .fc-more.active { background: #f0d68a; color: #854d0e; }
      .folder-card.fc-c2 .fc-more.active { background: #a8c8f0; color: #1d4ed8; }
      .folder-card.fc-c3 .fc-more.active { background: #f2b3cc; color: #9d174d; }
      .folder-card.fc-c4 .fc-more.active { background: #c6b6ef; color: #5b21b6; }
      .fc-c0 { background: #dcead9; }
      .fc-c1 { background: #fdeec2; }
      .fc-c2 { background: #d6e9fb; }
      .fc-c3 { background: #fbdce8; }
      .fc-c4 { background: #e3ddf7; }
      .folder-actions { display: none; grid-column: 1 / -1; gap: 10px; }
      .folder-actions.open { display: flex; }
      .folder-actions button { flex: 1; border: 1px solid #e5e7eb; background: #ffffff; border-radius: 12px; padding: 10px; font-size: 14px; font-weight: 600; color: #374151; cursor: pointer; }

      /* 文件行 */
      .file-row { border-radius: 18px; padding: 12px 14px; display: flex; align-items: center; gap: 12px; margin-bottom: 10px; cursor: pointer; }
      .file-icon { width: 46px; height: 46px; border-radius: 13px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: #ffffff; }
      .file-icon svg { width: 22px; height: 22px; }
      .file-meta { flex: 1; min-width: 0; }
      .file-name { font-weight: 600; color: #111827; font-size: 15px; overflow: hidden; white-space: nowrap; }
      .fname-text { display: inline-block; will-change: transform; }
      .fname-text.scrolling { animation: fnameScroll 7s ease-in-out infinite alternate; }
      .file-sub { font-size: 12px; color: #6b7280; margin-top: 3px; }
      .file-more { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; padding: 6px 2px; flex-shrink: 0; }
      .file-more.active { background: #dbeafe; color: #1d4ed8; border-radius: 8px; }
      .file-actions { display: none; margin: -2px 0 10px; padding: 12px 14px; background: #ffffff; border-radius: 18px; gap: 12px; justify-content: center; }
      .file-actions.open { display: flex; }
      .act-btn { width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .act-btn svg { width: 20px; height: 20px; }
      .act-link { background: #dbeafe; color: #2563eb; }
      .act-dl { background: #dcfce7; color: #16a34a; }
      .act-move { background: #f3f4f6; color: #4b5563; }
      .act-del { background: #fee2e2; color: #dc2626; }

      /* 编辑多选 */
      .edit-btn { background: #ffffff; border: 1px solid #e5e7eb; color: #374151; border-radius: 999px; padding: 7px 16px; font-size: 14px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
      .edit-btn.on { background: #3b82f6; border-color: transparent; color: #ffffff; }
      .sel-box { width: 22px; height: 22px; border-radius: 50%; border: 2px solid #d1d5db; background: #ffffff; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: #ffffff; }
      .sel-box.on { background: #3b82f6; border-color: #3b82f6; }
      .sel-box svg { width: 14px; height: 14px; }
      .batch-actions { display: flex; align-items: center; justify-content: space-between; background: #ffffff; border-radius: 18px; padding: 12px 14px; margin-bottom: 10px; }
      .batch-count { font-size: 14px; font-weight: 600; color: #374151; }
      .batch-btns { display: flex; gap: 12px; }
      .batch-btns .act-btn:disabled { opacity: 0.35; }
      @keyframes fnameScroll {
        0%, 25% { transform: translateX(0); }
        90%, 100% { transform: translateX(calc(-1 * var(--dx, 0px))); }
      }

      /* 类型配色（行背景 / 图标底） */
      .t-img { background: #e3f2e1; } .t-img .file-icon { background: #8fce8f; }
      .t-vid { background: #ece5f8; } .t-vid .file-icon { background: #b39ddb; }
      .t-aud { background: #fde8ef; } .t-aud .file-icon { background: #f2a7c3; }
      .t-doc { background: #dbeafe; } .t-doc .file-icon { background: #7db8f7; }
      .t-pdf { background: #fee2e2; } .t-pdf .file-icon { background: #f87171; }
      .t-code { background: #e5e7eb; } .t-code .file-icon { background: #9ca3af; }
      .t-zip { background: #fef3c7; } .t-zip .file-icon { background: #f6c453; }
      .t-other { background: #f3f4f6; } .t-other .file-icon { background: #d1d5db; }

      .empty-state { text-align: center; padding: 40px 16px; color: #6b7280; font-size: 14px; }

      /* 底部导航 */
      .bottom-nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; background: rgba(255,255,255,0.94); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-top: 1px solid #e5e7eb; display: grid; grid-template-columns: repeat(5, 1fr); align-items: center; padding: 8px 10px calc(10px + env(safe-area-inset-bottom)); box-sizing: border-box; }
      .nav-item { background: none; border: none; display: flex; flex-direction: column; align-items: center; gap: 3px; color: #6b7280; cursor: pointer; padding: 4px 10px; justify-self: center; }
      .nav-item svg { width: 22px; height: 22px; }
      .nav-item span { font-size: 11px; font-weight: 600; }
      .nav-plus { width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid #111827; background: transparent; color: #111827; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; justify-self: center; }
      .nav-plus svg { width: 18px; height: 18px; }

      /* 底部动作菜单 */
      .sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 60; display: none; }
      .sheet-backdrop.open { display: block; }
      .action-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 61; background: #ffffff; border-radius: 24px 24px 0 0; padding: 16px 16px calc(20px + env(safe-area-inset-bottom)); transform: translateY(105%); transition: transform 0.25s ease-out; box-sizing: border-box; max-width: 560px; margin: 0 auto; }
      .action-sheet.open { transform: translateY(0); }
      .sheet-btn { display: flex; align-items: center; gap: 10px; width: 100%; border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 14px; padding: 15px; font-size: 16px; font-weight: 600; color: #111827; cursor: pointer; margin-bottom: 10px; text-align: left; }
      .sheet-btn svg { width: 20px; height: 20px; color: #374151; flex-shrink: 0; }
      .sheet-cancel { display: block; width: 100%; border: none; background: none; border-radius: 14px; padding: 13px; font-size: 15px; font-weight: 600; color: #6b7280; cursor: pointer; }

      /* 存储弹窗 */
      .storage-modal { position: fixed; inset: 0; z-index: 62; background: rgba(0,0,0,0.4); display: none; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
      .storage-modal.open { display: flex; }
      .storage-card { background: #ffffff; border-radius: 20px; padding: 22px; width: 100%; max-width: 420px; box-sizing: border-box; }
      .storage-title { font-size: 18px; font-weight: 800; color: #111827; margin-bottom: 6px; }
      .storage-total { font-size: 13px; color: #6b7280; margin-bottom: 16px; }
      .storage-row { margin-bottom: 14px; }
      .storage-row .sr-top { display: flex; justify-content: space-between; font-size: 14px; color: #374151; margin-bottom: 6px; }
      .storage-row .sr-top b { color: #111827; }
      .storage-bar { height: 8px; border-radius: 999px; background: #eef2f7; overflow: hidden; }
      .storage-bar i { display: block; height: 100%; border-radius: 999px; }

      /* 移动弹窗 */
      .move-modal { position: fixed; inset: 0; z-index: 62; background: rgba(0,0,0,0.4); display: none; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
      .move-modal.open { display: flex; }
      .move-card { background: #ffffff; border-radius: 20px; padding: 22px; width: 100%; max-width: 420px; box-sizing: border-box; }
      .move-title { font-size: 18px; font-weight: 800; color: #111827; }
      .move-file { font-size: 13px; color: #6b7280; margin: 8px 0 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .move-select { width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 12px; padding: 12px; font-size: 15px; color: #111827; background: #f9fafb; margin-bottom: 16px; }
      .move-btns { display: flex; gap: 10px; }
      .move-btns button { flex: 1; border-radius: 12px; padding: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }
      .move-cancel { border: 1px solid #e5e7eb; background: #ffffff; color: #374151; }
      .move-ok { border: none; background: #3b82f6; color: #ffffff; }

      .toast { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 70; background: rgba(17,24,39,0.92); color: #ffffff; font-size: 14px; padding: 10px 18px; border-radius: 999px; white-space: nowrap; display: none; pointer-events: none; }

      /* 预览（原样保留） */
      .preview-overlay { position: fixed; inset: 0; background: #eef3f9; z-index: 1000; display: none; flex-direction: column; padding-top: env(safe-area-inset-top); box-sizing: border-box; }
      .preview-overlay.open { display: flex; }
      .preview-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
      .preview-title { font-weight: 600; color: #111827; overflow: hidden; white-space: nowrap; }
      .ptitle-text { display: inline-block; will-change: transform; }
      .ptitle-text.scrolling { animation: fnameScroll 7s ease-in-out infinite alternate; }
      .preview-close { background-color: #dbeafe; color: #1d4ed8; border: none; padding: 8px 18px; border-radius: 8px; cursor: pointer; flex-shrink: 0; font-size: 0.875rem; }
      .preview-body { flex: 1; overflow: auto; -webkit-overflow-scrolling: touch; padding: 16px; }
      .preview-body pre { margin: 0; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, Menlo, Consolas, monospace; color: #1f2937; }
      .preview-body img { max-width: 100%; display: block; margin: 0 auto; }
      .preview-body.img-mode { padding: 16px; overflow: hidden; }
      .img-viewer { width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center; touch-action: none; background: #eef3f9; position: relative; }
      .img-loading { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(0, 0, 0, 0.55); color: #ffffff; font-size: 13px; padding: 6px 14px; border-radius: 999px; pointer-events: none; z-index: 2; white-space: nowrap; }
      .img-viewer img { max-width: 100%; max-height: 100%; display: block; user-select: none; -webkit-user-select: none; will-change: transform; -webkit-backface-visibility: hidden; }
      .preview-urlbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #e5e7eb; background-color: #f9fafb; }
      .preview-url { flex: 1; font-size: 12px; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
      .preview-act { background-color: #ffffff; border: 1px solid #d1d5db; color: #111827; padding: 6px 12px; border-radius: 8px; cursor: pointer; flex-shrink: 0; font-size: 0.8125rem; }
    </style>
  </head>
  <body>
    <div class="app">
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="searchInput" type="text" placeholder="Search" oninput="onSearch()">
      </div>
      <div class="brand-row">
        <div>
          <div class="brand">Widgets Disk</div>
          <div class="usage" id="usageLine"></div>
        </div>
      </div>
      <div class="chips" id="chips">
        <button class="chip active" data-filter="all" onclick="setFilter('all')">全部</button>
        <button class="chip" data-filter="folder" onclick="setFilter('folder')"><svg viewBox="0 0 24 24" fill="#7bc7f9"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>文件夹</button>
      </div>
      <div class="crumb-bar" id="crumbBar">
        <button class="back-btn" id="backBtn" onclick="goUp()" style="display:none">&#8249;</button>
        <div class="crumbs" id="crumbs"></div>
      </div>
      <div class="scroll-area" id="scrollArea">
        <div id="recentSection"></div>
        <div id="folderSection"></div>
        <div id="fileSection"></div>
        <div id="emptyState" class="empty-state" style="display:none"></div>
      </div>
    </div>

    <nav class="bottom-nav">
      <button class="nav-item" onclick="goToPath('')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg><span>首页</span></button>
      <button class="nav-item" onclick="openStorage()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg><span>存储</span></button>
      <button class="nav-plus" onclick="openSheet()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      <button class="nav-item" onclick="focusSearch()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>搜索</span></button>
      <button class="nav-item" onclick="logout()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>退出</span></button>
    </nav>

    <div class="sheet-backdrop" id="sheetBackdrop" onclick="closeSheet()"></div>
    <div class="action-sheet" id="actionSheet">
      <button class="sheet-btn" onclick="pickFiles()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>上传文件</button>
      <button class="sheet-btn" onclick="sheetCreateFolder()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>新建文件夹</button>
      <button class="sheet-cancel" onclick="closeSheet()">取消</button>
    </div>

    <div class="storage-modal" id="storageModal" onclick="if(event.target===this)closeStorage()">
      <div class="storage-card">
        <div class="storage-title">存储用量</div>
        <div class="storage-total" id="storageTotal"></div>
        <div id="storageBody"></div>
        <button class="sheet-cancel" onclick="closeStorage()">关闭</button>
      </div>
    </div>

    <div class="move-modal" id="moveModal" onclick="if(event.target===this)closeMove()">
      <div class="move-card">
        <div class="move-title">移动到哪个文件夹？</div>
        <div class="move-file" id="moveFileName"></div>
        <select id="moveSelect" class="move-select"></select>
        <div class="move-btns">
          <button class="move-cancel" onclick="closeMove()">取消</button>
          <button class="move-ok" onclick="confirmMove()">确定</button>
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
    <input type="file" id="fileInput" accept="*/*" multiple style="display:none" onchange="onFilesChosen()">

    <script>
      async function logout() {
        await fetch('/api/logout', { method: 'POST' });
        window.location.reload();
      }

      let currentPath = '';
      let allFilesCache = [];
      let currentFilter = 'all';
      let searchQuery = '';
      let viewFiles = [];
      let viewFolders = [];
      let folderActionTarget = null;
      let editMode = false;
      let selFiles = new Set();
      let suppressScrollClose = false;
      let revealRestoreTop = null;
      let revealTop = null;
      let restoreTimer = null;

      function revealActions(el) {
        const sa = document.getElementById('scrollArea');
        const r = el.getBoundingClientRect();
        const sar = sa.getBoundingClientRect();
        const navClear = 120;
        const visibleBottom = sar.bottom - navClear;
        let delta = 0;
        if (r.bottom > visibleBottom) delta = r.bottom - visibleBottom + 16;
        else if (r.top < sar.top) delta = -(sar.top - r.top + 16);
        if (delta !== 0) {
          revealRestoreTop = sa.scrollTop;
          suppressScrollClose = true;
          sa.scrollTo({ top: sa.scrollTop + delta, behavior: 'auto' });
          revealTop = sa.scrollTop;
          setTimeout(function () { suppressScrollClose = false; }, 600);
        }
      }

      function restoreScrollAfterClose() {
        if (revealRestoreTop === null) return;
        const sa = document.getElementById('scrollArea');
        const top = revealRestoreTop;
        const rt = revealTop;
        revealRestoreTop = null;
        revealTop = null;
        if (rt !== null && Math.abs(sa.scrollTop - rt) > 150) return;
        suppressScrollClose = true;
        sa.scrollTo({ top: top, behavior: 'auto' });
        setTimeout(function () { suppressScrollClose = false; }, 600);
      }

      function scheduleRestore() {
        if (revealRestoreTop === null) return;
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(function () { restoreScrollAfterClose(); }, 150);
      }

      function fmtSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
      }

      const ICONS = (function () {
        function svg(inner) {
          return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
        }
        return {
          search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
          folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
          folderPlus: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>'),
          file: svg('<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>'),
          image: svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
          video: svg('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>'),
          music: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
          code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
          package: svg('<path d="M16.5 9.4L7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
          link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
          download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
          upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
          move: svg('<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>'),
          trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
          home: svg('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
          chart: svg('<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>'),
          logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
          chevronLeft: svg('<polyline points="15 18 9 12 15 6"/>'),
          check: svg('<polyline points="20 6 9 17 4 12"/>')
        };
      })();

      function fileTypeInfo(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic'].indexOf(ext) !== -1) return { cls: 't-img', icon: ICONS.image };
        if (['mp4', 'mov', 'avi', 'mkv', 'webm'].indexOf(ext) !== -1) return { cls: 't-vid', icon: ICONS.video };
        if (['mp3', 'wav', 'flac', 'aac', 'ogg'].indexOf(ext) !== -1) return { cls: 't-aud', icon: ICONS.music };
        if (['pdf'].indexOf(ext) !== -1) return { cls: 't-pdf', icon: ICONS.file };
        if (['doc', 'docx', 'txt', 'md', 'xls', 'xlsx', 'ppt', 'pptx'].indexOf(ext) !== -1) return { cls: 't-doc', icon: ICONS.file };
        if (['js', 'json', 'html', 'css', 'xml', 'fwd', 'rex', 'csv', 'log'].indexOf(ext) !== -1) return { cls: 't-code', icon: ICONS.code };
        if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(ext) !== -1) return { cls: 't-zip', icon: ICONS.package };
        return { cls: 't-other', icon: ICONS.file };
      }

      function renderCrumbs() {
        const el = document.getElementById('crumbs');
        const backBtn = document.getElementById('backBtn');
        backBtn.style.display = currentPath ? '' : 'none';
        el.innerHTML = '';
        const segs = currentPath ? currentPath.split('/') : [];
        const root = document.createElement('a');
        root.textContent = '根目录';
        root.onclick = function () { goToPath(''); };
        el.appendChild(root);
        let acc = '';
        segs.forEach(function (s, i) {
          acc = acc ? acc + '/' + s : s;
          const sep = document.createElement('span');
          sep.className = 'crumb-sep';
          sep.textContent = '/';
          el.appendChild(sep);
          if (i === segs.length - 1) {
            const now = document.createElement('span');
            now.className = 'crumb-now';
            now.textContent = s;
            el.appendChild(now);
          } else {
            const a = document.createElement('a');
            a.textContent = s;
            (function (p) { a.onclick = function () { goToPath(p); }; })(acc);
            el.appendChild(a);
          }
        });
      }

      function goToPath(p) {
        currentPath = p || '';
        if (currentPath) {
          currentFilter = 'folder';
          document.querySelectorAll('#chips .chip').forEach(function (c) {
            c.classList.toggle('active', c.getAttribute('data-filter') === 'folder');
          });
        }
        loadFiles();
      }

      function goUp() {
        if (!currentPath) return;
        const i = currentPath.lastIndexOf('/');
        goToPath(i === -1 ? '' : currentPath.slice(0, i));
      }

      function enterFolder(enc) { goToPath(enc ? decodeURIComponent(enc) : ''); }

      function setFilter(f) {
        currentFilter = f;
        if (f === 'all' && currentPath) currentPath = '';
        document.querySelectorAll('#chips .chip').forEach(function (c) {
          c.classList.toggle('active', c.getAttribute('data-filter') === f);
        });
        renderAll();
      }

      function onSearch() {
        searchQuery = document.getElementById('searchInput').value.trim().toLowerCase();
        renderAll();
      }

      function focusSearch() {
        document.getElementById('searchInput').focus();
        document.getElementById('scrollArea').scrollTop = 0;
      }

      function showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.style.display = 'block';
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.style.display = 'none'; }, 2200);
      }

      async function loadFiles() {
        const res = await fetch('/api/files');
        if (res.status === 401) return window.location.reload();
        if (!res.ok) return alert('读取文件列表失败');
        allFilesCache = await res.json();
        renderAll();
      }

      function currentView() {
        const prefix = currentPath ? currentPath + '/' : '';
        const folderMap = {};
        const files = [];
        allFilesCache.forEach(function (f) {
          const name = f.filename;
          if (name.indexOf(prefix) !== 0) return;
          const rest = name.slice(prefix.length);
          if (!rest || rest === '.keep') return;
          if (rest.slice(-6) === '/.keep') { folderMap[rest.slice(0, -6).split('/')[0]] = true; return; }
          if (rest.indexOf('/') !== -1) { folderMap[rest.split('/')[0]] = true; return; }
          files.push({ name: rest, full: name, size: f.size, time: f.upload_time });
        });
        let folders = Object.keys(folderMap).sort().map(function (fname) {
          const full = prefix + fname;
          let count = 0;
          allFilesCache.forEach(function (f) {
            if (f.filename.indexOf(full + '/') === 0 && f.filename.slice(-6) !== '/.keep') count++;
          });
          return { name: fname, full: full, count: count };
        });
        let outFiles = files;
        if (!currentPath && currentFilter === 'all') {
          outFiles = allFilesCache.filter(function (f) { return f.filename.slice(-6) !== '/.keep'; })
            .map(function (f) { return { name: f.filename.slice(f.filename.lastIndexOf('/') + 1), full: f.filename, size: f.size, time: f.upload_time }; });
        }
        if (searchQuery) {
          folders = folders.filter(function (d) { return d.name.toLowerCase().indexOf(searchQuery) !== -1; });
          outFiles = outFiles.filter(function (f) { return f.full.toLowerCase().indexOf(searchQuery) !== -1; });
        }
        if (currentFilter === 'folder' && !currentPath) outFiles = [];
        return { folders: folders, files: outFiles };
      }

      function renderAll() {
        renderCrumbs();
        const realAll = allFilesCache.filter(function (f) { return f.filename.slice(-6) !== '/.keep'; });
        const totalSize = realAll.reduce(function (s, f) { return s + (f.size || 0); }, 0);
        document.getElementById('usageLine').innerHTML = '已用 <b>' + fmtSize(totalSize) + '</b> · ' + realAll.length + ' 个文件';
        const view = currentView();
        viewFolders = view.folders;
        viewFiles = view.files;
        folderActionTarget = null;

        const recentEl = document.getElementById('recentSection');
        if (!currentPath && !searchQuery && currentFilter !== 'folder' && realAll.length) {
          const sorted = realAll.slice().sort(function (a, b) { return String(b.upload_time).localeCompare(String(a.upload_time)); });
          const top = sorted[0];
          const info = fileTypeInfo(top.filename);
          recentEl.innerHTML = \`
            <div class="sec-title"><span>最近文件</span></div>
            <div class="recent-card" id="recentCard">
              <div class="rc-icon">\${info.icon}</div>
              <div class="rc-name">\${top.filename}</div>
              <div class="rc-meta">
                <div class="rc-sub">\${fmtSize(top.size)}<br>上传于 \${new Date(top.upload_time).toLocaleDateString()}</div>
                <button class="rc-open">Open</button>
              </div>
            </div>
          \`;
          const card = document.getElementById('recentCard');
          if (card) card.onclick = function () { previewFile(top.filename); };
        } else { recentEl.innerHTML = ''; }

        const folderEl = document.getElementById('folderSection');
        if (view.folders.length || currentFilter === 'folder') {
          let h = '<div class="sec-title"><span>文件夹</span><button class="edit-btn" onclick="createFolder()">＋ 新建文件夹</button></div>';
          if (view.folders.length) {
            h += '<div class="folder-grid">';
            view.folders.forEach(function (d, i) {
              h += \`
                <div class="folder-card fc-c\${i % 5}" data-fidx="\${i}">
                  <span class="fc-icon">\${ICONS.folder}</span>
                  <span class="fc-name">\${d.name}</span>
                  <span class="fc-count">\${d.count} 个</span>
                  <button class="fc-more" data-fmore="\${i}">⋮</button>
                </div>
              \`;
            });
            h += '<div class="folder-actions" id="folderActions"><button data-fact="rename">改名</button><button data-fact="delete">删除</button></div></div>';
          }
          folderEl.innerHTML = h;
        } else { folderEl.innerHTML = ''; }

        if (editMode && !view.files.length) { editMode = false; selFiles.clear(); }
        const fileEl = document.getElementById('fileSection');
        if (view.files.length) {
          let h = '<div class="sec-title"><span>' + (currentPath ? '文件' : '全部文件') + ' · ' + view.files.length + ' 个</span><button class="edit-btn' + (editMode ? ' on' : '') + '" onclick="toggleEdit()">' + (editMode ? '完成' : '编辑') + '</button></div>';
          if (editMode) {
            h += '<div class="batch-actions"><span class="batch-count">已选 ' + selFiles.size + ' 个</span><div class="batch-btns">' +
              '<button class="act-btn act-dl" data-bact="download" title="下载"' + (selFiles.size ? '' : ' disabled') + '>' + ICONS.download + '</button>' +
              '<button class="act-btn act-move" data-bact="move" title="移动"' + (selFiles.size ? '' : ' disabled') + '>' + ICONS.move + '</button>' +
              '<button class="act-btn act-del" data-bact="delete" title="删除"' + (selFiles.size ? '' : ' disabled') + '>' + ICONS.trash + '</button>' +
              '</div></div>';
          }
          view.files.forEach(function (f, i) {
            const info = fileTypeInfo(f.name);
            const isSel = selFiles.has(f.full);
            const selHtml = editMode ? '<span class="sel-box' + (isSel ? ' on' : '') + '">' + ICONS.check + '</span>' : '';
            const moreHtml = editMode ? '' : '<button class="file-more">⋮</button>';
            const actsHtml = editMode ? '' : '<div class="file-actions" data-act-for="' + i + '">' +
              '<button class="act-btn act-link" data-act="link" title="复制链接">' + ICONS.link + '</button>' +
              '<button class="act-btn act-dl" data-act="download" title="下载">' + ICONS.download + '</button>' +
              '<button class="act-btn act-move" data-act="move" title="移动">' + ICONS.move + '</button>' +
              '<button class="act-btn act-del" data-act="delete" title="删除">' + ICONS.trash + '</button>' +
              '</div>';
            h += \`
              <div class="file-row \${info.cls}" data-idx="\${i}">
                \${selHtml}
                <div class="file-icon">\${info.icon}</div>
                <div class="file-meta">
                  <div class="file-name"><span class="fname-text">\${f.name}</span></div>
                  <div class="file-sub">\${fmtSize(f.size)} · \${new Date(f.time).toLocaleDateString()}</div>
                </div>
                \${moreHtml}
              </div>
              \${actsHtml}
            \`;
          });
          fileEl.innerHTML = h;
        } else { fileEl.innerHTML = ''; }

        const emptyEl = document.getElementById('emptyState');
        if (!view.folders.length && !view.files.length) {
          emptyEl.style.display = '';
          emptyEl.textContent = searchQuery ? '没有找到相关文件' : (currentPath ? '此文件夹为空' : '暂无文件，点底部 ＋ 上传');
        } else { emptyEl.style.display = 'none'; }

        document.querySelectorAll('#fileSection .fname-text').forEach(function (span) {
          const box = span.closest('.file-name');
          if (!box) return;
          const dx = span.scrollWidth - box.clientWidth;
          if (dx > 4) {
            span.style.setProperty('--dx', dx + 'px');
            span.style.animationDuration = Math.max(4, Math.round(dx / 30)) + 's';
            span.classList.add('scrolling');
          }
        });
      }

      function toggleEdit() {
        editMode = !editMode;
        if (!editMode) selFiles.clear();
        renderAll();
      }

      function updateBatchBar() {
        const countEl = document.querySelector('.batch-count');
        if (countEl) countEl.textContent = '已选 ' + selFiles.size + ' 个';
        document.querySelectorAll('.batch-btns .act-btn').forEach(function (b) {
          b.disabled = selFiles.size === 0;
        });
      }

      function batchDownload() {
        if (!selFiles.size) return;
        const files = Array.from(selFiles);
        files.forEach(function (full, i) {
          setTimeout(function () {
            const a = document.createElement('a');
            a.href = '/download/' + encPath(full);
            a.download = full.split('/').pop();
            document.body.appendChild(a);
            a.click();
            a.remove();
          }, i * 400);
        });
        showToast('开始下载 ' + files.length + ' 个文件');
      }

      async function batchDelete() {
        if (!selFiles.size) return;
        const files = Array.from(selFiles);
        if (!confirm('确定删除选中的 ' + files.length + ' 个文件吗？此操作不可恢复。')) return;
        let ok = 0;
        for (let i = 0; i < files.length; i++) {
          try {
            const res = await fetch('/api/delete/' + encodeURIComponent(files[i]), { method: 'DELETE' });
            if (res.ok) ok++;
          } catch (e) {}
        }
        selFiles.clear();
        editMode = false;
        loadFiles();
        showToast('已删除 ' + ok + ' 个文件');
      }

      function batchMove() {
        if (!selFiles.size) return;
        openMove(Array.from(selFiles));
      }

      document.getElementById('fileSection').addEventListener('click', function (e) {
        const bactBtn = e.target.closest('[data-bact]');
        if (bactBtn) {
          if (bactBtn.disabled) return;
          const bact = bactBtn.getAttribute('data-bact');
          if (bact === 'download') batchDownload();
          else if (bact === 'move') batchMove();
          else if (bact === 'delete') batchDelete();
          return;
        }
        const actBtn = e.target.closest('.act-btn');
        if (actBtn) {
          const wrap = actBtn.closest('.file-actions');
          if (!wrap) return;
          const idx = parseInt(wrap.getAttribute('data-act-for'), 10);
          const f = viewFiles[idx];
          if (!f) return;
          const act = actBtn.getAttribute('data-act');
          if (act === 'link') copyLink(f.full);
          else if (act === 'download') downloadFile(f.full);
          else if (act === 'move') openMove(f.full);
          else if (act === 'delete') deleteFile(f.full);
          return;
        }
        const row = e.target.closest('.file-row');
        if (!row) return;
        const idx = parseInt(row.getAttribute('data-idx'), 10);
        const f = viewFiles[idx];
        if (!f) return;
        if (editMode) {
          const had = selFiles.has(f.full);
          if (had) selFiles.delete(f.full); else selFiles.add(f.full);
          const box = row.querySelector('.sel-box');
          if (box) box.classList.toggle('on', !had);
          updateBatchBar();
          return;
        }
        if (e.target.closest('.file-more')) {
          const btn = e.target.closest('.file-more');
          const acts = document.querySelector('.file-actions[data-act-for="' + idx + '"]');
          const wasOpen = acts && acts.classList.contains('open');
          document.querySelectorAll('.file-actions.open').forEach(function (a) { a.classList.remove('open'); });
          document.querySelectorAll('.file-more.active, .fc-more.active').forEach(function (b) { b.classList.remove('active'); });
          const fa0 = document.getElementById('folderActions');
          if (fa0) fa0.classList.remove('open');
          if (acts && !wasOpen) {
            acts.classList.add('open');
            if (btn) btn.classList.add('active');
            revealActions(acts);
          }
          return;
        }
        previewFile(f.full);
      });

      document.getElementById('scrollArea').addEventListener('scroll', function () {
        if (suppressScrollClose) return;
        let hadOpen = false;
        document.querySelectorAll('.file-actions.open').forEach(function (a) { a.classList.remove('open'); hadOpen = true; });
        const fa = document.getElementById('folderActions');
        if (fa && fa.classList.contains('open')) { fa.classList.remove('open'); hadOpen = true; }
        if (hadOpen) {
          document.querySelectorAll('.file-more.active, .fc-more.active').forEach(function (b) { b.classList.remove('active'); });
          scheduleRestore();
        }
      }, { passive: true });

      document.addEventListener('click', function (e) {
        if (e.target.closest('.file-actions, .folder-actions, .file-more, .fc-more, .batch-actions')) return;
        let hadOpen = false;
        document.querySelectorAll('.file-actions.open').forEach(function (a) { a.classList.remove('open'); hadOpen = true; });
        const fa = document.getElementById('folderActions');
        if (fa && fa.classList.contains('open')) { fa.classList.remove('open'); hadOpen = true; }
        if (hadOpen) {
          document.querySelectorAll('.file-more.active, .fc-more.active').forEach(function (b) { b.classList.remove('active'); });
          restoreScrollAfterClose();
        }
      });

      document.getElementById('folderSection').addEventListener('click', function (e) {
        const factBtn = e.target.closest('[data-fact]');
        if (factBtn) {
          const fact = factBtn.getAttribute('data-fact');
          if (!folderActionTarget) return;
          const enc = encodeURIComponent(folderActionTarget);
          if (fact === 'rename') renameFolder(enc);
          else if (fact === 'delete') deleteFolder(enc);
          return;
        }
        const more = e.target.closest('.fc-more');
        if (more) {
          const card = more.closest('.folder-card');
          const idx = parseInt(card.getAttribute('data-fidx'), 10);
          const d = viewFolders[idx];
          if (!d) return;
          const fa = document.getElementById('folderActions');
          if (folderActionTarget === d.full && fa && fa.classList.contains('open')) {
            fa.classList.remove('open');
            folderActionTarget = null;
            more.classList.remove('active');
          } else {
            document.querySelectorAll('.file-actions.open').forEach(function (a) { a.classList.remove('open'); });
            document.querySelectorAll('.file-more.active, .fc-more.active').forEach(function (b) { b.classList.remove('active'); });
            folderActionTarget = d.full;
            if (fa) {
              fa.classList.add('open');
              more.classList.add('active');
              revealActions(fa);
            }
          }
          return;
        }
        const card = e.target.closest('.folder-card');
        if (!card) return;
        const idx = parseInt(card.getAttribute('data-fidx'), 10);
        const d = viewFolders[idx];
        if (!d) return;
        enterFolder(encodeURIComponent(d.full));
      });

      function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

      function copyLink(full) {
        const url = location.origin + '/widgets/' + encPath(full);
        const done = function () { showToast('已复制链接'); };
        const fallback = function () {
          const ta = document.createElement('textarea');
          ta.value = url;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          ta.remove();
          done();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(function () { fallback(); });
        } else { fallback(); }
      }

      function openSheet() {
        document.getElementById('actionSheet').classList.add('open');
        document.getElementById('sheetBackdrop').classList.add('open');
      }
      function closeSheet() {
        document.getElementById('actionSheet').classList.remove('open');
        document.getElementById('sheetBackdrop').classList.remove('open');
      }
      function pickFiles() { closeSheet(); document.getElementById('fileInput').click(); }
      function sheetCreateFolder() { closeSheet(); createFolder(); }

      function openStorage() {
        const groups = [
          { label: '图片', cls: 't-img', color: '#8fce8f', size: 0 },
          { label: '视频', cls: 't-vid', color: '#b39ddb', size: 0 },
          { label: '音频', cls: 't-aud', color: '#f2a7c3', size: 0 },
          { label: '文档', cls: 't-doc', color: '#7db8f7', size: 0 },
          { label: '其他', cls: null, color: '#9ca3af', size: 0 }
        ];
        let total = 0;
        allFilesCache.forEach(function (f) {
          if (f.filename.slice(-6) === '/.keep') return;
          const sz = f.size || 0;
          total += sz;
          const info = fileTypeInfo(f.filename);
          const g = groups.find(function (x) { return x.cls === info.cls; }) || groups[4];
          g.size += sz;
        });
        const totalFiles = allFilesCache.filter(function (f) { return f.filename.slice(-6) !== '/.keep'; }).length;
        document.getElementById('storageTotal').textContent = totalFiles + ' 个文件 · 合计 ' + fmtSize(total);
        let h = '';
        groups.forEach(function (g) {
          const pct = total ? Math.round(g.size / total * 100) : 0;
          h += '<div class="storage-row"><div class="sr-top"><span>' + g.label + '</span><b>' + fmtSize(g.size) + ' · ' + pct + '%</b></div><div class="storage-bar"><i style="width:' + pct + '%;background:' + g.color + '"></i></div></div>';
        });
        document.getElementById('storageBody').innerHTML = h;
        document.getElementById('storageModal').classList.add('open');
      }
      function closeStorage() { document.getElementById('storageModal').classList.remove('open'); }

      function onFilesChosen() {
        const n = document.getElementById('fileInput').files.length;
        if (n) uploadFile();
      }

      async function uploadFile() {
        const fileInput = document.getElementById('fileInput');
        const files = Array.prototype.slice.call(fileInput.files);
        if (!files.length) return;
        let okCount = 0;
        const failed = [];
        for (let i = 0; i < files.length; i++) {
          showToast('上传中 ' + (i + 1) + '/' + files.length + '...');
          try {
            const formData = new FormData();
            formData.append('file', files[i]);
            if (currentPath) formData.append('folder', currentPath);
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            if (res.ok) okCount++; else failed.push(files[i].name);
          } catch (e) { failed.push(files[i].name); }
        }
        fileInput.value = '';
        loadFiles();
        if (failed.length) showToast('成功 ' + okCount + ' 个，失败 ' + failed.length + ' 个');
        else showToast('上传完成 ' + okCount + ' 个');
      }

      async function deleteFile(filename) {
        if (!confirm('确定彻底删除文件：' + filename + ' 吗？')) return;

        const res = await fetch('/api/delete/' + encodeURIComponent(filename), {
          method: 'DELETE'
        });

        if (res.ok) {
          loadFiles();
        } else {
          alert('删除失败');
        }
      }

      async function createFolder() {
        const name = prompt('新文件夹名称：');
        if (name === null) return;
        const clean = name.trim();
        if (!clean || clean.indexOf('/') !== -1 || clean === '.' || clean === '..' || clean === '.keep') { alert('文件夹名无效'); return; }
        const path = currentPath ? currentPath + '/' + clean : clean;
        const res = await fetch('/api/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path })
        });
        if (res.ok) { loadFiles(); }
        else {
          const d = await res.json().catch(function () { return {}; });
          alert(d.error || '新建文件夹失败');
        }
      }

      async function deleteFolder(enc) {
        const folderPath = decodeURIComponent(enc);
        let count = 0;
        allFilesCache.forEach(function (f) {
          if (f.filename.indexOf(folderPath + '/') === 0 && f.filename.slice(-6) !== '/.keep') count++;
        });
        if (!confirm('确定删除文件夹「' + folderPath + '」及其中 ' + count + ' 个文件吗？此操作不可恢复。')) return;
        const res = await fetch('/api/folder/' + enc, { method: 'DELETE' });
        if (res.ok) { loadFiles(); } else { alert('删除文件夹失败'); }
      }

      async function renameFolder(enc) {
        const oldPath = decodeURIComponent(enc);
        const base = oldPath.split('/').pop();
        const name = prompt('文件夹改名：', base);
        if (name === null) return;
        const clean = name.trim();
        if (!clean || clean.indexOf('/') !== -1 || clean === '.' || clean === '..' || clean === '.keep') { alert('文件夹名无效'); return; }
        const parent = oldPath.indexOf('/') !== -1 ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
        const newPath = parent ? parent + '/' + clean : clean;
        if (newPath === oldPath) return;
        const res = await fetch('/api/rename-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPath: oldPath, newPath: newPath })
        });
        if (res.ok) { loadFiles(); }
        else {
          const d = await res.json().catch(function () { return {}; });
          alert(d.error || '改名失败');
        }
      }

      let moveTargets = [];

      function getAllFolders() {
        const set = {};
        allFilesCache.forEach(function (f) {
          const parts = f.filename.split('/');
          for (let i = 1; i < parts.length; i++) {
            set[parts.slice(0, i).join('/')] = true;
          }
        });
        return Object.keys(set).sort();
      }

      function openMove(full) {
        moveTargets = Array.isArray(full) ? full.slice() : [full];
        const label = moveTargets.length === 1 ? moveTargets[0].split('/').pop() : moveTargets.length + ' 个文件';
        document.getElementById('moveFileName').textContent = label;
        const sel = document.getElementById('moveSelect');
        sel.innerHTML = '';
        const rootOpt = document.createElement('option');
        rootOpt.value = '';
        rootOpt.textContent = '根目录';
        sel.appendChild(rootOpt);
        getAllFolders().forEach(function (p) {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          sel.appendChild(opt);
        });
        const first = moveTargets[0] || '';
        sel.value = first.indexOf('/') !== -1 ? first.slice(0, first.lastIndexOf('/')) : '';
        document.getElementById('moveModal').classList.add('open');
      }

      function closeMove() {
        document.getElementById('moveModal').classList.remove('open');
        moveTargets = [];
      }

      async function confirmMove() {
        if (!moveTargets.length) return;
        const target = document.getElementById('moveSelect').value;
        const targets = moveTargets.slice();
        closeMove();
        let ok = 0;
        const failed = [];
        for (let i = 0; i < targets.length; i++) {
          const full = targets[i];
          const base = full.split('/').pop();
          const to = target ? target + '/' + base : base;
          if (to === full) { ok++; continue; }
          try {
            const res = await fetch('/api/move', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: full, to: to })
            });
            if (res.ok) ok++; else failed.push(base);
          } catch (e) { failed.push(base); }
        }
        selFiles.clear();
        editMode = false;
        loadFiles();
        if (failed.length) showToast('成功 ' + ok + ' 个，失败 ' + failed.length + ' 个');
        else if (targets.length > 1) showToast('已移动 ' + ok + ' 个文件');
      }

      const PREVIEW_TEXT_EXTS = ['js', 'json', 'txt', 'fwd', 'rex', 'css', 'html', 'xml', 'md', 'csv', 'log'];
      const PREVIEW_IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];
      let previewCurrentUrl = '';
      async function previewFile(filename) {
        const overlay = document.getElementById('previewOverlay');
        const body = document.getElementById('previewBody');
        const titleEl = document.getElementById('previewTitle');
        titleEl.innerHTML = '';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'ptitle-text';
        titleSpan.textContent = filename.slice(filename.lastIndexOf('/') + 1);
        titleEl.appendChild(titleSpan);
        body.innerHTML = '<div style="color:#6b7280">加载中...</div>';
        overlay.classList.add('open');
        const tdx = titleEl.scrollWidth - titleEl.clientWidth;
        if (tdx > 4) {
          titleSpan.style.setProperty('--dx', tdx + 'px');
          titleSpan.style.animationDuration = Math.max(4, Math.round(tdx / 30)) + 's';
          titleSpan.classList.add('scrolling');
        }
        document.body.style.overflow = 'hidden';
        body.classList.remove('img-mode');
        const ext = filename.split('.').pop().toLowerCase();
        const fileUrl = '/widgets/' + encPath(filename);
        previewCurrentUrl = location.origin + fileUrl;
        document.getElementById('previewUrl').textContent = previewCurrentUrl;
        if (PREVIEW_IMG_EXTS.indexOf(ext) !== -1) {
          body.classList.add('img-mode');
          body.innerHTML = '';
          const viewer = document.createElement('div');
          viewer.className = 'img-viewer';
          const img = document.createElement('img');
          img.src = fileUrl;
          img.alt = filename;
          img.draggable = false;
          viewer.appendChild(img);
          body.appendChild(viewer);
          setupImageZoom(viewer, img);
          return;
        }
        if (PREVIEW_TEXT_EXTS.indexOf(ext) !== -1) {
          try {
            const res = await fetch(fileUrl);
            const text = await res.text();
            const pre = document.createElement('pre');
            pre.textContent = text;
            body.innerHTML = '';
            body.appendChild(pre);
          } catch (e) {
            body.innerHTML = '<div style="color:#ef4444">预览加载失败</div>';
          }
          return;
        }
        body.innerHTML = '<div style="color:#6b7280">该类型暂不支持在线预览，请使用「下载」查看。</div>';
      }
      async function downloadFile(filename) {
        try {
          const res = await fetch('/download/' + encPath(filename));
          if (!res.ok) { alert('下载失败'); return; }
          const blob = await res.blob();
          const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            return;
          }
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = objUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(objUrl); }, 4000);
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          alert('下载失败');
        }
      }
      function copyPreviewUrl() {
        const btn = document.getElementById('previewCopyBtn');
        const done = function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制地址'; }, 1500); };
        const fallbackCopy = function () {
          const ta = document.createElement('textarea');
          ta.value = previewCurrentUrl;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          ta.remove();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(previewCurrentUrl).then(done).catch(function () { fallbackCopy(); done(); });
        } else { fallbackCopy(); done(); }
      }
      function closePreview() {
        document.getElementById('previewOverlay').classList.remove('open');
        document.getElementById('previewBody').classList.remove('img-mode');
        document.body.style.overflow = '';
      }
      function preventGestureZoom(e) { e.preventDefault(); }
      document.addEventListener('gesturestart', preventGestureZoom);
      function setupImageZoom(viewer, img) {
        let scale = 1, tx = 0, ty = 0;
        let baseRatio = 1, initialized = false, settling = false, animLayout = false;
        function effRatio() { return animLayout ? 1 : baseRatio; }
        let startDist = 0, startScale = 1, startTx = 0, startTy = 0, startMidX = 0, startMidY = 0;
        let gestureStart = null, lastTapTime = 0;
        const pointers = new Map();
        function initLayout() {
          if (initialized || img.naturalWidth <= 0) return;
          const vw = viewer.clientWidth, vh = viewer.clientHeight;
          if (vw <= 0 || vh <= 0) return;
          baseRatio = Math.min(vw / img.naturalWidth, vh / img.naturalHeight, 1);
          img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
          img.style.width = img.naturalWidth + 'px';
          img.style.height = img.naturalHeight + 'px';
          initialized = true;
          apply(false);
        }
        let ready = false;
        const badge = document.createElement('div');
        badge.className = 'img-loading';
        badge.textContent = '图片加载中…';
        viewer.appendChild(badge);
        function markReady() {
          if (ready) return;
          ready = true;
          badge.style.display = 'none';
          initLayout();
        }
        if (img.complete && img.naturalWidth > 0) markReady();
        else {
          img.addEventListener('load', markReady);
          img.addEventListener('error', markReady);
          setTimeout(markReady, 20000);
        }
        if (img.decode) { const p = img.decode(); if (p && p.catch) p.catch(function () {}); }
        function getMaxScale() {
          if (initialized) return Math.max(1, 1 / baseRatio);
          if (img.naturalWidth > 0 && img.clientWidth > 0) return Math.max(1, img.naturalWidth / img.clientWidth);
          return 4;
        }
        function apply(animate) {
          if (animate) settling = true;
          img.style.transition = animate ? 'transform 0.25s ease-out' : 'none';
          img.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + (scale * effRatio()) + ')';
        }
        img.addEventListener('transitionend', function (e) {
          if (e.propertyName === 'transform') {
            settling = false;
            img.style.transition = 'none';
            if (animLayout) {
              animLayout = false;
              img.style.width = img.naturalWidth + 'px';
              img.style.height = img.naturalHeight + 'px';
              apply(false);
            }
          }
        });
        function clampPan() {
          const bw = initialized ? img.naturalWidth * baseRatio : img.clientWidth;
          const bh = initialized ? img.naturalHeight * baseRatio : img.clientHeight;
          const mx = Math.max(0, (bw * scale - viewer.clientWidth) / 2) + 48;
          const my = Math.max(0, (bh * scale - viewer.clientHeight) / 2) + 48;
          if (tx > mx) tx = mx; if (tx < -mx) tx = -mx;
          if (ty > my) ty = my; if (ty < -my) ty = -my;
        }
        function settle() {
          const ms = getMaxScale();
          if (scale > ms) { scale = ms; clampPan(); apply(true); }
          else if (scale < 1) { scale = 1; tx = 0; ty = 0; apply(true); }
          else if (scale === 1 && (tx !== 0 || ty !== 0)) { tx = 0; ty = 0; apply(true); }
        }
        function toggleZoom() {
          if (scale > 1) {
            if (initialized && !animLayout) {
              img.style.width = (img.naturalWidth * baseRatio) + 'px';
              img.style.height = (img.naturalHeight * baseRatio) + 'px';
              animLayout = true;
              apply(false);
            }
            scale = 1; tx = 0; ty = 0;
          } else { scale = Math.min(2.5, getMaxScale()); }
          clampPan();
          apply(true);
        }
        viewer.addEventListener('pointerdown', function (e) {
          if (!ready) {
            if (img.complete && img.naturalWidth > 0) markReady();
            else return;
          }
          if (pointers.size === 0 && settling) {
            settling = false;
            const m = getComputedStyle(img).transform;
            if (m && m !== 'none') {
              const inner = m.substring(m.indexOf('(') + 1, m.lastIndexOf(')'));
              const v = inner.split(',').map(function (s) { return parseFloat(s); });
              let cs = 0, ex = 0, fy = 0;
              if (m.indexOf('matrix3d') === 0 && v.length === 16) { cs = v[0]; ex = v[12]; fy = v[13]; }
              else if (v.length === 6) { cs = v[0]; ex = v[4]; fy = v[5]; }
              if (cs > 0) {
                scale = cs / effRatio();
                tx = ex + (cs - 1) * (img.offsetWidth / 2);
                ty = fy + (cs - 1) * (img.offsetHeight / 2);
                clampPan();
              }
            }
            if (animLayout) {
              animLayout = false;
              img.style.width = img.naturalWidth + 'px';
              img.style.height = img.naturalHeight + 'px';
            }
            img.style.transition = 'none';
            apply(false);
          }
          try { viewer.setPointerCapture(e.pointerId); } catch (err) {}
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 1) { gestureStart = { t: Date.now(), x: e.clientX, y: e.clientY, multi: false, type: e.pointerType }; }
          if (pointers.size === 2) {
            if (gestureStart) gestureStart.multi = true;
            const pts = Array.from(pointers.values());
            startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            startScale = scale; startTx = tx; startTy = ty;
            startMidX = (pts[0].x + pts[1].x) / 2; startMidY = (pts[0].y + pts[1].y) / 2;
          }
        });
        viewer.addEventListener('pointermove', function (e) {
          if (!pointers.has(e.pointerId)) return;
          const prev = pointers.get(e.pointerId);
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 1 && scale > 1) {
            tx += e.clientX - prev.x; ty += e.clientY - prev.y;
            clampPan(); apply(false);
          } else if (pointers.size === 2 && startDist > 0) {
            const pts = Array.from(pointers.values());
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            scale = Math.min(getMaxScale() * 1.25, Math.max(0.8, startScale * dist / startDist));
            tx = startTx + ((pts[0].x + pts[1].x) / 2 - startMidX);
            ty = startTy + ((pts[0].y + pts[1].y) / 2 - startMidY);
            clampPan(); apply(false);
          }
        });
        function endPointer(e) {
          const wasTracked = pointers.has(e.pointerId);
          pointers.delete(e.pointerId);
          if (pointers.size < 2) startDist = 0;
          if (pointers.size === 0) {
            settle();
            if (wasTracked && gestureStart && !gestureStart.multi && gestureStart.type === 'touch' && e.type === 'pointerup') {
              const dt = Date.now() - gestureStart.t;
              const moved = Math.hypot(e.clientX - gestureStart.x, e.clientY - gestureStart.y);
              if (dt < 250 && moved < 10) {
                const now = Date.now();
                if (now - lastTapTime < 300) { toggleZoom(); lastTapTime = 0; } else { lastTapTime = now; }
              }
            }
            gestureStart = null;
          }
        }
        viewer.addEventListener('pointerup', endPointer);
        viewer.addEventListener('pointercancel', function (e) {
          pointers.delete(e.pointerId);
          if (pointers.size < 2) startDist = 0;
          if (pointers.size === 0) { gestureStart = null; settle(); }
        });
        viewer.addEventListener('dblclick', function () { if (ready) toggleZoom(); });
      }

      loadFiles();
    </script>
    <div id="previewOverlay" class="preview-overlay">
      <div class="preview-header">
        <div id="previewTitle" class="preview-title"></div>
        <button class="preview-close" onclick="closePreview()">关闭</button>
      </div>
      <div class="preview-urlbar">
        <div id="previewUrl" class="preview-url"></div>
        <button class="preview-act" id="previewCopyBtn" onclick="copyPreviewUrl()">复制地址</button>
      </div>
      <div id="previewBody" class="preview-body"></div>
    </div>
  </body>
  </html>
  `;
}
