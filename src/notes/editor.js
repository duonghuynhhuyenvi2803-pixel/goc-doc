// Sổ ghi chú nền chấm: soạn thảo kiểu Word, dán ảnh, chip trang liên kết về PDF.
import { store } from '../store/index.js';

const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'IMG', 'HR', 'DIV', 'SPAN', 'MARK']);

export class NoteEditor {
  constructor(root, cb = {}) {
    this.cb = cb;
    this.root = root;
    root.innerHTML = `
      <div class="note-toolbar">
        <button data-cmd="h1" title="Tiêu đề lớn">H1</button>
        <button data-cmd="h2" title="Tiêu đề nhỏ">H2</button>
        <button data-cmd="p" title="Đoạn thường">¶</button>
        <span class="sep"></span>
        <button data-cmd="bold" title="Đậm (Ctrl+B)"><b>B</b></button>
        <button data-cmd="italic" title="Nghiêng (Ctrl+I)"><i>I</i></button>
        <button data-cmd="underline" title="Gạch chân (Ctrl+U)"><u>U</u></button>
        <button data-cmd="mark" title="Tô nền chữ"><mark>A</mark></button>
        <span class="sep"></span>
        <button data-cmd="ul" title="Danh sách chấm">•</button>
        <button data-cmd="ol" title="Danh sách số">1.</button>
        <button data-cmd="check" title="Checklist">☑</button>
        <button data-cmd="quote" title="Trích dẫn">❝</button>
        <button data-cmd="hr" title="Đường kẻ">—</button>
        <span class="sep"></span>
        <button data-cmd="img" title="Chèn ảnh">🖼</button>
        <span class="grow"></span>
        <span class="save-state"></span>
      </div>
      <div class="note-scroll">
        <div class="note-page" contenteditable="true" spellcheck="false" data-ph="Ghi chú, ý nghĩ, dán ảnh vào đây…"></div>
      </div>
      <div class="img-tools hidden">
        <button data-w="33">S</button><button data-w="60">M</button><button data-w="100">L</button><button data-del>🗑</button>
      </div>
      <input type="file" accept="image/*" multiple hidden>`;
    this.page = root.querySelector('.note-page');
    this.scroll = root.querySelector('.note-scroll');
    this.state = root.querySelector('.save-state');
    this.file = root.querySelector('input[type=file]');
    this.imgTools = root.querySelector('.img-tools');

    root.querySelector('.note-toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    root.querySelector('.note-toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cmd]');
      if (b) this.cmd(b.dataset.cmd);
    });
    this.page.addEventListener('input', () => this.changed());
    this.page.addEventListener('paste', (e) => this.onPaste(e));
    this.page.addEventListener('drop', (e) => this.onDrop(e));
    this.page.addEventListener('click', (e) => this.onClick(e));
    this.page.addEventListener('keydown', (e) => this.onKey(e));
    this.file.addEventListener('change', async () => {
      for (const f of this.file.files) await this.insertImageBlob(f);
      this.file.value = '';
    });
    document.addEventListener('selectionchange', this._sel = () => {
      const s = window.getSelection();
      if (s.rangeCount && this.page.contains(s.anchorNode)) this.lastRange = s.getRangeAt(0).cloneRange();
    });
    this.imgTools.addEventListener('mousedown', (e) => e.preventDefault());
    this.imgTools.addEventListener('click', (e) => {
      const img = this.selImg;
      if (!img) return;
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.del !== undefined) (img.closest('figure') || img).remove();
      else img.style.width = b.dataset.w + '%';
      this.hideImgTools();
      this.changed();
    });
    this.scroll.addEventListener('scroll', () => this.hideImgTools(), { passive: true });
  }

  destroy() { document.removeEventListener('selectionchange', this._sel); }

  async load(docId) {
    this.docId = docId;
    const n = await store.notes.get(docId);
    this.page.innerHTML = n?.html || '';
    await this.resolveImages();
    this.setState('');
  }

  async resolveImages(scope = this.page) {
    for (const img of scope.querySelectorAll('img[data-ref]')) {
      try { img.src = await store.images.url(img.dataset.ref); } catch { img.alt = '(không tải được ảnh)'; }
    }
  }

  serialize() {
    const c = this.page.cloneNode(true);
    c.querySelectorAll('img[data-ref]').forEach((i) => i.removeAttribute('src'));
    c.querySelectorAll('.selected,.just-added').forEach((i) => i.classList.remove('selected', 'just-added'));
    return { html: c.innerHTML, text: this.page.innerText.trim() };
  }

  changed() {
    this.setState('Đang lưu…');
    clearTimeout(this._t);
    this._t = setTimeout(() => this.save(), 800);
  }

  async save() {
    clearTimeout(this._t);
    if (!this.docId) return;
    const { html, text } = this.serialize();
    if (html === this._lastSaved) { this.setState('Đã lưu ✓'); return; }
    try {
      await store.notes.save(this.docId, html, text);
      this._lastSaved = html;
      this.setState('Đã lưu ✓');
    } catch (e) {
      this.setState('⚠ Chưa lưu được');
      console.error(e);
    }
  }

  setState(s) { this.state.textContent = s; }

  focusEnd() {
    this.page.focus();
    const r = document.createRange();
    r.selectNodeContents(this.page);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
  }

  restoreRange() {
    if (this.lastRange && this.page.contains(this.lastRange.startContainer)) {
      this.page.focus();
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(this.lastRange);
    } else this.focusEnd();
  }

  // Chèn HTML: tại con trỏ nếu đang soạn note, không thì xuống cuối trang
  insertBlock(html, atCursor = false) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const nodes = [...tpl.content.childNodes];
    let anchor = null;
    if (atCursor && this.lastRange && this.page.contains(this.lastRange.startContainer)) {
      anchor = this.lastRange.startContainer;
      while (anchor && anchor.parentNode !== this.page) anchor = anchor.parentNode;
    }
    const after = document.createElement('p');
    after.innerHTML = '<br>';
    if (anchor) anchor.after(...nodes, after);
    else {
      // bỏ đoạn trống cuối nếu có
      const last = this.page.lastElementChild;
      if (last && last.tagName === 'P' && !last.textContent.trim() && !last.querySelector('img')) last.remove();
      this.page.append(...nodes, after);
    }
    if (atCursor) {
      // đang soạn note → đặt con trỏ ngay sau phần vừa chèn
      this.page.focus();
      const r = document.createRange();
      r.setStart(after, 0); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      this.lastRange = r.cloneRange();
    }
    // gửi từ PDF → không lấy focus, để vẫn dùng được phím tắt bên PDF
    const first = nodes.find((n) => n.nodeType === 1);
    if (first) {
      const sb = this.scroll.getBoundingClientRect(), nb = first.getBoundingClientRect();
      this.scroll.scrollTo({ top: this.scroll.scrollTop + nb.top - sb.top - sb.height / 3, behavior: 'smooth' });
      first.classList.add('just-added');
      setTimeout(() => first.classList.remove('just-added'), 1600);
    }
    this.changed();
    return nodes;
  }

  insertQuote(a, hex, label) {
    const html = `<blockquote class="hl-quote" style="border-left-color:${hex};background:${hex}33">${esc(a.text || '')}` +
      ` <span class="pg-chip" contenteditable="false" data-page="${a.page}" data-ann="${a.id}">${label ? esc(label) + ' · ' : ''}tr. ${a.page}</span></blockquote>`;
    this.insertBlock(html, false);
  }

  async insertImageBlob(blob, page = null, atCursor = true) {
    this.setState('Đang tải ảnh…');
    try {
      const ref = await store.images.upload(blob);
      const chip = page ? `<figcaption><span class="pg-chip" contenteditable="false" data-page="${page}">📷 tr. ${page}</span></figcaption>` : '';
      const nodes = this.insertBlock(`<figure contenteditable="false"><img class="note-img" data-ref="${esc(ref)}" style="width:100%">${chip}</figure>`, atCursor);
      for (const n of nodes) if (n.querySelectorAll) await this.resolveImages(n);
    } catch (e) {
      this.setState('⚠ Lỗi tải ảnh');
      console.error(e);
    }
  }

  cmd(c) {
    this.restoreRange();
    const ex = (a, v = null) => document.execCommand(a, false, v);
    switch (c) {
      case 'h1': ex('formatBlock', 'H1'); break;
      case 'h2': ex('formatBlock', 'H2'); break;
      case 'p': ex('formatBlock', 'P'); break;
      case 'bold': ex('bold'); break;
      case 'italic': ex('italic'); break;
      case 'underline': ex('underline'); break;
      case 'mark': ex('hiliteColor', '#FFF3A3'); break;
      case 'ul': ex('insertUnorderedList'); break;
      case 'ol': ex('insertOrderedList'); break;
      case 'quote': ex('formatBlock', 'BLOCKQUOTE'); break;
      case 'hr': ex('insertHorizontalRule'); break;
      case 'img': this.file.click(); return;
      case 'check': {
        ex('insertUnorderedList');
        const s = window.getSelection();
        const ul = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).closest('ul');
        if (ul && this.page.contains(ul)) ul.classList.add('checklist');
        break;
      }
    }
    this.changed();
  }

  onKey(e) {
    // Enter ở cuối blockquote trống → thoát khỏi trích dẫn
    if (e.key === 'Enter' && !e.shiftKey) {
      const s = window.getSelection();
      const node = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
      const h = node?.closest('h1,h2,h3');
      if (h && this.page.contains(h)) {
        setTimeout(() => document.execCommand('formatBlock', false, 'P'), 0);
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.save(); }
  }

  onClick(e) {
    const chip = e.target.closest('.pg-chip');
    if (chip) { e.preventDefault(); this.cb.onJump?.(+chip.dataset.page, chip.dataset.ann || null); return; }
    const li = e.target.closest('ul.checklist > li');
    if (li) {
      const b = li.getBoundingClientRect();
      if (e.clientX < b.left + 4) { li.classList.toggle('done'); this.changed(); return; }
    }
    const img = e.target.closest('img.note-img');
    if (img) { this.showImgTools(img); return; }
    this.hideImgTools();
  }

  showImgTools(img) {
    this.hideImgTools();
    this.selImg = img;
    img.classList.add('selected');
    const rb = this.root.getBoundingClientRect(), ib = img.getBoundingClientRect();
    this.imgTools.classList.remove('hidden');
    this.imgTools.style.left = Math.max(4, ib.left - rb.left + 6) + 'px';
    this.imgTools.style.top = Math.max(44, ib.top - rb.top + 6) + 'px';
  }
  hideImgTools() {
    this.selImg?.classList.remove('selected');
    this.selImg = null;
    this.imgTools.classList.add('hidden');
  }

  async onPaste(e) {
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (imgs.length) {
      e.preventDefault();
      for (const i of imgs) await this.insertImageBlob(i.getAsFile());
      return;
    }
    const html = e.clipboardData?.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitize(html));
    }
  }

  async onDrop(e) {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await this.insertImageBlob(f);
  }
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 8) { ch.remove(); continue; }
      if (ch.nodeType !== 1) continue;
      if (['SCRIPT', 'STYLE', 'META', 'LINK', 'IFRAME', 'OBJECT', 'TITLE'].includes(ch.tagName)) { ch.remove(); continue; }
      walk(ch);
      if (!ALLOWED.has(ch.tagName)) { ch.replaceWith(...ch.childNodes); continue; }
      const keep = {};
      if (ch.tagName === 'A' && /^https:\/\//.test(ch.getAttribute('href') || '')) keep.href = ch.getAttribute('href');
      if (ch.tagName === 'IMG') {
        const src = ch.getAttribute('src') || '';
        if (/^(https:|data:image\/)/.test(src)) { keep.src = src; keep.class = 'note-img'; keep.style = 'width:100%'; }
        else { ch.remove(); continue; }
      }
      for (const a of [...ch.attributes]) ch.removeAttribute(a.name);
      for (const [k, v] of Object.entries(keep)) ch.setAttribute(k, v);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
