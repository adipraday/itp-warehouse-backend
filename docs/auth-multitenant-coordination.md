# Koordinasi: perubahan multi-tenant di auth-backend → warehouse-service

**Untuk tim warehouse-backend.** Memo koordinasi, bukan spec. Spec penuh ada di auth-repo
`project using codex/docs/multi_tenant_architecture.md`. Ini merangkum **hanya bagian yang
menyentuh warehouse-service** + keputusan yang butuh persetujuan kalian.

Status auth-backend (2026-09-13): **LIVE di produksi** — `https://auth.itpintar.co.id`, semua
langkah §1-§9 di bawah kelar & terverifikasi. **§10 = aksi yang perlu kalian lakukan sekarang**
buat cutover produksi bareng — baca itu duluan kalau baru buka doc ini.

---

## 1. Arah perubahan (ringkas)

Auth-backend akan jadi multi-tenant + multi-service:

- **`companies`** = tenant paling atas (pelanggan). 1 company → banyak `business_units`.
- **`business_unit` = 1 instance layanan** untuk 1 company (1 BU = 1 service). `warehouse` salah
  satu jenis service. `bu_id` yang kalian pakai sekarang tetap valid — cuma sekarang tiap `bu_id`
  itu spesifik "BU warehouse milik company X".
- Role baru **`owner`** — view-only lintas semua BU dalam 1 company.
- **`admin-bu` bisa pegang > 1 BU** lewat mekanisme grant (di auth-backend), direpresentasikan
  di token lewat klaim baru **`bu_ids`** (array).

---

## 2. Yang sampai ke warehouse-service

### 2.a — NON-breaking, cukup notifikasi (tidak perlu kerja)

| Perubahan | Kenapa aman |
|---|---|
| `aud` di token jadi **array** (`["warehouse-system-api"]`, satu elemen dulu) | `user-context.js` kalian pakai `jose` `jwtVerify({ audience: 'warehouse-system-api' })` → `jose` cek keanggotaan array, string tunggal & array 1-elemen berperilaku sama. **Sudah dicek dari sisi kami**, tidak ada kode kalian yang baca `payload.aud` sebagai string. |

**Yang diminta:** grep sekali di repo kalian untuk `\baud\b` / `payload.aud` (logging, audit,
dsb.) buat mastiin tidak ada asumsi `aud` = string di tempat lain. Kalau bersih, tidak ada kerja.

### 2.b — BREAKING, butuh kerja terkoordinasi di warehouse-service

| # | Perubahan | Yang perlu dikerjakan di warehouse-service |
|---|---|---|
| B1 | **Role `owner` masuk enum `role`.** Token `owner` akan datang dengan `role: "owner"`. `role-matrix.js` sekarang: `ROLES` tanpa `owner`, cuma `super-admin` yang di-short-circuit → `owner` otomatis jadi **read-only** (GET lolos, semua write/approve → 403). Itu **kebetulan sudah sesuai** (owner memang view-only), tapi harus disengaja. | Tambah `'owner'` ke `ROLES`. **Jangan** masukkan ke `WRITE_MATRIX`/`APPROVE_MATRIX`/`SUBMIT_MATRIX`/`HPP_VISIBLE_ROLES` — biar tetap read-only. (Konfirmasi: owner boleh lihat HPP/profit? kalau ya, tambah ke `HPP_VISIBLE_ROLES` saja.) |
| B2 | **Klaim baru `bu_ids`** (array of int, atau `null` = unrestricted). Menggantikan `bu_id` tunggal sebagai sumber otorisasi scope. `bu_id` tunggal **tetap ada** di token (= BU home admin-bu/staff) tapi bukan lagi buat cek akses. | `user-context.js`: baca `payload.bu_ids` → simpan di `request.userContext.buIds` (`null` = unrestricted, array = daftar BU yang diizinkan). `buScope()`: ubah dari `warehouse.bu_id === ctx.buId` jadi `warehouse.bu_id IN ctx.buIds` (dan `buIds == null` → bypass, seperti super-admin sekarang). |
| B3 | Selama transisi, kalau auth kirim `bu_ids` tapi `user-context.js` belum baca → `admin-bu` ber-grant cuma ter-scope ke home BU (lihat **lebih sedikit**, bukan lebih banyak). Aman, tapi berarti fitur multi-BU tidak jalan sampai kalian update. | Tidak ada — cuma catatan bahwa urutan rilis fleksibel (fail-safe). |

