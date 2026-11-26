// Trình xem PDF: hiển thị trang, lớp chữ để bôi chọn, highlight, bút vẽ, tẩy, chụp vùng, tìm kiếm.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { colorHex } from '../colors.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_RENDERED = 10;

export const norm = (s) => {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const n = s[i].normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    for (let k = 0; k < n.length; k++) { out += n[k]; map.push(i); }
  }
  return { out, map };
};

export class PdfView {
  constructor(root, cb = {}) {
    this.root = root;
    this.cb = cb;
    this.tool = 'select';
    this.color = 'yellow';
    this.penColor = '#1f1f1f';
    this.penWidth = 2.5;
    this.zoom = 1;
    this.anns = [];
    this.pages = []; // {num, base:{w,h}, el, canvas, text, hl, ink, draw, rendered, task}
    this.rendered = [];
    this.textCache = new Map();
    this.searchQuery = '';
    this.currentPage = 1;

    root.innerHTML = '';
    this.scroller = el('div', 'pdf-scroll');
    this.wrap = el('div', 'pdf-pages');
    this.scroller.appendChild(this.wrap);
    root.appendChild(this.scroller);
    this.popup = el('div', 'pdf-popup hidden');
    root.appendChild(this.popup);

    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderPage(this.pages[+e.target.dataset.page - 1]);
    }, { root: this.scroller, rootMargin: '600px 0px' });

    this.scroller.addEventListener('scroll', () => { this.hidePopup(); this.trackPage(); }, { passive: true });
    this.ro = new ResizeObserver(() => {
      clearTimeout(this._rt);
      this._rt = setTimeout(() => this.relayout(), 150);
    });
    this.ro.observe(this.scroller);

    this.wrap.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.wrap.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('selectionchange', this._sel = () => {
      clearTimeout(this._st);
      this._st = setTimeout(() => this.onSelectionSettled(), 350);
    });
    // Ctrl + lăn chuột để phóng to
    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });
  }

  destroy() {
    this.dead = true;
    clearTimeout(this._rt);
    clearTimeout(this._st);
    this.io.disconnect();
    this.ro.disconnect();
    document.removeEventListener('selectionchange', this._sel);
    this.pdf?.destroy();
    if (window.CSS?.highlights) CSS.highlights.delete('gd-search');
  }

  async load(data, startPage = 1, kind = 'pdf') {
    this.kind = kind;
    if (kind !== 'pdf') return this.loadHtml(data, startPage, kind);
    this.pdf = await pdfjsLib.getDocument({
      data,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
    }).promise;
    const n = this.pdf.numPages;
    const first = await this.pdf.getPage(1);
    const v1 = first.getViewport({ scale: 1 });
    for (let i = 1; i <= n; i++) {
      const p = { num: i, base: { w: v1.width, h: v1.height }, rendered: false };
      p.el = el('div', 'page');
      p.el.dataset.page = i;
      p.canvas = el('canvas', 'page-canvas');
      p.hl = el('div', 'hl-layer');
      p.text = el('div', 'textLayer');
      p.ink = document.createElementNS(SVGNS, 'svg');
      p.ink.classList.add('ink-layer');
      p.draw = el('div', 'draw-layer');
      const num = el('div', 'page-num');
      num.textContent = i;
      p.el.append(p.canvas, p.hl, p.text, p.ink, p.draw, num);
      this.wrap.appendChild(p.el);
      this.pages.push(p);
      this.bindDraw(p);
    }
    // Lấy kích thước thật của từng trang (chạy nền)
    (async () => {
      for (let i = 2; i <= n; i++) {
        if (this.dead) return;
        try {
          const pg = await this.pdf.getPage(i);
          const v = pg.getViewport({ scale: 1 });
          const p = this.pages[i - 1];
          if (Math.abs(v.width - p.base.w) > 0.5 || Math.abs(v.height - p.base.h) > 0.5) {
            p.base = { w: v.width, h: v.height };
            this.sizePage(p);
          }
        } catch {}
      }
    })();
    this.relayout();
    for (const p of this.pages) this.io.observe(p.el);
    this.applyTool();
    requestAnimationFrame(() => this.goTo(startPage, null, false));
    return n;
  }

  get isHtml() { return !!this.kind && this.kind !== 'pdf'; }
  get numPages() { return this.isHtml ? this.pages.length : this.pdf?.numPages || 0; }

  // Word / PowerPoint: dựng thành HTML, mỗi trang (section) hoặc slide là một "page"
  async loadHtml(data, startPage, kind) {
    const stage = el('div', 'html-stage');
    document.body.appendChild(stage);
    let nodes = [];
    try {
      if (kind === 'docx') {
        const { renderAsync } = await import('docx-preview');
        this.styleBox = el('div', 'docx-styles');
        this.root.appendChild(this.styleBox);
        await renderAsync(data, stage, this.styleBox, {
          className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
          ignoreWidth: false, ignoreHeight: false, experimental: true, useBase64URL: true, renderComments: false,
        });
        nodes = [...stage.querySelectorAll('.docx-wrapper > section')];
      } else if (kind === 'pptx') {
        const { init } = await import('pptx-preview');
        const box = el('div');
        stage.appendChild(box);
        const pv = init(box, { width: 960, height: 540, mode: 'list' });
        await pv.preview(data);
        nodes = [...box.querySelectorAll('.pptx-preview-slide-wrapper')];
      } else throw new Error('Định dạng này chưa hỗ trợ');
      if (!nodes.length) throw new Error('File trống hoặc không đọc được');
      const sizes = nodes.map((n) => ({ w: n.offsetWidth || 816, h: n.offsetHeight || 1056 }));
      nodes.forEach((node, idx) => {
        const i = idx + 1;
        const p = { num: i, base: sizes[idx], rendered: true, node };
        node.style.margin = '0';
        p.el = el('div', 'page html-page');
        p.el.dataset.page = i;
        p.box = el('div', 'html-scale' + (kind === 'docx' ? ' docx-wrapper' : ''));
        p.box.style.width = p.base.w + 'px';
        p.box.appendChild(node);
        p.hl = el('div', 'hl-layer');
        p.ink = document.createElementNS(SVGNS, 'svg');
        p.ink.classList.add('ink-layer');
        p.draw = el('div', 'draw-layer');
        const num = el('div', 'page-num');
        num.textContent = i;
        p.el.append(p.box, p.hl, p.ink, p.draw, num);
        this.wrap.appendChild(p.el);
        this.pages.push(p);
        this.bindDraw(p);
      });
    } finally {
      stage.remove();
    }
    this.relayout();
    this.applyTool();
    requestAnimationFrame(() => this.goTo(startPage, null, false));
    return this.pages.length;
  }

  scaleFor(p) {
    const avail = Math.max(200, this.scroller.clientWidth - 24);
    return (avail / p.base.w) * this.zoom;
  }

  sizePage(p) {
    const s = this.scaleFor(p);
    p.scale = s;
    p.W = Math.floor(p.base.w * s);
    p.H = Math.floor(p.base.h * s);
    p.el.style.width = p.W + 'px';
    p.el.style.height = p.H + 'px';
    p.el.style.setProperty('--scale-factor', s);
    if (this.isHtml) {
      p.box.style.transform = `scale(${s})`;
      this.drawHighlights(p); this.drawInk(p);
      return;
    }
    if (p.rendered) { this.unrender(p); this.renderPage(p); }
    else { this.drawHighlights(p); this.drawInk(p); }
  }

  relayout() {
    if (this.dead || !this.pages.length) return;
    const keep = this.currentPage;
    for (const p of this.pages) this.sizePage(p);
    this.goTo(keep, null, false);
  }

  setZoom(z) {
    this.zoom = Math.min(4, Math.max(0.4, z));
    this.relayout();
    this.cb.onZoom?.(this.zoom);
  }

  async renderPage(p) {
    if (this.dead || this.isHtml || !p || p.rendered || p.rendering) return;
    p.rendering = true;
    try {
      const page = await this.pdf.getPage(p.num);
      const viewport = page.getViewport({ scale: p.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      p.canvas.width = Math.floor(viewport.width * dpr);
      p.canvas.height = Math.floor(viewport.height * dpr);
      p.canvas.style.width = p.W + 'px';
      p.canvas.style.height = p.H + 'px';
      const ctx = p.canvas.getContext('2d');
      p.task = page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      await p.task.promise;
      p.text.innerHTML = '';
      const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: p.text, viewport });
      await tl.render();
      p.rendered = true;
      this.rendered.push(p);
      this.drawHighlights(p);
      this.drawInk(p);
      this.markSearch(p);
      this.evict();
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn(e);
    } finally {
      p.rendering = false;
    }
  }

  unrender(p) {
    p.task?.cancel?.();
    p.rendered = false;
    p.canvas.width = p.canvas.height = 0;
    p.text.innerHTML = '';
    this.rendered = this.rendered.filter((x) => x !== p);
  }

  evict() {
    if (this.rendered.length <= MAX_RENDERED) return;
    const c = this.currentPage;
    const sorted = [...this.rendered].sort((a, b) => Math.abs(b.num - c) - Math.abs(a.num - c));
    while (this.rendered.length > MAX_RENDERED) {
      const p = sorted.shift();
      if (Math.abs(p.num - c) < 3) break;
      this.unrender(p);
      this.io.unobserve(p.el); this.io.observe(p.el);
    }
  }

  trackPage() {
    const top = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
    let cur = 1;
    for (const p of this.pages) { if (p.el.offsetTop <= top) cur = p.num; else break; }
    if (cur !== this.currentPage) {
      this.currentPage = cur;
      this.cb.onPageChange?.(cur);
    }
  }

  goTo(num, annId = null, smooth = true) {
    const p = this.pages[Math.min(Math.max(1, num), this.pages.length) - 1];
    if (!p) return;
    let y = p.el.offsetTop - 12;
    const a = annId && this.anns.find((x) => x.id === annId);
    if (a) {
      const r = a.rects?.[0] || (a.path?.pts?.[0] ? [a.path.pts[0][0], a.path.pts[0][1]] : null);
      if (r) y = p.el.offsetTop + r[1] * p.H - this.scroller.clientHeight * 0.3;
    }
    this.scroller.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
    this.currentPage = p.num;
    this.cb.onPageChange?.(p.num);
    if (a) setTimeout(() => this.flash(a.id), smooth ? 450 : 50);
  }

  flash(id) {
    this.wrap.querySelectorAll(`[data-ann="${id}"]`).forEach((n) => {
      n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
    });
  }

  // ---------- Annotations ----------
  setAnns(list) {
    this.anns = list;
    for (const p of this.pages) { this.drawHighlights(p); this.drawInk(p); }
  }
  addAnn(a) { this.anns.push(a); this.redrawPage(a.page); }
  updateAnn(a) { const i = this.anns.findIndex((x) => x.id === a.id); if (i >= 0) this.anns[i] = a; this.redrawPage(a.page); }
  removeAnn(id) {
    const a = this.anns.find((x) => x.id === id);
    this.anns = this.anns.filter((x) => x.id !== id);
    if (a) this.redrawPage(a.page);
  }
  redrawPage(num) { const p = this.pages[num - 1]; if (p) { this.drawHighlights(p); this.drawInk(p); } }

  setFilter(colors) { this.filter = colors; for (const p of this.pages) this.drawHighlights(p); }

  drawHighlights(p) {
    p.hl.innerHTML = '';
    for (const a of this.anns) {
      if (a.page !== p.num || a.type !== 'highlight') continue;
      if (this.filter && !this.filter.includes(a.color)) continue;
      for (const r of a.rects || []) {
        const d = el('div', 'hl');
        d.dataset.ann = a.id;
        d.style.left = r[0] * 100 + '%';
        d.style.top = r[1] * 100 + '%';
        d.style.width = r[2] * 100 + '%';
        d.style.height = r[3] * 100 + '%';
        d.style.background = colorHex(a.color);
        p.hl.appendChild(d);
      }
    }
  }

  drawInk(p) {
    const svg = p.ink;
    svg.innerHTML = '';
    if (!p.W) return;
    svg.setAttribute('width', p.W);
    svg.setAttribute('height', p.H);
    svg.setAttribute('viewBox', `0 0 ${p.W} ${p.H}`);
    for (const a of this.anns) {
      if (a.page !== p.num || a.type !== 'ink') continue;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', pathD(a.path.pts, p.W, p.H));
      path.setAttribute('stroke', a.color);
      path.setAttribute('stroke-width', Math.max(0.8, a.path.w * p.W));
      path.dataset.ann = a.id;
      svg.appendChild(path);
    }
  }

  // ---------- Tools ----------
  setTool(t) { this.tool = t; this.applyTool(); this.hidePopup(); }
  setColor(c) { this.color = c; }
  setPenColor(c) { this.penColor = c; }

  applyTool() {
    this.root.dataset.tool = this.tool;
  }

  onMouseUp() {
    if (this.tool !== 'highlight') return;
    setTimeout(() => {
      const made = this.highlightSelection(this.color);
      if (made) window.getSelection()?.removeAllRanges();
    }, 10);
  }

  onSelectionSettled() {
    if (this.tool !== 'select') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.wrap.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width) return;
    this.showSelectionPopup(rect);
  }

  selectionToAnns(color) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.wrap.contains(sel.anchorNode)) return [];
    const range = sel.getRangeAt(0);
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const rects = [...range.getClientRects()];
    const byPage = new Map();
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const p = this.pages.find((pg) => {
        const b = pg.el.getBoundingClientRect();
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
      if (!p) continue;
      const b = p.el.getBoundingClientRect();
      if (r.height > b.height * 0.15) continue; // bỏ khối bao toàn trang
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push([(r.left - b.left) / b.width, (r.top - b.top) / b.height, r.width / b.width, r.height / b.height]);
    }
    const out = [];
    let first = true;
    for (const [p, rs] of byPage) {
      out.push({
        id: crypto.randomUUID(), page: p.num, type: 'highlight', color,
        rects: mergeRects(rs), text: first ? text : '', created_at: new Date().toISOString(),
      });
      first = false;
    }
    return out;
  }

  highlightSelection(color) {
    const list = this.selectionToAnns(color);
    for (const a of list) { this.addAnn(a); this.cb.onCreate?.(a); }
    return list;
  }

  // ---------- Popups ----------
  hidePopup() { this.popup.classList.add('hidden'); }

  placePopup(rect) {
    const rb = this.root.getBoundingClientRect();
    this.popup.classList.remove('hidden');
    const pw = this.popup.offsetWidth, ph = this.popup.offsetHeight;
    let x = rect.left + rect.width / 2 - rb.left - pw / 2;
    let y = rect.top - rb.top - ph - 8;
    if (y < 4) y = rect.bottom - rb.top + 8;
    x = Math.max(4, Math.min(rb.width - pw - 4, x));
    this.popup.style.left = x + 'px';
    this.popup.style.top = y + 'px';
  }

  colorDots(onPick, current) {
    const box = el('div', 'pp-colors');
    for (const c of this.cb.getColors()) {
      const b = el('button', 'dot' + (c.id === current ? ' on' : ''));
      b.style.background = c.hex;
      b.title = c.label;
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => onPick(c.id);
      box.appendChild(b);
    }
    return box;
  }

  showSelectionPopup(rect) {
    this.popup.innerHTML = '';
    this.popup.appendChild(this.colorDots((c) => {
      this.color = c; this.cb.onColorPicked?.(c);
      this.highlightSelection(c);
      window.getSelection()?.removeAllRanges();
      this.hidePopup();
    }));
    const row = el('div', 'pp-row');
    row.append(
      btn('📝 Highlight + gửi note', () => {
        const list = this.highlightSelection(this.color);
        window.getSelection()?.removeAllRanges();
        this.hidePopup();
        if (list[0]) this.cb.onSendToNote?.(list[0]);
      }),
      btn('📋 Copy', () => {
        navigator.clipboard?.writeText(window.getSelection().toString());
        this.hidePopup();
      }),
    );
    this.popup.appendChild(row);
    this.placePopup(rect);
  }

  onClick(e) {
    if (this.tool !== 'select' && this.tool !== 'highlight') return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pageEl = e.target.closest('.page');
    if (!pageEl) return;
    const p = this.pages[+pageEl.dataset.page - 1];
    const b = pageEl.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    const hit = [...this.anns].reverse().find((a) => a.page === p.num && a.type === 'highlight' &&
      (!this.filter || this.filter.includes(a.color)) &&
      a.rects.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]));
    if (!hit) { this.hidePopup(); return; }
    this.showAnnPopup(hit, { left: e.clientX - 1, top: e.clientY - 10, width: 2, bottom: e.clientY + 10 });
  }

  showAnnPopup(a, rect) {
    this.popup.innerHTML = '';
    this.popup.appendChild(this.colorDots((c) => {
      a.color = c; this.updateAnn(a); this.cb.onUpdate?.(a); this.hidePopup();
    }, a.color));
    const row = el('div', 'pp-row');
    row.append(
      btn('📝 Gửi sang note', () => { this.cb.onSendToNote?.(a); this.hidePopup(); }),
      btn('📋 Copy', () => { navigator.clipboard?.writeText(a.text || ''); this.hidePopup(); }),
      btn('🗑 Xoá', () => { this.removeAnn(a.id); this.cb.onDelete?.(a); this.hidePopup(); }),
    );
    this.popup.appendChild(row);
    this.placePopup(rect);
  }

  // ---------- Pen / eraser / snip ----------
  bindDraw(p) {
    const d = p.draw;
    let pts = null, live = null, box = null, start = null;
    const pos = (e) => {
      const b = d.getBoundingClientRect();
      return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
    };
    d.addEventListener('pointerdown', (e) => {
      if (!['pen', 'eraser', 'snip'].includes(this.tool)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      const pt = pos(e);
      if (this.tool === 'pen') {
        pts = [pt];
        live = document.createElementNS(SVGNS, 'path');
        live.setAttribute('stroke', this.penColor);
        live.setAttribute('stroke-width', this.penWidth);
        p.ink.appendChild(live);
      } else if (this.tool === 'eraser') {
        pts = [pt]; this.eraseAt(p, pt);
      } else {
        start = pt;
        box = el('div', 'snip-box');
        d.appendChild(box);
      }
    });
    d.addEventListener('pointermove', (e) => {
      if (!pts && !box) return;
      const pt = pos(e);
      if (this.tool === 'pen' && pts) {
        pts.push(pt);
        live.setAttribute('d', pathD(pts, p.W, p.H));
      } else if (this.tool === 'eraser' && pts) {
        this.eraseAt(p, pt);
      } else if (box) {
        const [x, y, w, h] = boxOf(start, pt);
        Object.assign(box.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: h * 100 + '%' });
      }
    });
    const end = async (e) => {
      if (this.tool === 'pen' && pts) {
        live.remove();
        if (pts.length > 1) {
          const a = {
            id: crypto.randomUUID(), page: p.num, type: 'ink', color: this.penColor,
            path: { w: this.penWidth / p.W, pts: simplify(pts).map(([x, y]) => [round(x), round(y)]) },
            created_at: new Date().toISOString(),
          };
          this.addAnn(a); this.cb.onCreate?.(a);
        }
      } else if (box) {
        const r = boxOf(start, pos(e));
        box.remove(); box = null;
        if (r[2] * p.W > 8 && r[3] * p.H > 8) {
          const blob = await this.snip(p, r);
          this.cb.onSnip?.(blob, p.num);
        }
      }
      pts = null; live = null;
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
  }

  eraseAt(p, [x, y]) {
    const tol = 10 / p.W;
    for (const a of [...this.anns]) {
      if (a.page !== p.num) continue;
      let hit = false;
      if (a.type === 'ink') {
        const pts = a.path.pts;
        for (let i = 0; i < pts.length && !hit; i++) {
          const q = pts[Math.min(i + 1, pts.length - 1)];
          if (distSeg([x, y * p.H / p.W], [pts[i][0], pts[i][1] * p.H / p.W], [q[0], q[1] * p.H / p.W]) < tol) hit = true;
        }
      } else if (a.type === 'highlight') {
        hit = a.rects.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]);
      }
      if (hit) { this.removeAnn(a.id); this.cb.onDelete?.(a); }
    }
  }

  async pageCanvas(p) {
    const scale = Math.max(2, 1400 / p.base.w);
    if (this.isHtml) {
      const { default: html2canvas } = await import('html2canvas');
      const holder = el('div', 'html-stage snap');
      const box = el('div', p.box.className);
      box.style.width = p.base.w + 'px';
      box.appendChild(p.node.cloneNode(true));
      holder.appendChild(box);
      document.body.appendChild(holder);
      try {
        return await html2canvas(box.firstChild, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false });
      } finally { holder.remove(); }
    }
    const page = await this.pdf.getPage(p.num);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  }

  async snip(p, [x, y, w, h]) {
    const c = await this.pageCanvas(p);
    const ctx = c.getContext('2d');
    // vẽ thêm highlight + nét bút vào ảnh chụp
    for (const a of this.anns) {
      if (a.page !== p.num) continue;
      if (a.type === 'highlight') {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = colorHex(a.color);
        for (const r of a.rects) ctx.fillRect(r[0] * c.width, r[1] * c.height, r[2] * c.width, r[3] * c.height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      } else if (a.type === 'ink') {
        ctx.strokeStyle = a.color; ctx.lineWidth = a.path.w * c.width; ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        a.path.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * c.width, py * c.height) : ctx.moveTo(px * c.width, py * c.height)));
        ctx.stroke();
      }
    }
    const out = document.createElement('canvas');
    out.width = Math.floor(w * c.width); out.height = Math.floor(h * c.height);
    out.getContext('2d').drawImage(c, x * c.width, y * c.height, out.width, out.height, 0, 0, out.width, out.height);
    return await new Promise((r) => out.toBlob(r, 'image/png'));
  }

  // ---------- Search ----------
  async pageText(num) {
    if (this.textCache.has(num)) return this.textCache.get(num);
    if (this.isHtml) {
      const t = (this.pages[num - 1]?.node.innerText || '').replace(/\s+/g, ' ');
      this.textCache.set(num, t);
      return t;
    }
    const page = await this.pdf.getPage(num);
    const tc = await page.getTextContent();
    const s = tc.items.map((i) => i.str + (i.hasEOL ? ' ' : '')).join('').replace(/\s+/g, ' ');
    this.textCache.set(num, s);
    return s;
  }

  async search(q, onProgress) {
    this.searchQuery = q.trim();
    if (this.isHtml) this.markHtmlSearch();
    else for (const p of this.pages) this.markSearch(p);
    if (!this.searchQuery) return [];
    const nq = norm(this.searchQuery).out;
    const results = [];
    for (let i = 1; i <= this.numPages; i++) {
      const s = await this.pageText(i);
      const { out, map } = norm(s);
      let idx = out.indexOf(nq);
      while (idx >= 0 && results.length < 300) {
        const a = map[idx], b = map[Math.min(idx + nq.length - 1, map.length - 1)] + 1;
        results.push({ page: i, before: s.slice(Math.max(0, a - 40), a), match: s.slice(a, b), after: s.slice(b, b + 50) });
        idx = out.indexOf(nq, idx + nq.length);
      }
      if (i % 20 === 0) onProgress?.(i, this.numPages);
      if (q.trim() !== this.searchQuery) return results;
    }
    return results;
  }

  // Tô kết quả tìm kiếm trong Word/PowerPoint (CSS Highlight API)
  markHtmlSearch() {
    if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
    CSS.highlights.delete('gd-search');
    const nq = this.searchQuery ? norm(this.searchQuery).out : '';
    if (!nq) return;
    const ranges = [];
    for (const p of this.pages) {
      const walker = document.createTreeWalker(p.node, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode()) && ranges.length < 500) {
        const { out, map } = norm(n.data);
        let i = out.indexOf(nq);
        while (i >= 0) {
          const r = new Range();
          r.setStart(n, map[i]);
          r.setEnd(n, map[i + nq.length - 1] + 1);
          ranges.push(r);
          i = out.indexOf(nq, i + nq.length);
        }
      }
    }
    CSS.highlights.set('gd-search', new Highlight(...ranges));
  }

  markSearch(p) {
    if (this.isHtml || !p.rendered) return;
    const nq = this.searchQuery ? norm(this.searchQuery).out : '';
    p.text.querySelectorAll('span').forEach((s) => {
      s.classList.toggle('search-hit', !!nq && s.childElementCount === 0 && norm(s.textContent).out.includes(nq));
    });
  }
}

