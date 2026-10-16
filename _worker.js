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

    // API: 上传文件
    if (method === 'POST' && path === '/api/upload') {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) return new Response('No file uploaded', { status: 400 });

      const filename = file.name;
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

    return new Response('Not Found', { status: 404 });
  }
};

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
  background_color: "#f3f4f6",
  theme_color: "#3b82f6",
  icons: [
    { src: "/icon-192.png?v=3cb4452362", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png?v=3cb4452362", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png?v=3cb4452362", sizes: "512x512", type: "image/png", purpose: "maskable" }
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
    <meta name="theme-color" content="#3b82f6">
    <link rel="apple-touch-icon" href="/icon-180.png?v=3cb4452362">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=3cb4452362">
    <link rel="manifest" href="/manifest.webmanifest?v=3cb4452362">
    <title>登录 - 文件管理</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f3f4f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .login-card { background: white; padding: 2.5rem 2rem; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); width: 100%; max-width: 320px; text-align: center; }
      h2 { margin-top: 0; color: #111827; margin-bottom: 1.5rem; }
      input { width: 100%; padding: 0.875rem; margin-bottom: 1rem; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box; font-size: 1rem; outline: none; transition: border-color 0.2s; }
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
    <meta name="theme-color" content="#3b82f6">
    <link rel="apple-touch-icon" href="/icon-180.png?v=3cb4452362">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=3cb4452362">
    <link rel="manifest" href="/manifest.webmanifest?v=3cb4452362">
    <title>文件管理控制台</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f9fafb; margin: 0; padding: 20px; color: #374151; }
      .container { max-width: 900px; margin: 0 auto; }
      
      /* 顶部导航区 */
      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
      .header h2 { margin: 0; color: #111827; display: flex; align-items: center; gap: 8px; }
      .logout-btn { background-color: white; color: #4b5563; border: 1px solid #d1d5db; padding: 8px 16px; border-radius: 8px; cursor: pointer; transition: all 0.2s; font-size: 0.875rem; }
      .logout-btn:hover { background-color: #f3f4f6; color: #111827; }
      .preview-overlay { position: fixed; inset: 0; background: #ffffff; z-index: 1000; display: none; flex-direction: column; padding-top: env(safe-area-inset-top); box-sizing: border-box; }
      .preview-overlay.open { display: flex; }
      .preview-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
      .preview-title { font-weight: 600; color: #111827; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .preview-close { background-color: #3b82f6; color: white; border: none; padding: 8px 18px; border-radius: 8px; cursor: pointer; flex-shrink: 0; font-size: 0.875rem; }
      .preview-body { flex: 1; overflow: auto; -webkit-overflow-scrolling: touch; padding: 16px; }
      .preview-body pre { margin: 0; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, Menlo, Consolas, monospace; color: #1f2937; }
      .preview-body img { max-width: 100%; display: block; margin: 0 auto; }
      .preview-body.img-mode { padding: 16px; overflow: hidden; }
      .img-viewer { width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center; touch-action: none; background: #ffffff; }
      .img-viewer img { max-width: 100%; max-height: 100%; display: block; user-select: none; -webkit-user-select: none; will-change: transform; -webkit-backface-visibility: hidden; }
      .preview-urlbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #e5e7eb; background-color: #f9fafb; }
      .preview-url { flex: 1; font-size: 12px; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
      .preview-act { background-color: #ffffff; border: 1px solid #d1d5db; color: #111827; padding: 6px 12px; border-radius: 8px; cursor: pointer; flex-shrink: 0; font-size: 0.8125rem; }

      /* 卡片样式 */
      .card { background: white; padding: 24px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 24px; border: 1px solid #f3f4f6; }
      
      /* 上传区 */
      .upload-area { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      input[type="file"] { flex: 1; min-width: 200px; padding: 10px; border: 1px dashed #d1d5db; border-radius: 8px; background: #f9fafb; cursor: pointer; color: #6b7280; }
      input[type="file"]::-webkit-file-upload-button, input[type="file"]::file-selector-button { background-color: #ffffff; border: 1px solid #d1d5db; color: #111827; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 0.875rem; margin-right: 10px; }
      .upload-btn { background-color: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background-color 0.2s; white-space: nowrap; }
      .upload-btn:hover { background-color: #2563eb; }
      
      /* 表格区 */
      .table-container { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; min-width: 600px; }
      th { background-color: #f9fafb; color: #6b7280; font-weight: 500; font-size: 0.875rem; padding: 12px 16px; text-align: left; border-bottom: 1px solid #e5e7eb; }
      td { padding: 16px; border-bottom: 1px solid #e5e7eb; font-size: 0.875rem; color: #111827; }
      tr:last-child td { border-bottom: none; }
      tr:hover { background-color: #f9fafb; }
      
      /* 操作按钮 */
      .actions { display: flex; gap: 12px; align-items: center; }
      .actions a { color: #3b82f6; text-decoration: none; font-weight: 500; transition: color 0.2s; }
      .actions a:hover { color: #1d4ed8; }
      .actions .delete-btn { color: #ef4444; background: none; border: none; padding: 0; cursor: pointer; font-weight: 500; font-size: 0.875rem; transition: color 0.2s; }
      .actions .delete-btn:hover { color: #b91c1c; }
      
      .empty-state { text-align: center; padding: 40px; color: #6b7280; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2>📦 <span>𝙒𝙞𝙙𝙜𝙚𝙩𝙨 𝘿𝙞𝙨𝙠</span></h2>
        <button class="logout-btn" onclick="logout()">退出登录</button>
      </div>

      <div class="card">
        <div class="upload-area">
          <input type="file" id="fileInput" accept="*/*" multiple onchange="onFilesChosen()" />
          <button class="upload-btn" onclick="uploadFile()">上传文件</button>
          <span id="chosenTip" style="font-size: 0.875rem; color: #6b7280;"></span>
        </div>
      </div>

      <div class="card" style="padding: 0;">
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>文件名</th>
                <th>大小</th>
                <th>上传时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="fileList"></tbody>
          </table>
        </div>
      </div>
    </div>

    <script>
      async function logout() {
        await fetch('/api/logout', { method: 'POST' });
        window.location.reload();
      }

      async function loadFiles() {
        const res = await fetch('/api/files');
        if(res.status === 401) return window.location.reload(); // 登录失效自动刷新
        if(!res.ok) return alert('读取文件列表失败');
        
        const files = await res.json();
        const tbody = document.getElementById('fileList');
        
        if (files.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state">暂无文件，请在上方上传</div></td></tr>';
          return;
        }

        tbody.innerHTML = '';
        files.forEach(f => {
          tbody.innerHTML += \`
            <tr>
              <td>\${f.filename}</td>
              <td>\${(f.size / 1024).toFixed(2)} KB</td>
              <td>\${new Date(f.upload_time).toLocaleString()}</td>
              <td class="actions">
                <a href="javascript:void(0)" onclick="previewFile('\${f.filename}')">预览</a>
                <a href="javascript:void(0)" onclick="downloadFile('\${f.filename}')">下载</a>
                <button class="delete-btn" onclick="deleteFile('\${f.filename}')">删除</button>
              </td>
            </tr>
          \`;
        });
      }

      function onFilesChosen() {
        const n = document.getElementById('fileInput').files.length;
        document.getElementById('chosenTip').textContent = n ? ('已选 ' + n + ' 个文件') : '';
      }

      async function uploadFile() {
        const fileInput = document.getElementById('fileInput');
        const files = Array.prototype.slice.call(fileInput.files);
        const btn = document.querySelector('.upload-btn');

        if (!files.length) return alert('请先选择文件');

        btn.disabled = true;
        let okCount = 0;
        const failed = [];
        for (let i = 0; i < files.length; i++) {
          btn.textContent = '上传中 ' + (i + 1) + '/' + files.length + '...';
          try {
            const formData = new FormData();
            formData.append('file', files[i]);
            const res = await fetch('/api/upload', {
              method: 'POST',
              body: formData
            });
            if (res.ok) okCount++; else failed.push(files[i].name);
          } catch (e) {
            failed.push(files[i].name);
          }
        }

        btn.textContent = '上传文件';
        btn.disabled = false;
        fileInput.value = '';
        onFilesChosen();
        loadFiles();

        if (failed.length) {
          alert('成功 ' + okCount + ' 个，失败 ' + failed.length + ' 个：\\n' + failed.join('\\n'));
        }
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

      const PREVIEW_TEXT_EXTS = ['js', 'json', 'txt', 'fwd', 'rex', 'css', 'html', 'xml', 'md', 'csv', 'log'];
      const PREVIEW_IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];
      let previewCurrentUrl = '';
      async function previewFile(filename) {
        const overlay = document.getElementById('previewOverlay');
        const body = document.getElementById('previewBody');
        document.getElementById('previewTitle').textContent = filename;
        body.innerHTML = '<div style="color:#6b7280">加载中...</div>';
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        body.classList.remove('img-mode');
        const ext = filename.split('.').pop().toLowerCase();
        const fileUrl = '/widgets/' + encodeURIComponent(filename);
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
          const res = await fetch('/download/' + encodeURIComponent(filename));
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
        let startDist = 0, startScale = 1, startTx = 0, startTy = 0, startMidX = 0, startMidY = 0;
        let gestureStart = null, lastTapTime = 0;
        const pointers = new Map();
        function getMaxScale() {
          if (img.naturalWidth > 0 && img.clientWidth > 0) return Math.max(1, img.naturalWidth / img.clientWidth);
          return 4;
        }
        function apply(animate) {
          img.style.transition = animate ? 'transform 0.25s ease-out' : 'none';
          img.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
        }
        function clampPan() {
          const mx = Math.max(0, (img.clientWidth * scale - viewer.clientWidth) / 2) + 48;
          const my = Math.max(0, (img.clientHeight * scale - viewer.clientHeight) / 2) + 48;
          if (tx > mx) tx = mx; if (tx < -mx) tx = -mx;
          if (ty > my) ty = my; if (ty < -my) ty = -my;
        }
        function toggleZoom() {
          if (scale > 1) { scale = 1; tx = 0; ty = 0; } else { scale = Math.min(2.5, getMaxScale()); }
          apply(true);
        }
        viewer.addEventListener('pointerdown', function (e) {
          img.style.transition = 'none';
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
            const ms = getMaxScale();
            if (scale > ms) { scale = ms; clampPan(); apply(true); }
            else if (scale < 1) { scale = 1; tx = 0; ty = 0; apply(true); }
            else if (scale === 1 && (tx !== 0 || ty !== 0)) { tx = 0; ty = 0; apply(true); }
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
          if (pointers.size === 0) gestureStart = null;
        });
        viewer.addEventListener('dblclick', function () { toggleZoom(); });
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
