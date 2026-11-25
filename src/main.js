import './polyfill.js';
import './textlayer.css';
import './style.css';
import * as pdfjsLib from 'pdfjs-dist';
import { store, uid, now } from './store/index.js';
import { PdfView, norm } from './reader/pdfview.js';
import { NoteEditor, esc } from './notes/editor.js';
import { getColors, setColorLabel, colorHex, colorLabel, PEN_COLORS } from './colors.js';

const app = document.getElementById('app');
const S = { sections: [], docs: [], noteTexts: new Map(), filter: 'all', query: '' };

// ---------------- helpers ----------------
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const $ = (sel, root = document) => root.querySelector(sel);
function toast(msg, ms = 2600) {
  const t = h(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
function modal(title, bodyHtml, actions) {
  return new Promise((resolve) => {
    const m = h(`<div class="modal-bg"><div class="modal"><h3>${esc(title)}</h3><div class="modal-body">${bodyHtml}</div><div class="modal-actions"></div></div></div>`);
    const box = $('.modal-actions', m);
    const close = (v) => { m.remove(); resolve(v); };
    for (const a of actions) {
      const b = h(`<button class="${a.primary ? 'btn primary' : a.danger ? 'btn danger' : 'btn'}">${esc(a.label)}</button>`);
      b.onclick = () => close(a.value?.(m) ?? a.label);
      box.appendChild(b);
    }
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(null); });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') box.querySelector('.primary')?.click();
    });
    document.body.appendChild(m);
    (m.querySelector('input,select') || box.querySelector('.primary'))?.focus();
  });
}
async function ask(title, value = '', placeholder = '') {
  return modal(title, `<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}">`, [
    { label: 'Huỷ', value: () => null },
    { label: 'OK', primary: true, value: (m) => $('input', m).value.trim() || null },
  ]);
}
async function confirmBox(title, msg) {
  return (await modal(title, `<p>${esc(msg)}</p>`, [
    { label: 'Huỷ', value: () => false },
    { label: 'Xoá', danger: true, value: () => true },
  ])) === true;
}
const fmtDate = (s) => { try { return new Date(s).toLocaleDateString('vi-VN'); } catch { return ''; } };

// ---------------- boot ----------------
async function boot() {
  await store.init();
  const user = await store.getUser();
  if (!user) return renderLogin();
  window.addEventListener('hashchange', route);
  await loadLibrary();
  route();
}

async function loadLibrary() {
  [S.sections, S.docs] = await Promise.all([store.sections.list(), store.docs.list()]);
  if (!S.sections.length && !localStorage.getItem('gd-seeded')) {
    const seed = [['📚', 'Sách chuyên ngành'], ['📝', 'Ôn thi'], ['📖', 'Truyện'], ['🧑‍🏫', 'Giáo án / học liệu']];
    for (const [i, [emoji, name]] of seed.entries()) await store.sections.upsert({ id: uid(), name, emoji, sort: i, created_at: now() });
    localStorage.setItem('gd-seeded', '1');
    S.sections = await store.sections.list();
  }
  try { S.noteTexts = new Map((await store.notes.listTexts()).map((n) => [n.doc_id, n.text || ''])); } catch {}
}

function route() {
  const m = /^#\/doc\/(.+)$/.exec(location.hash);
  if (m) openReader(m[1]);
  else renderLibrary();
}

// ---------------- login ----------------
function renderLogin() {
  app.innerHTML = '';
  const v = h(`<div class="login">
    <form class="login-card">
      <div class="logo big">📖 Góc Đọc</div>
      <p class="muted">Đọc PDF, highlight và ghi chú — đồng bộ laptop & điện thoại.</p>
      <input class="input" type="email" name="email" placeholder="Email" required autocomplete="email">
      <input class="input" type="password" name="pw" placeholder="Mật khẩu" required autocomplete="current-password">
      <button class="btn primary wide">Đăng nhập</button>
      <p class="err"></p>
    </form></div>`);
  $('form', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    $('.err', v).textContent = '';
    f.querySelector('button').disabled = true;
    try { await store.signIn(f.email.value.trim(), f.pw.value); boot(); }
    catch (err) { $('.err', v).textContent = 'Sai email hoặc mật khẩu (' + err.message + ')'; f.querySelector('button').disabled = false; }
  };
  app.appendChild(v);
}

