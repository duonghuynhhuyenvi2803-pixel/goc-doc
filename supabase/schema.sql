-- Góc Đọc — chạy toàn bộ file này trong Supabase → SQL Editor → New query → Run

create table if not exists sections (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  emoji text default '📁',
  sort int default 0,
  created_at timestamptz default now()
);

create table if not exists docs (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  section_id uuid references sections on delete set null,
  title text not null,
  file_path text not null,
  size bigint,
  page_count int,
  last_page int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists anns (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  doc_id uuid not null references docs on delete cascade,
  page int not null,
  type text not null,          -- 'highlight' | 'ink'
  color text,
  rects jsonb,                 -- [[x,y,w,h], ...] theo tỉ lệ 0..1 của trang
  path jsonb,                  -- { w: độ dày, pts: [[x,y], ...] }
  text text,
  comment text,
  created_at timestamptz default now()
);
create index if not exists anns_doc_idx on anns(doc_id);

create table if not exists notes (
  doc_id uuid primary key references docs on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  html text,
  text text,
  updated_at timestamptz default now()
);

-- Mỗi người chỉ thấy dữ liệu của mình
alter table sections enable row level security;
alter table docs enable row level security;
alter table anns enable row level security;
alter table notes enable row level security;

drop policy if exists own_sections on sections;
drop policy if exists own_docs on docs;
drop policy if exists own_anns on anns;
drop policy if exists own_notes on notes;
create policy own_sections on sections for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_docs on docs for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_anns on anns for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_notes on notes for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Kho file: pdfs (tối đa 50MB/file trên gói free) và images (ảnh dán vào note)
insert into storage.buckets (id, name, public, file_size_limit)
values ('pdfs', 'pdfs', false, 52428800), ('images', 'images', false, 10485760)
on conflict (id) do nothing;

drop policy if exists own_files_select on storage.objects;
drop policy if exists own_files_insert on storage.objects;
drop policy if exists own_files_update on storage.objects;
drop policy if exists own_files_delete on storage.objects;
create policy own_files_select on storage.objects for select
  using (bucket_id in ('pdfs','images') and (storage.foldername(name))[1] = auth.uid()::text);
create policy own_files_insert on storage.objects for insert
  with check (bucket_id in ('pdfs','images') and (storage.foldername(name))[1] = auth.uid()::text);
create policy own_files_update on storage.objects for update
  using (bucket_id in ('pdfs','images') and (storage.foldername(name))[1] = auth.uid()::text);
create policy own_files_delete on storage.objects for delete
  using (bucket_id in ('pdfs','images') and (storage.foldername(name))[1] = auth.uid()::text);
