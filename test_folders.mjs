import fs from 'node:fs';
import { execSync } from 'node:child_process';

if (typeof Response.json !== 'function') {
  Response.json = (data, init = {}) =>
    new Response(JSON.stringify(data), { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

const worker = (await import('./_worker.js')).default;

// ---- Byte-accurate KV stub ----
const store = new Map();
const enc = new TextEncoder(), dec = new TextDecoder();
const FILE_KV = {
  async get(key, opts) {
    if (!store.has(key)) return null;
    const bytes = store.get(key);
    if (opts && opts.type === 'arrayBuffer') return bytes.slice().buffer;
    if (opts && opts.type === 'stream') return new Response(bytes).body;
    return dec.decode(bytes);
  },
  async put(key, value) {
    if (typeof value === 'string') store.set(key, enc.encode(value));
    else if (value instanceof ArrayBuffer) store.set(key, new Uint8Array(value));
    else if (value instanceof Uint8Array) store.set(key, value.slice());
    else if (value && value.byteLength !== undefined) store.set(key, new Uint8Array(value));
    else store.set(key, enc.encode(String(value)));
  },
  async delete(key) { store.delete(key); },
};

// ---- D1 stub (in-memory, upsert by filename) ----
const dbRows = [];
function upsert(filename, size, upload_time) {
  const i = dbRows.findIndex(r => r.filename === filename);
  const row = { filename, size, upload_time: upload_time === undefined ? new Date().toISOString() : upload_time };
  if (i >= 0) dbRows[i] = row; else dbRows.push(row);
}
const FILE_DB = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.startsWith('INSERT')) upsert(args[0], args[1], args[2]);
            if (sql.startsWith('DELETE')) { const i = dbRows.findIndex(r => r.filename === args[0]); if (i >= 0) dbRows.splice(i, 1); }
            return {};
          },
          async all() {
            let rows = dbRows.slice();
            if (sql.includes('ORDER BY upload_time DESC')) rows.sort((a, b) => String(b.upload_time).localeCompare(String(a.upload_time)));
            return { results: rows };
          },
          async first() {
            if (sql.startsWith('SELECT filename FROM files WHERE filename = ?')) {
              return dbRows.find(r => r.filename === args[0]) || null;
            }
            if (sql.startsWith('SELECT size, upload_time FROM files WHERE filename = ?')) {
              const r = dbRows.find(r => r.filename === args[0]);
              return r ? { size: r.size, upload_time: r.upload_time } : null;
            }
            return null;
          },
        };
      },
      async all() { return { results: dbRows.slice() }; },
      async run() { return {}; },
    };
  },
};

const env = { FILE_KV, FILE_DB, ADMIN_SECRET: 'test-secret' };
const BASE = 'https://file.jane77u.gq';
const AUTH = { Cookie: 'auth_secret=test-secret' };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
async function j(res) { try { return await res.json(); } catch { return {}; } }

// seed: 2 root files (simulating existing files)
await FILE_KV.put('a.txt', 'hello a');
upsert('a.txt', 7, '2026-11-01T00:00:00.000Z');
await FILE_KV.put('b.png', new Uint8Array([1, 2, 3]));
upsert('b.png', 3, '2026-11-02T00:00:00.000Z');

// T1: create folder
console.log('T1 新建文件夹');
let res = await worker.fetch(new Request(BASE + '/api/folder', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '照片' }) }), env);
check('新建返回 200', res.status === 200, 'got ' + res.status);
check('KV 有 照片/.keep', store.has('照片/.keep'));
check('D1 有 照片/.keep', dbRows.some(r => r.filename === '照片/.keep'));

// T2: duplicate folder -> 409
console.log('T2 重复建文件夹');
res = await worker.fetch(new Request(BASE + '/api/folder', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '照片' }) }), env);
check('重复返回 409', res.status === 409, 'got ' + res.status);

// T3: invalid folder name -> 400
console.log('T3 非法文件夹名');
for (const bad of ['../x', 'a/../b', '.keep', '']) {
  res = await worker.fetch(new Request(BASE + '/api/folder', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bad }) }), env);
  check('非法名 ' + JSON.stringify(bad) + ' 返回 400', res.status === 400, 'got ' + res.status);
}

