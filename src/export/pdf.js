// Tải PDF có in sẵn highlight + nét bút.
import { PDFDocument, rgb, BlendMode, LineCapStyle } from 'pdf-lib';
import { colorHex } from '../colors.js';

const hexRgb = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export async function exportPdf(bytes, anns) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages();
  for (const a of anns) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const box = page.getCropBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    // (u,v) toạ độ 0..1 trên trang đang hiển thị → toạ độ PDF
    const map = (u, v) => {
      const { x, y, width: w, height: h } = box;
      if (rot === 90) return [x + v * w, y + u * h];
      if (rot === 180) return [x + (1 - u) * w, y + v * h];
      if (rot === 270) return [x + (1 - v) * w, y + h - u * h];
      return [x + u * w, y + h - v * h];
    };
    const viewW = rot % 180 ? box.height : box.width;
    if (a.type === 'highlight') {
      for (const r of a.rects || []) {
        const p1 = map(r[0], r[1]), p2 = map(r[0] + r[2], r[1] + r[3]);
        page.drawRectangle({
          x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]),
          width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]),
          color: hexRgb(colorHex(a.color)), opacity: 0.55, blendMode: BlendMode.Multiply,
        });
      }
    } else if (a.type === 'ink') {
      const pts = a.path.pts.map(([u, v]) => map(u, v));
      const thickness = Math.max(0.5, a.path.w * viewW);
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] },
          thickness, color: hexRgb(a.color), lineCap: LineCapStyle.Round,
        });
      }
    }
  }
  const out = await pdf.save();
  return new Blob([out], { type: 'application/pdf' });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
