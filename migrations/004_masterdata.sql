-- soft archive: "ลบ" ข้อมูลหลักโดยไม่ทำ FK/ledger พัง
ALTER TABLE products  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS archived_at timestamptz;