// ---------------- library ----------------
let reader = null;

function renderLibrary() {
  closeReader();
  document.title = 'Góc Đọc';
  app.innerHTML = '';
  const v = h(`<div class="lib">
    <header class="topbar">
      <div class="logo">📖 Góc Đọc</div>
      <div class="search-box"><span>🔍</span><input class="lib-search" placeholder="Tìm tài liệu hoặc nội dung note…" value="${esc(S.query)}"></div>
      <button class="btn primary up-btn">＋ Thêm PDF</button>
      <button class="icon-btn acct" title="Tài khoản">👤</button>
      <input type="file" accept="application/pdf" multiple hidden class="up-input">
    </header>
    <div class="lib-body">
      <nav class="sidebar"></nav>
      <main class="lib-main">
        <div class="lib-head"><h2 class="sec-title"></h2><div class="sec-actions"></div></div>
        <div class="grid"></div>
        <div class="drop-hint">Thả file PDF vào đây</div>
      </main>
    </div></div>`);
  app.appendChild(v);

  const input = $('.up-input', v);
  $('.up-btn', v).onclick = () => input.click();
  input.onchange = () => { uploadFiles([...input.files]); input.value = ''; };
  $('.lib-search', v).oninput = (e) => { S.query = e.target.value; drawGrid(); };
  $('.acct', v).onclick = async () => {
    const u = await store.getUser();
    const r = await modal('Tài khoản', `<p>${store.mode === 'cloud' ? '☁️ Đồng bộ Supabase' : '💾 Đang lưu trên máy này (chưa cấu hình Supabase)'}</p><p class="muted">${esc(u?.email || '')}</p>`,
      store.mode === 'cloud' ? [{ label: 'Đóng' }, { label: 'Đăng xuất', danger: true }] : [{ label: 'Đóng' }]);
    if (r === 'Đăng xuất') { await store.signOut(); location.hash = ''; renderLogin(); }
  };

  const main = $('.lib-main', v);
  main.addEventListener('dragover', (e) => { e.preventDefault(); main.classList.add('dragging'); });
  main.addEventListener('dragleave', (e) => { if (!main.contains(e.relatedTarget)) main.classList.remove('dragging'); });
  main.addEventListener('drop', (e) => {
    e.preventDefault(); main.classList.remove('dragging');
    const files = [...e.dataTransfer.files].filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length) uploadFiles(files);
  });

  drawSidebar();
  drawGrid();
}

function drawSidebar() {
  const nav = $('.sidebar');
  if (!nav) return;
  const count = (id) => S.docs.filter((d) => (id === 'none' ? !d.section_id : d.section_id === id)).length;
  nav.innerHTML = '';
  const item = (id, icon, name, n, editable) => {
    const b = h(`<div class="nav-item ${S.filter === id ? 'on' : ''}" data-id="${id}">
      <span class="ic">${esc(icon)}</span><span class="nm">${esc(name)}</span><span class="ct">${n}</span>
      ${editable ? '<button class="more" title="Sửa">⋯</button>' : ''}</div>`);
    b.onclick = (e) => {
      if (e.target.closest('.more')) return sectionMenu(S.sections.find((s) => s.id === id));
      S.filter = id; drawSidebar(); drawGrid();
    };
    // kéo tài liệu thả vào section
    b.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/doc')) { e.preventDefault(); b.classList.add('drop'); } });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', async (e) => {
      const docId = e.dataTransfer.getData('text/doc');
      b.classList.remove('drop');
      if (!docId) return;
      e.preventDefault(); e.stopPropagation();
      const d = S.docs.find((x) => x.id === docId);
      if (!d || id === 'all' || id === 'recent') return;
      d.section_id = id === 'none' ? null : id;
      await store.docs.upsert(d);
      drawSidebar(); drawGrid();
      toast(`Đã chuyển vào “${name}”`);
    });
    nav.appendChild(b);
  };
  item('all', '🗂', 'Tất cả', S.docs.length);
  item('recent', '🕘', 'Đọc gần đây', Math.min(8, S.docs.length));
  nav.appendChild(h('<div class="nav-label">Section</div>'));
  for (const s of S.sections) item(s.id, s.emoji || '📁', s.name, count(s.id), true);
  if (count('none')) item('none', '📄', 'Chưa phân loại', count('none'));
  const add = h('<button class="nav-add">＋ Thêm section</button>');
  add.onclick = async () => {
    const name = await ask('Tên section mới', '', 'VD: Sách tâm lý, Tài liệu IELTS…');
    if (!name) return;
    const s = { id: uid(), name, emoji: '📁', sort: S.sections.length, created_at: now() };
    await store.sections.upsert(s);
    S.sections.push(s);
    S.filter = s.id;
    drawSidebar(); drawGrid();
  };
  nav.appendChild(add);
}

