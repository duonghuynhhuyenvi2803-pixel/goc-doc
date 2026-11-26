# 📖 Góc Đọc

Web app đọc **PDF, Word (.docx), PowerPoint (.pptx)** + ghi chú song song: highlight nhiều màu có ý nghĩa, bút vẽ tay, chụp vùng PDF dán sang note, sổ note nền chấm như sổ tay, xuất Word / PDF có highlight, chia tài liệu theo section. Đồng bộ laptop ↔ điện thoại qua Supabase.

## Tính năng

| Phần | Có gì |
|---|---|
| Thư viện | Section (Sách chuyên ngành, Ôn thi, Truyện, Giáo án… thêm/sửa/xoá/đổi thứ tự), kéo thả PDF để thêm, kéo thẻ tài liệu thả vào section để chuyển, thanh tiến độ đọc, tìm theo tên **và nội dung note** (gõ không dấu cũng ra) |
| Đọc PDF | Nhớ trang đang đọc, phóng to/thu nhỏ (Ctrl + lăn chuột), nhảy trang, tìm chữ trong PDF (Ctrl+F) |
| Công cụ | 𝙸 Chọn chữ (V) · 🖍 Highlight (H) · ✏️ Bút (P) · 🧽 Tẩy (E) · ✂️ Chụp vùng → note (S) · Esc về chọn chữ |
| Highlight | 5 màu có nhãn (Ý chính, Từ vựng, Câu hay, Cần hỏi lại, Dịch/đối chiếu) — **nhấn đúp vào nhãn trong danh sách 🗒 để đổi tên**; lọc theo màu; bấm vào highlight để đổi màu / gửi sang note / xoá |
| Sổ note | Nền chấm, H1/H2, đậm/nghiêng/gạch chân, tô nền chữ, danh sách, checklist, trích dẫn, dán/kéo ảnh, chỉnh cỡ ảnh S/M/L; mỗi highlight gửi sang có **chip trang** — bấm là nhảy về đúng chỗ trong PDF; tự lưu |
| Bố cục | ◫ Chia đôi / chỉ PDF / chỉ note; kéo thanh giữa để chỉnh tỉ lệ; điện thoại tự chia trên/dưới |
| Xuất | ⤓ Note ra Word (.docx, kèm phụ lục highlight theo màu) · PDF có in highlight + nét vẽ · với Word/PowerPoint: tải file gốc |
| Word / PowerPoint | Mở .docx và .pptx ngay trong app, dùng chung highlight, bút, tẩy, chụp vùng, tìm kiếm, note như PDF. File .doc/.ppt đời cũ: mở bằng Office rồi *Save As* .docx/.pptx |

## Cài đặt (làm 1 lần, ~10 phút)

### 1. Tạo Supabase
1. Vào https://supabase.com → **New project** (gói Free), đặt mật khẩu DB tuỳ ý, region **Southeast Asia (Singapore)**.
2. Mở **SQL Editor → New query**, dán toàn bộ nội dung file [`supabase/schema.sql`](supabase/schema.sql) → **Run**. (Tạo bảng, phân quyền, kho chứa `pdfs` và `images`.)
3. **Authentication → Users → Add user → Create new user**: nhập email + mật khẩu của bạn, tick *Auto Confirm User*.
4. **Authentication → Sign In / Providers → Email**: tắt **Allow new users to sign up** (để chỉ mình bạn đăng nhập được).
5. **Project Settings → API** (hoặc *Data API*): copy **Project URL** và khoá **anon / publishable key**.

### 2. Deploy lên Vercel
1. https://vercel.com → **Add New → Project** → chọn repo `goc-doc` → Framework tự nhận **Vite**.
2. Mục **Environment Variables** thêm 2 biến:
   - `VITE_SUPABASE_URL` = Project URL
   - `VITE_SUPABASE_ANON_KEY` = anon key
3. **Deploy**. Mở link trên laptop và điện thoại, đăng nhập bằng tài khoản ở bước 1.3.

> Trên điện thoại: mở link bằng Chrome → menu ⋮ → **Thêm vào màn hình chính** để dùng như app.

## Chạy trên máy (tuỳ chọn)
```bash
npm install
cp .env.example .env.local   # điền 2 key Supabase; để trống thì app lưu tạm trong trình duyệt
npm run dev
```

## Giới hạn
- Supabase Free: tối đa **50MB/file PDF**, tổng 1GB lưu trữ.
- Word/PowerPoint được dựng lại bằng trình duyệt nên có thể lệch nhẹ so với Office (font, hiệu ứng, biểu đồ phức tạp). Cần chính xác 100% thì xuất ra PDF từ Office rồi tải lên.
- PDF dạng ảnh scan (không có lớp chữ) thì không bôi chọn chữ được — dùng ✂️ chụp vùng hoặc ✏️ bút.
- Nhãn màu highlight lưu riêng trên từng thiết bị.

## Cấu trúc
```
src/main.js            thư viện, màn đọc, đăng nhập
src/reader/pdfview.js  hiển thị PDF, highlight, bút, tẩy, chụp vùng, tìm kiếm
src/notes/editor.js    sổ note
src/export/            xuất .docx và PDF
src/store/             lưu trữ: supabase.js (cloud) / local.js (IndexedDB)
supabase/schema.sql    database
```