// T4: upload into folder
console.log('T4 上传到文件夹');
const fd = new FormData();
fd.append('file', new File(['beach'], 'beach.jpg', { type: 'image/jpeg' }));
fd.append('folder', '照片');
res = await worker.fetch(new Request(BASE + '/api/upload', { method: 'POST', headers: AUTH, body: fd }), env);
check('上传返回 200', res.status === 200, 'got ' + res.status);
check('KV 有 照片/beach.jpg', store.has('照片/beach.jpg'));
check('D1 有 照片/beach.jpg', dbRows.some(r => r.filename === '照片/beach.jpg'));
res = await worker.fetch(new Request(BASE + '/widgets/' + encodeURIComponent('照片/beach.jpg')), env);
check('能取到文件夹里的文件', res.status === 200 && (await res.text()) === 'beach');

// T5: nested folder + upload
console.log('T5 嵌套文件夹');
res = await worker.fetch(new Request(BASE + '/api/folder', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '照片/海滩' }) }), env);
check('嵌套新建 200', res.status === 200, 'got ' + res.status);
const fd2 = new FormData();
fd2.append('file', new File(['sand'], 'sand.txt', { type: 'text/plain' }));
fd2.append('folder', '照片/海滩');
res = await worker.fetch(new Request(BASE + '/api/upload', { method: 'POST', headers: AUTH, body: fd2 }), env);
check('嵌套上传 200', res.status === 200, 'got ' + res.status);
check('KV 有 照片/海滩/sand.txt', store.has('照片/海滩/sand.txt'));

// T6: move root file into folder
console.log('T6 移动文件进文件夹');
res = await worker.fetch(new Request(BASE + '/api/move', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'a.txt', to: '照片/a.txt' }) }), env);
check('移动返回 200', res.status === 200, 'got ' + res.status);
check('旧 key 消失', !store.has('a.txt') && !dbRows.some(r => r.filename === 'a.txt'));
check('新 key 存在且内容一致', store.has('照片/a.txt') && dec.decode(store.get('照片/a.txt')) === 'hello a');
check('D1 新 key 存在', dbRows.some(r => r.filename === '照片/a.txt'));

// T7: move to existing target -> 409
console.log('T7 移动到已存在目标');
res = await worker.fetch(new Request(BASE + '/api/move', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'b.png', to: '照片/beach.jpg' }) }), env);
check('返回 409', res.status === 409, 'got ' + res.status);
check('b.png 未动', store.has('b.png'));

// T8: rename folder
console.log('T8 文件夹改名');
res = await worker.fetch(new Request(BASE + '/api/rename-folder', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath: '照片', newPath: '相册' }) }), env);
check('改名返回 200', res.status === 200, 'got ' + res.status);
check('旧前缀全消失', !dbRows.some(r => r.filename === '照片' || r.filename.startsWith('照片/')));
check('相册/beach.jpg 在', store.has('相册/beach.jpg') && dbRows.some(r => r.filename === '相册/beach.jpg'));
check('相册/海滩/sand.txt 在', store.has('相册/海滩/sand.txt'));
check('相册/a.txt 内容一致', dec.decode(store.get('相册/a.txt')) === 'hello a');

// T9: rename into itself -> 400
console.log('T9 改名进自身');
res = await worker.fetch(new Request(BASE + '/api/rename-folder', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath: '相册', newPath: '相册/子' }) }), env);
check('返回 400', res.status === 400, 'got ' + res.status);

// T10: delete folder (nested contents too), root file untouched
console.log('T10 删除文件夹');
res = await worker.fetch(new Request(BASE + '/api/folder/' + encodeURIComponent('相册'), { method: 'DELETE', headers: AUTH }), env);
const delBody = await j(res);
check('删除返回 200', res.status === 200, 'got ' + res.status);
check('删了 5 条（含 .keep 与嵌套）', delBody.deleted === 5, 'deleted=' + delBody.deleted);
check('相册前缀全消失', !dbRows.some(r => r.filename.startsWith('相册/')) && !Array.from(store.keys()).some(k => k.startsWith('相册/')));
check('根文件 b.png 还在', store.has('b.png') && dbRows.some(r => r.filename === 'b.png'));