async function sectionMenu(s) {
  S.editing = s;
  const r = await modal('Sửa section', `
    <label class="lbl">Biểu tượng</label><input class="input emoji" value="${esc(s.emoji || '📁')}" maxlength="4">
    <label class="lbl">Tên</label><input class="input name" value="${esc(s.name)}">
    <label class="lbl">Thứ tự</label>
    <div class="row"><button class="btn sm up">↑ Lên</button><button class="btn sm down">↓ Xuống</button></div>`,
  [
    { label: 'Xoá section', danger: true, value: () => 'delete' },
    { label: 'Huỷ', value: () => null },
    { label: 'Lưu', primary: true, value: (m) => ({ emoji: $('.emoji', m).value.trim() || '📁', name: $('.name', m).value.trim() || s.name }) },
  ]);
  if (r === 'delete') {
    if (!(await confirmBox('Xoá section?', `Tài liệu trong “${s.name}” sẽ chuyển sang “Chưa phân loại”, không bị xoá.`))) return;
    await store.sections.remove(s.id);
    for (const d of S.docs) if (d.section_id === s.id) { d.section_id = null; await store.docs.upsert(d); }
    S.sections = S.sections.filter((x) => x.id !== s.id);
    if (S.filter === s.id) S.filter = 'all';
  } else if (r) {
    Object.assign(s, r);
    await store.sections.upsert(s);
  }
  drawSidebar(); drawGrid();
}

// Nút ↑ ↓ trong modal sửa section
document.addEventListener('click', async (e) => {
  const up = e.target.closest('.modal .up'), down = e.target.closest('.modal .down');
  if (!up && !down) return;
  const i = S.sections.indexOf(S.editing);
  const j = i + (up ? -1 : 1);
  if (i < 0 || j < 0 || j >= S.sections.length) return;
  [S.sections[i], S.sections[j]] = [S.sections[j], S.sections[i]];
  S.sections.forEach((s, k) => (s.sort = k));
  await Promise.all([store.sections.upsert(S.sections[i]), store.sections.upsert(S.sections[j])]);
  drawSidebar();
  toast('Đã đổi thứ tự', 1200);
});

function filteredDocs() {
  let list = S.docs;
  if (S.filter === 'recent') list = [...list].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 8);
  else if (S.filter === 'none') list = list.filter((d) => !d.section_id);
  else if (S.filter !== 'all') list = list.filter((d) => d.section_id === S.filter);
  const q = norm(S.query.trim()).out;
  if (q) list = S.docs.filter((d) => norm(d.title).out.includes(q) || norm(S.noteTexts.get(d.id) || '').out.includes(q));
  return list;
}

