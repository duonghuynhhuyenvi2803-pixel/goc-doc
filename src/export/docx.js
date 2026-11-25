// Xuất note ra Word (.docx), kèm phụ lục danh sách highlight theo màu.
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, BorderStyle, ShadingType, AlignmentType,
} from 'docx';
import { store } from '../store/index.js';
import { getColors } from '../colors.js';

const MAX_W = 600; // px, khổ A4 trừ lề

export async function exportDocx(title, noteRoot, anns) {
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];

  const runsOf = async (node, fmt = {}) => {
    const out = [];
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        if (ch.textContent) out.push(new TextRun({ text: ch.textContent, ...fmt }));
      } else if (ch.nodeType === 1) {
        const t = ch.tagName;
        if (t === 'BR') out.push(new TextRun({ text: '', break: 1 }));
        else if (t === 'IMG') { const r = await imageRun(ch); if (r) out.push(r); }
        else if (ch.classList.contains('pg-chip')) out.push(new TextRun({ text: ` [${ch.textContent.trim()}]`, color: '888888', size: 18, ...fmt }));
        else {
          const f = { ...fmt };
          if (t === 'B' || t === 'STRONG' || ch.style?.fontWeight === 'bold') f.bold = true;
          if (t === 'I' || t === 'EM' || ch.style?.fontStyle === 'italic') f.italics = true;
          if (t === 'U') f.underline = {};
          if (t === 'MARK' || ch.style?.backgroundColor) f.highlight = 'yellow';
          out.push(...(await runsOf(ch, f)));
        }
      }
    }
    return out;
  };

  const walk = async (parent, listInfo = null) => {
    for (const n of parent.childNodes) {
      if (n.nodeType === 3) {
        if (n.textContent.trim()) children.push(new Paragraph({ children: [new TextRun(n.textContent)] }));
        continue;
      }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (t === 'H1') children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: await runsOf(n) }));
      else if (t === 'H2') children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: await runsOf(n) }));
      else if (t === 'H3') children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: await runsOf(n) }));
      else if (t === 'HR') children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } } }));
      else if (t === 'BLOCKQUOTE') {
        const color = rgbToHex(n.style.borderLeftColor) || 'BBBBBB';
        children.push(new Paragraph({
          children: await runsOf(n, { italics: true }),
          border: { left: { style: BorderStyle.SINGLE, size: 18, color, space: 8 } },
          shading: { type: ShadingType.CLEAR, fill: 'F7F7F5', color: 'auto' },
          indent: { left: 240 },
          spacing: { before: 120, after: 120 },
        }));
      } else if (t === 'UL' || t === 'OL') {
        let i = 1;
        for (const li of n.children) {
          if (li.tagName !== 'LI') continue;
          const check = n.classList.contains('checklist');
          const prefix = check ? (li.classList.contains('done') ? '☑ ' : '☐ ') : t === 'OL' ? `${i++}. ` : '• ';
          children.push(new Paragraph({ indent: { left: 360, hanging: 240 }, children: [new TextRun(prefix), ...(await runsOf(li))] }));
        }
      } else if (t === 'FIGURE') {
        const img = n.querySelector('img');
        const r = img && (await imageRun(img));
        if (r) children.push(new Paragraph({ children: [r], alignment: AlignmentType.CENTER }));
        const cap = n.querySelector('figcaption');
        if (cap) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: cap.textContent.trim(), color: '888888', size: 18 })] }));
      } else if (t === 'DIV' && n.querySelector('p,h1,h2,ul,ol,blockquote,figure')) await walk(n);
      else children.push(new Paragraph({ children: await runsOf(n), spacing: { after: 80 } }));
    }
  };
  await walk(noteRoot);

  // Phụ lục: highlight theo màu
  const hls = anns.filter((a) => a.type === 'highlight' && a.text).sort((a, b) => a.page - b.page);
  if (hls.length) {
    children.push(new Paragraph({ text: 'Danh sách highlight', heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
    for (const c of getColors()) {
      const list = hls.filter((a) => a.color === c.id);
      if (!list.length) continue;
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: '■ ', color: c.hex.slice(1) }), new TextRun(c.label)] }));
      for (const a of list) {
        children.push(new Paragraph({
          indent: { left: 240 },
          shading: { type: ShadingType.CLEAR, fill: c.hex.slice(1), color: 'auto' },
          spacing: { after: 60 },
          children: [new TextRun(a.text), new TextRun({ text: `  — tr. ${a.page}`, color: '666666', size: 18 })],
        }));
      }
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

async function imageRun(img) {
  try {
    let blob;
    if (img.dataset.ref) blob = await store.images.blob(img.dataset.ref);
    else blob = await (await fetch(img.src)).blob();
    if (!blob) return null;
    // Chuyển về PNG để chắc chắn Word đọc được
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const pct = parseFloat(img.style.width) || 100;
    const w = Math.min(bmp.width, (MAX_W * pct) / 100);
    const h = (bmp.height * w) / bmp.width;
    return new ImageRun({ type: 'png', data: await png.arrayBuffer(), transformation: { width: Math.round(w), height: Math.round(h) } });
  } catch (e) {
    console.warn('Bỏ qua ảnh', e);
    return null;
  }
}

function rgbToHex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
  if (!m) return null;
  return [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
}
