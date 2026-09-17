# Warehouse Hierarchy (Main / Branch)

**Status: IMPLEMENTED (2026-08-28).** Awalnya catatan desain hasil diskusi di sesi terpisah
("Catatan Desain: Hierarki Warehouse per-BU & Aturan Provisioning User"), direview dan
dieksekusi di sesi ini. Dokumen itu digantikan oleh ini untuk bagian §2-nya (hierarki
warehouse) — bagian §3 (provisioning user) dipindah jadi
[`user-provisioning-requirements.md`](./user-provisioning-requirements.md) karena scope-nya di
auth-backend, bukan repo ini.

---

## Model

```
warehouses
  id
  bu_id                 -- tetap sama untuk warehouse utama & semua cabangnya
  parent_warehouse_id   -- NULL = warehouse utama; diisi id warehouse utama = warehouse cabang
  code, name, address, ...
```

`parent_warehouse_id` (nullable, self-reference ke `warehouses.id`) — bukan `sub_bu_id`
terpisah, karena identitas tenant (`bu_id`) tetap satu baik untuk warehouse utama maupun
cabangnya. Yang berbeda cuma relasi antar-warehouse.

Migration: [`202608280002_add_warehouse_parent.js`](../migrations/202608280002_add_warehouse_parent.js) —
`ALTER TABLE ADD COLUMN` + index + **FK asli** (`fk_warehouses_parent`, `ON DELETE RESTRICT`).
Beda dari `bu_id` (INT polos tanpa FK, karena `business_units` ada di auth-service terpisah),
`parent_warehouse_id` menunjuk baris di tabel yang sama — FK asli itu tepat di sini, mengikuti
pola self-reference yang sudah ada (`fk_inventory_transactions_reversal`, `fk_transfers_reversal`).

## Aturan bisnis (semua ditegakkan di `warehouses.service.js`, bukan cuma DB)

| Aturan | Ditegakkan sebagai |
|---|---|
| Warehouse tidak boleh jadi induk dirinya sendiri | `400 INVALID_PARENT_WAREHOUSE` |
| `parent_warehouse_id` harus menunjuk warehouse yang **ada** | `400 INVALID_PARENT_WAREHOUSE` |
| Parent harus warehouse **utama** (`parent_warehouse_id IS NULL`) — kedalaman dibatasi 2 level, cabang-dari-cabang ditolak | `400 INVALID_PARENT_WAREHOUSE` |
| Parent harus `bu_id` yang **sama** dengan warehouse anak | `400 INVALID_PARENT_WAREHOUSE` |
| **Tepat satu** warehouse utama per `bu_id` (diputuskan 2026-08-28 — bukan "bebas banyak") | `409 MAIN_WAREHOUSE_EXISTS` |
| Warehouse yang masih punya cabang **tidak boleh**: (a) di-demote jadi cabang, (b) pindah `bu_id`, (c) dihapus (diputuskan 2026-08-28 — bukan "cabang auto-naik jadi utama") | `409 WAREHOUSE_HAS_BRANCHES` |

MySQL tidak punya partial unique index, jadi "tepat satu warehouse utama per BU" dicek manual
lewat query (`findMainWarehouseInBu`) sebelum insert/update, bukan constraint DB.

**Gotcha yang ditambal di luar draft awal** (dua hal ini nggak disebut di catatan diskusi awal,
ditemukan saat review teknis sebelum implementasi):
- Validasi konsistensi `bu_id` cuma dicek pas *bikin relasi* di draft awal — di implementasi ini
  juga dicek ulang tiap kali `PUT /warehouses/:id` mengubah `bu_id`, supaya warehouse yang udah
  punya anak/induk nggak bisa diam-diam pindah BU dan bikin relasinya nyeleneh (lihat aturan
  terakhir di tabel — "pindah `bu_id`" ikut diblokir sama kondisi "masih punya cabang").
- Self-reference (`id == parent_warehouse_id`) ditambal eksplisit — nggak disebut di draft.

## Perubahan API

- `POST /api/warehouses` / `PUT /api/warehouses/:id` — body terima `parent_warehouse_id`
  (integer, nullable, opsional). Response object warehouse sekarang juga bawa field ini.
- Kode error baru: `INVALID_PARENT_WAREHOUSE` (400), `MAIN_WAREHOUSE_EXISTS` (409),
  `WAREHOUSE_HAS_BRANCHES` (409, dipakai juga di `DELETE`).
- Tidak ada perubahan di `role-matrix.js` — siapa yang boleh nulis warehouse (cuma
  `admin-bu`/`super-admin`) tidak berubah, hierarki main/cabang tidak dapat aturan role
  tersendiri.
- **Tidak berdampak ke BU-scoping** (`buScope()`, filter `bu_id` di list endpoint) — hierarki
  cuma soal relasi antar-warehouse dalam satu BU yang sama, ortogonal dari model keamanan
  lintas-BU yang sudah ada.

## Konsekuensi terhadap data yang sudah ada

Migration ini **additive** (tidak breaking), tapi ada satu konsekuensi operasional yang perlu
disadari: semua warehouse yang sudah ada sebelum migration otomatis dapat
`parent_warehouse_id = NULL` — artinya semuanya "warehouse utama" secara default. Business unit
mana pun yang **sudah** punya lebih dari satu warehouse (banyak yang begitu di data dev
sekarang) otomatis "melanggar" aturan satu-utama-per-BU secara retroaktif.

**Ini tidak memblokir apa pun yang sudah ada** — aturan cuma dicek saat create/update baru, jadi
warehouse lama tetap jalan seperti biasa. Tapi begitu ada yang mau bikin warehouse **baru**
dengan `parent_warehouse_id: null` di BU yang sudah punya warehouse lain, itu akan ditolak
`409 MAIN_WAREHOUSE_EXISTS` — perlu tentukan dulu yang mana warehouse utama BU itu (lewat
`PUT` set `parent_warehouse_id` ke yang lain) sebelum bisa nambah "utama" baru. Data cleanup ini
belum dikerjakan (di luar scope perubahan skema hari ini), silakan diberesin manual per-BU kalau
mau memakai fitur ini secara penuh.

## Test coverage

- `tests/modules/warehouses.service.test.js` — 12 test baru: uniqueness warehouse utama,
  validasi parent (tidak ada/depth>2/beda BU/self-reference), block demote/pindah-BU/hapus saat
  masih punya cabang, dan jalur normal (create/update/delete tanpa pelanggaran).
- Diverifikasi live: create utama → create cabang → tolak cucu (depth) → tolak hapus induk yang
  masih punya cabang → hapus cabang → self-reference ditolak. Semua sesuai ekspektasi.
- Suite lengkap: **150/150 lolos** (138 sebelumnya + 12 baru).

---

## Catatan lain dari sesi ini (di luar scope hierarki, dicatat karena ditemukan saat verifikasi live)

Saat testing live, ditemukan `warehouses.bu_id` untuk hampir semua baris (termasuk id 22/23 yang
sebelumnya dikonfirmasi `bu_id = 11`/`12` di sesi yang sama) sudah berubah jadi `bu_id = 13`
(id=1 jadi `14`) — **bukan** lewat `PUT /api/warehouses/:id` (dicek: `activity_logs` tidak
punya satu pun log `UPDATE` untuk resource warehouse, cuma `CREATE`). Berarti perubahan itu
terjadi lewat jalur di luar API ini (query langsung ke DB, script, atau reset/reseed). Bukan
akibat dari perubahan hierarki di dokumen ini — flag ini murni informasi, biar kalau ada
kejanggalan data BU nanti, sudah ada jejaknya di sini.
