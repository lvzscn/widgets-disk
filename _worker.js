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
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
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
    <link rel="apple-touch-icon" href="/icon-180.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
    <link rel="manifest" href="/manifest.webmanifest">
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
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="文件管理">
    <meta name="theme-color" content="#3b82f6">
    <link rel="apple-touch-icon" href="/icon-180.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
    <link rel="manifest" href="/manifest.webmanifest">
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
      .preview-urlbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #e5e7eb; background-color: #f9fafb; }
      .preview-url { flex: 1; font-size: 12px; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
      .preview-act { background-color: #ffffff; border: 1px solid #d1d5db; color: #111827; padding: 6px 12px; border-radius: 8px; cursor: pointer; flex-shrink: 0; font-size: 0.8125rem; }

      /* 卡片样式 */
      .card { background: white; padding: 24px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 24px; border: 1px solid #f3f4f6; }
      
      /* 上传区 */
      .upload-area { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      input[type="file"] { flex: 1; min-width: 200px; padding: 10px; border: 1px dashed #d1d5db; border-radius: 8px; background: #f9fafb; cursor: pointer; color: #6b7280; }
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
        const ext = filename.split('.').pop().toLowerCase();
        const fileUrl = '/widgets/' + encodeURIComponent(filename);
        previewCurrentUrl = location.origin + fileUrl;
        document.getElementById('previewUrl').textContent = previewCurrentUrl;
        if (PREVIEW_IMG_EXTS.indexOf(ext) !== -1) {
          body.innerHTML = '';
          const img = document.createElement('img');
          img.src = fileUrl;
          body.appendChild(img);
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
        document.body.style.overflow = '';
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
