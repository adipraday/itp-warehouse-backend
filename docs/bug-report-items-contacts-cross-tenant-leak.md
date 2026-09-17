# Bug Report: Items & Contacts Bocor Lintas-Tenant (Company Berbeda)

**Dilaporkan 2026-09-08**, ditemukan user langsung (bukan dari sesi lain) saat pertama kali
mencoba alur company benar-benar baru setelah rollout multi-tenant.

---

## Kronologi

1. Create company baru "PT. Cakrawala Abadi" + business unit dengan service warehouse
   (`bu-wh-ckr-01`, id 28, `company_id: 3`).
2. Create admin-bu untuk BU itu, set password.
3. Login — ekspektasi: BU baru otomatis punya 1 warehouse pusat dari setup layanan. **Realita:
   belum ada** (lihat catatan di §4 — bukan bug, fitur yang memang belum ada).
4. Create manual 1 warehouse, kode `BU-WH-CKR-02` — berhasil, ter-scope benar ke `bu_id: 28`.
5. Buka halaman **Item** — **ada item dari BU lain**. Harusnya kosong (BU/company baru).

---

## Root cause

`items` dan `contacts` **tidak pernah punya kolom `bu_id` sama sekali** sejak awal — murni
master data global lintas seluruh database, tidak peduli warehouse/BU/company mana pun.
Sebelum ada model multi-tenant company yang sebenarnya, ini "cuma" berarti item dibagi lintas-BU
dalam satu company yang sama (kurang ideal tapi tidak fatal). Begitu company kedua yang beneran
terpisah dibuat, jadi kebocoran data nyata: company A bisa lihat (dan referensikan di
transaksinya sendiri) seluruh katalog item/contact company B.

Dikonfirmasi lewat DB langsung: `items`/`contacts` tidak punya kolom `bu_id` (`DESCRIBE items`),
warehouse `BU-WH-CKR-02` sudah benar `bu_id: 28`, tapi `GET /api/items` sebagai admin-bu BU 28
mengembalikan 5 item milik `bu_id: 13` (PUSAT, company lain).

---

## Perbaikan

**Migration** `202609080001_add_items_contacts_bu_id.js` — tambah `bu_id INT NULL` (no FK, pola
sama seperti `warehouses.bu_id`) ke `items` dan `contacts`. **Tidak** backfill di migration itu
sendiri (itu akan hardcode angka `bu_id`, exactly kesalahan yang sudah ditutup di
`bug-report-bu-id-mismatch.md`) — backfill dipisah jadi `scripts/backfill-items-contacts-bu.mjs`,
resolve target BU dari `code` (default `PUSAT`) ke auth-backend, bukan angka mentah.

**Dua lapis validasi ditambahkan:**

1. `items`/`contacts` sendiri: list ter-filter (`bu_id IN (buIds)`, sama pola seperti
   `warehouses`), akses `:id` di luar scope → `403 FORBIDDEN` (helper baru
   `src/shared/auth/master-data-scope.js`, fungsi `assertRowInScope`), `bu_id` di body
   create/update di-force server-side (tidak bisa diisi bebas kecuali super-admin).
2. **Referensi** `item_id`/`contact_id` di 7 modul yang membuat detail transaksi — inbounds,
   outbounds, sales, purchases, returns, stock-transfers, stock-opnames — divalidasi sebelum
   ditulis (`assertItemsInScope`, `assertContactInScope`), supaya tidak bisa "nyolong" referensi
   ke item/contact BU lain lewat `POST`/`PUT` biarpun tidak kelihatan di list mana pun.

**Backfill dijalankan** (dev DB ini): 5 item + 6 contact lama di-assign ke `bu_id: 13` (PUSAT) —
keputusan eksplisit, bukan dibiarkan `NULL`, supaya data test PUSAT/BU-C yang sudah ada tidak
hilang aksesnya.

**Diverifikasi live** (skenario persis dari laporan user):
- `GET /api/items` sebagai admin-bu BU baru (28) → `{"data":[],"meta":{"total":0}}` — kosong,
  sesuai ekspektasi.
- Create item baru sebagai BU itu → otomatis `bu_id: 28`.
- `admin.pusat` (BU 13) tetap lihat 5 item lama, **tidak** lihat item BU 28.
- `super-admin` tetap lihat semua item lintas company (6 total).
- `POST /api/inbounds` di warehouse BU 28 referensi `item_id` milik BU 13 → `403 FORBIDDEN`
  (`"item 1 is outside your business unit"`). Referensi item milik BU sendiri → `201` sukses.

**Test suite:** 20 test baru (`master-data-scope.test.js` +14, wiring test di
`items`/`contacts`/`inbounds`/`stock-transfers` service test) — total **203/203 lolos**.

Detail dampak ke frontend: `docs/frontend-integration-guide.md` §15.

---

## Catatan terpisah (bukan bug, klarifikasi ekspektasi)

Poin #3 di kronologi ("ekspektasi BU baru otomatis punya 1 warehouse pusat dari setup layanan")
**bukan bug** — tidak pernah ada fitur auto-provisioning warehouse saat BU/company dibuat.
Warehouse selalu dibuat manual lewat `POST /api/warehouses`, sama seperti sebelumnya. Kalau
auto-provisioning warehouse-utama-saat-BU-dibuat memang diinginkan sebagai fitur, itu permintaan
terpisah — belum dikerjakan, belum masuk rencana.