---

## 3. Keputusan yang butuh input kalian

| # | Pertanyaan | Konteks | Usulan kami |
|---|---|---|---|
| K1 | **Audience auth-backend sendiri.** Kami mau setiap token **selalu** memuat audience auth-backend (mis. `skinet-auth-api`) di `aud`, di samping `warehouse-system-api`. | Tanpa ini, user dari BU non-warehouse tidak bisa akses endpoint auth-backend sendiri. Tidak mempengaruhi kalian (tetap cek `warehouse-system-api`), tapi `aud` array kalian akan berisi ≥2 elemen untuk sebagian user. | Setuju? Ada objection soal `aud` isinya lebih dari 1? |
| K2 | **Nilai `iss` production** — masih `https://auth.local/` di dev, belum pernah dikunci. | `user-context.js` kalian validasi `issuer: app.config.AUTH_JWT_ISSUER`. | Usul: `https://auth.itpintar.co.id/`. Kalian OK? |
| K3 | **`owner` & HPP.** Owner view-only lintas company — boleh lihat angka HPP/profit di dashboard? | `HPP_VISIBLE_ROLES` di `role-matrix.js`. | Kami netral — keputusan bisnis kalian. |
| K4 | **Timing.** `aud`-array (non-breaking) bisa digulirkan duluan, terpisah dari `bu_ids`+`owner` (breaking). Kalian prefer sekaligus atau bertahap? | — | Bertahap: `aud`-array dulu (kami rilis, kalian cukup grep), lalu `bu_ids`+`owner` setelah `user-context.js`/`role-matrix.js` kalian siap. |

---

## 4. Tidak berubah

- Kontrak klaim yang sudah dikunci Fase 1: `role` enam nilai lama tetap valid (`owner` cuma
  **tambahan**), `bu_id`, `user_id`, `sub`, `iss`, `typ`, `jti`, `iat`, `exp` — semua sama.
- RS256 + JWKS + `kid` — sama.
- Pembagian tanggung jawab: auth = identitas + scope, warehouse = otorisasi resource — sama.
- Trade-off staleness ≤15 menit (revoke grant / suspend baru berlaku pas token expired) — sama
  persis dengan yang sudah kalian terima untuk suspend user.

---

## 5. Terpisah — sisa dari bug `bu_id` 2026-09-06

~~Masih perlu dikerjakan di warehouse-backend~~ **SUDAH SELESAI (2026-09-06)** — dikerjakan
sebelum memo ini dibaca, jadi info di bawah **basi**, tolong update dokumen sumbernya juga
(`warehouse-integration-analysis.md` §8 masih bilang "Yang HARUS dikerjakan"):

1. ~~`scripts/seed-baseline.sql` hardcode `bu_id: 13`~~ — file dihapus, diganti
   `scripts/seed-baseline.mjs` (+ `scripts/seed-bu-c.mjs` baru), keduanya resolve `bu_id` dari
   `code` ke `GET /business-units?code=<CODE>` (`X-Service-Key`) di **setiap run**, tidak pernah
   hardcode lagi.
2. ~~Validasi `bu_id` di `POST/PUT /api/warehouses`~~ — sudah jalan lewat
   `src/shared/auth/business-units-client.js`, panggil `GET /business-units/:id`
   (`X-Service-Key`). `bu_id` tidak ada/`INACTIVE` → `400 INVALID_BUSINESS_UNIT`; auth-backend
   unreachable → `502 BUSINESS_UNIT_SERVICE_UNAVAILABLE` (fail-closed).

Diverifikasi live (bu_id invalid/inactive/valid, auth-backend dimatikan, kedua script seed) +
12 unit test baru. Detail lengkap: `docs/warehouse-hierarchy.md`, dan status ini juga sudah
di-append ke `bug-report-bu-id-mismatch.md` (repo frontend) langsung.

---

## 6. Jawaban warehouse-backend — K1–K4 (2026-09-08)

Diverifikasi dulu sebelum jawab, bukan langsung percaya klaim di §2.a:
- **Grep `\baud\b`/`payload.aud` di seluruh `src/`: nol hasil.** Tidak ada kode yang membaca
  klaim `aud` secara langsung/asumsi bentuk string — satu-satunya titik sentuh adalah opsi
  `audience` yang dioper ke `jose`'s `jwtVerify()`.