function drawGrid() {
  const grid = $('.grid');
  if (!grid) return;
  const sec = S.sections.find((s) => s.id === S.filter);
  const titles = { all: 'Tất cả tài liệu', recent: 'Đọc gần đây', none: 'Chưa phân loại' };
  $('.sec-title').textContent = S.query.trim() ? `Kết quả cho “${S.query.trim()}”` : sec ? `${sec.emoji || '📁'} ${sec.name}` : titles[S.filter];
  const list = filteredDocs();
  grid.innerHTML = '';
  if (!list.length) {
    grid.appendChild(h(`<div class="empty">${S.query ? 'Không tìm thấy tài liệu nào.' : 'Chưa có tài liệu. Bấm <b>＋ Thêm PDF</b> hoặc kéo thả file PDF vào đây.'}</div>`));
    return;
  }
  const q = norm(S.query.trim()).out;
  for (const d of list) {
    const s = S.sections.find((x) => x.id === d.section_id);
    const pct = d.page_count ? Math.round(((d.last_page || 1) / d.page_count) * 100) : 0;
    let snippet = '';
    if (q) {
      const t = S.noteTexts.get(d.id) || '';
      const { out, map } = norm(t);
      const i = out.indexOf(q);
      if (i >= 0) { const a = map[i]; snippet = '…' + t.slice(Math.max(0, a - 30), a + 60) + '…'; }
    }
    const c = h(`<div class="card" draggable="true">
      <div class="cover" style="--hue:${hue(d.title)}"><span>${esc(s?.emoji || '📄')}</span><div class="cover-title">${esc(d.title)}</div></div>
      <div class="card-body">
        <div class="card-title" title="${esc(d.title)}">${esc(d.title)}</div>
        <div class="card-meta">${s ? esc(s.name) + ' · ' : ''}Trang ${d.last_page || 1}/${d.page_count || '?'}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        ${snippet ? `<div class="snip">${esc(snippet)}</div>` : ''}
      </div>
      <button class="more" title="Tuỳ chọn">⋯</button></div>`);
    c.onclick = (e) => { if (e.target.closest('.more')) return docMenu(d); location.hash = '#/doc/' + d.id; };
    c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/doc', d.id));
    grid.appendChild(c);
  }
}

const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

async function docMenu(d) {
  const opts = ['<option value="">— Chưa phân loại —</option>', ...S.sections.map((s) => `<option value="${s.id}" ${s.id === d.section_id ? 'selected' : ''}>${esc(s.emoji || '')} ${esc(s.name)}</option>`)].join('');
  const r = await modal('Tài liệu', `
    <label class="lbl">Tên</label><input class="input name" value="${esc(d.title)}">
    <label class="lbl">Section</label><select class="input sec">${opts}</select>
    <p class="muted small">Thêm ngày ${fmtDate(d.created_at)} · ${(d.size / 1048576).toFixed(1)} MB</p>`,
  [
    { label: 'Xoá', danger: true, value: () => 'delete' },
    { label: 'Huỷ', value: () => null },
    { label: 'Lưu', primary: true, value: (m) => ({ title: $('.name', m).value.trim() || d.title, section_id: $('.sec', m).value || null }) },
  ]);
  if (r === 'delete') {
    if (!(await confirmBox('Xoá tài liệu?', `“${d.title}” cùng toàn bộ highlight và note sẽ bị xoá vĩnh viễn.`))) return;
    await store.docs.remove(d);
    S.docs = S.docs.filter((x) => x.id !== d.id);
  } else if (r) {
    Object.assign(d, r);
    await store.docs.upsert(d);
  }
  drawSidebar(); drawGrid();
}

async function uploadFiles(files) {
  const section_id = S.sections.some((s) => s.id === S.filter) ? S.filter : null;
  for (const f of files) {
    if (store.mode === 'cloud' && f.size > 50 * 1048576) { toast(`“${f.name}” lớn hơn 50MB, Supabase free không nhận.`, 4000); continue; }
    toast(`Đang tải lên “${f.name}”…`, 1500);
    try {
      const buf = await f.arrayBuffer();
      let page_count = null;
      try { const p = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise; page_count = p.numPages; p.destroy(); } catch {}
      const up = await store.docs.uploadPdf(f);
      const d = { id: uid(), title: f.name.replace(/\.pdf$/i, ''), section_id, page_count, last_page: 1, ...up, created_at: now(), updated_at: now() };
      await store.docs.upsert(d);
      S.docs.unshift(d);
      drawSidebar(); drawGrid();
      toast(`Đã thêm “${d.title}”`);
    } catch (e) {
      console.error(e);
      toast(`Lỗi khi tải “${f.name}”: ${e.message}`, 5000);
    }
  }
}