// ---------- helpers ----------
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function btn(label, fn) { const b = el('button', 'pp-btn'); b.textContent = label; b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; return b; }
const round = (v) => Math.round(v * 10000) / 10000;

function pathD(pts, W, H) {
  if (!pts.length) return '';
  let d = `M${(pts[0][0] * W).toFixed(1)} ${(pts[0][1] * H).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const mx = ((x0 + x1) / 2) * W, my = ((y0 + y1) / 2) * H;
    d += ` Q${(x0 * W).toFixed(1)} ${(y0 * H).toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  d += ` L${(l[0] * W).toFixed(1)} ${(l[1] * H).toFixed(1)}`;
  return d;
}

function boxOf(a, b) {
  const x = Math.max(0, Math.min(a[0], b[0])), y = Math.max(0, Math.min(a[1], b[1]));
  return [x, y, Math.min(1, Math.max(a[0], b[0])) - x, Math.min(1, Math.max(a[1], b[1])) - y];
}

function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) > 0.002) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Gộp các ô chữ nằm cùng dòng thành một dải highlight
function mergeRects(rs) {
  rs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of rs) {
    const line = lines.find((l) => Math.abs(l[1] + l[3] / 2 - (r[1] + r[3] / 2)) < Math.min(l[3], r[3]) * 0.5 &&
      r[0] <= l[0] + l[2] + 0.02 && r[0] + r[2] >= l[0] - 0.02);
    if (line) {
      const x1 = Math.min(line[0], r[0]), y1 = Math.min(line[1], r[1]);
      const x2 = Math.max(line[0] + line[2], r[0] + r[2]), y2 = Math.max(line[1] + line[3], r[1] + r[3]);
      line[0] = x1; line[1] = y1; line[2] = x2 - x1; line[3] = y2 - y1;
    } else lines.push([...r]);
  }
  return lines.map((r) => r.map(round));
}