- **Dites langsung** (bukan cuma percaya dokumentasi `jose`): tanda-tangani token dengan
  `aud: ["warehouse-system-api", "skinet-auth-api"]` (2 elemen, persis skenario K1), verifikasi
  pakai kode `user-context.js` yang berjalan sekarang (`audience: 'warehouse-system-api'`,
  masih string tunggal di config kami) — **lolos**. Konfirmasi: klaim §2.a benar, bukan asumsi.

| # | Jawaban | Catatan |
|---|---|---|
| **K1** | **Setuju.** Tidak ada objection soal `aud` berisi >1 elemen. | Terverifikasi empiris di atas — nol perubahan kode dibutuhkan di sisi kami untuk ini. |
| **K2** | **Setuju** — `https://auth.itpintar.co.id/`. | Murni nilai config (`AUTH_JWT_ISSUER` di `.env` kami), bukan perubahan kode. Tolong koordinasikan timing update `.env` kedua backend bareng saat deploy production, supaya tidak ada window di mana `iss` tidak match. |
| **K3** | **Boleh — tambahkan `owner` ke `HPP_VISIBLE_ROLES`.** | Keputusan bisnis dari tim warehouse: `owner` level eksekutif/pemilik company, visibilitas margin lintas-BU justru esensi dari peran ini. Akan dikerjakan bareng B1 (nanti, bukan sekarang — lihat implikasi di bawah). |
| **K4** | **Setuju, bertahap.** `aud`-array dulu (cukup notifikasi, sudah kami verifikasi aman), `bu_ids`+`owner` menyusul setelah `user-context.js`/`role-matrix.js`/`buScope()` kami siap. | Direkomendasikan dari sisi kami juga — beri waktu implementasi B1/B2 yang benar + testing, bukan dikerjakan buru-buru berbarengan dengan `aud`-array. |

**Implikasi K3 buat B1 (dicatat, belum dikerjakan — nunggu `bu_ids`+`owner` benar-benar rilis):**
tambah `'owner'` ke `ROLES` di `role-matrix.js`, **jangan** masukkan ke `WRITE_MATRIX`/
`APPROVE_MATRIX`/`SUBMIT_MATRIX` (tetap read-only via short-circuit `can()` yang sudah ada polanya
mirip `super-admin`, tapi TANPA bypass write — perlu entry eksplisit, bukan short-circuit generik),
**tapi tambahkan** ke `HPP_VISIBLE_ROLES` sesuai K3 di atas.

**Status kesiapan B1/B2 di sisi kami:** belum dikerjakan (menunggu kontrak `bu_ids`+`owner`
dirilis final sesuai K4, bukan blocker sekarang). Begitu siap dirilis, beri tahu — perkiraan
kerja: `user-context.js` (baca `payload.bu_ids`, simpan `request.userContext.buIds`),
`bu-scope.js` (`bu_id = ?` → `bu_id IN (...)`, `buIds == null` bypass sama seperti `buId == null`
sekarang), `role-matrix.js` (`owner` masuk `ROLES` + `HPP_VISIBLE_ROLES`, keluar dari matrix
tulis). Existing test suite (167 test) jadi baseline regresi — akan ditambah test baru untuk
`owner` dan `bu_ids` array-scoping mengikuti pola yang sudah ada di `tests/shared/*.test.js`.

---

## 7. Kontrak JWT baru — LIVE di auth-backend dev (2026-09-08)

Auth-backend `multi_tenant_architecture.md` §6 langkah 0–7 sudah diimplementasikan & E2E-tested
di DB dev. Token yang diterbitkan `/auth/login` & `/auth/refresh` **sekarang** berbentuk:

```json
{
  "iss": "https://auth.local/",
  "aud": ["skinet-auth-api", "warehouse-system-api"],
  "sub": "26",
  "user_id": 26,
  "role": "admin-bu",
  "bu_id": 13,
  "company_id": null,
  "bu_ids": [13, 15],
  "typ": "access",
  "jti": "...", "iat": 0, "exp": 0
}
```

