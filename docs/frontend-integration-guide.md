# Frontend Integration Guide

Dokumen ini merangkum **semua update di sisi backend** (2026-08-28) yang berdampak langsung ke
cara frontend harus dibangun — auth, role, business unit, dan field audit. Ini **bukan**
pengganti [`api-documentation.md`](./api-documentation.md) (referensi lengkap tiap endpoint
resource — warehouses, items, sales, dst tetap di situ, dan sebagian isinya soal auth di sana
**sudah basi**, lihat catatan di §1). Dokumen ini fokus ke lapisan yang baru: apa yang berubah,
kenapa, dan apa yang harus dikerjakan frontend supaya langsung nyambung.

---

## Daftar Isi

1. [Yang berubah sejak `api-documentation.md` ditulis](#1-yang-berubah-sejak-api-documentationmd-ditulis)
2. [Dua backend terpisah](#2-dua-backend-terpisah)
3. [Alur autentikasi](#3-alur-autentikasi)
4. [Memanggil warehouse-backend dengan token](#4-memanggil-warehouse-backend-dengan-token)
5. [Role & implikasi UI](#5-role--implikasi-ui)
6. [Business Unit scoping](#6-business-unit-scoping)
7. [Visibilitas HPP](#7-visibilitas-hpp)
8. [Field audit baru di semua dokumen](#8-field-audit-baru-di-semua-dokumen)
9. [Activity Logs (modul baru)](#9-activity-logs-modul-baru)
10. [Error handling: auth vs error bisnis](#10-error-handling-auth-vs-error-bisnis)
11. [Status rollout saat ini (AUTH_MODE)](#11-status-rollout-saat-ini-auth_mode)
12. [Checklist implementasi frontend](#12-checklist-implementasi-frontend)
13. [Akun test & data seed](#13-akun-test--data-seed)
14. [Multi-tenant: role `owner` & multi-BU (2026-09-08)](#14-multi-tenant-role-owner--multi-bu-2026-09-08)
15. [Items & Contacts sekarang di-scope per BU (2026-09-08)](#15-items--contacts-sekarang-di-scope-per-bu-2026-09-08)
16. [Auto-provisioning warehouse utama (2026-09-08)](#16-auto-provisioning-warehouse-utama-2026-09-08)

---

## 1. Yang berubah sejak `api-documentation.md` ditulis

`api-documentation.md` dibuat 2026-08-25, **sebelum** auth diimplementasikan. Bagian
["Autentikasi" di situ](./api-documentation.md#1-konvensi-umum) masih bilang *"Belum ada. Tidak
ada header auth yang dibutuhkan saat ini"* — **itu sudah tidak akurat**. Semua endpoint
`/api/*` di warehouse-backend sekarang mengenali identitas lewat header
`Authorization: Bearer <token>`. Selain itu, sejak tanggal itu juga ditambahkan:

- Kolom audit (`created_by`, `approved_by`, `completed_by`) di semua dokumen transaksional (§8)
- Modul baru `activity-logs` (§9)
- Filter otomatis per business unit di semua endpoint list (§6)
- Pembatasan akses ke data HPP/cost berdasar role (§7)

Selebihnya (bentuk body, field bisnis, alur status DRAFT→COMPLETED, dst) di
`api-documentation.md` **masih akurat** — tetap jadi rujukan utama untuk itu.

---

## 2. Dua backend terpisah

| | Auth backend | Warehouse backend |
|---|---|---|
| Fungsi | Login, register, kelola user & business unit, terbitkan token | Semua data bisnis (warehouses, items, sales, dst) |
| Base URL (dev) | `http://localhost:5020` | `http://localhost:3000` |
| Prefix | **Tidak pakai** `/api` (`/auth/login`, bukan `/api/auth/login`) | `/api/*` |
| Auth diri sendiri | Ya, terbitkan JWT | Tidak — cuma **verifikasi** JWT dari auth-backend |

Frontend perlu tahu dua base URL ini (mis. `VITE_AUTH_API_URL` dan `VITE_WAREHOUSE_API_URL`).
Keduanya sudah dikonfigurasi CORS untuk `http://localhost:5173` (default Vite dev server) —
kalau frontend jalan di port lain, update `CORS_ORIGIN` (warehouse-backend `.env`) dan
`CLIENT_ORIGIN` (auth-backend `.env`), lalu restart kedua server.

---

## 3. Alur autentikasi

### Login

```
POST http://localhost:5020/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "..." }
```

Response (200):
```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "access_token": "eyJhbGciOiJSUzI1NiIs...",
    "refresh_token": "refresh_BZWo73bak8...",
    "token_type": "Bearer",
    "expires_in": 900,
    "refresh_token_expires_at": "2026-09-04T05:36:28.678Z",
    "user": {
      "id": 23,
      "name": "BU-A Admin",
      "email": "admina@test.local",
      "role": "admin-bu",
      "bu_id": 11,
      "bu_name": "Business Unit A",
      "status": "ACTIVE",
      "email_verified_at": null,
      "last_login": "2026-08-28T05:14:59.000Z",
      "created_at": "...",
      "updated_at": "..."
    }
  }
}
```

- **`access_token`** — JWT RS256, umur pendek (`expires_in` detik, default 900 = 15 menit). Ini
  yang dikirim ke warehouse-backend di tiap request (§4).
  - Isi klaimnya: `user_id`, `role`, `bu_id`, `iss`, `aud`, `exp` — frontend **tidak perlu**
    decode ini sendiri, semua info yang dibutuhkan sudah ada di `data.user`.
- **`refresh_token`** — dipakai buat dapat access token baru tanpa login ulang. Auth-backend
  juga set ini (dan access token) sebagai **httpOnly cookie** otomatis (`credentials: true` di
  CORS-nya) — kalau frontend cuma jalan di browser yang sama origin-nya diizinkan, cookie ini
  bisa dipakai sebagai alternatif ke localStorage. Paling aman: simpan `access_token` di memori
  (state, bukan localStorage, buat kurangi risiko XSS), `refresh_token` boleh di storage yang
  lebih persisten (localStorage/cookie) karena cuma dipakai buat `/auth/refresh`.
- **`user.bu_id: null`** → super-admin, akses lintas semua business unit.
- **`user.bu_name`** — sudah di-resolve backend, frontend **tidak perlu** panggil endpoint lain
  buat dapat nama BU sendiri.

### Refresh

```
POST http://localhost:5020/auth/refresh
Content-Type: application/json

{ "refresh_token": "refresh_BZWo73bak8..." }
```
(atau kirim lewat cookie kalau login sebelumnya set cookie — endpoint ini baca
`req.body.refresh_token || req.cookies.refresh_token`.)

Response sama persis seperti login (`access_token` + `refresh_token` **baru** — refresh token
lama langsung tidak berlaku, jangan dipakai ulang / reuse terdeteksi & semua token user
di-revoke sebagai proteksi pencurian token).

**Kapan refresh:** access token cuma hidup 15 menit. Pola yang disarankan: refresh proaktif
beberapa menit sebelum `expires_in` habis, atau reaktif saat warehouse-backend balikin `401` —
lihat §10.

### Logout

```
POST http://localhost:5020/auth/logout
Content-Type: application/json

{ "refresh_token": "..." }
```
Mencabut refresh token itu. Hapus `access_token` dari memori/state frontend setelahnya — tidak
ada cara "cabut" access token yang sudah terbit sebelum `exp`-nya lewat (itu sifat JWT
stateless), jadi 15 menit adalah window maksimum token lama masih valid meski sudah "logout".

---

## 4. Memanggil warehouse-backend dengan token

Setiap request ke `http://localhost:3000/api/*` (kecuali `GET /health` dan `GET /documentation`)
butuh header:

```
Authorization: Bearer <access_token>
```

Contoh:
```
GET http://localhost:3000/api/sales
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

Tidak ada endpoint di warehouse-backend untuk login/register — itu semua di auth-backend (§2/§3).
Warehouse-backend murni **memverifikasi** token yang dikirim (lewat JWKS auth-backend), tidak
pernah menerbitkannya sendiri.

---

## 5. Role & implikasi UI

**Update 2026-09-08:** ada role ke-7, `owner` — lihat §14 buat detail lengkap. Ringkas: view-only
lintas semua BU dalam satu company, ditambahkan ke tabel di bawah tapi baris "Bisa nulis"-nya
selalu kosong (memang begitu, bukan kelupaan).

Hierarki: `super-admin` (lintas semua company/BU) → `owner` (lintas semua BU **dalam satu
company**, view-only) → `admin-bu` (kelola satu/lebih BU — bisa >1 kalau di-grant, §14) →
4 role operasional dalam satu BU.

| Role | Bisa nulis (create/update/delete) | Approve/reject |
|---|---|---|
| **super-admin** | Semua resource, semua BU | Semua |
| **owner** | — (view-only, semua endpoint tulis 403) | — |
| **admin-bu** | Semua resource, BU sendiri (+ BU hasil grant, §14) | stock-transfers, stock-opnames, returns |
| **staff-gudang** | inbounds, outbounds, stock-transfers, stock-opnames, returns | submit stock-opname |
| **kasir-sales** | contacts, outbounds, sales, returns | — |
| **purchasing** | items, contacts, inbounds, purchases | — |
| **finance** | payments | — |

`warehouses` (master data warehouse) **cuma admin-bu/super-admin** yang bisa create/edit/hapus.

**Implikasi buat UI:**
- Sembunyikan/nonaktifkan tombol create/edit/delete/approve untuk resource yang role user
  saat ini tidak boleh sentuh — cek dari tabel di atas, bukan cuma andalkan backend nolak
  `403` (lebih baik untuk UX, meski backend tetap jadi validasi terakhir yang sebenarnya).
- Semua **read (GET)** terbuka untuk semua role yang login, **kecuali** data HPP — lihat §7.
- Role user aktif ada di `user.role` dari response login (§3), simpan di state/context auth
  frontend, pakai buat kondisional render.

---

## 6. Business Unit scoping

**Update 2026-09-08:** scope akses sekarang bisa lebih dari satu BU (grant `admin-bu`, atau
`owner` lintas company) — lihat §14. Yang di bawah ini (behavior dari sisi frontend) **tidak
berubah sama sekali**, cuma sekarang "BU-nya sendiri" bisa berarti lebih dari satu BU.

Satu business unit (`bu_id`) bisa punya **banyak warehouse** (bukan 1:1). User biasa (`bu_id`
bukan `null`) otomatis hanya melihat data warehouse-warehouse milik BU-nya sendiri (atau BU-BU
yang dia punya akses, §14) —
**ini otomatis di backend, frontend tidak perlu kirim filter apa pun** untuk itu:

- `GET /api/sales` (tanpa `?warehouse_id`) untuk user BU-A → cuma baris dari warehouse BU-A.
- Kalau frontend secara eksplisit kirim `?warehouse_id=<id warehouse BU lain>` → ditolak
  `403 FORBIDDEN`. Jadi **dropdown pilihan warehouse di form manapun harus difilter ke
  warehouse milik BU user sendiri** (dari `GET /api/warehouses`, yang juga sudah otomatis
  ke-filter) — jangan biarkan user pilih/ketik ID warehouse BU lain, karena pasti 403.
- `super-admin` (`bu_id: null`) tidak kena filter ini — lihat semua warehouse semua BU, dan
  boleh pilih warehouse mana pun.

---

## 7. Visibilitas HPP

Tiga endpoint berikut **menolak** role `staff-gudang` dan `kasir-sales` dengan `403 FORBIDDEN`
(bahkan `401` kalau tidak ada token sama sekali — endpoint ini tidak lenient seperti endpoint
lain):

- `GET /api/cost-layers`, `GET /api/cost-layers/:id`
- `GET /api/cost-summary`
- `GET /api/dashboard/profit`

Yang boleh akses: `super-admin`, `admin-bu`, `purchasing`, `finance`.

**Implikasi UI:** kalau user login sebagai `staff-gudang`/`kasir-sales`, **sembunyikan total**
menu/tab/kartu dashboard yang menampilkan HPP, COGS, atau gross margin — jangan cuma
menyembunyikan lalu tetap manggil API-nya (bakal dapat 403 yang tidak perlu, atau lebih buruk,
nge-log noise di sisi backend).

**Catatan:** `GET /api/dashboard/stock` dan `GET /api/dashboard/summary` **tidak** kena
pembatasan ini meski keduanya membawa field `total_value` (nilai stok = qty × unit cost
teragregasi) — jadi field itu tetap kelihatan oleh semua role. Ini keputusan sadar (bukan
kelupaan), tapi kalau ternyata itu juga dianggap terlalu sensitif buat staff-gudang/kasir-sales,
kasih tahu — itu perubahan kecil di backend.

---

## 8. Field audit baru di semua dokumen

Semua dokumen transaksional (inbounds, outbounds, sales, purchases, stock-transfers,
stock-opnames, returns) sekarang punya kolom tambahan di response:

```json
{
  "created_by": 24,
  "approved_by": null,
  "completed_by": 23
}
```

- Nilainya **angka `user_id` mentah** (dari auth-backend), **bukan** nama — warehouse-backend
  sengaja tidak simpan tabel user sendiri, biar tidak ada dua sumber kebenaran soal siapa-user-siapa.
- `approved_by`/`completed_by` cuma terisi untuk dokumen yang memang punya tahap approve/complete
  itu (mis. `outbounds` tidak punya `approved_by` karena tidak ada langkah approve di alurnya).

**Cara resolve `user_id` → nama untuk ditampilkan di UI ("Dibuat oleh: ...")** — panggil
auth-backend:

```
GET http://localhost:5020/users/:id
Authorization: Bearer <access_token>
```

⚠️ **Gotcha penting:** endpoint ini **admin-only** di auth-backend (`super-admin`/`admin-bu`
saja) — role operasional (`staff-gudang`, `kasir-sales`, `purchasing`, `finance`) akan dapat
`403` kalau coba resolve nama user lain lewat endpoint ini. Untuk role non-admin, opsinya:
- Cuma tampilkan `user_id` mentah (atau "User #24") kalau bukan `admin-bu`/`super-admin` yang
  login, ATAU
- Minta admin-bu bikin daftar user timnya sekali (cache di frontend/state global saat admin
  login), lalu untuk role lain **jangan** coba resolve individual — cukup tampilkan ID, ATAU
- (kalau memang dibutuhkan) minta tim auth-backend buka endpoint read-only terbatas
  (`id, name` saja, bukan `email`/`role`) untuk semua role terautentikasi — ini perubahan di
  repo auth-backend, bukan di sini.

`GET /users/me` (auth-backend) selalu boleh dipanggil siapa pun yang login untuk resolve
identitas **diri sendiri**.

---

## 9. Activity Logs (modul baru)

Endpoint baru, read-only, belum ada di `api-documentation.md`:

```
GET /api/activity-logs?user_id=23&warehouse_id=22&entity_type=sales&entity_id=7&action=complete&from=2026-08-01&to=2026-08-31
GET /api/activity-logs/:id
```

Semua field query opsional.

**Update 2026-09-09:** sempat ketahuan modul ini **kelewat** waktu rollout BU-scoping (jadi
sempat kebuka lintas-tenant penuh, terus dikasih stopgap `super-admin`-only sementara) — sekarang
sudah di-scope beneran per BU, sama seperti resource lain. `GET /api/activity-logs` otomatis
cuma balikin log milik BU (BU-BU) caller sendiri; `super-admin` tetap lihat semua termasuk baris
lama yang `bu_id`-nya `null` (dari sebelum kolom ini ada, tidak bisa dipetakan lagi). Akses
`GET /:id` ke log di luar scope → **`404 NOT_FOUND`** (bukan `403`) — sengaja, biar tidak
kebocor bahwa log itu ada.

**Object activity-log:**
```json
{
  "id": 501,
  "user_id": 23,
  "warehouse_id": 22,
  "bu_id": 13,
  "action": "complete",
  "entity_type": "sales",
  "entity_id": 7,
  "method": "POST",
  "endpoint": "/api/sales/7/complete",
  "status_code": 200,
  "metadata": {},
  "created_at": "2026-08-28 12:15:44.100"
}
```

Log ini otomatis tercatat backend untuk **setiap** request yang mengubah data (bukan cuma
dokumen transaksional) — `action` diturunkan dari method HTTP + path (`create`, `update`,
`delete`, `complete`, `approve`, dst). `user_id` di sini punya gotcha resolve-nama yang sama
seperti §8.

---

## 10. Error handling: auth vs error bisnis

Semua error dari warehouse-backend tetap pakai amplop yang sama
([lihat `api-documentation.md` §1](./api-documentation.md#1-konvensi-umum)):
```json
{ "error": { "code": "SOME_CODE", "message": "...", "details": [] } }
```

Dua kode baru yang **khusus auth**, beda penanganan dari error bisnis biasa (409/400 validasi):

| HTTP | `code` | Kapan | Aksi yang benar di frontend |
|---|---|---|---|
| 401 | `UNAUTHORIZED` | Token tidak ada / expired / signature invalid | **Coba refresh token** (§3) sekali, kalau refresh juga gagal → paksa logout, redirect ke halaman login |
| 403 | `FORBIDDEN` | Token valid, tapi role tidak diizinkan (§5) atau warehouse target di luar BU user (§6) atau HPP (§7) | **Jangan** coba refresh — token-nya valid, cuma memang tidak berhak. Tampilkan pesan "tidak punya akses", jangan logout paksa |

Pola yang disarankan: interceptor HTTP client (axios/fetch wrapper) yang cek `error.code` dari
body respons (bukan cuma status code — 401 dari server lain/proxy bisa punya makna beda), retry
sekali dengan token baru kalau `UNAUTHORIZED`, dan biarkan `FORBIDDEN` naik ke komponen buat
ditampilkan sebagai pesan biasa.

---

## 11. Status rollout saat ini (AUTH_MODE)

Warehouse-backend jalan dengan `AUTH_MODE=hybrid` **sekarang** (bisa berubah — cek `.env` server
kalau ragu). Artinya:

- Kalau frontend **kirim** `Authorization: Bearer <token>` yang valid → dipakai, semuanya
  seperti dijelaskan di atas.
- Kalau frontend **tidak kirim token sama sekali** → request tetap **diterima** (tidak 401),
  tapi `request.userContext` kosong (`userId: null, role: null, buId: null`) — artinya
  **tidak ada filter BU, tidak ada pembatasan role** kecuali endpoint HPP (§7) yang memang
  reject total tanpa identitas.
- Ini **window transisi** — begitu frontend konsisten kirim Bearer token, `AUTH_MODE` akan
  dipindah ke `jwt` (strict, token wajib di semua `/api/*`) dan window ini ditutup. **Jangan
  bangun fitur yang mengandalkan perilaku "tanpa token masih jalan"** — anggap token selalu
  wajib sejak awal, supaya tidak ada kerja ulang saat mode strict diaktifkan.

---

## 12. Checklist implementasi frontend

- [ ] Dua base URL terpisah (auth-backend `:5020` tanpa prefix, warehouse-backend `:3000/api`)
- [ ] Halaman/flow login → simpan `access_token` (memori) + `refresh_token` (storage persisten)
- [ ] HTTP client warehouse-backend selalu attach `Authorization: Bearer <access_token>`
- [ ] Interceptor: `401 UNAUTHORIZED` → refresh sekali → retry; gagal → logout paksa
- [ ] Interceptor: `403 FORBIDDEN` → tampilkan pesan akses ditolak, **jangan** logout
- [ ] State/context global nyimpen `user.role` dan `user.bu_id` dari response login, dipakai
      buat render kondisional (§5)
- [ ] Dropdown warehouse di semua form difilter dari `GET /api/warehouses` (sudah otomatis
      ke-scope BU), jangan hardcode/manual-entry ID warehouse
- [ ] Menu/kartu dashboard HPP disembunyikan total untuk `staff-gudang`/`kasir-sales` (§7)
- [ ] Tampilan "dibuat/disetujui/diselesaikan oleh" pakai `created_by`/`approved_by`/`completed_by`
      + strategi resolve-nama yang sadar keterbatasan admin-only (§8)
- [ ] (Opsional, kalau dibutuhkan) halaman activity log pakai `GET /api/activity-logs` (§9)

---

## 13. Akun test & data seed

Database dev (`warehouse_db` + `auth_db`) sudah di-reset bersih dan diisi ulang dengan data
baseline (2026-08-29), lalu ditambah 1 BU kedua (2026-08-30) khusus buat testing perbandingan
antar-BU dan hierarki warehouse — siap dipakai langsung, tidak perlu bikin data sendiri buat mulai.

Ada **2 business unit berisi data** sekarang: `PUSAT` (1 warehouse, flat) dan `BU-C` (2
warehouse, utama+cabang) — sengaja dibuat beda struktur biar keliatan behavior BU-scoping-nya
(login BU-C sama sekali tidak bisa lihat data PUSAT, dan sebaliknya) dan hierarki warehouse-nya
(§ dokumen [`warehouse-hierarchy.md`](./warehouse-hierarchy.md)).

### Akun login

Password sama semua: **`Admin12345`**

| Email | Role | `bu_id` | Cocok buat testing apa |
|---|---|---|---|
| `superadmin@test.local` | `super-admin` | — (global) | Akses lintas semua BU, lihat HPP, kelola business unit |
| `admin.pusat@test.local` | `admin-bu` | 13 (PUSAT) | Kelola penuh BU PUSAT, approve stock-transfer/opname/return, lihat HPP |
| `staff.pusat@test.local` | `staff-gudang` | 13 (PUSAT) | Inbound/outbound/transfer/opname — **HPP ke-block** (§7) |
| `kasir.pusat@test.local` | `kasir-sales` | 13 (PUSAT) | Alur sales/POS — **HPP ke-block** (§7) |
| `purchasing.pusat@test.local` | `purchasing` | 13 (PUSAT) | Kelola item, alur purchase |
| `finance.pusat@test.local` | `finance` | 13 (PUSAT) | Kelola payment |
| `admin.buc@test.local` | `admin-bu` | 15 (BU-C) | Sama seperti `admin.pusat`, tapi buat BU kedua — bandingkan isolasinya |
| `staff.buc@test.local` | `staff-gudang` | 15 (BU-C) | Operasional gudang BU-C |
| `kasir.buc@test.local` | `kasir-sales` | 15 (BU-C) | Alur sales/POS BU-C |
| `owner@test.local` | `owner` | — (`company_id: 1`, `bu_ids` = semua BU company) | Testing role baru (§14) — lihat semua warehouse PUSAT+BU-C sekaligus, semua tulis harus 403 |

**Catatan (2026-09-08):** `admin.pusat` sudah di-grant akses tambahan ke BU-C (`bu_ids: [13, 15]`)
buat testing skenario multi-BU §14 — login ulang untuk dapat token dengan `bu_ids` terbaru kalau
sempat login sebelum grant ini dibuat (token lama masih `bu_ids: [13]` sampai expire, ≤15 menit).

Login lewat auth-backend seperti biasa (§3): `POST http://localhost:5020/auth/login`.

⚠️ **Rate limit**: `/auth/login` punya **dua** limiter sekaligus, dua-duanya 5 percobaan / 15
menit — satu **per IP** (`strictAuthRateLimiter`, jadi kena walau beda-beda email tiap coba),
satu lagi **per email** (`perEmailRateLimiter`). Kalau testing berkali-kali dan kena
`"Too many attempts. Please try again later."` — itu bukan bug, tunggu saja atau restart
auth-backend (dua-duanya in-memory, reset begitu proses restart).

### Data warehouse — BU PUSAT (`bu_id: 13`)

- 1 warehouse utama: `WH-PUSAT` (Gudang Pusat), `parent_warehouse_id: null` — semua akun
  `*.pusat@test.local` di atas bisa akses warehouse ini.
- 5 item, semuanya sudah punya **stok terisi** lewat inbound COMPLETED sungguhan (bukan raw
  insert — jadi `stock_mutations`/`inventory_cost_layers`/FIFO cost-nya konsisten):

  | SKU | Nama | Stok | Cost (FIFO) | Harga jual |
  |---|---|---|---|---|
  | SKU-001 | Router TP-Link | 50 pcs | 100.000 | 150.000 |
  | SKU-002 | Kabel LAN Cat6 100m | 20 roll | 300.000 | 450.000 |
  | SKU-003 | Switch 8 Port | 30 pcs | 170.000 | 250.000 |
  | SKU-004 | Access Point WiFi | 25 pcs | 220.000 | 320.000 |
  | SKU-005 | Kabel Power | 100 pcs | 15.000 | 25.000 |

- 4 contact: 2 supplier (PT Sumber Jaya Elektronik, CV Mitra Teknologi), 2 customer (Budi
  Santoso, Toko Makmur Jaya).

### Data warehouse — BU-C (`bu_id: 15`)

- **2 warehouse berhierarki** (fitur main/branch, §`warehouse-hierarchy.md`):
  `WH-C-PUSAT` (utama, `parent_warehouse_id: null`) dan `WH-C-CABANG` (cabang,
  `parent_warehouse_id` menunjuk ke `WH-C-PUSAT`). Semua akun `*.buc@test.local` bisa akses
  keduanya.
- Item **sama** dengan BU PUSAT (SKU-001–005 — `items` itu master data global, bukan per-BU),
  tapi **stoknya beda** per warehouse, sengaja dibuat asimetris buat perbandingan:

  | SKU | Stok di `WH-C-PUSAT` | Stok di `WH-C-CABANG` |
  |---|---|---|
  | SKU-001 Router TP-Link | 40 | 10 |
  | SKU-002 Kabel LAN Cat6 100m | 15 | — |
  | SKU-003 Switch 8 Port | 20 | 8 |
  | SKU-004 Access Point WiFi | 18 | — |
  | SKU-005 Kabel Power | 80 | 25 |

- 2 contact baru: PT Surya Elektrindo (supplier), Toko Jaya Makmur Surabaya (customer) — tapi
  ingat, `contacts` juga global, jadi contact BU PUSAT di atas tetap kepakai/kelihatan juga di
  sini (bukan bug — memang tidak di-scope per-BU di skema ini).

Semua item di atas punya margin beneran antara cost dan harga jual, jadi kalau mau nge-test alur
sales → lihat `gross_margin_pct` di `GET /api/dashboard/profit` (butuh role yang boleh lihat
HPP — §7), angkanya bakal masuk akal, tidak nol/aneh.

### Reset ulang kalau perlu

**Update 2026-09-06**: sempat ada bug nyata gara-gara ini — lihat
[`bug-report-bu-id-mismatch.md`](./bug-report-bu-id-mismatch.md). `business_units.id` di
auth-backend itu auto-increment dan **bergeser** tiap `auth_db` di-reseed, jadi
`warehouses.bu_id` di sini **tidak boleh pernah** di-hardcode ke angka tertentu — harus selalu
di-resolve dari `code` (`PUSAT`, `BU-C`) saat itu juga. Aturan urutan yang sekarang wajib
dipegang: **auth-backend duluan** (business unit + user-nya harus sudah ada), **baru**
warehouse-backend di-seed sesudahnya — tidak boleh dikerjakan independen di waktu terpisah.

Kalau data testing kotor lagi dan mau mulai dari nol (bukan sesuatu yang perlu frontend jalankan
sendiri, tapi berguna diketahui — minta ke tim warehouse-backend kalau butuh reset):

1. [`scripts/reset-warehouse-db.sql`](../scripts/reset-warehouse-db.sql) — kosongkan semua tabel
   data, struktur & migration tracking tetap aman.
2. Pastikan business unit `PUSAT` dan `BU-C` sudah ada & `ACTIVE` di auth-backend (super-admin
   `POST /business-units` kalau belum).
3. [`scripts/seed-baseline.mjs`](../scripts/seed-baseline.mjs) — isi ulang bagian BU PUSAT
   (warehouse + item + contact). **Bukan `.sql` lagi** — ini script Node yang manggil
   auth-backend buat resolve `bu_id` dari code `"PUSAT"` di setiap run, jadi tidak akan pernah
   nyasar seperti insiden kemarin. Jalankan: `node scripts/seed-baseline.mjs`.
4. [`scripts/seed-bu-c.mjs`](../scripts/seed-bu-c.mjs) — isi ulang bagian BU-C (2 warehouse
   berhierarki + 2 contact), sama-sama resolve dari code `"BU-C"`. Jalankan:
   `node scripts/seed-bu-c.mjs`. (User-user `*.buc@test.local` dibuat lewat auth-backend, bukan
   script ini — lihat catatan di sana.)
5. Stok tidak ikut ke-seed di kedua script — inbound-kan lagi lewat API (§ di atas) supaya
   `stock_mutations`/FIFO cost layer-nya konsisten.

---

## 14. Multi-tenant: role `owner` & multi-BU (2026-09-08)

Auth-backend sekarang multi-tenant. Kontrak token berubah — **field baru, field lama tetap ada**,
jadi ini additive dari sisi bentuk data, tapi ada satu role baru dengan implikasi UI nyata.

### Klaim token yang baru

```json
{
  "role": "admin-bu",
  "bu_id": 13,
  "bu_ids": [13, 15],
  "company_id": null,
  "aud": ["skinet-auth-api", "warehouse-system-api"]
}
```

- **`bu_ids`** (array of int, atau `null`) — BU mana saja yang boleh diakses user ini. Ini yang
  dipakai backend buat scoping sekarang, **bukan** `bu_id` lagi.
- **`bu_id`** (tetap ada, singular) — cuma "BU asal/home" user, buat referensi (mis. label di UI
  "user ini home-nya BU mana"). Jangan dipakai buat logika akses di frontend.
- **`company_id`** — cuma terisi untuk `owner`. Frontend boleh abaikan; scoping owner tetap lewat
  `bu_ids` yang sudah dihitung backend.
- **`aud`** jadi array (dulu string tunggal) — **tidak ada dampak apa pun** ke frontend, `Bearer`
  token dikirim persis sama seperti sebelumnya.

### Role baru: `owner`

View-only lintas **semua BU dalam satu company** (bukan lintas semua company — itu `super-admin`).
- `GET` di endpoint mana pun: sama seperti role lain, `bu_ids`-nya otomatis mencakup semua BU
  company itu, jadi list/dashboard/dst langsung menampilkan gabungan semua BU tanpa frontend
  perlu switch-BU manual.
- **Semua** `POST`/`PUT`/`DELETE` (create/update/delete/approve/submit/reject di resource mana
  pun): `403 FORBIDDEN`. Sembunyikan **semua** tombol aksi tulis kalau `user.role === 'owner'` —
  jangan cuma sebagian, backend menolak tanpa kecuali.
- **Boleh** lihat HPP/profit (§7) — `owner` sudah termasuk di `HPP_VISIBLE_ROLES`.

### `admin-bu` bisa punya akses ke lebih dari satu BU (grant)

`admin-bu` yang di-grant BU tambahan (oleh admin-bu native BU itu, atau super-admin — endpoint
`POST /users/:id/grants` di auth-backend, bukan warehouse-backend) akan punya `bu_ids` berisi
lebih dari satu id. Dampaknya ke frontend **sepenuhnya transparan** — dropdown warehouse
(`GET /api/warehouses`) otomatis menampilkan warehouse dari semua BU yang di-grant, list resource
apa pun (`GET /api/sales`, dst) otomatis gabungan semua BU itu juga. Tidak perlu UI switch-tenant
eksplisit — user cukup lihat data gabungan seolah satu scope besar.

**Satu hal yang perlu UI-nya kalau relevan:** kalau mau menampilkan "BU mana yang sedang dilihat"
per baris data (berguna kalau admin-bu ber-grant lihat data campuran dari 2+ BU dalam satu list),
setiap objek warehouse yang dikembalikan `GET /api/warehouses` sudah punya field `bu_id` — tinggal
dipetakan ke nama BU kalau frontend punya cara resolve `bu_id` → nama (lewat `bu_name` di response
login untuk BU sendiri, atau simpan daftar BU yang pernah terlihat).

### Yang TIDAK berubah

- Alur login/refresh/token attach (§3/§4) — sama persis.
- Role 6 lama (`super-admin`...`finance`) dan hak mereka (§5) — tidak berubah, cuma nambah `owner`.
- Error handling (§10) — `owner` yang ditolak write tetap `403 FORBIDDEN`, pola sama seperti role
  lain yang ditolak.

### Status

Sudah **live di auth-backend dev** dan **sudah diimplementasikan + diverifikasi live** di
warehouse-backend (bukan cuma unit test) — 3 skenario dites langsung terhadap server yang benar-benar
jalan: admin-bu ber-grant lihat warehouse di 2 BU sekaligus, owner lihat semua warehouse
company tapi semua tulis ditolak (HPP tetap boleh), staff tetap ter-kunci ke 1 BU. Detail teknis
di `docs/auth-multitenant-coordination.md` (bukan untuk dibaca frontend, itu dokumen koordinasi
internal dua backend).

---

## 15. Items & Contacts sekarang di-scope per BU (2026-09-08)

**Bug nyata yang ditemukan:** bikin company baru ("PT. Cakrawala Abadi", tenant terpisah sama
sekali dari company lain) → warehouse-nya sendiri sudah benar ter-scope, tapi halaman **Item**
menampilkan item milik company lain — karena `items`/`contacts` dulu **sama sekali tidak** punya
`bu_id`, murni master data global. Sudah ditutup penuh, dua lapis:

1. **`items`/`contacts` sekarang punya `bu_id` sendiri**, persis seperti `warehouses`. `GET
   /api/items`/`GET /api/contacts` otomatis ke-filter ke BU pemanggil (sama seperti resource
   lain — frontend tidak perlu kirim filter apa pun). Akses langsung ke item/contact milik BU
   lain (`GET`/`PUT /:id`) → `403 FORBIDDEN`. `bu_id` di body create/update **diabaikan dari
   client** dan di-force server-side, sama seperti `warehouses`.
2. **Referensi `item_id`/`contact_id` di transaksi juga divalidasi** — sebelumnya cuma listnya
   yang ke-filter, tapi `POST`/`PUT` ke inbound/outbound/sales/purchase/return/stock-transfer/
   stock-opname tetap bisa "nyolong" referensi ke item BU lain kalau ID-nya ditebak/diketahui.
   Sekarang ditolak `403 FORBIDDEN` juga (`"item 5 is outside your business unit"` /
   `"contact 12 is outside your business unit"`).

**Implikasi UI:** dropdown pemilihan item/contact di form manapun (bikin inbound, sales, dst)
harus diisi dari `GET /api/items` / `GET /api/contacts` (yang sudah otomatis ke-filter) — jangan
pernah hardcode atau cache ID item/contact lintas sesi/lintas BU, karena sekarang benar-benar
akan ditolak kalau BU-nya beda.

**Data lama (dari sebelum fix ini):** item/contact yang sudah ada sebelum 2026-09-08 di-backfill
ke BU `PUSAT` (bukan dibiarkan tanpa BU) — jadi tidak hilang, cuma sekarang kepemilikannya
eksplisit. BU/company baru mulai dari katalog item/contact kosong, bukan warisan data lama.

---

## 16. Auto-provisioning warehouse utama (2026-09-08)

Bikin BU/company baru **tidak otomatis** dapat warehouse — itu tetap langkah terpisah. Yang baru:
sekarang ada endpoint buat "mengotomatiskan"-nya dari sisi frontend, tinggal dipanggil sekali di
alur pembuatan BU:

```
POST http://localhost:3000/api/warehouses/provision-default
Authorization: Bearer <access_token super-admin>
Content-Type: application/json

{ "bu_id": 29 }
```

**Kapan manggilnya:** tepat setelah `POST /business-units` (auth-backend) sukses — pakai `id` BU
yang baru dibuat. Aman dipanggil dari alur "create company/BU" di frontend sebagai langkah
lanjutan otomatis, user tidak perlu klik "buat warehouse" manual lagi.

**Sifatnya idempotent** — kalau dipanggil lagi (misal user retry karena network error) dan BU itu
ternyata sudah punya warehouse utama, endpoint ini **tidak** membuat yang kedua — cuma
mengembalikan yang sudah ada. Beda status code buat bedain: `201` = baru dibuat, `200` = sudah
ada sebelumnya. Response body-nya sama bentuknya di dua kasus (`{ "data": {...warehouse} }`),
jadi frontend biasanya tidak perlu peduli status code-nya kecuali mau kasih pesan beda
("Warehouse utama dibuat" vs "Warehouse utama sudah ada").

Nama & kode warehouse-nya **diturunkan otomatis** dari nama/`code` BU (mis. "Gudang Utama
<nama BU>") — tidak perlu diisi manual. Kalau nanti mau nama/kode beda dari default itu, tinggal
`PUT /api/warehouses/:id` seperti biasa setelahnya.

`bu_id` yang dikirim harus BU milik caller sendiri (kecuali dipanggil sebagai `super-admin`, yang
bebas untuk BU mana pun) — `403 FORBIDDEN` kalau tidak. Karena BU baru biasanya belum punya
admin-bu yang sudah login di titik ini (`super-admin` yang bikin BU-nya duluan), realistisnya
endpoint ini dipanggil pakai token `super-admin` yang sama yang dipakai untuk `POST
/business-units`.

---

## 17. Assign staff ke warehouse spesifik (2026-09-09)

Fitur baru: kalau satu BU punya lebih dari satu warehouse (mis. "Gudang Pusat" + "Gudang
Cabang"), sekarang staff-level user (`staff-gudang`, `kasir-sales`, `purchasing`, `finance`) bisa
di-scope ke warehouse tertentu saja — bukan cuma ke level BU seperti sebelumnya. `admin-bu`,
`owner`, dan `super-admin` **tidak** kena fitur ini, scope mereka tetap seperti biasa.

**Ini murni fitur warehouse-backend** — tidak ada perubahan token/klaim di auth-backend. Field
`nama`/`email`/`role` di form tambah user tetap 3 field itu saja; assignment warehouse-nya
langkah terpisah setelah user dibuat, lewat endpoint baru di bawah.

### Alur yang perlu ditambahkan di frontend

1. **Setelah login**, atau begitu dapat error `403` dengan `code: "WAREHOUSE_ACCESS_NOT_CONFIGURED"`
   dari endpoint mana pun, panggil:

   ```
   GET http://localhost:3000/api/me/access-status
   Authorization: Bearer <access_token>
   ```

   Response:
   ```json
   { "data": { "role": "staff-gudang", "assigned": false, "warehouse_ids": [] } }
   ```

   Kalau `assigned: false` — **redirect ke halaman notice** "Akses Anda belum disiapkan, hubungi
   admin-bu Anda untuk di-assign ke warehouse." Endpoint ini satu-satunya yang tetap bisa diakses
   staff yang belum di-assign — semua endpoint `/api/*` lain akan `403` untuk mereka sampai
   di-assign.

2. **Halaman baru untuk admin-bu**: "Assign Staff ke Warehouse" — CRUD sederhana:

   ```
   GET    /api/user-warehouse-assignments?warehouse_id=3       (list assignment per warehouse)
   POST   /api/user-warehouse-assignments   { "user_id": 501, "warehouse_id": 3 }
   DELETE /api/user-warehouse-assignments/5                    (5 = id assignment, bukan user_id)
   ```

   Semua endpoint ini dibatasi ke warehouse milik BU admin-bu yang login sendiri (`403 FORBIDDEN`
   kalau pilih warehouse BU lain) — `super-admin` bebas semua BU. Satu staff **bisa** di-assign ke
   lebih dari satu warehouse (mis. yang merangkap Pusat + Cabang).

3. **Tidak perlu ubah apa pun** di endpoint-endpoint yang sudah ada (`/api/stocks`,
   `/api/inbounds`, dst.) — begitu staff sudah di-assign, hasil list/read mereka otomatis
   kepersempit ke warehouse yang di-assign saja (staff Cabang tidak akan lihat data Pusat lagi,
   walau satu BU). Ini transparan dari sisi frontend, tidak ada parameter baru yang perlu dikirim.

Detail teknis lengkap (skema tabel, kode error, kenapa desainnya begini): lihat
[`user-warehouse-assignments.md`](./user-warehouse-assignments.md).

---

## 18. Barcode scanner di kasir (2026-09-13)

Langkah pertama dari beberapa fitur operasional kasir yang lagi digarap. Alatnya (thermal printer +
bluetooth scanner 1D/2D) udah ada di sisi hardware — ini yang perlu ditambahkan di frontend biar
alatnya kepake:

```
GET http://localhost:3000/api/items/by-barcode/8991234567890?warehouse_id=1
Authorization: Bearer <access_token>
```

**Alur di halaman kasir:** scanner biasanya emulate keyboard — hasil scan otomatis "diketik" ke
input field yang lagi fokus, diakhiri Enter. Jadi tinggal: fokus ke 1 input tersembunyi/khusus,
begitu Enter ditekan → ambil value-nya → panggil endpoint ini dengan `warehouse_id` = warehouse
tempat kasir itu beroperasi → response-nya langsung berisi nama, harga jual, DAN stok saat ini di
warehouse tsb (`stock.quantity`) — cukup 1x request per scan, tidak perlu manggil `/stocks`
terpisah.

**Kalau `404`** — barcode belum terdaftar di sistem. Tampilkan opsi "Daftarkan produk baru" yang
arahin ke form tambah item (field `barcode` sudah bisa diisi di situ, lihat `api-documentation.md`
§5).

**Kalau `403 FORBIDDEN`** — ini kejadian kalau kasir kirim `warehouse_id` yang bukan miliknya (di
luar BU-nya, atau bukan warehouse yang di-assign ke dia — lihat `user-warehouse-assignments.md`).
Di alur normal ini seharusnya tidak pernah kejadian karena `warehouse_id` yang dikirim harusnya
warehouse tempat kasir itu login, bukan pilihan bebas dari user.

**Search manual** (`GET /api/items/search?q=...`) sekarang juga ikut cocokin ke `barcode`, jadi
kalau scanner-nya lagi bermasalah, kasir masih bisa ketik manual sebagian nomor barcode dan tetap
ketemu produknya — tapi ini fuzzy match (LIKE), bukan exact seperti endpoint `/by-barcode/`.

Roadmap fitur operasional kasir (§17–§23) **sudah lengkap semua** per 2026-09-13: ~~cetak struk
(ESC/POS)~~ (§19), ~~sesi kasir/shift~~ (§20), ~~hitung kembalian & diskon~~ (§21), ~~hold
transaksi~~ (§22), ~~standarisasi metode pembayaran~~ (§23). Kalau ada kebutuhan operasional baru
yang belum kecover, kabarin aja.

---

## 19. Cetak struk ke printer thermal (2026-09-13)

```
GET http://localhost:3000/api/sales/3/receipt?paper_width_mm=58
Authorization: Bearer <access_token>
```

Hanya bisa dipanggil untuk sale yang **sudah COMPLETED** (`409 INVALID_STATUS` kalau masih DRAFT).
`paper_width_mm` opsional, default `58` (kalau printer-nya 80mm, kirim `80`).

**Penting untuk dipahami:** printer-nya nyambung Bluetooth ke **device kasir** (laptop/tablet/HP),
bukan ke server backend. Jadi backend cuma nyiapin data & byte-nya — yang benar-benar "ngomong" ke
printer via Bluetooth itu kode di browser/frontend, pakai Web Bluetooth API.

Response-nya kasih 2 bentuk sekaligus:
- **`text_lines`** — array teks polos, siap ditampilkan di layar (preview struk sebelum print, atau
  kalau suatu saat ada printer yang gak pakai ESC/POS).
- **`escpos_base64`** — byte ESC/POS lengkap (base64), sudah termasuk perintah cut kertas di akhir.
  Tinggal di-decode jadi bytes dan ditulis ke printer. **Tidak perlu ngerti format ESC/POS sama
  sekali di frontend** — itu semua sudah diurus backend.

**Contoh kode Web Bluetooth** (Chrome/Edge desktop & Android — Web Bluetooth belum didukung
Safari/iOS):

```js
async function printReceipt(saleId) {
  const res = await fetch(`http://localhost:3000/api/sales/${saleId}/receipt`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const { data: receipt } = await res.json();
  const bytes = Uint8Array.from(atob(receipt.escpos_base64), (c) => c.charCodeAt(0));

  // UUID di bawah ini yang paling umum dipakai printer thermal Bluetooth LE
  // generic/"cheap China" — kalau printer lo gak connect, cek dokumentasi/SDK
  // bawaan printer-nya buat UUID service & characteristic yang benar.
  const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
  const CHARACTERISTIC_UUID = '00002af1-0000-1000-8000-00805f9b34fb';

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID] }]
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

  // Kirim per-chunk kecil (BLE punya batas ukuran per-write) dengan jeda
  // dikit biar buffer printer gak kebanjiran.
  const CHUNK_SIZE = 100;
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    await characteristic.writeValue(bytes.slice(i, i + CHUNK_SIZE));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
```

**Kalau device kasirnya HP Android pakai aplikasi native** (bukan browser) — pattern-nya sama:
ambil `escpos_base64`, decode jadi bytes, kirim ke printer lewat Bluetooth SPP/BLE API platform
masing-masing (mis. `react-native-ble-plx`), gak perlu install library ESC/POS terpisah karena
byte-nya udah jadi dari backend.

**Kalau mau preview struk di layar dulu sebelum print** (misal buat konfirmasi ke pelanggan) —
render `text_lines` apa adanya di elemen `<pre>` atau font monospace, jangan pakai font
proporsional (nanti alignment kolom harga jadi berantakan).

---

## 20. Sesi kasir / shift (2026-09-13)

Sebelum kasir bisa mulai jualan, dia harus "buka kasir" dulu — dan di akhir harinya "tutup kasir"
buat rekonsiliasi. Alur yang perlu ditambahkan di frontend:

**1. Saat halaman POS dibuka**, cek dulu apakah kasir yang login udah punya sesi terbuka:
```
GET http://localhost:3000/api/cash-sessions/current
Authorization: Bearer <access_token>
```
`data: null` → tampilkan modal "Buka Kasir" (input modal awal). `data: {...}` → langsung lanjut ke
layar POS, sesi yang ada itu yang dipakai.

**2. Buka kasir:**
```
POST http://localhost:3000/api/cash-sessions/open
{ "warehouse_id": 1, "opening_amount": 100000 }
```
`409 CASH_SESSION_ALREADY_OPEN` kalau ternyata ada sesi lain yang kelupaan belum ditutup (jarang
kejadian kalau step 1 di atas dijalankan dengan benar, tapi tetap perlu di-handle — kasih tahu user
"masih ada sesi #X yang belum ditutup").

**3. Selama shift berjalan** — **tidak ada yang berubah** di alur bikin sale/catat payment yang
sudah ada. Backend otomatis nge-link tiap `POST /api/payments` ke sesi yang lagi terbuka. Pastikan
kirim `payment_method: "CASH"` (nilai enum, lihat §23) untuk pembayaran tunai — metode lain
(`QRIS`, `DEBIT`, dll) gak dihitung sebagai kas fisik, memang sengaja begitu.

**3.5. Kas Keluar (pengeluaran operasional, 2026-09-13)** — kalau kasir perlu ambil uang dari laci
buat keperluan operasional (beli galon air, ongkos kirim dadakan, dll), catat dulu SEBELUM
uangnya beneran diambil:
```
POST http://localhost:3000/api/cash-sessions/1/expenses
{ "amount": 30000, "description": "Beli galon air" }
```
`description` wajib diisi — ini yang muncul di laporan tutup kasir nanti. `409
INSUFFICIENT_CASH_IN_DRAWER` kalau nominalnya lebih besar dari yang seharusnya ada di laci saat itu
— tampilkan errornya ke kasir, jangan biarkan dia coba lagi dengan asal-asalan mengecilkan nominal
tanpa penjelasan.

**4. Tutup kasir** — kasir hitung fisik uang di laci, input hasilnya:
```
POST http://localhost:3000/api/cash-sessions/1/close
{ "closing_amount": 240000, "notes": "opsional" }
```
Response-nya kasih tahu `cash_difference` — **negatif = kasir kurang (defisit)**, positif = lebih.
Tampilkan ini jelas-jelas ke kasir/admin-bu sebelum ditutup beneran kalau bisa (mis. preview dulu
pakai `GET /api/cash-sessions/current` buat lihat `summary.live_expected_cash`, baru kasir input
hasil hitung fisiknya buat di-`close`).

**Laporan shift (X-report/Z-report)** — `GET /api/cash-sessions/:id` bentuknya sama baik sesi masih
`OPEN` (X-report, laporan sementara) atau sudah `CLOSED` (Z-report, laporan final) — `summary.by_method`
kasih breakdown per metode bayar, `summary.expenses` daftar lengkap pengeluaran + alasannya, cocok
buat ditampilkan sebagai struk penutupan kasir (bisa dicetak juga pakai pendekatan yang sama seperti
§19 kalau mau).

Detail lengkap format request/response & cara hitung selisih: `api-documentation.md` §20.

---

## 21. Diskon & kembalian (2026-09-13)

**Diskon** — cuma level transaksi (belum per-item), dikirim pas bikin/update sale:
```
POST http://localhost:3000/api/sales
{ "warehouse_id": 1, "invoice_date": "2026-09-13", "tax_rate": 0.11, "discount_amount": 30000, "details": [...] }
```
Backend hitung ulang `subtotal`/`tax`/`total_amount` otomatis (diskon diterapkan sebelum pajak) —
frontend cuma perlu kirim `discount_amount` (nominal, bukan persen — kalau UI-nya nawarin diskon
persen, hitung dulu ke nominal sebelum kirim ke backend). Kirim `discount_amount` lebih besar dari
subtotal → `400 DISCOUNT_EXCEEDS_SUBTOTAL`, tampilkan pesan errornya ke kasir.

**Kembalian** — dikirim pas catat pembayaran, HANYA relevan buat `payment_method: "CASH"`:
```
POST http://localhost:3000/api/payments
{ "invoice_id": 6, "amount": 297000, "amount_tendered": 300000, "payment_method": "CASH", "payment_date": "2026-09-13" }
```
`amount` = jumlah yang harus dibayar (biasanya sama dengan sisa tagihan invoice). `amount_tendered`
= uang tunai yang **benar-benar diserahkan** pelanggan (kalau dia bayar pas, bisa skip field ini
sama sekali). Response-nya langsung kasih `change_amount` — tampilkan itu ke layar kasir ("Kembalian:
Rp3.000") dan/atau cetak struknya (§19 — struk otomatis nampilin baris Kembalian kalau ada).

**Alur UI yang disaranin** di layar pembayaran: input "Uang Diterima" (defaultnya samain dengan
total tagihan biar kasir bisa langsung Enter kalau bayar pas), begitu nilainya lebih besar dari
total, langsung tampilkan preview kembalian di layar SEBELUM kirim ke backend (hitung sendiri di
frontend: `tendered - total`) — biar kasir bisa konfirmasi dulu sebelum submit. Backend tetap yang
jadi sumber kebenaran akhir (`change_amount` di response), preview di frontend cuma buat UX.

---

## 22. Hold/park transaksi (2026-09-13)

Buat kasir yang lagi bikin cart terus perlu layani pelanggan lain dulu (pelanggan lupa dompet,
mikir-mikir dulu, dll) — cart-nya bisa "ditahan" tanpa hilang:

```
POST http://localhost:3000/api/sales/6/hold
{ "hold_label": "Meja 5" }
```

`hold_label` opsional tapi disaranin diisi — ini yang bikin daftar transaksi tertahan gampang
dikenali kasir ("oh ini punya Budi", "meja 5"). Sale-nya **tetap DRAFT** seperti biasa, jadi alur
edit/complete/cancel yang udah ada tidak berubah sama sekali — hold cuma nempelin
`held_at`/`hold_label`.

**Layar "Transaksi Tertahan"** tinggal query:
```
GET http://localhost:3000/api/sales?status=DRAFT&held=true&warehouse_id=1
```

**Lanjutkan transaksi yang ditahan** — buka detailnya (`GET /api/sales/6`), edit kalau perlu (`PUT`),
lalu lepas status tahannya:
```
POST http://localhost:3000/api/sales/6/resume
```
Ini murni penanda — gak wajib dipanggil sebelum `complete`, tapi disaranin dipanggil begitu kasir
"masuk" ke transaksi itu lagi biar `held=true` gak ke-listing lagi begitu sedang aktif dikerjakan.
`409 NOT_HELD` kalau dipanggil di sale yang memang gak lagi ditahan (mis. double-click tombol
resume) — aman untuk di-ignore di frontend kalau memang itu skenarionya.

---

## 23. Standarisasi metode pembayaran (2026-09-13)

`payment_method` di `POST /api/payments` sekarang **wajib** salah satu dari:
`CASH`, `QRIS`, `DEBIT`, `CREDIT`, `TRANSFER`, `EWALLET`, `OTHER` — nilai lain ditolak
`400 VALIDATION_ERROR`. Kalau UI kasir sebelumnya kirim teks bebas ("Tunai", "cash", dll), **ganti
ke salah satu nilai enum di atas** (dropdown/pilihan tombol, bukan input teks). Field `notes` di
payment masih bebas kalau perlu catatan tambahan (mis. "QRIS via GoPay").

---

## 24. Bug fix: SKU & barcode sekarang unik per BU, bukan global (2026-09-14)

Ditemukan pas desain fitur import di bawah: `sku` item dulu unik **secara global** lintas semua
tenant — 2 bisnis yang gak berhubungan gak bisa sama-sama pakai SKU yang identik (padahal ini
wajar banget kejadian, tiap bisnis biasanya mulai numbering SKU dari awal lagi). Sekarang sudah
diperbaiki: `sku` unik **per `bu_id`**. Gak ada perubahan kontrak API sama sekali (request/response
bentuknya sama persis) — cuma perilaku validasi konflik SKU-nya yang sekarang benar.

**Update susulan, hari yang sama:** awalnya `barcode` sengaja dibiarkan unik global (alasannya
"barcode = kode produk fisik EAN, emang unik di dunia nyata"). Ternyata ini salah — dilaporkan
langsung oleh user pas nyoba tambah item nyata (produk rokok) dan kena `409 ITEM_BARCODE_EXISTS`
padahal item itu belum pernah dia buat di BU-nya sendiri. Kejadiannya: 2 toko beda yang jual
produk fisik identik wajar aja pakai barcode EAN yang sama — barcode itu identitas PRODUK, bukan
identitas SIAPA YANG BOLEH JUAL. Sekarang `barcode` juga unik **per `bu_id`**, sama kayak `sku`.

**Yang perlu diperhatikan di frontend**: kalau sebelumnya nampilin pesan error generik pas kena
`409 ITEM_BARCODE_EXISTS`/`409 ITEM_SKU_EXISTS`, gak perlu ada perubahan — kode errornya tetap
sama, cuma sekarang konfliknya beneran valid (dalam BU sendiri) dan gak akan lagi kejadian
false-positive gara-gara kebentur data BU lain yang gak berhubungan.

## 25. Import item + stok awal dari CSV/Excel (2026-09-14)

```
POST http://localhost:3000/api/items/import
Content-Type: multipart/form-data

file: <items.csv atau items.xlsx>
```

Ini `multipart/form-data`, **bukan JSON** — kalau pakai `fetch`, kirim pakai `FormData`:
```js
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const res = await fetch('http://localhost:3000/api/items/import', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` }, // JANGAN set Content-Type manual — browser yang atur boundary-nya
  body: formData
});
```

**Kolom file** (baris header): `sku`, `name`, `unit` (wajib) + `barcode`, `min_stock`,
`selling_price`, `warehouse_code`, `quantity`, `unit_cost` (opsional, `unit_cost` jadi wajib kalau
`quantity` diisi > 0). Detail lengkap tiap kolom: `api-documentation.md` §5.

**UX yang disaranin untuk halaman import:**
1. Sediakan tombol "Download Template" — tinggal panggil `GET /api/items/import/template?format=csv`
   (atau `xlsx`), file-nya udah jadi (lihat §26 di bawah), gak perlu bikin sendiri di frontend.
2. Kalau responsnya `400 IMPORT_VALIDATION_FAILED`, **tampilkan `details` sebagai tabel** (kolom:
   No. Baris, Pesan Error) — jangan cuma tampilkan `message` di level atas, soalnya detail per
   barisnya lah yang paling berguna buat user memperbaiki file-nya.
3. **Ingatkan user bahwa ini all-or-nothing**: kalau ada 1 baris error dari 200 baris, SEMUANYA
   ditolak — gak ada yang ke-import sebagian. Sarankan user perbaiki file lalu upload ulang dari
   awal, bukan cuma baris yang error.
4. Update ke item yang sudah ada itu **full replace** — kalau user cuma mau update `selling_price`
   1 kolom tapi kirim ulang baris lengkap, field lain yang dikosongkan di file akan ikut ke-reset.
   Kasih peringatan ini di UI kalau usernya baru pertama kali pakai fitur ini.
5. Setelah import sukses dan `warehouses_stocked > 0`, kasih link ke `GET /api/inbounds/:id` (pakai
   `inbound_ids` dari response) biar user bisa cek detail dokumen inbound yang otomatis dibikin.

---

## 26. Download template & export item (2026-09-14)

Keduanya balikin **file beneran** (bukan JSON) — di frontend cukup arahkan `<a>`/`window.location`
atau trigger download dari response blob-nya, jangan di-`fetch().then(r => r.json())` seperti
endpoint lain.

**Download template** (buat pertama kali import, biar tau format kolomnya):
```
GET http://localhost:3000/api/items/import/template?format=csv
GET http://localhost:3000/api/items/import/template?format=xlsx
```

**Export item** (buat lihat/edit data yang udah ada, lalu re-import kalau perlu bulk-update):
```
GET http://localhost:3000/api/items/export?format=csv
GET http://localhost:3000/api/items/export?format=csv&warehouse_id=1
```

**Yang WAJIB dipahami sebelum kasih tombol "Export" ke user**: hasil export **sengaja gak
mengandung kolom `quantity`/`unit_cost`** yang dikenali endpoint import — jadi kalau user
export, edit dikit (misal ganti harga jual), terus langsung re-import file yang sama, itu **AMAN**:
cuma data master yang ke-update, **stok TIDAK ikut nambah dobel**. Kalau `warehouse_id` disertakan,
ada kolom `current_quantity` yang nunjukkin stok saat ini — itu cuma buat referensi/lihat-lihat,
bukan buat di-reimport sebagai penambahan stok (nama kolomnya beda dari `quantity` yang dikenali
import, jadi importer bakal cuekin kolom itu). Jelasin ini ke user di tooltip/dokumentasi halaman
export, biar mereka gak salah kira "export terus import lagi = duplikasi stok".

Contoh kode download file di browser:
```js
async function downloadItemsExport(format = 'csv', warehouseId = null) {
  const url = new URL('http://localhost:3000/api/items/export');
  url.searchParams.set('format', format);
  if (warehouseId) url.searchParams.set('warehouse_id', warehouseId);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const blob = await res.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `items-export.${format}`;
  link.click();
  URL.revokeObjectURL(link.href);
}
```

---

## Dokumen terkait

- [`api-documentation.md`](./api-documentation.md) — referensi lengkap tiap endpoint resource
  (bentuk body, field bisnis, alur status). Auth-nya sudah basi, itu sebabnya dokumen ini ada.
- [`auth-integration-guide.md`](./auth-integration-guide.md) — catatan historis sisi
  backend (kontrak token, keputusan role-matrix, kronologi implementasi). Berguna kalau butuh
  konteks "kenapa" di balik keputusan di dokumen ini, tapi tidak perlu dibaca cuma buat mulai
  ngerjain frontend.
- [`user-warehouse-assignments.md`](./user-warehouse-assignments.md) — detail teknis fitur
  assign staff ke warehouse spesifik (§17 di atas).
