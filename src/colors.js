// Màu highlight có ý nghĩa — nhãn đổi được, lưu trên máy.
const DEFAULT = [
  { id: 'yellow', hex: '#FFE066', label: 'Ý chính' },
  { id: 'green', hex: '#8CE99A', label: 'Từ vựng' },
  { id: 'pink', hex: '#FFA8D5', label: 'Câu hay' },
  { id: 'blue', hex: '#91D5FF', label: 'Cần hỏi lại' },
  { id: 'orange', hex: '#FFC078', label: 'Dịch / đối chiếu' },
];

export const PEN_COLORS = ['#1f1f1f', '#e03131', '#1971c2', '#2f9e44', '#f08c00'];

export function getColors() {
  try {
    const saved = JSON.parse(localStorage.getItem('gd-colors') || 'null');
    if (Array.isArray(saved)) return DEFAULT.map((c) => ({ ...c, label: saved.find((s) => s.id === c.id)?.label || c.label }));
  } catch {}
  return DEFAULT.map((c) => ({ ...c }));
}

export function setColorLabel(id, label) {
  const cs = getColors().map((c) => (c.id === id ? { ...c, label } : c));
  try { localStorage.setItem('gd-colors', JSON.stringify(cs.map(({ id, label }) => ({ id, label })))); } catch {}
  return cs;
}

export const colorHex = (id) => getColors().find((c) => c.id === id)?.hex || id || '#FFE066';
export const colorLabel = (id) => getColors().find((c) => c.id === id)?.label || '';