Perubahan vs kontrak Fase 1:
- **`aud` jadi array.** Selalu memuat `skinet-auth-api` (K1) + audience tiap service yang boleh
  diakses user. Untuk user warehouse = `["skinet-auth-api", "warehouse-system-api"]`.
  → **Aksi kalian: nol.** Sudah kalian verifikasi (§2.a, §6). `jose` `audience: 'warehouse-system-api'`
  tetap match.
- **`bu_ids` (baru, `number[]|null`).** Sumber kebenaran scope. `null` = unrestricted (super-admin).
  `owner` → semua BU company-nya. `admin-bu` → home + grant. staff → `[bu_id]`.
  → **Aksi kalian (B2):** `user-context.js` baca `payload.bu_ids`; `bu-scope.js`
  `warehouse.bu_id IN buIds` (`null` = bypass). Sebelum itu, `bu_id` tunggal masih ada & benar,
  jadi admin-bu ber-grant cuma ke-scope ke home BU — aman (fail-safe, lihat B3).
- **`company_id` (baru, `number|null`).** Cuma relevan buat `owner`. Warehouse boleh abaikan
  (owner discope lewat `bu_ids`).
- **`role` bisa `"owner"`.** view-only lintas BU company.
  → **Aksi kalian (B1):** `owner` ke `ROLES` + `HPP_VISIBLE_ROLES`, JANGAN ke matrix tulis.
  Sampai itu: `owner` otomatis read-only (bukan `super-admin`, jadi semua tulis 403) — aman tapi
  belum sengaja.

**Sisi auth-backend `verifyAccessToken` sekarang cek `aud: 'skinet-auth-api'`** (bukan lagi
`warehouse-system-api`) — ini internal auth-backend, tidak menyentuh kalian.

**Yang belum berubah:** `iss` dev tetap `https://auth.local/` (prod `https://auth.itpintar.co.id/`
saat deploy, K2); RS256 + JWKS + `kid`; TTL 15m; refresh tak pernah keluar ke warehouse.

**Rollout (K4):** `aud`-array + `bu_ids` + `owner` sudah sekaligus di dev karena non-breaking di
sisi kalian (fail-safe). Silakan kerjakan B1+B2 kapan pun siap — tidak ada tekanan waktu, token
lama-gaya tidak lagi diterbitkan tapi yang penting `bu_id` tunggal tetap akurat selama transisi.
Kabari saat B1/B2 landed → kita jadwalkan tes E2E lintas-backend (admin-bu ber-grant lihat
warehouse di 2 BU, owner read-only).

---

## 8. Provisioning + cascade deaktivasi (auth-backend, 2026-09-08) — FYI, tidak butuh aksi

Auth-backend sekarang punya CRUD `companies` + `business_units` (dengan `company_id`/`service_id`)
+ `GET /services` — super-admin bisa onboard customer/BU baru lewat API (sebelumnya cuma seed).

**Yang relevan buat warehouse-service:**
- **Deaktivasi tenant (T4):** kalau super-admin set `companies.status = INACTIVE`, semua user di
  bawah company itu (owner + semua BU-nya) **tidak bisa lagi login / refresh** di auth-backend
  (401). Access token yang sudah jalan tetap diterima warehouse-service sampai expired (≤15 menit)
  — **trade-off staleness yang sama persis** dengan `users.status = SUSPENDED` yang sudah kalian
  terima. Tidak ada perubahan kode di sisi kalian; cukup tahu bahwa "user hilang akses dalam
  ≤15 menit setelah company dinonaktifkan" itu perilaku by-design.
- `bu_id` yang kalian terima di token tetap stabil (auto-increment, tidak berubah). BU baru dari
  company lain akan punya `bu_id` baru; resolusi tetap lewat `GET /business-units?code=` +
  `X-Service-Key` seperti sekarang.

---

## 9. ✅ `activity-logs` module di-scope per BU (temuan 2026-09-08 → SELESAI 2026-09-09)

Ditemukan saat verifikasi: modul `src/modules/activity-logs/` **kelewat** waktu rollout
`bu-filter.js` ke 15 modul lain. `GET /api/activity-logs` dan `/api/activity-logs/:id`:
- Tidak ada `preValidation: buScope(...)`, tidak ada `onRequest: guard(...)`
- Service tidak nerima `request.userContext.buIds`; repository cuma filter dari query param client
- Akibat: **user mana pun yang login** (semua role, semua BU/company) bisa baca **seluruh audit
  trail lintas-tenant** — termasuk `metadata`, `endpoint`, `entity_id`