// T11: render admin HTML, extract embedded script, node --check it
console.log('T11 渲染产物与内嵌脚本');
res = await worker.fetch(new Request(BASE + '/', { headers: AUTH }), env);
const html = await res.text();
check('管理页 200', res.status === 200, 'got ' + res.status);
const m = html.match(/<script>([\s\S]*?)<\/script>/);
check('能抽出内嵌 script', !!m);
if (m) {
  fs.writeFileSync('/tmp/admin_script.js', m[1]);
  try {
    execSync('node --check /tmp/admin_script.js', { stdio: 'pipe' });
    check('内嵌脚本 node --check 通过', true);
  } catch (e) {
    check('内嵌脚本 node --check 通过', false, (e.stdout || e.stderr || e.message).toString().slice(0, 500));
  }
  // escape survival: 渲染产物里模板插值 ${ 与反引号存活，无被吞的转义
  check('渲染后模板插值 ${ 存活', m[1].includes('${'));
  check('渲染后反引号存活', m[1].includes('`'));
  check('含面包屑栏', html.includes('id="crumbs"'));
  check('含新建文件夹入口（底部菜单）', html.includes('新建文件夹') && html.includes('sheetCreateFolder'));
  check('含上传入口（底部菜单）', html.includes('上传文件') && html.includes('pickFiles'));
  check('含 createFolder/renameFolder/deleteFolder/openMove/confirmMove', ['createFolder', 'renameFolder', 'deleteFolder', 'openMove', 'confirmMove'].every(fn => m[1].includes(fn)));
  check('含移动下拉（moveModal/moveSelect/getAllFolders）', m[1].includes('moveModal') && m[1].includes('moveSelect') && m[1].includes('getAllFolders'));
  check('旧移动 prompt 已删', !m[1].includes("prompt('移动到哪个文件夹"));
  check('含 renderCrumbs/goToPath/enterFolder', ['renderCrumbs', 'goToPath', 'enterFolder'].every(fn => m[1].includes(fn)));
  check('含 .keep 过滤', m[1].includes("'.keep'"));
  check('含 crumb-bar 样式', html.includes('.crumb-bar'));
  check('含搜索框', html.includes('id="searchInput"'));
  check('含筛选 chips', html.includes('id="chips"') && html.includes('data-filter="folder"'));
  check('含最近文件区', html.includes('id="recentSection"'));
  check('含文件夹区与文件区', html.includes('id="folderSection"') && html.includes('id="fileSection"'));
  check('含底部导航与 ＋ 按钮', html.includes('bottom-nav') && html.includes('nav-plus'));
  check('含底部动作菜单', html.includes('id="actionSheet"'));
  check('含存储弹窗', html.includes('id="storageModal"'));
  check('含文件行与文件夹卡片样式', html.includes('.file-row') && html.includes('.folder-card'));
  check('含最近文件大卡样式', html.includes('.recent-card'));
  check('含文件操作展开栏', html.includes('.file-actions'));
  check('含 setFilter/onSearch/openSheet/openStorage/copyLink', ['setFilter', 'onSearch', 'openSheet', 'openStorage', 'copyLink'].every(fn => m[1].includes(fn)));
  check('含 fileTypeInfo/fmtSize', m[1].includes('fileTypeInfo') && m[1].includes('fmtSize'));
  check('含 ICONS 图标集', m[1].includes('const ICONS') && ['ICONS.image', 'ICONS.video', 'ICONS.music', 'ICONS.file', 'ICONS.code', 'ICONS.package', 'ICONS.check'].every(s => m[1].includes(s)));
  check('搜索框为 type=text（无 iOS 原生放大镜）', html.includes('type="text"') && !html.includes('type="search"'));
  check('操作按钮为柔和配色', ['.act-link { background: #dbeafe;', '.act-dl { background: #dcfce7;', '.act-move { background: #f3f4f6;', '.act-del { background: #fee2e2;'].every(s => html.includes(s)));
  check('单文件操作白条按钮居中', html.includes('.file-actions') && html.includes('justify-content: center'));
  check('底部加号居中（五等分 grid，格内居中）', html.includes('grid-template-columns: repeat(5, 1fr)') && html.split('.nav-plus')[1].split('}')[0].includes('justify-self: center'));
  check('含编辑按钮与批量栏', m[1].includes('toggleEdit') && m[1].includes('edit-btn') && m[1].includes('batch-actions') && m[1].includes('batch-count'));
  check('批量栏只有下载/移动/删除三钮（无复制链接）', ['data-bact="download"', 'data-bact="move"', 'data-bact="delete"'].every(s => m[1].includes(s)) && !m[1].includes('data-bact="link"'));
  check('含批量下载/删除/移动与复选框', ['batchDownload', 'batchDelete', 'batchMove', 'sel-box', 'selFiles', 'editMode'].every(s => m[1].includes(s)));
  check('移动弹窗支持多文件（moveTargets 数组）', m[1].includes('moveTargets') && m[1].includes('Array.isArray(full)'));
  check('底部导航五等分 grid，加号格内居中', html.includes('grid-template-columns: repeat(5, 1fr)') && html.includes('.nav-plus') && html.split('.nav-plus')[1].split('}')[0].includes('justify-self: center'));
  check('滑动屏幕自动收起操作按钮', m[1].includes("addEventListener('scroll'") && m[1].includes('.file-actions.open') && m[1].includes('folderActions'));
  check('加号为模板样式小细线圆圈（32px 描边、无填充、不上浮）', html.includes('width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid #111827; background: transparent') && !html.split('.nav-plus')[1].split('}')[0].includes('margin-top: -26px'));
  check('All 栏根目录扁平化显示真正全部文件', m[1].includes("currentFilter === 'all'") && m[1].includes("outFiles = outFiles.filter"));
  check('点空白处自动收起操作按钮（文档级点击）', m[1].includes("document.addEventListener('click'") && m[1].includes('.file-actions, .folder-actions, .file-more, .fc-more, .batch-actions'));
  check('文件夹区有新建文件夹按钮（Folder 栏无文件夹也显示）', html.includes('新建文件夹') && html.includes('onclick="createFolder()"') && m[1].includes("view.folders.length || currentFilter === 'folder'"));
  check('进入文件夹时 Folder 筛选自动切回 All', m[1].includes("if (currentPath && currentFilter === 'folder')") && m[1].includes("currentFilter = 'all'"));
  check('已删「文件」筛选，只剩 All/Folder', !html.includes('data-filter="file"') && !m[1].includes("currentFilter === 'file'"));
  check('文件链接分段编码（斜杠保持原样）', m[1].includes("function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }") && m[1].includes("'/widgets/' + encPath(") && m[1].includes("'/download/' + encPath("));
  check('展开操作条时滚进视野且不被滚动收起', m[1].includes("function revealActions(el)") && m[1].includes("if (suppressScrollClose) return;") && !m[1].includes("scrollIntoView"));
  check('返回按钮 24px（缩小20%），箭头 18px', html.includes('.back-btn { width: 24px; height: 24px;') && html.includes('.back-btn svg { width: 18px; height: 18px; }'));
  check('文件操作按钮用 SVG 图标', ['ICONS.link', 'ICONS.download', 'ICONS.move', 'ICONS.trash'].every(s => m[1].includes(s)));
  check('文件夹卡片用 SVG 图标', m[1].includes('ICONS.folder'));
  check('最近文件标题为中文', html.includes('最近文件') && !html.includes('Recent File'));
  check('渲染产物无 emoji 图标', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(html));
  check('静态 HTML 含内联 SVG 图标', (html.match(/<svg/g) || []).length >= 10);
  check('预览 overlay 仍在', html.includes('previewOverlay'));
  check('长文件名跑马灯仍在', html.includes('fname-text') && html.includes('fnameScroll'));
  check('旧表格已移除（无 thead-wrap/table）', !html.includes('thead-wrap') && !html.includes('<table'));
}

// T12: /api/files still lists root files
console.log('T12 列表接口');
res = await worker.fetch(new Request(BASE + '/api/files', { headers: AUTH }), env);
const list = await j(res);
check('列表返回 b.png', Array.isArray(list) && list.some(r => r.filename === 'b.png'));

console.log(`\n结果: ${pass} 过, ${fail} 挂`);
process.exit(fail ? 1 : 0);
