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