### Stopgap SUDAH diterapkan (2026-09-08)
`activity-logs.routes.js` — kedua route di-`onRequest: authorize('super-admin')`. Frontend
(`permissions.ts` `canViewActivityLogs()`, `Layout.tsx`, `App.tsx`) juga dibatasi super-admin.
Test 208/208 tetap hijau. Live check: super-admin 200, admin-bu/staff 403, no-token 401.

### Fix sebenarnya — SELESAI & E2E-tested (2026-09-09)

Dikerjakan persis sesuai briefing, diverifikasi live sebelum ditulis di sini (bukan cuma percaya
kode sendiri):

1. **Migration** `202609090001_add_activity_logs_bu_id.js` — `activity_logs.bu_id INT NULL` +
   index (`bu_id, created_at`), backfill dari `warehouses.bu_id` (JOIN, sama database — bukan
   angka hardcode). Dijalankan: dari 23 baris lama, 7 ke-backfill (punya `warehouse_id`), 16
   tetap `NULL` (≈70%, sesuai perkiraan) — cuma kelihatan `super-admin`.
2. **`log-hook.js`**: `resolveBuId()` baru — `warehouse_id` diketahui → `SELECT bu_id FROM
   warehouses WHERE id = ?`; kalau NULL/tidak ada `warehouse_id` sama sekali → fallback ke
   `request.userContext.buId` (BU home aktor). Dites live: create `item` (resource tanpa
   `warehouse_id` sama sekali) sebagai `admin.pusat` (home BU 13) → log baru langsung `bu_id: 13`
   tanpa lookup ke warehouses (`db.execute` tidak dipanggil kalau tidak ada `warehouse_id`).
3. **`activity-logs.routes.js`**: stopgap `authorize('super-admin')` **sudah dibuang**, diganti
   `preValidation: buScope('activity-logs')` (no-op untuk `:id` karena tidak ada entry di
   `DOC_WAREHOUSE_SQL` — sesuai perkiraan, actual scoping `:id` ada di service, lihat poin 4).
4. **`activity-logs.service.js`**: `listActivityLogs`/`getActivityLog` terima `buIds`. List pakai
   `directBuIdsCondition('bu_id', buIds)` di repository. `getActivityLog`: baris di luar scope →
   **404 `NOT_FOUND`, bukan 403** (sengaja — supaya tidak bocorin bahwa log itu ada, existence
   activity-log lintas-tenant sendiri sensitif).
5. **Diverifikasi live** (bukan cuma unit test): `admin.pusat` (bu_id 13) → list cuma balikin
   `bu_id: 13`; `super-admin` → list balikin semua termasuk `null`; `admin.pusat` akses log
   miliknya sendiri → `200`; akses log milik BU 28 (company lain) → `404 NOT_FOUND` (dicoba
   duluan asumsi 403, ternyata benar 404 sesuai desain).
6. **Test**: `tests/modules/activity-logs.service.test.js` (7 test, scoping + NULL bu_id + 404
   bukan 403) + `tests/shared/log-hook.test.js` (4 test baru, `resolveBuId` termasuk fallback
   dan "tidak pernah throw"). Total suite **220/220 lolos**.

**Frontend — SELESAI (2026-09-09):** `canViewActivityLogs()` di `permissions.ts` dilonggarkan ke
`['super-admin','admin-bu','owner']`; komentar STOPGAP dibuang dari `permissions.ts` / `Layout.tsx`
/ `App.tsx`. `tsc -b` clean. Normalisasi stopgap **komplet di dua sisi**.

---

## 8. Status warehouse-service — B1 + B2 LANDED & E2E-tested (2026-09-08)

