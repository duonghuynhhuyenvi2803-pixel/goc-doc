// Chép font chuẩn + cMap của pdf.js vào public/ (để hiển thị đúng chữ tiếng Việt, CJK…)
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/pdfjs', { recursive: true });
cpSync('node_modules/pdfjs-dist/cmaps', 'public/pdfjs/cmaps', { recursive: true });
cpSync('node_modules/pdfjs-dist/standard_fonts', 'public/pdfjs/standard_fonts', { recursive: true });
console.log('pdf.js assets copied');
