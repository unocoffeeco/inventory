# AGENTS.md — กฎการทำงานในโปรเจกต์นี้

Lean inventory API: Node 20+ / TypeScript (ESM) / Express 4 / pg (raw SQL, ไม่มี ORM) / Zod v3 / Vitest 2 / PostgreSQL 16

## คำสั่ง
- `npm run dev` — รัน API (:3000)
- `npm run migrate` — apply migration ที่ยังไม่ถูกใช้
- `npm test` — integration + HTTP tests (ต้องมี DATABASE_URL)
- `npm run check` — `tsc --noEmit && vitest run` ← **รันก่อนบอกว่างานเสร็จทุกครั้ง**

## 🔴 กฎเหล็ก — ห้ามแตะเด็ดขาด
1. **ห้ามแก้ logic ใน `src/inventory/service.ts`**: `applyDelta`, `lockBalances`, `BEGIN/COMMIT/ROLLBACK`, ลำดับการล็อก (`product_id, location_id`)
   — ทั้งหมดนี้คือ atomicity + กันติดลบ + กัน deadlock ที่ผ่านเทสต์มาแล้ว
2. **ถ้าเทสต์แดง ห้ามแก้เทสต์ให้ผ่าน** ให้แก้โค้ด — โดยเฉพาะ `tests/inventory.integration.test.ts`
3. **ห้ามแก้ migration ที่ apply แล้ว** (`001`–`004`) — DB จริง apply ไปแล้ว ให้สร้างไฟล์ใหม่ `00N_ชื่อ.sql` เสมอ
4. **ห้าม commit `.env`** หรือ secret ใด ๆ — API key เก็บในตาราง `api_keys` ไม่ใช่ env var
5. **ห้ามเปลี่ยน response shape ของ endpoint ที่มีอยู่** (breaking change) — ถ้าจำเป็นให้หยุดและถามก่อน
6. **ห้ามใช้ ORM / query builder** — raw SQL + parameterized query (`$1, $2`) เท่านั้น
7. **ห้าม log `Authorization` header หรือ secret** ในทุกกรณี
8. ห้าม `git commit` / `git push` เอง — เจ้าของ repo เป็นคนตัดสินใจ

## รูปแบบโค้ดที่ต้องทำตาม
- ESM: import ไฟล์ภายในต้องลงท้าย `.js` (`import { pool } from '../db/pool.js'`)
- Endpoint ที่เขียนข้อมูลต้องมี `requireScope(...)` จาก `src/auth/apiKeys.js`
- ทุก handler ต้อง `try { ... } catch (e) { fail(res, e) }` (Express 4 ไม่จับ async error ให้)
- **id ทุกตัวในระบบเป็น string** (bigint จาก pg) — ฝั่งรับ input ใช้ `z.coerce.number().int().positive()`
- Error รูปแบบ `{ error: 'CODE' }` และ map ผ่าน `src/http/fail.ts`
- เพิ่ม endpoint = router ใน `src/<domain>/routes.ts` + mount ใน `src/app.ts` + zod ใน `src/<domain>/schemas.ts`
- ปรับยอดสต็อกต้องผ่าน `POST /inventory/operations` เท่านั้น — **ห้าม UPDATE `inventory_balances` ตรง ๆ**

## โครงสร้าง
- `src/inventory/` — ledger operations (service = หัวใจ ห้ามแตะ logic)
- `src/masterdata/` — products / locations CRUD (soft archive)
- `src/auth/apiKeys.ts` — API key middleware + scopes
- `src/http/fail.ts` — error → response ร่วม
- `migrations/` — SQL เรียงตามชื่อ + ตาราง `schema_migrations`

## Definition of Done
1. `npm run check` ผ่าน (tsc เงียบ + เทสต์เขียวทั้งหมด)
2. มีเทสต์ครอบของใหม่ (HTTP test สร้าง API key เองในไฟล์ ไม่ copy มือ)
3. ไม่แตะไฟล์ในกฎเหล็ก / ไม่มี secret ในไฟล์ tracked
4. สรุปว่าเปลี่ยนอะไร ทำไม และหลักฐาน (output เทสต์)