**Scope diperluas dari yang diminta** — brief B2 cuma sebut 2 file
(`user-context.js`, `bu-scope.js`), tapi itu cuma menutup validasi *single-target*
(write ke satu warehouse tertentu). Kode kami sebelumnya (item #1/#2, sesi lampau)
sudah bikin **15 modul lain** filter list (`GET /api/sales`, `/api/warehouses`,
dashboard, dst) berdasarkan `bu_id` tunggal juga — kalau cuma 2 file itu yang
disentuh, admin-bu ber-grant BISA write ke BU ke-2 tapi TIDAK BISA melihatnya di
list mana pun. Jadi kami perluas ke semua 45 file/15 modul yang pakai `buId`,
supaya konsisten. File baru: `src/shared/auth/bu-filter.js` (helper `IN (...)`
dipakai di semua modul, generalisasi dari filter `bu_id = ?` yang lama).

### B1 — `role-matrix.js`
- `'owner'` ditambah ke `ROLES` dan `HPP_VISIBLE_ROLES` (K3).
- **Tidak** ditambahkan ke `WRITE_MATRIX`/`APPROVE_MATRIX`/`SUBMIT_MATRIX` — `owner` otomatis
  ditolak di semua write/approve/submit karena `can()` tidak short-circuit dia (beda dari
  `super-admin`), dan tidak ada satu pun resource yang mencantumkan `'owner'` di allow-list-nya.

### B2 — `user-context.js` + `bu-scope.js` + (perluasan) 15 modul list-filter
- `user-context.js`: baca `payload.bu_ids` → `request.userContext.buIds`. Tiga kasus:
  `null` eksplisit → unrestricted; array → dipakai apa adanya; **klaim tidak ada sama sekali**
  (token lama, atau mode header/hybrid legacy) → fallback ke `[buId]`, TIDAK pernah diasumsikan
  unrestricted hanya karena klaim-nya absen (fail-safe, sesuai B3 kalian).
- `bu-scope.js`: cek `warehouse.bu_id IN ctx.buIds` (dulu `=== ctx.buId`), `buIds == null` bypass.
- Semua 15 modul: parameter `buId` (single) → `buIds` (array) end-to-end, dari route
  (`request.userContext?.buIds`) → service → repository (`bu_id IN (...)` lewat `bu-filter.js`).

### Diverifikasi live — ketiga skenario E2E yang dijanjikan di §4 briefing, semua PASS:
- **(a)** Bikin grant beneran (`POST /users/26/grants {bu_id:15}` ke `admin.pusat`, native BU 13)
  → login ulang, token `bu_ids: [13,15]` → `GET /api/warehouses` balikin **3 warehouse dari BU 13
  DAN BU 15 sekaligus** (sebelum grant: cuma 1, BU 13 saja).
- **(b)** Bikin akun `owner` beneran (`role:"owner", company_id:1`) → `GET /api/warehouses`
  balikin semua 3 warehouse di company (`bu_ids` token-nya otomatis semua BU company itu) →
  `POST /api/warehouses` dan `POST /api/sales` dua-duanya `403 FORBIDDEN` (`"Role \"owner\" may
  not write ..."`) → `GET /api/dashboard/profit` (HPP) tetap `200` sesuai K3.
- **(c)** `staff.pusat` (single-BU, tanpa grant) tetap cuma lihat 1 warehouse (BU 13), akses
  langsung ke warehouse BU 15 → `403 FORBIDDEN`.

**Test suite:** 21 test baru (`bu-scope.test.js` +2, `role-matrix.test.js` owner describe block +5,
`user-context.test.js` +2 untuk klaim `bu_ids` eksplisit) — total **176/176 lolos**.

Siap dijadwalkan E2E bareng kapan pun — dari sisi kami sudah tidak ada kerjaan tersisa untuk
B1/B2. `owner@test.local` (password `Admin12345`, company 1) ditinggal aktif sebagai akun test
tambahan kalau mau dipakai lagi.

---

## 10. 🚀 Cutover produksi — auth-backend LIVE, aksi buat warehouse-backend (2026-09-13)

Auth-backend sekarang jalan di produksi: **`https://auth.itpintar.co.id`** (VPS, Docker,
TLS Let's Encrypt, di belakang Cloudflare mode `Full (strict)`). Ini yang perlu diganti di
`.env` **produksi** warehouse-backend — **dan wajib diganti BARENGAN** (deploy dua-duanya di
waktu yang sama, bukan gantian), soalnya begitu salah satu sisi ganti duluan bakal ada window
token/`X-Service-Key` ditolak:

```bash
AUTH_JWKS_URL=https://auth.itpintar.co.id/.well-known/jwks.json
AUTH_JWT_ISSUER=https://auth.itpintar.co.id/
AUTH_JWT_AUDIENCE=warehouse-system-api          # TIDAK berubah — aud selalu array sekarang,
                                                  # jose tetap match asal ini ada di dalamnya
AUTH_API_URL=https://auth.itpintar.co.id
SERVICE_API_KEY=<samain dengan SERVICE_API_KEY di .env VPS auth-backend>
```

**`SERVICE_API_KEY`** — nilai aslinya **jangan** ditaruh di dokumen/chat ini. Minta langsung ke
sesi/orang yang pegang `.env` VPS auth-backend (dicatat waktu provisioning, lihat
`docs/deployment-vps.md` §3 di repo auth) — kirim lewat kanal aman (password manager terbagi,
bukan Slack/email polos).

### Yang TIDAK berubah
- Kontrak klaim JWT (`role`, `bu_id`, `bu_ids`, `company_id`, `typ`, dst.) — sama seperti dev,
  cuma domain-nya yang beda.
- `AUTH_MODE=jwt` di warehouse-backend kalian sudah default — tidak perlu diapa-apain, cutover
  ini murni ganti *domain* auth-backend yang dituju, bukan cara verifikasinya.

### Checklist verifikasi setelah cutover
- [ ] Login user warehouse (staff/admin-bu/owner) di auth-backend produksi → token diterima
      warehouse-backend produksi (JWKS ke-fetch dari domain baru, `iss` match)
- [ ] `GET /business-units?code=<CODE>` dari warehouse-backend produksi (pakai `SERVICE_API_KEY`
      baru) → `200`, bukan `401`/`502`
- [ ] Refresh token flow tetap jalan (auth-backend produksi issue token baru, warehouse terima)
- [ ] Kalau ada window di mana salah satu `.env` belum ke-update — cek log `502
      BUSINESS_UNIT_SERVICE_UNAVAILABLE` / JWKS fetch error, itu tanda belum sinkron

### Belum siap dari sisi auth-backend (FYI, bukan blocker cutover di atas)
- `CLIENT_ORIGIN` di `.env` auth-backend produksi masih **kosong** — nunggu domain frontend
  produksi (admin console / warehouse-frontend) ada. Kalau frontend kalian nanti manggil
  auth-backend produksi langsung dari browser (bukan lewat warehouse-backend), request bakal
  kena CORS block sampai domain-nya ditambahin ke `CLIENT_ORIGIN` — kabarin auth-backend kalau
  ini sudah relevan.

## 11. 🗄️ Backup DB — sistem baru, sudah aktif di VPS untuk KEDUA service (2026-09-20)

Sebelumnya tidak ada backup sama sekali untuk auth-backend maupun warehouse-backend (cuma
volume Docker `db_data`, yang persisten lintas restart tapi bukan pengganti backup — satu
`docker compose down -v` yang salah = hilang semua).

Dibuatkan `deploy/backup-db.sh` + `deploy/restore-db.sh` generik (dump `mariadb-dump` harian,
gzip, retensi 14 hari, restore interaktif dengan konfirmasi ketik nama DB) di warehouse-backend,
lalu pola yang sama **sudah dipasang dan aktif** di `/opt/skinet-auth-api/deploy/` di VPS (cron
harian di crontab root, jam 02:20, karena direktori itu dimiliki `root:root`). Detail lengkap:
`warehouse project 230826/docs/deployment-vps.md` §7.

**Aksi buat siapapun yang pegang repo `itp-backend-auth`:** kedua script di
`/opt/skinet-auth-api/deploy/backup-db.sh` dan `restore-db.sh` di VPS **belum ada di git repo
auth-backend** — sudah jalan (cron aktif), tapi kalau server di-rebuild dari git clone bersih,
script ini akan hilang. Tolong tarik salinannya dari VPS dan commit ke repo kalau sempat, supaya
tidak cuma hidup sebagai file yatim di server.

**Update 2026-09-19 — off-site copy juga sudah selesai.** Backup harian kedua service sekarang
otomatis ter-upload ke Google Drive (via `rclone`, satu akun, folder terpisah per service:
`itp-backups/warehouse-db/` dan `itp-backups/auth-db/`), jadi tidak lagi cuma tersimpan di disk
VPS yang sama dengan database live-nya. Detail lengkap + cara reproduksi kalau perlu ganti akun
Drive: `warehouse project 230826/docs/deployment-vps.md` §7.4.