// ---------------- reader ----------------
function closeReader() {
  if (!reader) return;
  reader.note.save();
  reader.saveProgress(true);
  reader.view.destroy();
  reader.note.destroy();
  document.removeEventListener('keydown', reader.onKey);
  document.removeEventListener('click', reader.layClick);
  reader = null;
}

async function openReader(id) {
  closeReader();
  if (!S.docs.length) await loadLibrary();
  const d = S.docs.find((x) => x.id === id);
  if (!d) { location.hash = ''; return; }
  document.title = d.title + ' · Góc Đọc';
  app.innerHTML = '';
  const layout = localStorage.getItem('gd-layout') || 'split';
  const v = h(`<div class="reader" data-layout="${layout}">
    <header class="rbar">
      <button class="icon-btn back" title="Về thư viện">←</button>
      <div class="rtitle" title="${esc(d.title)}">${esc(d.title)}</div>
      <div class="pageinfo"><input class="pg-in" value="1"> / <span class="pg-total">…</span></div>
      <div class="tools">
        <button data-tool="select" title="Chọn chữ (V)">𝙸</button>
        <button data-tool="highlight" title="Highlight (H)">🖍</button>
        <button data-tool="pen" title="Bút vẽ (P)">✏️</button>
        <button data-tool="eraser" title="Tẩy (E)">🧽</button>
        <button data-tool="snip" title="Chụp vùng → note (S)">✂️</button>
      </div>
      <div class="palette"></div>
      <div class="rbar-right">
        <button class="icon-btn zo" title="Thu nhỏ">−</button><span class="zv">100%</span><button class="icon-btn zi" title="Phóng to">＋</button>
        <button class="icon-btn s-btn" title="Tìm trong PDF (Ctrl+F)">🔍</button>
        <button class="icon-btn l-btn" title="Danh sách highlight">🗒</button>
        <button class="icon-btn lay-btn" title="Bố cục">◫</button>
        <button class="icon-btn x-btn" title="Xuất file">⤓</button>
      </div>
    </header>
    <div class="split">
      <section class="pane pane-pdf"><div class="pdf-host"></div><aside class="drawer hidden"></aside><div class="loading">Đang mở PDF…</div></section>
      <div class="divider" title="Kéo để chỉnh"><i></i></div>
      <section class="pane pane-note"></section>
    </div></div>`);
  app.appendChild(v);

  const ratio = parseFloat(localStorage.getItem('gd-ratio') || '0.55');
  const setRatio = (r) => v.style.setProperty('--ratio', Math.min(0.85, Math.max(0.15, r)));
  setRatio(ratio);

  const anns = await store.anns.list(d.id).catch(() => []);
  const R = (reader = { doc: d, anns });

  // ---- note ----
  R.note = new NoteEditor($('.pane-note', v), {
    onJump: (page, annId) => {
      if (v.dataset.layout === 'note') setLayout('split');
      R.view.goTo(page, annId);
    },
  });
  R.note.load(d.id);

  const sendToNote = (a) => {
    if (v.dataset.layout === 'pdf') setLayout('split');
    R.note.insertQuote(a, colorHex(a.color), colorLabel(a.color));
  };

  // ---- pdf ----
  R.view = new PdfView($('.pdf-host', v), {
    getColors,
    onCreate: (a) => { R.anns.push(a); persist(a); refreshDrawer(); },
    onUpdate: (a) => { persist(a); refreshDrawer(); },
    onDelete: (a) => { R.anns = R.anns.filter((x) => x.id !== a.id); store.anns.remove(a.id).catch(err); refreshDrawer(); },
    onSendToNote: sendToNote,
    onSnip: (blob, page) => {
      if (v.dataset.layout === 'pdf') setLayout('split');
      R.note.insertImageBlob(blob, page, false);
      toast('Đã dán vùng chụp vào note', 1500);
    },
    onPageChange: (p) => { $('.pg-in', v).value = p; R.page = p; R.saveProgress(); },
    onZoom: (z) => { $('.zv', v).textContent = Math.round(z * 100) + '%'; },
    onColorPicked: (c) => { R.view.setColor(c); drawPalette(); },
  });
  const err = (e) => { console.error(e); toast('⚠ Lỗi lưu: ' + e.message, 4000); };
  const persist = (a) => store.anns.upsert({ ...a, doc_id: d.id }).catch(err);

  R.saveProgress = (now_ = false) => {
    clearTimeout(R._pt);
    const go = () => {
      if (!R.page || R.page === d.last_page) return;
      d.last_page = R.page; d.updated_at = now();
      store.docs.upsert(d).catch(() => {});
    };
    now_ ? go() : (R._pt = setTimeout(go, 1500));
  };

  try {
    const data = await store.docs.getPdf(d);
    const n = await R.view.load(data, d.last_page || 1);
    R.view.setAnns([...R.anns]);
    $('.pg-total', v).textContent = n;
    if (d.page_count !== n) { d.page_count = n; store.docs.upsert(d).catch(() => {}); }
  } catch (e) {
    console.error(e);
    $('.loading', v).textContent = '⚠ Không mở được PDF: ' + e.message;
    return;
  }
  $('.loading', v).remove();

  // ---- toolbar ----
  const setTool = (t) => {
    R.view.setTool(t);
    v.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    drawPalette();
  };
  const drawPalette = () => {
    const pal = $('.palette', v);
    pal.innerHTML = '';
    if (R.view.tool === 'pen') {
      for (const c of PEN_COLORS) {
        const b = h(`<button class="dot ${R.view.penColor === c ? 'on' : ''}" style="background:${c}"></button>`);
        b.onclick = () => { R.view.setPenColor(c); drawPalette(); };
        pal.appendChild(b);
      }
      const w = h(`<select class="pen-w" title="Độ dày"><option value="1.5">Mảnh</option><option value="2.5">Vừa</option><option value="5">Dày</option><option value="12">Dạ quang</option></select>`);
      w.value = String(R.view.penWidth);
      w.onchange = () => (R.view.penWidth = +w.value);
      pal.appendChild(w);
    } else if (R.view.tool === 'select' || R.view.tool === 'highlight') {
      for (const c of getColors()) {
        const b = h(`<button class="dot ${R.view.color === c.id ? 'on' : ''}" style="background:${c.hex}" title="${esc(c.label)}"></button>`);
        b.onclick = () => { R.view.setColor(c.id); drawPalette(); };
        pal.appendChild(b);
      }
      const lab = h(`<span class="pal-label">${esc(colorLabel(R.view.color))}</span>`);
      pal.appendChild(lab);
    }
  };
  v.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  setTool('select');

  $('.back', v).onclick = () => { location.hash = ''; };
  $('.zi', v).onclick = () => R.view.setZoom(R.view.zoom * 1.15);
  $('.zo', v).onclick = () => R.view.setZoom(R.view.zoom / 1.15);
  $('.pg-in', v).onchange = (e) => R.view.goTo(parseInt(e.target.value) || 1);
  $('.pg-in', v).onfocus = (e) => e.target.select();

  // ---- layout ----
  const setLayout = (l) => {
    v.dataset.layout = l;
    localStorage.setItem('gd-layout', l);
  };
  $('.lay-btn', v).onclick = async () => {
    const r = await modal('Bố cục', `<div class="lay-opts">
      <button class="lay" data-l="split">◫<span>Chia đôi</span></button>
      <button class="lay" data-l="pdf">▭<span>Chỉ PDF</span></button>
      <button class="lay" data-l="note">✎<span>Chỉ note</span></button></div>`, [{ label: 'Đóng', value: () => null }]);
    void r;
  };
  document.addEventListener('click', R.layClick = (e) => {
    const b = e.target.closest('.lay[data-l]');
    if (!b || !reader) return;
    setLayout(b.dataset.l);
    b.closest('.modal-bg')?.remove();
  });

  // ---- divider kéo thả ----
  const div = $('.divider', v), split = $('.split', v);
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    v.classList.add('resizing');
    const vertical = getComputedStyle(split).flexDirection === 'column';
    const move = (ev) => {
      const b = split.getBoundingClientRect();
      const r = vertical ? (ev.clientY - b.top) / b.height : (ev.clientX - b.left) / b.width;
      setRatio(r);
    };
    const up = () => {
      v.classList.remove('resizing');
      localStorage.setItem('gd-ratio', getComputedStyle(v).getPropertyValue('--ratio'));
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
  });

  // ---- drawer: highlight list & search ----
  const drawer = $('.drawer', v);
  R.drawerMode = null;
  R.colorFilter = null;
  const openDrawer = (mode) => {
    if (R.drawerMode === mode) { R.drawerMode = null; drawer.classList.add('hidden'); return; }
    R.drawerMode = mode;
    drawer.classList.remove('hidden');
    refreshDrawer();
    if (mode === 'search') $('.ds-in', drawer)?.focus();
  };
  const refreshDrawer = () => {
    if (R.drawerMode === 'list') drawList();
    else if (R.drawerMode === 'search' && !$('.ds-in', drawer)) drawSearch();
  };
  const drawList = () => {
    drawer.innerHTML = '';
    drawer.appendChild(h(`<div class="dr-head"><b>Highlight & nét vẽ</b><button class="icon-btn dr-x">✕</button></div>`));
    const chips = h('<div class="chips"></div>');
    for (const c of getColors()) {
      const n = R.anns.filter((a) => a.type === 'highlight' && a.color === c.id).length;
      const on = !R.colorFilter || R.colorFilter.includes(c.id);
      const b = h(`<button class="chip ${on ? 'on' : ''}" title="Bấm để lọc · nhấn đúp để đổi tên nhãn"><i style="background:${c.hex}"></i>${esc(c.label)} <small>${n}</small></button>`);
      b.onclick = () => {
        const all = getColors().map((x) => x.id);
        let f = R.colorFilter ? [...R.colorFilter] : [...all];
        if (R.colorFilter == null) f = [c.id];
        else if (f.includes(c.id)) f = f.filter((x) => x !== c.id);
        else f.push(c.id);
        R.colorFilter = f.length === 0 || f.length === all.length ? null : f;
        R.view.setFilter(R.colorFilter);
        drawList();
      };
      b.ondblclick = async () => {
        const name = await ask('Đổi tên nhãn màu', c.label);
        if (name) { setColorLabel(c.id, name); drawList(); drawPalette(); }
      };
      chips.appendChild(b);
    }
    drawer.appendChild(chips);
    const list = R.anns
      .filter((a) => a.type === 'ink' || !R.colorFilter || R.colorFilter.includes(a.color))
      .sort((a, b) => a.page - b.page || (a.rects?.[0]?.[1] ?? 0) - (b.rects?.[0]?.[1] ?? 0));
    const box = h('<div class="dr-list"></div>');
    if (!list.length) box.appendChild(h('<p class="muted pad">Chưa có highlight nào. Bôi đen chữ trên PDF để bắt đầu.</p>'));
    for (const a of list) {
      const it = h(`<div class="dr-item">
        <i class="bar-c" style="background:${a.type === 'ink' ? a.color : colorHex(a.color)}"></i>
        <div class="dr-txt">${a.type === 'ink' ? '<span class="muted">✏️ Nét vẽ tay</span>' : esc(a.text || '(tiếp nối trang trước)')}</div>
        <div class="dr-meta"><span>tr. ${a.page}</span>${a.type === 'highlight' ? '<button class="mini send" title="Gửi sang note">📝</button>' : ''}<button class="mini del" title="Xoá">🗑</button></div></div>`);
      it.onclick = (e) => {
        if (e.target.closest('.send')) return sendToNote(a);
        if (e.target.closest('.del')) { R.view.removeAnn(a.id); R.anns = R.anns.filter((x) => x.id !== a.id); store.anns.remove(a.id).catch(err); return drawList(); }
        R.view.goTo(a.page, a.id);
        if (matchMedia('(max-width: 760px)').matches) openDrawer('list');
      };
      box.appendChild(it);
    }
    drawer.appendChild(box);
    const hl = list.filter((a) => a.type === 'highlight' && a.text);
    if (hl.length) {
      const all = h(`<button class="btn wide">📝 Gửi ${hl.length} highlight đang lọc sang note</button>`);
      all.onclick = () => hl.forEach(sendToNote);
      drawer.appendChild(all);
    }
    $('.dr-x', drawer).onclick = () => openDrawer('list');
  };
  const drawSearch = () => {
    drawer.innerHTML = '';
    drawer.appendChild(h(`<div class="dr-head"><b>Tìm trong PDF</b><button class="icon-btn dr-x">✕</button></div>`));
    const inp = h(`<input class="input ds-in" placeholder="Gõ từ cần tìm… (không cần dấu)">`);
    const res = h('<div class="dr-list"></div>');
    drawer.append(inp, res);
    let t;
    inp.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = inp.value;
        res.innerHTML = q.trim() ? '<p class="muted pad">Đang tìm…</p>' : '';
        const out = await R.view.search(q, (i, n) => { if (inp.value === q) res.innerHTML = `<p class="muted pad">Đang tìm… ${i}/${n}</p>`; });
        if (inp.value !== q) return;
        res.innerHTML = q.trim() ? `<p class="muted pad">${out.length} kết quả</p>` : '';
        for (const r of out) {
          const it = h(`<div class="dr-item sr"><div class="dr-txt">…${esc(r.before)}<mark>${esc(r.match)}</mark>${esc(r.after)}…</div><div class="dr-meta"><span>tr. ${r.page}</span></div></div>`);
          it.onclick = () => R.view.goTo(r.page);
          res.appendChild(it);
        }
      }, 300);
    };
    $('.dr-x', drawer).onclick = () => { R.view.search(''); openDrawer('search'); };
  };
  $('.l-btn', v).onclick = () => openDrawer('list');
  $('.s-btn', v).onclick = () => openDrawer('search');

  // ---- export ----
  $('.x-btn', v).onclick = async () => {
    const r = await modal('Xuất file', `<p class="muted">Chọn loại file muốn tải về:</p>`, [
      { label: 'Huỷ', value: () => null },
      { label: '📄 PDF có highlight', value: () => 'pdf' },
      { label: '📝 Note ra Word', primary: true, value: () => 'docx' },
    ]);
    if (!r) return;
    toast('Đang tạo file…', 1500);
    try {
      if (r === 'docx') {
        await R.note.save();
        const { exportDocx } = await import('./export/docx.js');
        const blob = await exportDocx(d.title, R.note.page, R.anns);
        (await import('./export/pdf.js')).download(blob, `${d.title} - ghi chú.docx`);
      } else {
        const { exportPdf, download } = await import('./export/pdf.js');
        const bytes = await store.docs.getPdf(d);
        download(await exportPdf(bytes, R.anns), `${d.title} (highlight).pdf`);
      }
    } catch (e) { console.error(e); toast('⚠ Lỗi xuất file: ' + e.message, 5000); }
  };

  // ---- phím tắt ----
  R.onKey = (e) => {
    const typing = e.target.closest?.('[contenteditable="true"], input, textarea, select');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.target.closest?.('.pane-note')) { e.preventDefault(); if (R.drawerMode !== 'search') openDrawer('search'); else $('.ds-in', drawer)?.focus(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const map = { v: 'select', h: 'highlight', p: 'pen', e: 'eraser', s: 'snip' };
    if (map[e.key]) setTool(map[e.key]);
    if (e.key === 'Escape') { setTool('select'); R.view.hidePopup(); }
  };
  document.addEventListener('keydown', R.onKey);
}

window.addEventListener('beforeunload', () => { reader?.note.save(); reader?.saveProgress(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { reader?.note.save(); reader?.saveProgress(true); } });

boot().catch((e) => { console.error(e); app.innerHTML = `<p class="pad">⚠ Lỗi khởi động: ${esc(e.message)}</p>`; });
