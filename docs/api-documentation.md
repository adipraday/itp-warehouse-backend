# Warehouse System API Documentation

Referensi lengkap seluruh endpoint REST API untuk keperluan frontend development.
Base path semua endpoint: `/api`. Contoh: `GET /api/warehouses` diakses di `http://localhost:3000/api/warehouses`.

Dokumen ini dibuat langsung dari schema Fastify di source code (`src/modules/**/*.schema.js`), jadi field dan aturan validasinya akurat dengan implementasi aktual per 2026-08-25.

> Swagger UI interaktif juga tersedia otomatis saat server jalan (`@fastify/swagger-ui` sudah terpasang) — cek `src/plugins/swagger.js` untuk path-nya kalau mau eksplorasi request/response langsung dari browser.

---

## Daftar Isi

1. [Konvensi Umum](#1-konvensi-umum)
2. [Referensi Kode Error](#2-referensi-kode-error)
3. [Health Check](#3-health-check)
4. [Warehouses](#4-warehouses)
5. [Items](#5-items)
6. [Contacts](#6-contacts)
7. [Stocks (Read Model)](#7-stocks-read-model)
8. [Inbound Inventory](#8-inbound-inventory)
9. [Outbound Inventory](#9-outbound-inventory)
10. [Stock Mutations (Ledger)](#10-stock-mutations-ledger)
11. [Cost Layers / HPP (FIFO)](#11-cost-layers--hpp-fifo)
12. [Stock Transfers](#12-stock-transfers)
13. [Stock Opnames](#13-stock-opnames)
14. [Sales](#14-sales)
15. [Purchases](#15-purchases)
16. [Invoices (Gabungan Sales + Purchase)](#16-invoices-gabungan-sales--purchase)
17. [Payments](#17-payments)
18. [Returns](#18-returns)
19. [Dashboard / Reporting](#19-dashboard--reporting)
20. [Cash Sessions (Sesi Kasir / Shift)](#20-cash-sessions-sesi-kasir--shift)
21. [Alur Kerja Umum (Workflow Examples)](#21-alur-kerja-umum-workflow-examples)

---

## 1. Konvensi Umum

### Response Envelope

| Jenis respons | Bentuk |
|---|---|
| GET list | `{ "data": [...], "meta": { "page": 1, "per_page": 20, "total": 42 } }` |
| GET detail / command sukses | `{ "data": { ... } }` |
| Error validasi | `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }` |
| Error bisnis (409/404/400) | `{ "error": { "code": "SOME_CODE", "message": "...", "details": [] } }` |

### Pagination

Semua endpoint list menerima query `page` (default `1`, min `1`) dan `per_page` (default `20`, min `1`, **max `100`**).

### Format Angka & Tanggal

- **Uang/desimal** (`unit_price`, `unit_cost`, `total_amount`, dll) selalu dikembalikan sebagai **string**, contoh `"150000.00"` — bukan number. Ini disengaja supaya presisi uang tidak rusak jadi floating point. Body request tetap boleh kirim number biasa (mis. `"unit_price": 150000`).
- **Tanggal** (`invoice_date`, `transaction_date`, dll) format `YYYY-MM-DD` (kolom `DATE`, tanpa waktu/timezone).
- **Timestamp** (`created_at`, `completed_at`, dll) format `YYYY-MM-DD HH:mm:ss.SSS`, disimpan sebagai string apa adanya dari database (bukan ISO 8601 dengan `Z`).

### Idempotency-Key

Endpoint yang benar-benar berdampak ke stok (`complete` pada inbound/outbound/transfer/sales/purchase/return, `approve` pada stock-opname) **mewajibkan** header:

```
Idempotency-Key: <string unik, mis. UUID>
```

**Cara pakai:**
- Kalau request pertama sukses, retry dengan key + endpoint + body yang **sama persis** akan mengembalikan response yang **sama persis** (bukan memproses ulang / tidak membuat mutation kedua).
- Kalau key yang sama dipakai lagi tapi endpoint atau body-nya **beda**, request ditolak `409 IDEMPOTENCY_KEY_REUSED`.
- **Wajib generate key baru untuk setiap aksi baru** (bukan reuse key lama), kecuali memang sengaja mau retry request yang sama (mis. karena timeout/koneksi putus).
- Endpoint yang **tidak** butuh header ini: semua `GET`, `POST`/`PUT`/`DELETE` biasa (create/update/delete draft), dan transisi status yang tidak berdampak stok (`approve` pada transfer, `submit`/`reject`/`cancel` di manapun, `POST /payments`).

### Field yang Tidak Boleh Dikirim Client

Beberapa field selalu dihitung backend — kalau dikirim di body, akan **ditolak** karena semua body schema pakai `additionalProperties: false`:

- `subtotal`, `tax`, `total_amount`, `payment_status` pada invoice (sales/purchase) — client hanya boleh kirim `tax_rate` (0–1).
- `unit_cost`, `cost_amount` pada return detail — selalu di-copy backend dari HPP historis dokumen asal.
- Semua field turunan (`amount`, `total_price`, `total_cost`, `difference`) — dihitung MySQL generated column atau backend.

### Autentikasi

> ⚠️ **Basi.** Baris ini ditulis sebelum auth diimplementasikan. Semua endpoint `/api/*` di
> bawah sekarang butuh `Authorization: Bearer <token>` (dengan pengecualian transisi — lihat
> `AUTH_MODE` di dokumen yang disebut berikut). Untuk alur login, role, business-unit scoping,
> visibilitas HPP, dan field audit yang berdampak ke frontend, baca
> **[`frontend-integration-guide.md`](./frontend-integration-guide.md)** — bagian di bawah ini
> (body, field bisnis, alur status per resource) tetap akurat dan tetap jadi rujukan utama.

---

## 2. Referensi Kode Error

| HTTP | `code` | Kapan muncul |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body/query/params tidak sesuai JSON schema (field wajib hilang, tipe salah, dll) |
| 400 | `REVERSAL_REASON_REQUIRED` | `reversal_of_*_id` diisi tapi `reversal_reason` kosong |
| 400 | `INVALID_REVERSAL_TARGET` | Dokumen target reversal tidak ada / statusnya bukan COMPLETED |
| 400 | `SAME_WAREHOUSE` | Stock transfer: `source_warehouse_id` sama dengan `destination_warehouse_id` |
| 400 | `EXACTLY_ONE_ORIGIN_REQUIRED` | Return: harus isi salah satu `original_invoice_id` **atau** `original_inventory_transaction_id`, tidak keduanya/tidak sama sekali |
| 400 | `INVALID_ORIGIN_FOR_TYPE` | Return: tipe return tidak cocok dengan field origin yang diisi |
| 400 | `INVALID_ORIGIN_DOCUMENT` | Return: dokumen origin tidak ditemukan / tipe atau status salah |
| 400 | `DAMAGED_MUST_BE_SCRAPPED` | Return: detail `condition: DAMAGED` tapi `action` bukan `SCRAP` |
| 400 | `INVALID_REPLACE_ACTION` | Return: `action: REPLACE` dipakai di luar RETURN_CUSTOMER + GOOD |
| 400 | `ITEM_NOT_ON_ORIGINAL_DOCUMENT` | Return: item yang diretur tidak ada di dokumen asal |
| 404 | `NOT_FOUND` | Resource dengan `:id` tersebut tidak ditemukan |
| 400 | `INVALID_PARENT_WAREHOUSE` | `parent_warehouse_id` tidak valid — tidak ada, beda `bu_id`, self-reference, atau parent-nya sendiri bukan warehouse utama |
| 400 | `INVALID_BUSINESS_UNIT` | `bu_id` yang dikirim tidak ada di auth-backend, atau status BU-nya bukan `ACTIVE` (dicek live tiap create/update warehouse) |
| 502 | `BUSINESS_UNIT_SERVICE_UNAVAILABLE` | Warehouse-backend tidak bisa menghubungi auth-backend buat validasi `bu_id` — coba lagi, bukan error dari input client |
| 409 | `WAREHOUSE_CODE_EXISTS` | `code` warehouse sudah dipakai |
| 409 | `MAIN_WAREHOUSE_EXISTS` | `bu_id` target sudah punya warehouse utama (`parent_warehouse_id IS NULL`) lain |
| 409 | `WAREHOUSE_HAS_BRANCHES` | Warehouse masih punya cabang aktif — tidak bisa di-demote, pindah `bu_id`, atau dihapus |
| 409 | `WAREHOUSE_REFERENCED` | Warehouse mau dihapus tapi masih direferensikan data lain |
| 409 | `ITEM_SKU_EXISTS` | `sku` item sudah dipakai |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Lihat bagian [Idempotency-Key](#idempotency-key) |
| 409 | `INVALID_STATUS` | Aksi tidak valid untuk status dokumen saat ini (mis. complete dokumen yang sudah COMPLETED) |
| 409 | `INSUFFICIENT_STOCK` | Stok fisik atau sisa FIFO cost layer tidak cukup |
| 409 | `FIFO_ALLOCATION_MISMATCH` | Guard internal (harusnya tidak pernah muncul di kondisi normal) |
| 409 | `RETURN_QUANTITY_EXCEEDS_ELIGIBLE` | Quantity retur melebihi sisa yang masih boleh diretur dari dokumen asal |
| 409 | `AMOUNT_EXCEEDS_BALANCE` | Payment: `amount` melebihi sisa tagihan invoice |

---

## 3. Health Check

```
GET /health
```

Tidak pakai prefix `/api`. Response: `{ "data": { "status": "ok" } }`.

---

## 4. Warehouses

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/warehouses` | List, paginated |
| GET | `/api/warehouses/:id` | Detail |
| POST | `/api/warehouses` | Create → `201` |
| PUT | `/api/warehouses/:id` | Update (full replace) |
| DELETE | `/api/warehouses/:id` | Hapus — ditolak `409 WAREHOUSE_REFERENCED` kalau masih direferensikan |
| GET | `/api/warehouses/:id/stocks` | List stok per item di warehouse ini, paginated |
| GET | `/api/warehouses/:id/stock-summary` | Ringkasan: total item, total qty, low/out-of-stock count |
| POST | `/api/warehouses/provision-default` | Auto-provisioning (2026-09-08) — lihat di bawah |

### Auto-provisioning warehouse utama

Panggil sekali **setelah** bikin business unit/company baru di auth-backend, supaya BU itu
langsung punya 1 warehouse utama tanpa langkah manual:

```
POST /api/warehouses/provision-default
{ "bu_id": 29 }
```

**Idempotent** — aman dipanggil berkali-kali. Kalau BU itu belum punya warehouse utama, dibuatkan
satu (nama & kode diturunkan dari nama/`code` BU, mis. BU `code: "bu-wh-ckr-01"` → warehouse
`code: "WH-BU-WH-CKR-01"`) → `201`. Kalau sudah ada, warehouse yang sudah ada itu langsung
dibalikin apa adanya (tidak dibuat lagi) → `200`. Response envelope sama di kedua kasus:
`{ "data": { ...warehouse } }`.

`bu_id` wajib target BU yang `ACTIVE` (`400 INVALID_BUSINESS_UNIT` kalau tidak) dan harus BU milik
caller sendiri kecuali dipanggil sebagai `super-admin` (`403 FORBIDDEN` kalau bukan).

**Body create/update:**
```json
{ "code": "WH-01", "name": "Gudang Utama", "address": "Jl. Sudirman No. 1", "parent_warehouse_id": null }
```
`code` (wajib, ≤50 char, unik), `name` (wajib, ≤100 char), `address` (opsional, nullable).

`bu_id` yang dikirim (atau di-force dari identitas `admin-bu`) **divalidasi live** ke auth-backend
tiap create/update — harus BU yang beneran ada dan `ACTIVE`, kalau tidak → `400
INVALID_BUSINESS_UNIT`. Ini bukan sekadar dicek formatnya, tapi beneran ditanyakan ke
auth-backend, jadi jangan asal kirim angka.

`parent_warehouse_id` (opsional, nullable) — `null`/tidak diisi = warehouse **utama**; diisi id
warehouse utama = warehouse ini jadi **cabang**-nya. Aturan (lihat
[`warehouse-hierarchy.md`](./warehouse-hierarchy.md) untuk detail lengkap):
- Parent yang diisi wajib warehouse yang ada, `bu_id` sama, dan **wajib warehouse utama sendiri**
  (kedalaman dibatasi 2 level — cabang tidak boleh punya cabang) → kalau dilanggar:
  `400 INVALID_PARENT_WAREHOUSE`.
- Satu `bu_id` cuma boleh punya **tepat satu** warehouse utama → `409 MAIN_WAREHOUSE_EXISTS`.
- Warehouse yang masih punya cabang tidak bisa di-demote jadi cabang, pindah `bu_id`, atau
  dihapus → `409 WAREHOUSE_HAS_BRANCHES`.

**Object warehouse:** `id, code, name, address, bu_id, parent_warehouse_id, created_by, created_at, updated_at`

**Object warehouse-stock** (di `/:id/stocks`): `item_id, sku, name, unit, quantity, min_stock, updated_at`

**Object stock-summary**: `warehouse_id, total_items, total_quantity, low_stock_count, out_of_stock_count`

---

## 5. Items

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/items` | List, paginated |
| GET | `/api/items/:id` | Detail |
| POST | `/api/items` | Create → `201` |
| PUT | `/api/items/:id` | Update (full replace) |
| GET | `/api/items/search?q=router` | Cari by SKU/nama/barcode (LIKE), paginated. **`q` wajib** |
| GET | `/api/items/by-barcode/:barcode?warehouse_id=1` | **Baru 2026-09-13.** Lookup exact-match buat scanner POS. `warehouse_id` opsional — kalau dikirim, response ikut kasih stok item itu di warehouse tsb (`stock: {warehouse_id, quantity}`), jadi 1x request per scan. `404` kalau barcode tidak ketemu. |
| GET | `/api/items/:id/stocks?warehouse_id=1` | Stok item lintas warehouse (filter `warehouse_id` opsional), paginated |
| GET | `/api/items/:id/cost?warehouse_id=1` | Rata-rata biaya FIFO saat ini untuk 1 item di 1 warehouse. **`warehouse_id` wajib** |
| GET | `/api/items/:id/cost-history?warehouse_id=1` | Riwayat cost layer item ini di warehouse tsb, paginated. **`warehouse_id` wajib** |
| POST | `/api/items/import` | **Baru 2026-09-14.** Bulk import item + stok awal dari file CSV/.xlsx — lihat bagian tersendiri di bawah |

Tidak ada `DELETE /items` (item master tidak boleh dihapus).

**Update 2026-09-08:** item sekarang di-scope per business unit (dulu global lintas-tenant —
lihat `warehouse-hierarchy.md`/changelog terkait untuk insiden yang melatarbelakangi ini). `bu_id`
di body **tidak perlu dikirim manual** — di-force server-side sama seperti `warehouses` (§4).
Item milik BU lain: `GET`/`PUT` ke `:id`-nya → `403 FORBIDDEN`; referensi `item_id` dari BU lain
di detail transaksi (inbound/outbound/sales/dst) juga ditolak `403`.

**Update 2026-09-13:** field baru `barcode` (nullable, unik kalau diisi) — buat dukung barcode
scanner di kasir. **Beda dari `sku`**: `sku` itu kode internal (biasanya frontend yang atur), sedang
`barcode` adalah nilai yang tercetak/discan di kemasan produk (bisa beda dari `sku`). Item lama
tanpa barcode tetap valid (`barcode: null`) — isi belakangan lewat `PUT` kapan saja. Assign barcode
yang sudah dipakai item lain → `409 ITEM_BARCODE_EXISTS`.

**Update 2026-09-14 — bug fix `sku` unik per BU:** sebelumnya `sku` unik **global** lintas-tenant —
2 bisnis yang gak ada hubungannya gak bisa sama-sama pakai SKU yang sama persis (padahal wajar
banget kejadian di dunia nyata). Sekarang `sku` unik **per `bu_id`** — 2 BU beda boleh pakai SKU
yang sama, tapi dalam 1 BU yang sama tetap harus unik seperti biasa.

**Update 2026-09-14 — bug fix `barcode` juga unik per BU (revisi dari keputusan sebelumnya):**
awalnya `barcode` sengaja dibiarkan unik global dengan alasan "barcode = kode produk fisik/EAN yang
emang unik di dunia nyata". Ternyata alasan itu salah arah — **barcode mengidentifikasi PRODUK,
bukan siapa yang boleh jualan produk itu**. Kasus nyata yang ketemu: 2 toko yang gak berhubungan
sama-sama jual produk yang identik (misal rokok merek yang sama) — keduanya wajar pakai barcode
EAN yang sama persis, tapi sistem lama cuma ngizinin BU pertama yang daftarin barcode itu, BU
manapun setelahnya ketolak `409 ITEM_BARCODE_EXISTS` walau produknya beneran beda kepemilikan.
Sekarang `barcode` juga unik **per `bu_id`**, sama persis pola `sku`. **Efek ke `GET
/api/items/by-barcode/:barcode`**: karena sekarang 2 BU bisa share barcode yang sama, lookup-nya
di-scope ke BU si pemanggil — hasilnya selalu item milik BU sendiri, gak akan ketuker walau ada BU
lain yang kebetulan punya barcode identik.

**Body create/update:**
```json
{ "sku": "SKU-001", "barcode": "8991234567890", "name": "Router TP-Link", "unit": "pcs", "min_stock": 5, "selling_price": 150000 }
```
`sku` (wajib, ≤50, unik **per `bu_id`**), `barcode` (opsional/nullable, ≤64, unik **per `bu_id`** kalau diisi), `name` (wajib, ≤150), `unit` (wajib, ≤20), `min_stock` (int, default 0), `selling_price` (default 0).

**Object item:** `id, bu_id, sku, barcode, name, unit, min_stock, selling_price, created_at, updated_at`

**Object hasil `/by-barcode/:barcode`**: sama seperti object item, ditambah `stock` (cuma muncul kalau `?warehouse_id=` dikirim): `{ warehouse_id, quantity }`.

**Object item-stock** (di `/:id/stocks`): `warehouse_id, warehouse_code, warehouse_name, quantity, updated_at`

**Object cost** (di `/:id/cost`): `item_id, warehouse_id, quantity_remaining, total_value, average_unit_cost`

**Object cost-history entry**: `id, quantity_received, quantity_remaining, unit_cost, origin_cost_layer_id, created_at`

### Import item + stok awal (`POST /api/items/import`, baru 2026-09-14)

`multipart/form-data`, bukan JSON — kirim file di field `file`:
```
curl -X POST http://localhost:3000/api/items/import \
  -H "Authorization: Bearer <token>" \
  -F "file=@items.csv"
```
Support **CSV dan .xlsx** (deteksi otomatis dari ekstensi filename atau mimetype). Maks 5000 baris,
maks ukuran file 10MB.

**Kolom (baris header, urutan bebas):**

| Kolom | Wajib? | Keterangan |
|---|---|---|
| `sku` | ✅ | Unik per BU (lihat bug fix di atas) |
| `name` | ✅ | |
| `unit` | ✅ | |
| `barcode` | opsional | Unik global — kosongkan kalau item belum punya barcode |
| `min_stock` | opsional | Default 0 |
| `selling_price` | opsional | Default 0 |
| `warehouse_code` | opsional | Kosongkan kalau baris ini cuma mau bikin/update data item, tanpa nambah stok |
| `quantity` | opsional | Cuma dipakai kalau `warehouse_code` diisi. Wajib > 0 kalau mau nambah stok |
| `unit_cost` | **wajib kalau `quantity` > 0** | Harga beli per unit — dipakai buat cost layer FIFO |

**Perilaku (sesuai keputusan desain 2026-09-14):**
1. **`sku` sudah ada (dalam BU yang sama) → data item di-UPDATE** (full replace, sama seperti `PUT /:id` biasa — kolom yang dikosongkan di file akan me-reset field itu ke default, bukan dibiarkan seperti semula. Kosongkan `barcode`/`min_stock`/dll dengan hati-hati kalau memang gak mau berubah, isi ulang nilai lamanya).
2. **Satu `sku` cuma boleh muncul SEKALI per file** — kalau mau nambah stok item yang sama ke 2 warehouse berbeda, jalankan 2x import terpisah (satu per warehouse), atau tambah stok warehouse kedua lewat `/api/inbounds` biasa setelah import pertama.
3. **Ada satu baris aja yang salah → SELURUH file ditolak**, gak ada yang ke-import (`400
   IMPORT_VALIDATION_FAILED`, `details` isinya daftar `{row, message}` per baris yang bermasalah —
   `row` itu nomor baris asli di file, termasuk baris header, jadi baris data pertama = `row: 2`).
4. Import **butuh caller yang punya home BU sendiri** (admin-bu/purchasing) — `super-admin` gak
   bisa pakai endpoint ini (`400 BU_REQUIRED`), karena gak ada BU tunggal yang jelas jadi tujuan
   import. `warehouse_code` di file harus warehouse milik BU caller sendiri, kalau bukan → ditolak.

**Bagaimana stok awal masuk:** setiap baris dengan `warehouse_code` + `quantity > 0` bukan cuma
nulis angka ke `stocks` — di baliknya bikin **dokumen INBOUND asli yang langsung COMPLETED**
(satu dokumen per warehouse yang disentuh, isinya semua item buat warehouse itu), persis mekanisme
yang sama kayak `POST /api/inbounds` + `/complete` biasa. Efeknya: cost layer FIFO ke-buat dengan
benar, dan riwayatnya kelihatan normal di `GET /api/inbounds` (catatan `"Initial stock from item
import"`) — bukan quantity yang muncul misterius tanpa jejak.

**Response sukses:**
```json
{ "data": { "rows_processed": 2, "items_created": 1, "items_updated": 1, "warehouses_stocked": 1, "inbound_ids": [23] } }
```

**Response gagal validasi:**
```json
{
  "error": {
    "code": "IMPORT_VALIDATION_FAILED",
    "message": "2 row(s) failed validation — nothing was imported",
    "details": [
      { "row": 3, "message": "sku is required" },
      { "row": 5, "message": "warehouse_code \"WH-XXX\" not found" }
    ]
  }
}
```

### Download template (`GET /api/items/import/template`, baru 2026-09-14)

```
GET /api/items/import/template?format=csv
GET /api/items/import/template?format=xlsx
```
`format` opsional, default `csv`. Balikin file **cuma baris header** (kolom persis sama seperti
tabel di atas) — kosong, gak ada baris contoh, biar gak ada resiko baris dummy ke-upload beneran
(inget, item **gak bisa dihapus** di sistem ini). Response-nya file beneran (`Content-Disposition:
attachment`), bukan JSON.

### Export item (`GET /api/items/export`, baru 2026-09-14)

```
GET /api/items/export?format=csv
GET /api/items/export?format=csv&warehouse_id=1
```
`format` opsional (default `csv`), `warehouse_id` opsional (harus warehouse milik BU caller
sendiri, sama seperti validasi di endpoint lain).

**PENTING — kolomnya SENGAJA beda dari kolom import**, biar aman kalau file hasil export ini
di-upload balik tanpa diedit dulu:

- **Tanpa `warehouse_id`** (default): satu baris per item, kolom `sku, barcode, name, unit,
  min_stock, selling_price` — **TIDAK ADA** `quantity`/`unit_cost`/`warehouse_code` sama sekali.
  Ini yang bikin export-lalu-reimport-langsung **100% aman**: file ini valid buat di-import ulang
  (kolom wajib `sku`/`name`/`unit` ada semua), tapi karena gak ada `quantity`, gak ada stok baru
  yang ke-tambah — cuma update data master (nama, harga jual, dll) kalau memang ada yang diedit.
- **Dengan `warehouse_id`**: satu baris per item + kolom `warehouse_code` dan **`current_quantity`**
  (bukan `quantity`!) yang nunjukkin stok saat ini di warehouse itu, buat referensi. Nama kolomnya
  sengaja beda (`current_quantity`, bukan `quantity`) — importer **gak mengenali** kolom itu sama
  sekali, jadi tetap aman di-upload balik tanpa bikin stok dobel keitung.
- Kalau memang niatnya nambah stok lewat re-import, user harus **sengaja** nambahin/ganti nama
  kolom jadi `quantity` + isi `unit_cost` — bukan kejadian gak sengaja dari export biasa.

Response-nya file (`Content-Disposition: attachment`), bukan JSON.

---

## 6. Contacts

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/contacts?type=supplier` | List, filter `type` opsional (`supplier`\|`customer`\|`both`), paginated |
| GET | `/api/contacts/:id` | Detail |
| POST | `/api/contacts` | Create → `201` |
| PUT | `/api/contacts/:id` | Update (full replace) |

> Catatan: kontak dengan `type: "both"` ikut muncul saat filter `type=supplier` **atau** `type=customer` (karena kontak "both" memang berperan sebagai keduanya).

**Update 2026-09-08:** sama seperti Items — sekarang di-scope per business unit, `bu_id` di-force
server-side, referensi `contact_id` dari BU lain di header transaksi ditolak `403`.

**Body create/update:**
```json
{ "type": "customer", "name": "Budi Santoso", "phone": "08123456789", "email": null, "address": null }
```
`type` (wajib, enum), `name` (wajib, ≤150), `phone`/`email`/`address` opsional nullable.

**Object contact:** `id, bu_id, type, name, phone, email, address, created_at, updated_at`

---

## 7. Stocks (Read Model)

Read-only. **Tidak ada** `POST`/`PUT`/`DELETE`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/stocks?warehouse_id=1&item_id=10` | List semua baris stok, kedua filter opsional, paginated |
| GET | `/api/stocks/low-stock?warehouse_id=1` | Item dengan `0 < quantity <= min_stock` |
| GET | `/api/stocks/out-of-stock?warehouse_id=1` | Item dengan `quantity = 0` |

**Object stock:** `id, warehouse_id, warehouse_code, warehouse_name, item_id, sku, item_name, unit, min_stock, quantity, updated_at`

---

## 8. Inbound Inventory

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/inbounds?warehouse_id=1&status=DRAFT&from=2026-08-01&to=2026-08-31` | List, semua filter opsional |
| GET | `/api/inbounds/:id` | Detail + `details[]` |
| POST | `/api/inbounds` | Create DRAFT → `201` |
| PUT | `/api/inbounds/:id` | Update — **hanya status DRAFT** |
| DELETE | `/api/inbounds/:id` | Hapus — **hanya status DRAFT** |
| POST | `/api/inbounds/:id/complete` | DRAFT → COMPLETED. **Butuh header `Idempotency-Key`** |
| POST | `/api/inbounds/:id/cancel` | DRAFT → CANCELLED |

**Flow status:** `DRAFT → COMPLETED` atau `DRAFT → CANCELLED`. Setelah COMPLETED, dokumen immutable — koreksi pakai OUTBOUND baru dengan `reversal_of_transaction_id` + `reversal_reason`.

**Body create/update:**
```json
{
  "warehouse_id": 2,
  "contact_id": null,
  "transaction_date": "2026-08-25",
  "notes": null,
  "reversal_of_transaction_id": null,
  "reversal_reason": null,
  "details": [
    { "item_id": 1, "quantity": 10, "unit_price": 50000 }
  ]
}
```
`warehouse_id`, `transaction_date`, `details` (min 1 item) wajib. Tiap detail: `item_id`+`quantity` wajib, `unit_price` default 0.

**Efek `complete`:** membuat 1 `stock mutation` tipe `IN` + 1 `cost layer` FIFO baru per item, menambah stok.

**Object dokumen (header + details):**
```json
{
  "id": 1, "transaction_number": "IN-000001", "warehouse_id": 2, "contact_id": null,
  "type": "INBOUND", "status": "COMPLETED",
  "reversal_of_transaction_id": null, "reversal_reason": null,
  "transaction_date": "2026-08-25", "notes": null,
  "completed_at": "2026-08-25 17:00:34.279", "cancelled_at": null,
  "created_at": "...", "updated_at": "...",
  "details": [
    { "id": 1, "item_id": 1, "sku": "SKU-001", "name": "Router TP-Link",
      "quantity": 10, "unit_price": "50000.00", "total_price": "500000.00" }
  ]
}
```
List response (`GET /api/inbounds`) mengembalikan header **tanpa** `details`.

---

## 9. Outbound Inventory

Identik strukturnya dengan Inbound, tapi mengurangi stok via FIFO.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/outbounds?warehouse_id=1&status=DRAFT&from=...&to=...` | List |
| GET | `/api/outbounds/:id` | Detail |
| POST | `/api/outbounds` | Create DRAFT → `201` |
| PUT | `/api/outbounds/:id` | Update — hanya DRAFT |
| DELETE | `/api/outbounds/:id` | Hapus — hanya DRAFT |
| POST | `/api/outbounds/:id/complete` | DRAFT → COMPLETED. **Butuh `Idempotency-Key`** |
| POST | `/api/outbounds/:id/cancel` | DRAFT → CANCELLED |

**Body create/update:**
```json
{
  "warehouse_id": 2,
  "contact_id": null,
  "transaction_date": "2026-08-25",
  "notes": null,
  "reversal_of_transaction_id": null,
  "reversal_reason": null,
  "details": [ { "item_id": 1, "quantity": 5 } ]
}
```
Sama seperti inbound, **kecuali detail tidak punya `unit_price`**. Ini disengaja: biaya barang yang keluar selalu ditentukan oleh alokasi FIFO saat `complete`, bukan oleh harga yang diinput client — jadi tidak ada field harga untuk diisi di outbound manual. Object detail response juga cuma `id, item_id, sku, name, quantity` (tanpa `unit_price`/`total_price`).

**Efek `complete`:** validasi stok cukup → alokasi FIFO (bisa lintas beberapa cost layer) → 1 `stock mutation` tipe `OUT` per item → stok berkurang. Kalau stok/FIFO tidak cukup → `409 INSUFFICIENT_STOCK`, seluruh transaksi rollback.

---

## 10. Stock Mutations (Ledger)

Read-only, immutable. **Tidak ada** `POST`/`PUT`/`DELETE`.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/stock-mutations?warehouse_id=1&item_id=10&type=OUT&direction=OUT&source_type=INVENTORY_TRANSACTION&source_id=5&from=...&to=...` | List, semua filter opsional |
| GET | `/api/stock-mutations/:id` | Detail |

`type` enum: `IN, OUT, RETURN_IN, RETURN_OUT, ADJUSTMENT`. `direction` enum: `IN, OUT`. `source_type` enum: `INVENTORY_TRANSACTION, RETURN, STOCK_OPNAME, STOCK_TRANSFER`.

**Object mutation:** `id, warehouse_id, item_id, type, direction, quantity, total_cost, source_type, source_id, inventory_transaction_id, return_id, stock_opname_id, stock_transfer_id, occurred_at, created_at`

Gunakan `source_type` + `source_id` untuk traceability — hubungkan mutation ke dokumen bisnis yang memicunya (inbound/outbound/transfer/return/opname).

---

## 11. Cost Layers / HPP (FIFO)

Read-only, dibuat backend saat transaksi inventory selesai. **Tidak ada CRUD publik.**

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/cost-layers?warehouse_id=1&item_id=10&remaining_only=true` | List, semua filter opsional |
| GET | `/api/cost-layers/:id` | Detail |
| GET | `/api/cost-summary?warehouse_id=1&from=2026-08-01&to=2026-08-31` | Total nilai persediaan (semua filter opsional) |

**Object cost layer:** `id, warehouse_id, item_id, source_stock_mutation_id, origin_cost_layer_id, quantity_received, quantity_remaining, unit_cost, created_at`

`origin_cost_layer_id` terisi hanya untuk layer hasil transfer antar gudang (menunjuk layer sumber di gudang asal).

**Object cost-summary:** `quantity_remaining, total_value`

---

## 12. Stock Transfers

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/stock-transfers?source_warehouse_id=1&destination_warehouse_id=2&status=DRAFT` | List |
| GET | `/api/stock-transfers/:id` | Detail |
| POST | `/api/stock-transfers` | Create DRAFT → `201` |
| PUT | `/api/stock-transfers/:id` | Update — hanya DRAFT |
| DELETE | `/api/stock-transfers/:id` | Hapus — hanya DRAFT |
| POST | `/api/stock-transfers/:id/approve` | DRAFT → APPROVED (transisi biasa, **tidak** butuh Idempotency-Key) |
| POST | `/api/stock-transfers/:id/complete` | APPROVED → COMPLETED. **Butuh `Idempotency-Key`** |
| POST | `/api/stock-transfers/:id/cancel` | DRAFT/APPROVED → CANCELLED |

**Flow:** `DRAFT → APPROVED → COMPLETED`, atau `DRAFT/APPROVED → CANCELLED`.

**Body create/update:**
```json
{
  "source_warehouse_id": 2,
  "destination_warehouse_id": 3,
  "transfer_date": "2026-08-25",
  "notes": null,
  "reversal_of_transfer_id": null,
  "reversal_reason": null,
  "details": [ { "item_id": 1, "quantity": 2 } ]
}
```
`source_warehouse_id` **tidak boleh sama** dengan `destination_warehouse_id` (`400 SAME_WAREHOUSE`). Detail hanya `item_id` + `quantity` — **tidak ada** `unit_price`/cost di body (cost diambil dari FIFO alokasi saat complete, bukan input client).

**Efek `complete`:** alokasi FIFO dari gudang asal → mutation `OUT` di asal + mutation `IN` di tujuan → membuat cost layer baru di tujuan per alokasi (dengan `origin_cost_layer_id` menunjuk layer asal). **Tidak membentuk revenue/COGS.**

**Object detail transfer:** `id, item_id, sku, name, quantity` (tanpa field cost).

**Object header:** `id, transfer_number, source_warehouse_id, destination_warehouse_id, status, reversal_of_transfer_id, reversal_reason, transfer_date, notes, approved_at, completed_at, cancelled_at, created_at, updated_at`

---

## 13. Stock Opnames

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/stock-opnames?warehouse_id=1&status=DRAFT` | List |
| GET | `/api/stock-opnames/:id` | Detail |
| POST | `/api/stock-opnames` | Create DRAFT → `201` |
| PUT | `/api/stock-opnames/:id` | Update — hanya DRAFT |
| DELETE | `/api/stock-opnames/:id` | Hapus — hanya DRAFT |
| POST | `/api/stock-opnames/:id/submit` | DRAFT → SUBMITTED (tidak butuh Idempotency-Key) |
| POST | `/api/stock-opnames/:id/approve` | SUBMITTED → APPROVED. **Butuh `Idempotency-Key`** |
| POST | `/api/stock-opnames/:id/cancel` | DRAFT/SUBMITTED → CANCELLED |

**Flow:** `DRAFT → SUBMITTED → APPROVED`, atau `DRAFT/SUBMITTED → CANCELLED`.

**Body create/update:**
```json
{
  "warehouse_id": 2,
  "opname_date": "2026-08-25",
  "notes": null,
  "reversal_of_stock_opname_id": null,
  "reversal_reason": null,
  "details": [ { "item_id": 1, "physical_qty": 5, "notes": null } ]
}
```
Client **hanya kirim `physical_qty`** (hasil hitung fisik). `system_qty` **selalu di-snapshot otomatis oleh backend** dari stok sistem saat itu (saat create/update, bukan saat approve) — jangan dikirim, tidak akan diterima.

**Efek `approve`:** untuk tiap item, `difference = physical_qty - system_qty` (dihitung MySQL, bukan JS).
- `difference > 0` → mutation `ADJUSTMENT` arah `IN`, cost layer baru dengan `unit_cost = 0`.
- `difference < 0` → mutation `ADJUSTMENT` arah `OUT` via alokasi FIFO normal.
- `difference == 0` → item di-skip, tidak ada dampak ledger sama sekali.

**Object detail opname:** `id, item_id, sku, name, system_qty, physical_qty, difference, notes`

**Object header:** `id, opname_number, warehouse_id, opname_date, status, reversal_of_stock_opname_id, reversal_reason, notes, submitted_at, approved_at, cancelled_at, created_at, updated_at`

---

## 14. Sales

Sales = invoice bertipe `SALES`. **Untuk POS, pakai resource yang sama** (`GET /api/items/search` + `POST /api/sales`) — jangan cari endpoint `/pos/sales` terpisah, tidak ada.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/sales?warehouse_id=1&status=DRAFT&held=true` | List. `held` opsional: `true` = cuma yang lagi ditahan, `false` = cuma yang tidak, kosongkan = semua |
| GET | `/api/sales/:id` | Detail + `details[]` |
| POST | `/api/sales` | Create DRAFT → `201` |
| PUT | `/api/sales/:id` | Update — hanya DRAFT |
| DELETE | `/api/sales/:id` | Hapus — hanya DRAFT |
| POST | `/api/sales/:id/hold` | **Baru 2026-09-13.** Tahan transaksi (hanya DRAFT) — lihat bagian "Hold/Resume" di bawah |
| POST | `/api/sales/:id/resume` | **Baru 2026-09-13.** Lepas status tahan |
| POST | `/api/sales/:id/complete` | DRAFT → COMPLETED. **Butuh `Idempotency-Key`** |
| POST | `/api/sales/:id/cancel` | DRAFT → CANCELLED |
| GET | `/api/sales/:id/receipt?paper_width_mm=58` | **Baru 2026-09-13.** Struk print-ready buat printer thermal. Hanya buat sale **COMPLETED** (`409 INVALID_STATUS` kalau belum). `paper_width_mm`: `58` (default, 32 char/baris) atau `80` (48 char/baris). |

**Body create/update:**
```json
{
  "warehouse_id": 2,
  "contact_id": 2,
  "invoice_date": "2026-08-25",
  "due_date": null,
  "tax_rate": 0.11,
  "discount_amount": 0,
  "notes": null,
  "reversal_of_invoice_id": null,
  "reversal_reason": null,
  "details": [ { "item_id": 1, "quantity": 5, "unit_price": 150000 } ]
}
```
**PENTING:** jangan kirim `subtotal`/`tax`/`total_amount` — akan ditolak schema. Kirim `tax_rate` (0–1,
default 0), backend hitung `subtotal` dari `details`.

**Update 2026-09-13 — `discount_amount`:** diskon **level transaksi** (flat, bukan persen — kalau
mau diskon persen, hitung nominalnya di frontend sebelum kirim), diterapkan **sebelum** pajak:
```
taxable_base = subtotal - discount_amount
tax          = taxable_base * tax_rate
total_amount = taxable_base + tax
```
Opsional, default `0`. Tidak boleh melebihi `subtotal` yang dihitung dari `details` → `400
DISCOUNT_EXCEEDS_SUBTOTAL`. **Catatan:** ini diskon per-transaksi, bukan per-item — belum ada field
diskon di level `invoice_details`.

**Hold / Resume (2026-09-13):** buat "menahan" transaksi yang lagi dibikin (mis. pelanggan lupa
bawa dompet, kasir mau layani orang lain dulu) tanpa kehilangan cart-nya:
```
POST /api/sales/6/hold
{ "hold_label": "Meja 5" }
```
Cuma bisa buat sale berstatus **DRAFT** (`409 INVALID_STATUS` kalau sudah COMPLETED/CANCELLED).
`hold_label` opsional (buat identifikasi di layar "Transaksi Tertahan" — nomor meja, nama pelanggan,
dll). Manggil `/hold` lagi di sale yang sudah ditahan **tidak error** — cuma refresh `held_at` dan
ganti label. Lepas status tahan:
```
POST /api/sales/6/resume
```
`409 NOT_HELD` kalau sale itu memang lagi tidak ditahan. **Ini bukan state baru** — sale yang
ditahan tetap `status: "DRAFT"` seperti biasa, `held_at`/`hold_label` cuma penanda tambahan.
Filter list `?held=true` buat nampilin cuma yang lagi ditahan (lihat tabel endpoint di atas).

**Efek `complete`:**
1. Membuat & langsung menyelesaikan **1 transaksi OUTBOUND baru** yang ter-link (`inventory_transaction_id` pada response akan terisi) — sekali saja, tidak mungkin dobel.
2. Menjalankan FIFO seperti outbound biasa (mengurangi stok, membuat mutation `OUT`).
3. **Membekukan HPP** ke `unit_cost`/`cost_amount` pada tiap `invoice_details` (dipakai untuk laporan profit — lihat [Dashboard](#19-dashboard--reporting)).

**Object detail sales:** `id, item_id, sku, name, quantity, unit_price, amount, unit_cost, cost_amount` — `unit_cost`/`cost_amount` masih `"0.00"` selama status DRAFT, terisi setelah COMPLETED.

**Object header:**
```json
{
  "id": 2, "invoice_number": "SAL-000002", "warehouse_id": 2, "contact_id": 2,
  "type": "SALES", "status": "COMPLETED",
  "held_at": null, "hold_label": null,
  "reversal_of_invoice_id": null, "reversal_reason": null,
  "inventory_transaction_id": 6,
  "invoice_date": "2026-08-25", "due_date": null,
  "subtotal": "750000.00", "discount_amount": "0.00", "tax": "82500.00", "total_amount": "832500.00",
  "payment_status": "PAID",
  "notes": null, "completed_at": "...", "cancelled_at": null,
  "created_at": "...", "updated_at": "..."
}
```
`payment_status` (`UNPAID`\|`PARTIAL`\|`PAID`) dihitung otomatis dari [Payments](#17-payments) — jangan pernah kirim/ubah manual.

**Object receipt** (`GET /:id/receipt`):
```json
{
  "invoice_number": "SAL-000003",
  "invoice_date": "2026-09-13",
  "warehouse": { "id": 1, "code": "WH-PUSAT", "name": "Gudang Pusat", "address": "..." },
  "business_unit": { "id": 13, "name": "..." },
  "customer": { "id": 9, "name": "Budi Santoso" },
  "cashier_user_id": 900,
  "items": [ { "sku": "SKU-001", "name": "Router TP-Link", "quantity": 2, "unit_price": "150000.00", "amount": "300000.00" } ],
  "subtotal": "300000.00", "discount_amount": "30000.00", "tax": "27000.00", "total_amount": "297000.00",
  "payments": [ { "method": "CASH", "amount": "297000.00", "amount_tendered": "300000.00", "change_amount": "3000.00", "payment_date": "2026-09-13" } ],
  "amount_paid": "297000.00", "balance_due": "0.00",
  "paper_width_mm": 58,
  "text_lines": ["...", "..."],
  "escpos_base64": "G0BbY..."
}
```
`warehouse`/`business_unit`/`customer` bisa `null` (mis. `contact_id` tidak diisi → walk-in customer). `text_lines` = teks polos siap tampil di layar (preview struk) atau print ke printer non-ESC/POS. `escpos_base64` = byte ESC/POS lengkap (base64) — tinggal di-decode jadi `Uint8Array`/`Buffer` dan ditulis langsung ke printer via Web Bluetooth, **tidak perlu tahu format ESC/POS di frontend**. Lihat `frontend-integration-guide.md` §19 buat contoh kode Web Bluetooth-nya.

**Update 2026-09-13:** struk sekarang otomatis menampilkan baris **Diskon** (kalau `discount_amount
> 0`) dan **Kembalian** di bawah baris metode bayar (kalau payment itu punya `change_amount > 0`) —
lihat §17 Payments buat detail `amount_tendered`/`change_amount`.

---

## 15. Purchases

Purchase = invoice bertipe `PURCHASE` (bukan purchase order — langsung jadi dokumen penerimaan barang saat completed).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/purchases?warehouse_id=1&status=DRAFT` | List |
| GET | `/api/purchases/:id` | Detail |
| POST | `/api/purchases` | Create DRAFT → `201` |
| PUT | `/api/purchases/:id` | Update — hanya DRAFT |
| DELETE | `/api/purchases/:id` | Hapus — hanya DRAFT |
| POST | `/api/purchases/:id/complete` | DRAFT → COMPLETED. **Butuh `Idempotency-Key`** |
| POST | `/api/purchases/:id/cancel` | DRAFT → CANCELLED |

Body dan struktur object identik dengan Sales (lihat di atas), bedanya `type: "PURCHASE"` dan prefix nomor dokumen `PUR-`.

**Efek `complete`:** membuat & menyelesaikan **1 transaksi INBOUND baru** yang ter-link, membuat `stock mutation IN` + `cost layer` FIFO baru per item (persis seperti inbound biasa). Tidak ada pembekuan `unit_cost`/`cost_amount` pada detail (field itu khusus untuk SALES).

---

## 16. Invoices (Gabungan Sales + Purchase)

Read-only, gabungan SALES + PURCHASE dalam satu resource untuk kebutuhan listing/filter lintas tipe.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/invoices?type=SALES&payment_status=UNPAID&status=COMPLETED&warehouse_id=1` | List, semua filter opsional |
| GET | `/api/invoices/:id` | Detail (bisa SALES atau PURCHASE) |
| GET | `/api/invoices/:id/payments` | List pembayaran untuk invoice ini, paginated |

Struktur object sama dengan [Sales](#14-sales)/[Purchases](#15-purchases). Untuk **membuat/mengubah** invoice, tetap pakai endpoint `/api/sales` atau `/api/purchases` sesuai tipenya — resource ini murni untuk read gabungan.

---

## 17. Payments

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/payments?invoice_id=1&from=2026-08-01&to=2026-08-31` | List, semua filter opsional |
| GET | `/api/payments/:id` | Detail |
| POST | `/api/payments` | Create → `201`. **Tidak butuh Idempotency-Key** |

**Body:**
```json
{ "invoice_id": 2, "amount": 297000, "amount_tendered": 300000, "payment_method": "CASH", "payment_date": "2026-08-25", "notes": null }
```
`invoice_id`, `amount` (>0), `payment_method` (lihat enum di bawah), `payment_date` wajib.
`amount_tendered` opsional (lihat "Kembalian" di bawah).

**Validasi:**
- Invoice harus berstatus `COMPLETED`, kalau tidak → `409 INVALID_STATUS`.
- `amount` tidak boleh melebihi sisa tagihan (`total_amount - total sudah dibayar`) → `409 AMOUNT_EXCEEDS_BALANCE` (message berisi angka sisa tagihan persis).
- Setelah insert, `invoices.payment_status` otomatis dihitung ulang: `UNPAID` (belum bayar) → `PARTIAL` (sebagian) → `PAID` (lunas/lebih).

**Update 2026-09-13:**
- `kasir-sales` sekarang boleh `POST /api/payments` (sebelumnya cuma `admin-bu`/`finance`) — supaya kasir bisa nyelesain satu transaksi penuh (bikin sale → complete → catat bayar) tanpa perlu admin-bu turun tangan tiap kali.
- Field baru `cash_session_id` (nullable, **server-resolved, jangan dikirim dari body** — dikirim juga ditolak schema karena `additionalProperties: false`). Kalau kasir yang mencatat lagi punya sesi kasir OPEN di warehouse invoice tsb, payment otomatis ke-tag ke sesi itu — dipakai buat rekonsiliasi kas pas tutup kasir (lihat [§20 Cash Sessions](#20-cash-sessions-sesi-kasir--shift)). `null` kalau tidak ada sesi terbuka (mis. finance mencatat pelunasan invoice B2B, bukan transaksi kasir).
- **Kembalian (`amount_tendered`/`change_amount`):** `amount` tetap berarti persis seperti dulu —
  jumlah yang benar-benar diterapkan ke saldo invoice (tidak boleh melebihi sisa tagihan, cek di
  atas tidak berubah). `amount_tendered` (opsional) = uang tunai fisik yang **benar-benar diterima**
  dari pelanggan, kalau lebih besar dari `amount`. Backend hitung `change_amount = amount_tendered -
  amount` otomatis dan simpan di record payment. Kalau tidak dikirim, `amount_tendered` default ke
  `amount` dan `change_amount` jadi `"0.00"` (pembayaran pas). `amount_tendered` **tidak boleh**
  lebih kecil dari `amount` → `400 AMOUNT_TENDERED_TOO_LOW`. Cuma relevan buat `payment_method:
  "CASH"` — buat metode lain kirim `amount_tendered` sama dengan `amount` atau tidak usah dikirim
  sama sekali.
- **`payment_method` sekarang enum**, bukan teks bebas lagi: `CASH`, `QRIS`, `DEBIT`, `CREDIT`,
  `TRANSFER`, `EWALLET`, `OTHER`. Nilai di luar itu → `400 VALIDATION_ERROR`. (Data lama yang
  sempat tersimpan sebelum enum ini ada, mis. `"Cash"`/`"transfer"`, tetap tampil apa adanya di
  response — enum cuma dicek pas nulis data baru.) Rekonsiliasi kas di [§20 Cash
  Sessions](#20-cash-sessions-sesi-kasir--shift) tetap mencocokkan `"CASH"` case-insensitive, jadi
  aman baik buat data lama maupun baru.

**Object payment:** `id, payment_number, invoice_id, cash_session_id, amount, amount_tendered, change_amount, payment_method, payment_date, notes, created_at`

---

## 18. Returns

Modul paling kompleks — retur dari customer (barang balik dari pembeli) atau ke supplier (barang balik ke pemasok).

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/returns?warehouse_id=1&type=RETURN_CUSTOMER&status=DRAFT` | List |
| GET | `/api/returns/:id` | Detail + `details[]` |
| POST | `/api/returns` | Create DRAFT → `201` |
| PUT | `/api/returns/:id` | Update — hanya DRAFT. **`type` dan referensi origin tidak bisa diubah** |
| DELETE | `/api/returns/:id` | Hapus — hanya DRAFT |
| POST | `/api/returns/:id/approve` | DRAFT → APPROVED (tidak butuh Idempotency-Key) |
| POST | `/api/returns/:id/complete` | APPROVED → COMPLETED. **Butuh `Idempotency-Key`** |
| POST | `/api/returns/:id/reject` | DRAFT/APPROVED → REJECTED |
| POST | `/api/returns/:id/cancel` | DRAFT/APPROVED → CANCELLED |

**Flow:** `DRAFT → APPROVED → COMPLETED`; `DRAFT/APPROVED → REJECTED` atau `CANCELLED`.

### Body create (RETURN_CUSTOMER)

```json
{
  "warehouse_id": 2,
  "contact_id": 2,
  "type": "RETURN_CUSTOMER",
  "original_invoice_id": 2,
  "return_date": "2026-08-25",
  "reason": "Salah warna",
  "details": [
    { "item_id": 1, "quantity": 2, "condition": "GOOD", "action": "REPLACE" }
  ]
}
```

### Body create (RETURN_SUPPLIER)

```json
{
  "warehouse_id": 2,
  "contact_id": 5,
  "type": "RETURN_SUPPLIER",
  "original_inventory_transaction_id": 5,
  "return_date": "2026-08-25",
  "reason": "Barang cacat produksi",
  "details": [
    { "item_id": 1, "quantity": 4, "condition": "GOOD", "action": "RESTOCK" }
  ]
}
```

### Aturan Validasi (dicek saat create **dan** update)

| Aturan | Konsekuensi kalau dilanggar |
|---|---|
| Tepat satu dari `original_invoice_id` / `original_inventory_transaction_id` harus terisi | `400 EXACTLY_ONE_ORIGIN_REQUIRED` |
| `RETURN_CUSTOMER` wajib pakai `original_invoice_id`; `RETURN_SUPPLIER` wajib pakai `original_inventory_transaction_id` | `400 INVALID_ORIGIN_FOR_TYPE` |
| Dokumen origin harus ada & berstatus `COMPLETED` (invoice tipe `SALES` / transaksi tipe `INBOUND`) | `400 INVALID_ORIGIN_DOCUMENT` |
| Item retur harus ada di dokumen origin | `400 ITEM_NOT_ON_ORIGINAL_DOCUMENT` |
| Quantity retur ≤ (quantity di dokumen asal − total quantity yang sudah COMPLETED diretur sebelumnya) | `409 RETURN_QUANTITY_EXCEEDS_ELIGIBLE` |
| `condition: DAMAGED` wajib `action: SCRAP` | `400 DAMAGED_MUST_BE_SCRAPPED` |
| `action: REPLACE` hanya valid untuk `RETURN_CUSTOMER` + `condition: GOOD` | `400 INVALID_REPLACE_ACTION` |

`unit_cost` per detail **selalu di-copy backend** dari HPP historis dokumen asal (frozen HPP invoice untuk customer return, `unit_price` inbound untuk supplier return) — jangan dikirim di body, tidak akan diterima kalaupun dikirim (field tidak ada di schema).

### Efek `complete`

**RETURN_CUSTOMER**, per detail:
- `condition: DAMAGED` (action SCRAP) → **tidak ada dampak apapun** ke stok/mutation/cost layer. Barang dianggap musnah.
- `condition: GOOD` + `action: RESTOCK` atau `REPLACE` → barang masuk stok lagi (`mutation RETURN_IN` + cost layer baru senilai HPP historis).
- Kalau ada baris `action: REPLACE`, sistem **tambahan** membuat **1 transaksi OUTBOUND replacement** (item & quantity sama dengan yang diretur, harga jual `0`), mengurangi stok via FIFO seperti outbound biasa. Kalau stok pengganti tidak cukup → `409 INSUFFICIENT_STOCK`, **seluruh complete di-rollback** (barang retur tidak jadi masuk stok sama sekali).

**RETURN_SUPPLIER**, per detail: selalu alokasi FIFO → `mutation RETURN_OUT` → stok berkurang, apapun `condition`/`action`-nya.

**Object detail return:** `id, item_id, sku, name, quantity, condition, action, unit_cost, total_cost`

**Object header:**
```json
{
  "id": 1, "return_number": "RET-000001", "warehouse_id": 2, "contact_id": 2,
  "type": "RETURN_CUSTOMER",
  "original_invoice_id": 2, "original_inventory_transaction_id": null,
  "replacement_inventory_transaction_id": 7,
  "status": "COMPLETED",
  "reversal_of_return_id": null, "reversal_reason": null,
  "return_date": "2026-08-25", "reason": "Salah warna",
  "approved_at": "...", "completed_at": "...", "cancelled_at": null,
  "created_at": "...", "updated_at": "..."
}
```
`replacement_inventory_transaction_id` hanya terisi kalau ada baris `REPLACE` yang berhasil di-complete.

---

## 19. Dashboard / Reporting

Semua read-only, agregasi. `warehouse_id` di semua endpoint ini **opsional** — kalau tidak diisi, agregasi lintas semua warehouse.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/dashboard/summary?warehouse_id=1&date=2026-08-23` | Gabungan stock + sales + purchases untuk 1 tanggal. `date` opsional (default hari ini) |
| GET | `/api/dashboard/stock?warehouse_id=1` | Ringkasan stok (item, quantity, nilai persediaan, low/out-of-stock) |
| GET | `/api/dashboard/sales?warehouse_id=1&from=2026-08-01&to=2026-08-31` | Total penjualan COMPLETED dalam rentang tanggal |
| GET | `/api/dashboard/purchases?warehouse_id=1&from=...&to=...` | Total pembelian COMPLETED dalam rentang tanggal |
| GET | `/api/dashboard/profit?warehouse_id=1&from=...&to=...` | Gross profit dari sales COMPLETED (revenue − HPP beku) |

**Object `/summary`:**
```json
{
  "date": "2026-08-25",
  "stock": { "total_items": 1, "total_quantity": 7, "total_value": "279000.00", "low_stock_count": 0, "out_of_stock_count": 0 },
  "sales": { "count": 1, "subtotal": "750000.00", "tax": "82500.00", "total_amount": "832500.00" },
  "purchases": { "count": 1, "subtotal": "450000.00", "tax": "49500.00", "total_amount": "499500.00" }
}
```

**Object `/stock`:** `total_items, total_quantity, total_value, low_stock_count, out_of_stock_count`

**Object `/sales` & `/purchases`:** `count, subtotal, tax, total_amount`

**Object `/profit`:**
```json
{ "revenue": "750000.00", "cogs": "135000.00", "gross_profit": "615000.00", "gross_margin_pct": 82 }
```
`revenue`/`cogs` dijumlahkan langsung dari `invoice_details.amount`/`cost_amount` milik sales COMPLETED — bukan hitung ulang FIFO, jadi cepat dan konsisten dengan HPP yang sudah dibekukan saat sale complete.

---

## 20. Cash Sessions (Sesi Kasir / Shift)

Baru 2026-09-13, roadmap operasional kasir #3. Satu sesi = satu "buka kasir → tutup kasir": kasir
input modal awal, sistem lacak semua pembayaran yang masuk selama sesi itu terbuka, lalu di akhir
kasir input hasil hitung fisik uang di laci — sistem bandingkan sama yang seharusnya ada (selisih
lebih/kurang otomatis kehitung).

**Satu user cuma boleh punya 1 sesi OPEN di satu waktu** (di warehouse mana pun) — `409
CASH_SESSION_ALREADY_OPEN` kalau nyoba buka lagi sebelum yang lama ditutup.

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/cash-sessions?warehouse_id=1&user_id=501&status=OPEN` | List, semua filter opsional |
| GET | `/api/cash-sessions/current` | Sesi OPEN milik user yang sedang login. `data: null` kalau belum ada yang dibuka — **bukan** `404` |
| GET | `/api/cash-sessions/:id` | Detail + `summary` (X-report kalau masih OPEN, Z-report kalau sudah CLOSED — bentuknya sama) |
| POST | `/api/cash-sessions/open` | Buka sesi baru → `201` |
| POST | `/api/cash-sessions/:id/expenses` | **Baru 2026-09-13.** Catat pengeluaran operasional dari laci (Kas Keluar) — lihat bagian tersendiri di bawah |
| POST | `/api/cash-sessions/:id/close` | Tutup sesi |

**Body `open`:**
```json
{ "warehouse_id": 1, "opening_amount": 100000, "notes": "shift pagi" }
```
`warehouse_id` wajib (harus warehouse milik BU sendiri — atau warehouse yang di-assign kalau
caller-nya staff dengan [assignment spesifik](./user-warehouse-assignments.md)), `opening_amount`
opsional (default 0), `notes` opsional.

**Body `close`:**
```json
{ "closing_amount": 240000, "notes": "tutup shift pagi" }
```
`closing_amount` = hasil hitung fisik uang tunai di laci saat itu (**bukan** total semua metode
bayar — cuma uang tunai fisik). Cuma bisa dipanggil pada sesi berstatus `OPEN` (`409
INVALID_STATUS` kalau sudah `CLOSED`).

**Bagaimana `cash_session_id` nempel ke payment:** setiap `POST /api/payments` otomatis dicek —
kalau user yang mencatat lagi punya sesi `OPEN` di warehouse invoice tsb, payment itu langsung
ditandai punya sesi itu. Tidak ada field yang perlu dikirim manual dari frontend soal ini sama
sekali — kasir tinggal jalan seperti biasa (buka kasir sekali di awal shift, lalu proses transaksi
seperti biasa), backend yang urus linking-nya.

**Kas Keluar / pengeluaran operasional (`POST /:id/expenses`, baru 2026-09-13):**
```json
{ "amount": 30000, "description": "Beli galon air" }
```
Buat uang yang **keluar** dari laci selama shift buat keperluan operasional (bukan sales/payment) —
misal beli galon air, ongkos kirim dadakan, dll. `description` **wajib diisi** (bukan opsional) —
tanpa alasan yang tercatat, fitur ini kehilangan gunanya sebagai audit trail. Cuma bisa dipanggil
pada sesi `OPEN` (`409 INVALID_STATUS` kalau `CLOSED`). Ditolak `409
INSUFFICIENT_CASH_IN_DRAWER` kalau `amount`-nya lebih besar dari uang yang seharusnya masih ada di
laci saat itu (modal awal + kas masuk − pengeluaran sebelumnya) — sistem gak bakal biarkan
pengeluaran bikin saldo yang seharusnya jadi negatif.

**Perhitungan saat close:**
```
expected_cash_amount = opening_amount
                      + SUM(payment.amount WHERE payment_method = 'CASH' AND cash_session_id = sesi ini)
                      - SUM(cash_session_expenses.amount WHERE cash_session_id = sesi ini)
cash_difference       = closing_amount - expected_cash_amount
```
`cash_difference` positif = uang lebih dari seharusnya, negatif = kurang (kasir defisit).
**Penting:** cuma `payment_method` yang persis `"CASH"` (case-insensitive) yang dihitung — QRIS,
transfer, debit, dll TIDAK masuk hitungan kas fisik (masuk akal, karena uangnya gak pernah masuk
laci). Lihat [§17 Payments](#17-payments) buat daftar `payment_method` yang valid.

**Object session:**
```json
{
  "id": 1, "warehouse_id": 1, "user_id": 501, "status": "CLOSED",
  "opening_amount": "100000.00", "closing_amount": "220000.00",
  "expected_cash_amount": "220000.00", "cash_difference": "0.00",
  "opened_at": "...", "closed_at": "...", "notes": "tutup shift pagi",
  "summary": {
    "by_method": [
      { "method": "CASH", "count": 1, "amount": "150000.00" }
    ],
    "total_amount": "150000.00",
    "total_count": 1,
    "expenses": [
      { "id": 1, "amount": "30000.00", "description": "Beli galon air", "created_at": "..." }
    ],
    "total_expenses": "30000.00",
    "live_expected_cash": "220000.00"
  }
}
```
`summary` selalu ada di respons `GET /:id`, `GET /current`, `POST /:id/expenses`, dan
`POST /:id/close` — `by_method` breakdown SEMUA metode bayar (bukan cuma cash), `expenses` daftar
lengkap pengeluaran selama sesi, sedang `expected_cash_amount`/`cash_difference` di level atas cuma
terisi setelah `CLOSED`. `live_expected_cash` di dalam `summary` selalu terhitung live (berguna
buat preview "kalau ditutup sekarang" selagi masih OPEN).

\* `POST /open` tidak menyertakan `summary` (sesi baru dibuka, belum ada transaksi/pengeluaran apa pun).

---

## 21. Alur Kerja Umum (Workflow Examples)

### A. Menerima barang dari supplier (Purchase)
1. `POST /api/purchases` → dapat `id` DRAFT
2. `POST /api/purchases/:id/complete` (+ header `Idempotency-Key`) → stok bertambah, FIFO layer baru terbentuk

### B. Menjual barang ke customer (Sales / POS)
1. `GET /api/items/search?q=...` → cari item
2. `POST /api/sales` → dapat `id` DRAFT, `total_amount` sudah otomatis terhitung
3. `POST /api/sales/:id/complete` (+ `Idempotency-Key`) → stok berkurang via FIFO, HPP dibekukan di detail
4. `POST /api/payments` → catat pembayaran, `payment_status` invoice ter-update otomatis

### C. Pindah stok antar gudang
1. `POST /api/stock-transfers` → DRAFT
2. `POST /api/stock-transfers/:id/approve` → APPROVED
3. `POST /api/stock-transfers/:id/complete` (+ `Idempotency-Key`) → stok pindah dengan nilai FIFO terjaga

### D. Stock opname (cek fisik)
1. `POST /api/stock-opnames` dengan `physical_qty` hasil hitung fisik → `system_qty` otomatis di-snapshot
2. `POST /api/stock-opnames/:id/submit` → SUBMITTED
3. `POST /api/stock-opnames/:id/approve` (+ `Idempotency-Key`) → selisih otomatis diposting sebagai ADJUSTMENT

### E. Customer minta tukar barang (return + replace)
1. `POST /api/returns` dengan `original_invoice_id` mengarah ke sale yang sudah COMPLETED, detail `condition: GOOD, action: REPLACE`
2. `POST /api/returns/:id/approve` → APPROVED
3. `POST /api/returns/:id/complete` (+ `Idempotency-Key`) → barang lama masuk stok di HPP historis, barang pengganti otomatis keluar via outbound gratis (unit_price 0)

### F. Retur ke supplier
1. `POST /api/returns` dengan `type: RETURN_SUPPLIER`, `original_inventory_transaction_id` mengarah ke inbound yang sudah COMPLETED
2. `POST /api/returns/:id/approve` → APPROVED
3. `POST /api/returns/:id/complete` (+ `Idempotency-Key`) → stok keluar via FIFO, mutation `RETURN_OUT`

---

## Catatan untuk Frontend

- **Selalu generate `Idempotency-Key` baru** (mis. `crypto.randomUUID()`) setiap kali user menekan tombol "Complete"/"Approve" — simpan key itu di state komponen supaya kalau request di-retry otomatis (mis. karena network error), key-nya tetap sama dan tidak memicu dampak stok dua kali.
- Semua field uang (`unit_price`, `total_amount`, dll) datang sebagai **string**, bukan number — parse dengan `parseFloat`/library desimal saat mau dihitung ulang di frontend, jangan langsung `+`/`-` sebagai number JS kalau butuh presisi.
- Cek `status` dokumen sebelum menampilkan tombol aksi: tombol "Edit"/"Delete" hanya relevan saat `DRAFT`; tombol "Complete" relevan saat status sebelum-terakhir (`DRAFT` untuk inbound/outbound/sales/purchase, `APPROVED` untuk transfer/return, `SUBMITTED` untuk opname).
- Error `409` pada aksi `complete` (`INSUFFICIENT_STOCK`, `INVALID_STATUS`, dll) berarti **tidak ada perubahan apapun** yang tersimpan (full rollback) — aman untuk retry setelah user memperbaiki kondisinya.
