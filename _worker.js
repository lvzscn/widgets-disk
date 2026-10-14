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
