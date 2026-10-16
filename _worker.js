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
const ICON_512_B64 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAhFklEQVR4nO3d27MlV33Y8d9vdfe+nDN7zlx1d+QhGjm4hBw0wpSJjSkutiMbB+MEp8opv/gx/0Xe85SHPBGqQnBwRbiMXDKRkAGnTACHOALFEAwaAx5mBmlGOqNz2Xt391q/PPQ5cz0zGumsM31m/76fB5BG87Cqa/f69nW1mpkAAPwJfQ8AANAPAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnyr4H4MWXv3X+zBvx9Q2rrdBQ9T0cYF9RsxisOTCQew7ox977QN/j8ULNrO8xLLj/9JUzP7igm205m8/baEFDKIKJ9j0uYD8xi6kNYsOqGg3LY8P6XQ9VTz1xX9/DWnAEYA996itnv302bbYqsSmCipiICBscuBlVETWTJBqK4sGD9ks/W33oF+7te1gLiwDslX/3p+d+cikFa4OamZiYcNQP3BZTVRVprRhW4cmf0T94PxeF9gQByO/5F889/720NrNCGjMmfeBtUjHRkLR8133yb3/twb6Hs4B4Ciizr7x0/rn/l9ZnsWT2B3bHRMVSsObb5+0/fvEnfQ9nARGAzF74vm3UFiQmZn9g10zUzEqLL50Pn/2f5/oezqIhADn9h+fO/PRSW1jLsT+Qj5olS/XX/r7teySLhgBk8/yL579/QSqNibsqQFYmqmKzRv79F872PZaFQgCy+dtzbR23n/UEkJWZFCH9+HX90re5EJQNAcjmhxejpoY3vIC9YjadN989n/oex+JgKYg8nv7GuUZHKpu3CIB2r7kAuAm79YuSZiGECzNWUsmGAORx5rWY2niz8ylVSUnaZNF47wK4qUI1BC0K0e6t+Wv/q4mqpEsb9V98+/yHHmeViAwIQB4X12OKFsI1R/jdDYEm2ry1lMxMkmyvB9HLKIH9qttzVC2oqGpZyLAMRbjhhMDS+iy9tsm16zwIQB5zqUJobHti737NTbRpk2ISMxEV7f5cr/wFANdJJpasTVI3cVDqqApBrxwwqZhoNW3YgfIgAHmYlEGjWdvN7clk1qRZa8Klf+At6vYXE5m11sS0VGlZXtmFQlm1PGqdCWdSeZjp5UP7ZLIxT7PGlCN9YBdUJCbbqNO8tauOojQRgEw4A8hl6xfZzf5tMo76gd1TFROZ1klFh2UQ4QZaTpwB5LJ11rpZp5ZlgICsTGSztiaaqm09IYQcCEAeJqYqs8bqyOwPZNY9ULfZWOIlsKwIQB6q0kabtxybAHuiux8wbbafqEMOBCAPFa1bS6wCCuwZFWlai5bYy3LhJnAebeouUN7O3+UsAdjRbew/JnWz9wNxgwDk0Sa7jWWgu1NXng8Crndl57nlYikm1kQOobIhAHmkZKp6k5+uqnZftGjNknSfiAdwFRURDSKqIYRQdB+B2envqZi1XATKhADk0cYd/1hVJMWmbesU6xSjpSSWCABwna0AaAghhKIqykGohiJBJF3315IIH13KhQDkkW6c01Utxnq+kZq5pWhiqiqioqrceweu162SmFIbY1u39TQUZTFcqqrxdcsnJpPEmrqZEIBMTK76GJiKWJxvNrN1S6lbDOjaJ9f4+QI3sb2zxLaJ7aVUzarxREN527cJ8BYQgDzs8s9TVVJqZmttPd36VwBvnaqKSGxmKbWD8cFQDbuJn8k/I65F5KWSrJ690c43RVgLDtg1DRZjvXkpNbVcfZqNHAhAZs18Pc5nomxYIBNVS6nevGSp4ZQ6L+apbFQ11rN2vslvFMhM1VKsp+tXFl5HDgQgF7UUm/kG96eAPaGamvnWrTVkQgDyUNE437TIKSqwZ1Tb+YalyN21XHgKKI9kbdvM3+R3qSwVB7yJWy+oaCnFeia6fMfGs9gIQB6pbVJsdpz/u09YWAqWgpmyYCiwMzURUU0hmOxcAhWxtp2JLd3xwS0mApCHtTsvUaghxbZMbRmKWFRNUUQNSfmkEXAdUzNJsWhj2dQDVSmrujtyuvaviaRkkRVB8yAAeaTYbn29dJuqpaTNdDyerK0cu3D4nldWjr26fHCtGs5CEfmsHXCNFNqmmm4urb925LVX7r306rG1145a0nJYX9UAE9VkydLOa2/hrSIAeSS76hepImJtPahGs4ff+eL9J/7+8D2vFGWbYrF9Cci4iwVco2gHZTscT4/c88rD7/zuxhuTV878zJm/e/S1cw8UVRPC1R9bskgAMiEAmVjamtfVzDS21fGHzpx84n8fue+8qjX1IMZS5KqLmsz/wNW2l3yLsRDT4Xh24ue/c//DP/rR937u9Ld/oakHZdmaqXSrru+4UjTeOgKQh1l3/0osaUrhHe966dEnvlkNm6aupLsPzCvswC3oVf+vllKoZ6NyUD/6xN8cuueVv/3qP1tfPVxWjYiY8bJNNrwHkJOZphROvvv/vPO9Xw9lqucDVeOWL/BWqZqGlFJoZqN7HvzJEx/80sGjF9u2Ym/KiwBkoyKxLU889rcnT/1NikWKIQROVIG3r8tAPR+uHLvw+C//j/GBtdiWNCAjApCHqjVNdezBnzx66puW1Ez5mQJZhJCa+fDwfed/7sn/1d0NZufKhQDkkVKoRrOTT3yzrJoUOUgBctKQmvnooUdevv/E6bblzmU2BCCPth489Mj3j953vm0qVa78APmZyYnHvz0YzlJi4sqD7ZjHeLJ234nTqias9ADsAVVLsTx4+PX7Hv5hikXfw1kQBCCPlWMXD9/7SlMPlBu/wN4wU9V0/z/+IRdYc+FqWh6H73mlLGKsy5us8XDdG2C8CQxcz7Y++bj9/zvT5YOry4dev6MjW1wEII+VY6+mVOw0q6uKJYnRUrQmSTTeCAN2oiIqRdCilDJoUAnbbwdv/wW1GIvhaLZy9GJvo1wsBCCPpcmamVy9GpyKmkiUtkl1lDptrQHE7A/clEorprVI0LLSQalVkHDVXmOStBzU48l6n6NcIAQgj8FoVrdB5PINAE2Waps1Njcx3f5OGJ8zBW5HsnZmTSHlQEdlqK78uYRQxMFg3uPYFgk3gfMI4erlCTVas5nWa5sJkz7wtqholHZmG/M0u+bPg2nBaqB5cAaQyZWlrLRJ85lNRYypH9iNbg+qbWopjcKVr4DxomUunAHkpY00M5tedS0IwK6oaGPzedzseyALiADkYiqSJM3jJk95AnmpaC3zOs3Zs/IiANmYSG2bJlydBPJT0dqmMTXbb9IgAwKQh4q21rTWcIQC7BmrbcYZdkYEIA8Taaw2vlQE7CFtrW0sMv3nQgDyiNa21vDYD7DHrLE5O1ouPAaaR5LWbv2h6u43qyqcvgI72Tp9tjc5kTaLkafsMiEAeURJKrrDSg/dZG+SWottSm0yvg8P3EhFRbTQogyhDCGIyQ57ioomSZFHLTIhAHmYtdcf2KuoSUrSzmI9b601MUuJ1YCAm9KgqipBykExGJehDKo3nhAkMwKQBwHII157/UdVTKSexXqjjW2S7kxARbU7zulnkMC+1i3+aSatNG3bTNtqVAyXy1CGKw1QMbF068utuG0EYA+oxGjz9aadRbHtdeCuxkkAcAvbF07raWzrNDxQVaPrPgHGLpQHTwFlpiqxSdPVutmMIhzsA2+XiqqkaLM36nqzVb3ld2LwtnAGkFU3+1+qrTGlrcCudSfQs7VGRIfLBfN/XsxS2aioJZmtNdYa2xXISEXma3U9i7rDFVW8fUxU+QSpN9u2Tlz2ATJTMZH5ehOjsXtlRADyUJU4T013pRJAbqpirdUbzY7vB+DtIQDZ1NM2JZ5OA/aMSjNrY2sSOM7Kg5vAecTG4jze4vBf5fILAPx2gZ2Z3PJNeRWJ0kxbHd3JQS0yApBHbGKKO69Sq1u/W2tEoolJ4vwVuE635wTVUqQS7R743HFPiXW0AftQHgQgj9TajZN/9wdzsdbskBYPaLFchIFo4CQAuJaJRZGppUuWLqS2ERtqKLb+01VULFn3dj12jwDkEZtrFifpJvhGzEweKQbvDMMHQ3VciwMahBcEgJ1Zk9LrEs+n9oepfinOL0kaiBaXP7HdrRWRxAhAJgQgj5SuXP4J2xd8Tmj1q4Plh8NgScPWoYvI1v8CuJaKVKr3SHVPOXjcRu8t2xfb2dfj5lRsKNpN+apiJpH5PxMCkIltvaYeRBqxgegHyqVfKZeHEkSsWwP68ipwXAACdrS9HFxS0Xu1+vVB9U/S8M+btR+mZnj1fsMxVCZcjsjFutm/Fjsg4V9WKx+uJkPRtP3ngXkfeDPdQVLYuglsyezhMPyDwaF3F8PZ1qx/i9vDeMsIQDZBtBFZ0uJfDVYeK8bJTJj3gbdLRYJIsrQsxcerlVPFaC68BpwZAcjGxILIR8sDJ8MwSWLLArsXRJLYQMJHy8nJMJhLCqIc/+fCNJWHikzN3luM/mkxTmJsViCXrgFLofjN8sCKFLWxf2XDlsyjNntAy18pl4VrPkBuQSSZ3R8G7yuXTN7kq/G4fQQgjyjyZDk+FKrEZUpgD6iIqT1Zjo+GouUmcCYEII/7tHgsDIXZH9gbKiImyxJOFWMCkAvvAeTxoJaHQpna9GbLFBII4BZuNbN3i209EobnONDKhADkcaIYSnuL/7798LLxCiNwCyoq21cmro9B96eHtHhIqjs7qoVFAPK4V0uxZqe1QFUsSmrFWrEoFnmHBbgpDaKlSCGhFC13+gy8LYneG5i48mA75rEcbrybEkSSxE1Jzfa8z3krcEuWxOYiJqmQUEoYiVbXNaBQnWjR1wAXDAHIo5Ig10zwKmkuaSbWbP0rsz9wW3TrwD/VkhoJIwkj0XBVBnTI3pQJAcijuPKLVBGTOJU05agf2AUVEUlTsVaKJdGyW3FLr9ndsCs8BppdN/tvigizP7BrKtZIXBeL7FDZEYC8VNJU0qzvYQCLRMXidgOQEwHISMVqibOtfwaQjYq1nFhnRwAyShKnPOUJ7A2VVEuq+x7GQiEA+aS5WMvhCbCH2unlLwRj9whALoljE2CPqWgSazjKyoUAZGKRw39g75nEOTtaLgQgE2u5+g/sOROR7mALGRCATFIrylEJsMe6vYwAZEIAMuEJZeAOMeGTYJkQgFz4RQJ3hBGAbAhARlwCAu4MApAHAQAApwgAADhFAADcdbgElAcBAACnCAAAOEUAAMApPgmZR0oqpmI8CQrsITMNprwGkAsByKMcNaK1FImXAYA9ZEGGTVH0PYxFoUZMb88Lf/lX042Nup6nlK6a5M0kBJsNmu9KbHlBEdhjqiG15f1N9bN61fq7JiYaqrIcjMZPfeSD/Q7xLkIA3sSfPvuF1QuvNk29ub7RxjaoalC9su6bilhKOq2DibIcHLCnTERMBkUaVKnb+678p2QpJVEdjkbj8dJwvPTgP3r4A+97b3+DvQsQgJt6+k+fOf+Tf6jnc7NUFGW3obo5/rpNpmKqXP4H9p6JqJjpjRdbu383M1W1lFJKZVUdOLjy8Dse+fCv/vKdH+ldgQDs4NnnXvjR6R/Us6moiqolPkEH3GWuPh8/cuz4H/yb3+9xMPsWAbjeH/+3z537yT9sHUewcYC7XLcjLy0tn/z5d33wV36p7+HsL8xx1/jP/+WPXrvwUzYLsFBUxayqqkfe+dhvfOgDfY9mH+FFsCs+/Uf/9bVXfyoSmP2BhWImIm3b/uC7//eFr/xV36PZRwjAlj9++nMXfnrORMy44g8sIDNrm+Z73/lW3wPZRwiAiMh/f+Er5878WJWtASw01Xpef/JTn+p7HPsFU56IyA9f/juu+wMLr3u4Y+2NS59/9gt9j2VfIADyJ888O9vc6HsUAO4EMxOzc2f+oe+B7AsEQC789JzwxCfghpnMp5t/9oXn+x5I/7wH4Nnn/2Jjfa3vUQC4o0zs/NkzfY+if95XA7302kWO/QFvzGS6sd73KPrn/QxgurkRgveNAHjTLRTx7HMv9D2Qnnmf+zbW1/jANOBQ27arr1/sexQ9cx2A5/7iL5umFr7hAjjTXfidbm72PZCeuQ5AjE1RFNwDABxSVUux71H0zHUAUrLA27+AS6rKJ5xcT38c+QOecfbvOgAA4BkBAACnCAAAOEUAAMApAgAAThEAAHDKeQC8PwQGwDPnAQAAvwgAADhFAADAKQIAAE75DgD3gAE45jsAAOAYAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAwCvrewB9IwAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOuQ6A+6UAAbjmOgAA4BkBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABO+Q4Ay4ECnmnfA+ib7wAAgGPOA8ApAAC/nAcAAPwiAADgFAEAAKcIAAA4RQAAwKmy7wFgkam6f9B618x4Vg17hQBgT6iqmbVtKyIpJTPr/qTvcd0ddFsIIYQgZAB7gwAgP1VtmkZVl5eX77///uPHj08mk8cff7zvcd01vvnNb66urp49e/bixYt1XVdVRT6xFwgA8qvr+siRI48++ugjjzwyGo26w9i1tbXJZNL30O4Ca2trJ0+eTCm9+93vfuWVV77zne/8+Mc/btu2qqqUUt+jw0IhAMisaZqTJ0++5z3vWVlZaZrm8oUgM5vNZn2P7u5w+RLQAw88cP/997/88st//dd/vb6+XlUV5wHIiAAgj+4aRUrpiSeeOHXqlIjMZrPu+nV3K5gbwm+VmXVX0k6dOnXq1KlPfvKTr732Gg1ARjwGimyapnnsscfe8573dEf93eyP3eiq+eqrr4rIH/7hH66srLRtS0qRC7soMuju+j788MOnTp2KMaaUmP0zCiF0DfjFX/zFoii6R6r6HhQWAXspMkgpDYfD3/u93zt27FhKiekpuxDChQsXTpw4ceLEibqu2cLIggBgt7rD/0ceeURELl68yNy0R8xsZWXlYx/72NLSEheCkAUBwG6ZWVmWTz311NraGs8p7p3uJEBEjh8/znZGFgQAu6KqbdseOXJERCaTCYele211dfWBBx7gvTBkQQCwK6oaY+ze8OL6z53x/ve/n3vsyIKfEXbLzIbD4fr6Otcl7oBDhw71PQQsDgKA3TKzoig49r8zVldXu3/gEhB2jwAgg27dgr5H4cWZM2fY2siCAACAUwQAAJwiAADgFAEAAKcIAACv3D9IRQAAwCkCAABOEQAAcIoAAIBTBAAAnHIdAPePAGTDujR30kMPPcQGRxauA4AsuhWhY4x9D8QFVgNFRgQAu6Wqs9lsMpmwSP0dcOnSpe4fWA8Ou8cei13pvgfZzUpHjx7l0sSe6j4E9sILL/DpBWRBALArZjYYDM6fPy8iGxsbBGCvHTp06PTp0zFGzrewe/yGsCtmpqrT6fSzn/3s8vIy1yX2Tkrp6NGjInLmzBlmf2TBzwi71X0S8lvf+paIHDt2jKsTe2dtbe3Tn/70pUuXhsMh2xm7RwCQQVEUb7zxxqc+9anV1dXuOnXfI1o0McbxeHz69OmXXnqpqiq2MLIgAMhjMBi8+OKLX/3qV8fjsfBmQFYxxtFotLq6+txzz02n06IoOPxHFgQAGXTTfVmWX/rSl77xjW+MRqOiKHgzYPdSSimlpaWlN9544+mnnz5z5sxwOCSuyKXsewBYEGYWQogxPvvss6urq+973/smk8lsNutmq+5ecd9jvPscP358bW3t+9///he/+MVu9uf5H2REAJBNSimEYGZf/vKXT58+/eSTTz722GPd7cqVlZW+R3c36d6r6Dba5z//+Zdeemlzc3M0GnHlB3kRAOTUHe+PRqMf/ehHZ8+e/frXv/6Od7zjE5/4RN/jususrKw8//zzL7/88pkzZy5dulRVFbM/9gIBQH4ppW7COnv27Llz5772ta9113+4CnQ7bFt3RjUej7t/7ntcWEAEALvVXd+/7sJ0SklVuzuWHeHRoNvWbc/ucc8bp/6iKHoZFRYPAcCudE/9F0XRPfZz9TH+5XlfRLhv+ZZ02+1mR/1lyW6LPPglIYPBYFAURdu23U3gG/8Cx/4ZjUYj3rZDFhyXYbe6M4DhcNj3QBYfmxp5EQBkYGYHDhzgDdW9ZmbLy8tlWXL4jywIADIws6qqJpNJ3wNZZCmlwWBw4MCBvgeCxUEAkIeZHTx4cDwed8//9D2cBRRCWFlZYSU4ZEQAkI2qHj58uFuuQHjqP5Pufq+ZHTp0aGlpiYtsyIgAIJvu85DHjx9fXl42MxaD273uPYCiKI4ePTqZTDj2R16+HwM1EQ5Ss+oeUzl69OhoNFpfX5/P5yKiqpwNvCWX35srimI8Hh88eHAwGHDsj+x8BwB7oJu8JpPJeDyeTqfz+byu6xgj89ftK4qiLMvRaDQcDkejkYhc95IdkAUBwJ7oLlxMJpPl5eVuUXsuX9ymbqIviiKEoKpdOJn9sRcIAPZKd/1aVbuFIvoezt3n8gbseyBYWAQAe6ibvDj2f9uY/bGneAoIAJwiAADgFAEAAKcIAAA45TwA3JwE4JfzAACAXwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFOuA2B9DwAAeuQ6AADgGQEAAKcIAAA4RQAAwCkCAABO+Q4AjwEBcMx3AADAMQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKecB4APAgDwy3kAAMAvAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKd8B0BVRfseBIA+sOs7D4CJJEt9jwJAH0yS+1dBXQdARGKMqhwJAO5YspS8H/+5DkAIRYzefwGATyZm3k8AfAegKKuyqkJwvREAh1S1CKGsBn0PpGeu577f+sgHqmogrAkHOGMiIYTheKnvgfTMdQBERIsypcRtAMAVFYkpDYfjvgfSM+8BGB84WFUV0z/gh5mFEEbLk8AloL4H0LPx8oGiGnAGAPgRNKjqaHygLMu+x9Iz7wEws/FkJYRAAwAfVINWw/Fo+UBT130PpmfeA5BiWp6sVMOxqvJMGLDwVEVDWF45XBQFz4G6D0BKZjI5fLwoyxA4CQAWWXeiP14+OFo60LYNy0F4D4Cqtk0zGA0nh4+XJe8EAIsshDBamhw8ciy2bXJ/+C8EoLsg2Lbt+MDB5UNHQwicBwCLR1WLIpTD0aFj96oGE1Plxp94vwleFGomYpJiu3zwkKqur16wpuHiILAwVERVB+Plg0fuDWXRtm039xdF0ffQeuY9AKpBxETFzGLbLh04WJTl+urFejY1s5RMxDhOAO5G3fP+IhJCWDp4eLJyRFQvz/4iUlVVrwPsn/cAFEWIMXVHCCISUxyOl4aj8drrF2cba21TiwaWDATuRmVRmOhgNF5aOby0PIltm9LW6r8qapb+xW98sO8x9sx7AMqyaptpKK88ENYtEH3w6D2j5clsc21zfU1jG4K2bTTrrhtyQgDsO2ZmKYlqURRFCE2Mw+XJcLQ0nhwMIbRNLdtPAW39/cRlXlEudn/mc8/c+ESwmZRlqaptU8e2mW9uzGabsW2DaiAAwH7TXcWNKRRFNRgNxkvD4TCUg7Is26Y2M7lht1XRf/07v9nLYPcP72cAIqK6QwVVpW0bESnLqqgG5WA0CccuHz5QAGC/MdvaM1MyEQkhtG07n89CCNfN/qratu3BlUN9DHN/IQAyGo2n080QiuuWhe6m+y4DqpqSqqpsXUAEsI90k78lEbGUzCzFKKq645s9JqIafvsjv3rHh7nvcAlIROQzTz8TiusDcCO2FbD/3founarGGMdLSx//5x++Y0PatzgDEBFZnhxYX18v32xtEG7/Ane77n4As3+HN4FFRD726x8s+TIMsOi6w//f//hH+x7IfsEloCs+87lneMgTWFSq2rZxeXn5dzj838YZwBW//7u/bZZEbnxgDMDdTts2jkYjZv+rcQZwvc987hlVCSGwZYBFoW3bLi8vffypX+t7JPsLAdjBH3/+z9um0RBCYPsAd6vuFZ/Oysqh3/owz31ejwnupv7oT/4spXR5gWg2FHB3UFXpXgw2VasGw0989Df6HtM+RQBu5ZkvfmU6nTZ1bWZFcfm7wdwiAPanreP9lFJRlsPh6Hef+kjfQ9rXCMBt+bMX/rKu523TtG0yS8JGA/YZDSGEUJZlNRh87Ne9L/N5mwgAADjFY6AA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACcIgAA4BQBAACnCAAAOEUAAMApAgAAThEAAHCKAACAUwQAAJwiAADgFAEAAKcIAAA4RQAAwCkCAABOEQAAcIoAAIBTBAAAnCIAAOAUAQAApwgAADhFAADAKQIAAE4RAABwigAAgFMEAACc+v9zwFkRvS9kDgAAAABJRU5ErkJggg==";

