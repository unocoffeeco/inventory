-- audit: ใครทำ operation นี้
-- ตั้งใจไม่มี FK ให้ api_keys เพื่อให้ attribution อยู่รอดแม้ key ถูกลบ
ALTER TABLE inventory_operations
  ADD COLUMN IF NOT EXISTS api_key_id uuid,
  ADD COLUMN IF NOT EXISTS actor      text;

-- actor มาจาก header ที่ client ควบคุม → จำกัดความยาวกันข้อมูลขยะ
ALTER TABLE inventory_operations
  DROP CONSTRAINT IF EXISTS inventory_operations_actor_len;
ALTER TABLE inventory_operations
  ADD CONSTRAINT inventory_operations_actor_len
  CHECK (actor IS NULL OR char_length(actor) BETWEEN 1 AND 100);