const APP_MANIFEST = {
  name: "文件管理",
  short_name: "文件管理",
  description: "小型文件储存面板",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#3b82f6",
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
    <meta name="theme-color" content="#3b82f6">
    <link rel="apple-touch-icon" href="/icon-180.png?v=892bc065f8">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=892bc065f8">
    <link rel="manifest" href="/manifest.webmanifest?v=892bc065f8">
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
    <link rel="apple-touch-icon" href="/icon-180.png?v=892bc065f8">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=892bc065f8">
    <link rel="manifest" href="/manifest.webmanifest?v=892bc065f8">
    <title>文件管理控制台</title>
    <style>
      html { overscroll-behavior: none; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f9fafb; margin: 0; padding: 20px; color: #374151; height: 100vh; height: 100dvh; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; overscroll-behavior: none; }
      .container { max-width: 900px; margin: 0 auto; width: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column; }
      
      /* 顶部导航区 */
      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
      .header h2 { margin: 0; color: #111827; display: flex; align-items: center; gap: 8px; }
      .logout-btn { background-color: white; color: #4b5563; border: 1px solid #d1d5db; padding: 8px 16px; border-radius: 8px; cursor: pointer; transition: all 0.2s; font-size: 0.875rem; }
      .logout-btn:hover { background-color: #f3f4f6; color: #111827; }
      .preview-overlay { position: fixed; inset: 0; background: #ffffff; z-index: 1000; display: none; flex-direction: column; padding-top: env(safe-area-inset-top); box-sizing: border-box; }
      .preview-overlay.open { display: flex; }
      .preview-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
      .preview-title { font-weight: 600; color: #111827; overflow: hidden; white-space: nowrap; }
      .ptitle-text { display: inline-block; will-change: transform; }
      .ptitle-text.scrolling { animation: fnameScroll 7s ease-in-out infinite alternate; }
      .preview-close { background-color: #3b82f6; color: white; border: none; padding: 8px 18px; border-radius: 8px; cursor: pointer; flex-shrink: 0; font-size: 0.875rem; }
      .preview-body { flex: 1; overflow: auto; -webkit-overflow-scrolling: touch; padding: 16px; }
      .preview-body pre { margin: 0; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, Menlo, Consolas, monospace; color: #1f2937; }
      .preview-body img { max-width: 100%; display: block; margin: 0 auto; }
      .preview-body.img-mode { padding: 16px; overflow: hidden; }
      .img-viewer { width: 100%; height: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center; touch-action: none; background: #ffffff; position: relative; }
      .img-loading { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(0, 0, 0, 0.55); color: #ffffff; font-size: 13px; padding: 6px 14px; border-radius: 999px; pointer-events: none; z-index: 2; white-space: nowrap; }
      .img-viewer img { max-width: 100%; max-height: 100%; display: block; user-select: none; -webkit-user-select: none; will-change: transform; -webkit-backface-visibility: hidden; }
      .preview-urlbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #e5e7eb; background-color: #f9fafb; }
      .preview-url { flex: 1; font-size: 12px; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
      .preview-act { background-color: #ffffff; border: 1px solid #d1d5db; color: #111827; padding: 6px 12px; border-radius: 8px; cursor: pointer; flex-shrink: 0; font-size: 0.8125rem; }

      /* 卡片样式 */
      .card { background: white; padding: 24px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 24px; border: 1px solid #f3f4f6; flex-shrink: 0; }
      .list-card { flex: 1; min-height: 0; display: flex; flex-direction: column; margin-bottom: 0; overflow: hidden; }
      
      /* 上传区 */
      .upload-area { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      input[type="file"] { flex: 1; min-width: 200px; padding: 10px; border: 1px dashed #d1d5db; border-radius: 8px; background: #f9fafb; cursor: pointer; color: #6b7280; }
      input[type="file"]::-webkit-file-upload-button, input[type="file"]::file-selector-button { background-color: #ffffff; border: 1px solid #d1d5db; color: #111827; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 0.875rem; margin-right: 10px; }
      .upload-btn { background-color: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: 500; transition: background-color 0.2s; white-space: nowrap; }
      .upload-btn:hover { background-color: #2563eb; }
      
      /* 表格区 */
      .table-container { flex: 1; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; background: #ffffff; touch-action: pan-y; }
      .thead-wrap { flex-shrink: 0; overflow: hidden; background-color: #f9fafb; }
      table { width: 100%; border-collapse: collapse; min-width: 680px; -webkit-text-size-adjust: 100%; table-layout: fixed; }
      th { background-color: #f9fafb; color: #6b7280; font-weight: 500; font-size: 0.875rem; padding: 12px 16px; text-align: left; border-bottom: 1px solid #e5e7eb; }
      td { padding: 12px 16px; border-bottom: 1px solid #e5e7eb; font-size: 0.875rem; color: #111827; line-height: 20px; }
      td.col-size { min-width: 96px; }
      td.col-time { min-width: 176px; }
      tr:last-child td { border-bottom: none; }
      tr:hover { background-color: #f9fafb; }
      .col-nowrap { white-space: nowrap; }
      .fname-cell { position: relative; width: 232px; box-sizing: border-box; }
      .fname-box { position: absolute; left: 16px; right: 16px; top: 0; bottom: 0; display: flex; align-items: center; overflow: hidden; white-space: nowrap; }
      .fname-text { display: block; flex: none; white-space: nowrap; will-change: transform; }
      .fname-text.scrolling { animation: fnameScroll 7s ease-in-out infinite alternate; }
      @keyframes fnameScroll {
        0%, 25% { transform: translateX(0); }
        90%, 100% { transform: translateX(calc(-1 * var(--dx, 0px))); }
      }
      
      /* 操作按钮 */
      .actions { white-space: nowrap; min-width: 156px; }
      .actions-in { display: flex; gap: 12px; align-items: center; }
      .actions-in > * { flex-shrink: 0; }
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

      <div class="card list-card" style="padding: 0;">
        <div class="thead-wrap">
          <table class="head-table">
            <colgroup><col style="width:232px"><col style="width:96px"><col style="width:196px"><col style="width:156px"></colgroup>
            <thead>
              <tr>
                <th>文件名</th>
                <th>大小</th>
                <th>上传时间</th>
                <th>操作</th>
              </tr>
            </thead>
          </table>
        </div>
        <div class="table-container">
          <table>
            <colgroup><col style="width:232px"><col style="width:96px"><col style="width:196px"><col style="width:156px"></colgroup>
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
              <td class="fname-cell"><div class="fname-box"><span class="fname-text">\${f.filename}</span></div></td>
              <td class="col-nowrap col-size">\${(f.size / 1024).toFixed(2)} KB</td>
              <td class="col-nowrap col-time">\${new Date(f.upload_time).toLocaleString()}</td>
              <td class="actions"><div class="actions-in">
                <a href="javascript:void(0)" onclick="previewFile('\${f.filename}')">预览</a>
                <a href="javascript:void(0)" onclick="downloadFile('\${f.filename}')">下载</a>
                <button class="delete-btn" onclick="deleteFile('\${f.filename}')">删除</button>
              </div></td>
            </tr>
          \`;
        });
        document.querySelectorAll('.fname-box').forEach(box => {
          const span = box.querySelector('.fname-text');
          const dx = span.scrollWidth - box.clientWidth;
          if (dx > 4) {
            span.style.setProperty('--dx', dx + 'px');
            span.style.animationDuration = Math.max(4, Math.round(dx / 30)) + 's';
            span.classList.add('scrolling');
          }
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
        const titleEl = document.getElementById('previewTitle');
        titleEl.innerHTML = '';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'ptitle-text';
        titleSpan.textContent = filename;
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

      (function () {
        const sc = document.querySelector('.table-container');
        const headTable = document.querySelector('.head-table');
        if (!sc || !headTable) return;
        let lastLeft = -1;
        sc.addEventListener('scroll', function () {
          if (sc.scrollLeft !== lastLeft) {
            lastLeft = sc.scrollLeft;
            headTable.style.transform = 'translateX(' + (-lastLeft) + 'px)';
          }
        }, { passive: true });
      })();
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
