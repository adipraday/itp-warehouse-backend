# Auth Integration Guide (untuk `warehouse-system-api`)

Panduan menyambungkan backend ini ke **auth backend** (`skinet-auth-api`, repo terpisah di
`C:\Users\adipr\Documents\MyProject\project using codex`).

Melengkapi [`auth-backend-requirements.md`](auth-backend-requirements.md) — dokumen itu adalah *spec*;
dokumen ini adalah *status aktual + cara integrasi*. Kalau ada beda, dokumen ini yang benar.

Terakhir diperbarui: 2026-08-28

---

## 1. Status

Auth backend **sudah jadi & tersmoke-test**. Sudah menerbitkan JWT RS256 asli lewat `POST /auth/login`
dan `POST /auth/refresh`. Analisa lengkap + rencana ada di
`project using codex/docs/warehouse-integration-analysis.md`.

**Fase 2 selesai (2026-08-28).** [`src/shared/auth/user-context.js`](../src/shared/auth/user-context.js)
sudah diganti dari baca-header-polos → verifikasi JWT RS256 via JWKS (`jose`, `createRemoteJWKSet` + `jwtVerify`).
Diverifikasi E2E langsung ke auth backend yang jalan (bukan mock):

- `GET /api/warehouses` dengan `Authorization: Bearer <token>` asli dari `POST /auth/login` → `200`, data benar.
- `POST /api/warehouses` dengan token itu → `created_by` di response **persis** = `user_id` dari klaim token (12).
- Token acak/rusak, `AUTH_MODE=jwt` → `401 UNAUTHORIZED` (bukan `500`, sudah diperbaiki — kode awal lupa set `error.code`).
- `AUTH_MODE=hybrid`: token JWT asli tetap jalan, **dan** header lama (`X-User-Id` dkk) masih jalan sebagai fallback — dites dua-duanya di request terpisah, keduanya benar.
- Env aktif sekarang: `AUTH_MODE=hybrid` (lihat §4.5 soal kapan pindah ke `jwt` penuh).

**Enforcement layer (2026-08-28):** ditambahkan di `user-context.js` (kini hook `onRequest`, bukan
`preHandler`, supaya auth jalan sebelum validasi body).

- `AUTH_MODE=jwt` → **setiap `/api/*` wajib token valid**; tanpa/invalid token → `401` (bukan lagi lolos
  dengan `userContext` null). Allowlist publik: `/health`, `/documentation`, `/`.
- `AUTH_MODE=hybrid` / `header` → tetap longgar (tidak ada request ditolak karena identitas kosong).
- `error-handler.js` — 4xx kini di-log level `warn` tanpa stack (401 auth jadi rutin), 5xx tetap `error`.

**Business unit ≠ warehouse (2026-08-28):** satu BU bisa punya beberapa warehouse. `userContext` sekarang
`{ userId, role, buId }` (bukan `warehouseId` palsu). Warehouse target diambil dari param request, bukan
dari token. Audit-log `warehouse_id` diambil dari `warehouse_id` di query/body request.

**Role matrix (2026-08-28, WIRED):** `src/shared/auth/role-matrix.js` = single source of truth,
di-wire ke semua route mutating via `onRequest: guard(resource, action)`. GET tetap terbuka untuk semua
user terautentikasi. Enforcement respek `AUTH_MODE`: kalau ada identitas → role dicek di semua mode;
kalau tidak ada identitas → `guard()` no-op di `hybrid`/`header` (di `jwt` sudah ditolak upstream).
`src/shared/auth/authorize.js` (`authorize(...roles)`) tetap ada untuk kasus di luar matrix.

⚠️ Isi matrix masih **best-guess least-privilege** — review & catat versi final di
`auth-backend-requirements.md` §10.

Env aktif sekarang: `AUTH_MODE=hybrid`. **"Wajib login" + role enforcement penuh baru aktif saat
`AUTH_MODE=jwt`** — pindah ke situ setelah frontend konsisten kirim `Authorization: Bearer`.

---

## 2. Kontrak token (WAJIB dipatuhi verifier)

Access token dikirim di setiap request:

```
Authorization: Bearer <access_token>
```

Payload JWT:

```json
{
  "iss": "https://auth.local/",
  "aud": "warehouse-system-api",
  "sub": "42",
  "user_id": 42,
  "role": "admin-bu",
  "bu_id": 2,
  "typ": "access",
  "jti": "…",
  "iat": 1724800000,
  "exp": 1724800900
}
```

Header JWT: `{ "alg": "RS256", "typ": "JWT", "kid": "dev-1" }`.

| Klaim | Arti | Catatan verifier |
|---|---|---|
| `user_id` | id user (number) | ini yang dipakai untuk `created_by`/`completed_by` dll. `sub` = string yang sama. |
| `role` | salah satu dari 6: `super-admin`, `admin-bu`, `staff-gudang`, `kasir-sales`, `purchasing`, `finance` | dipakai `guard()` / `role-matrix.js` di backend ini |
| `bu_id` | **business unit id** (number) atau `null` | auth backend tidak tahu soal "warehouse" — masuk apa adanya ke `context.buId`, dicocokkan ke `warehouses.bu_id` per request lewat `buScope()` (lihat §3). `null` = super-admin, tidak ter-scope. |
| `iss` | `https://auth.local/` di dev | verifier **wajib** cek; nilai production disepakati sebelum deploy |
| `aud` | `warehouse-system-api` | verifier **wajib** cek |
| `exp` | expiry (~15 menit) | verifier cek; pakai `clockTolerance` 30–60s |

**Aturan keamanan verifier (jangan dilewatkan):**
- `algorithms: ['RS256']` **hardcoded**. Jangan pernah terima `none` atau HS256.
- Cek `iss` dan `aud`.
- Access token **satu-satunya** token yang datang ke sini. Refresh token tidak pernah dikirim ke backend ini.

---

## 3. `bu_id` bukan `warehouse_id` — satu BU boleh punya banyak warehouse

> Bagian ini sebelumnya menjelaskan rencana pemetaan 1:1 `warehouseId = bu_id`. Rencana itu
> **tidak dipakai** — model final (§4.7) adalah satu business unit boleh punya banyak warehouse,
> jadi token tidak pernah "menjadi" satu warehouse. Isi di bawah adalah model yang aktif.

`request.userContext` berbentuk `{ userId, role, buId }` — **tidak ada field `warehouseId`** di context.
`buId` cuma identitas tenant (business unit) milik user, **bukan** warehouse target. Warehouse target
selalu datang dari request itu sendiri: `warehouse_id`/`source_warehouse_id`/`destination_warehouse_id`
di body/query, atau `:id` dokumen (di-lookup per resource).

Yang menghubungkan `buId` ke warehouse target adalah hook `buScope(resource)`
([`src/shared/auth/bu-scope.js`](../src/shared/auth/bu-scope.js)), bukan `user-context.js`:

1. Kumpulkan semua `warehouse_id` yang disebut request (langsung dari body/query, atau hasil lookup
   `:id` dokumen ke tabel yang relevan, mis. `inventory_transactions.warehouse_id` untuk inbound/outbound).
2. `SELECT id, bu_id FROM warehouses WHERE id IN (...)` sekali jalan untuk semua id yang terkumpul.
3. Kalau ada satu saja warehouse yang `bu_id`-nya ≠ `ctx.buId` → `403 FORBIDDEN`.

`buId === null` (super-admin) melewati pengecekan ini sepenuhnya — akses ke semua warehouse, semua BU.
Tanpa identitas (mode `hybrid`/`header` tanpa token) juga no-op (lenient selama masa transisi).

**Konsekuensi penting:** `warehouses.bu_id` sendiri **nullable** — warehouse yang belum di-assign ke BU
mana pun (`bu_id IS NULL`) tidak bisa disentuh siapa pun kecuali `super-admin` (lihat §4.7 dan §5 poin 5
di [`update 28082612031.md`](update%2028082612031.md) soal data dev lama yang perlu di-assign manual).

---

## 4. Fase 2 — langkah implementasi

### 4.1 Kunci kontrak (sekali, dengan tim auth)

Konfirmasi nilai final: `iss` production, `aud`, TTL access token. (Asumsi `bu_id`/`warehouseId` 1:1 di
poin ini sudah tidak berlaku — model final ada di §3 dan §4.7: satu BU boleh punya banyak warehouse.)

### 4.2 Ambil public key

Dua opsi:
- **Runtime (disarankan):** fetch `GET http://<auth-host>/.well-known/jwks.json`, cache, cocokkan `kid`.
  Mendukung rotasi key tanpa redeploy.
- **Statis:** simpan `jwt-public.pem` (dari repo auth `keys/jwt-public.pem` atau
  `GET /.well-known/public-key.pem`) sebagai env var / file.

Public key **dev** saat ini:

```
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzlz3XlCxd1ngQ/4vfe3N
WXx2ucUecQHsKHZMErYrvX39e/VxguS/uOn0Hdj+rPrLH3xbYjPtDcEdJM06RrIE
HcoMpExxpZGHJUinbS85IEiS0vqUsIVWwRGXFjZh90O7w27omXP7FLvhvBly9qa1
YAK6jCJnBwaFS5ip9iXAA+CfwUEUc1aA+fINmEc6cAex6oUifWqglTqEzkUTwj5D
ROwGHF9DHv/8VuDvbIvZVEoB72QjLcXUWexb9chjzpff+wbMoUerolMOkOkwgKH1
lvifBfqpyLzugQLJr2U3fsW9YYzmOYJyohSeCJ5UbrUBH9G9Z80kvPinF/pauV64
kQIDAQAB
-----END PUBLIC KEY-----
```

> Ini key dev — akan beda kalau auth backend regenerate. Untuk apa pun selain coba-coba lokal,
> pakai JWKS URL sebagai sumber kebenaran.

### 4.3 Tambah env

Ke `src/config/env.js` schema (`@fastify/env`):

```js
AUTH_JWKS_URL:      { type: 'string', default: 'http://localhost:5020/.well-known/jwks.json' },
AUTH_JWT_ISSUER:    { type: 'string', default: 'https://auth.local/' },
AUTH_JWT_AUDIENCE:  { type: 'string', default: 'warehouse-system-api' },
AUTH_MODE:          { type: 'string', default: 'jwt' }   // 'jwt' | 'header' | 'hybrid' (transisi)
```

### 4.4 Library

`npm i jose` (pure ESM, punya `createRemoteJWKSet` + cache bawaan). Alternatif: `jsonwebtoken` + `jwks-rsa`.

### 4.5 `user-context.js` — bentuk & perilaku aktual

Bentuk `request.userContext`: **`{ userId, role, buId }`** (bukan `warehouseId` — lihat §3).

Source of truth kodenya ada di [`src/shared/auth/user-context.js`](../src/shared/auth/user-context.js) —
sengaja **tidak** ditempel lengkap di sini supaya dokumen ini tidak basi lagi tiap kali file itu diedit.
Tiga hal yang beda dari rencana awal Fase 2 (kalau lihat versi lama dokumen ini di git history):

1. **Hook `onRequest`, bukan `preHandler`.** Auth harus jalan sebelum body/schema divalidasi, supaya
   request tanpa identitas dapat `401` (bukan `400` duluan gara-gara body-nya belum boleh diperiksa).
2. **`AUTH_MODE=jwt` menolak, bukan cuma "lewat dengan context kosong".** Request `/api/*` tanpa token
   valid → `401` langsung di sini, kecuali path masuk `PUBLIC_PATHS` (`/health`, `/documentation`, `/`).
   Di mode `hybrid`/`header`, tetap lenient (tidak ada yang ditolak karena identitas kosong).
3. **Klaim `bu_id` masuk ke `context.buId`, apa adanya** — tidak diterjemahkan jadi `warehouseId` sama
   sekali (§3 menjelaskan kenapa penerjemahan itu tidak relevan lagi).

Header legacy yang dibaca di mode `hybrid`/`header`: `X-User-Id`, `X-User-Role`, `X-Bu-Id` (nama lama
`X-Warehouse-Id` masih diterima sebagai alias, untuk kompatibilitas mundur).

### 4.6 Test E2E (sudah dijalankan)

1. Auth backend (`project using codex`): `npm run dev` (port 5020).
2. Backend ini: `npm run dev` (port 3000).
3. User uji: `node scripts/create-super-admin.mjs admin@test.local 'Admin12345' 'Admin'` lalu login,
   atau bikin `admin-bu` dengan `bu_id` via `POST /users`.
4. Dengan `Authorization: Bearer <access_token>`:
   - `GET /api/warehouses` → 200; `POST /api/warehouses` → `created_by` = `user_id` klaim token ✅
   - `AUTH_MODE=jwt`: tanpa token / token rusak / `aud` salah → 401 ✅ (termasuk POST body invalid → 401, bukan 400)
   - `/health`, `/documentation` tanpa token → 200 ✅
   - `AUTH_MODE=hybrid`: token JWT **dan** header `X-User-Id` dua-duanya jalan ✅
   - `AUTH_MODE=jwt` + role matrix: `kasir-sales` POST `/api/sales` → lolos; POST `/api/warehouses` /
     `/api/purchases` → 403; `staff-gudang` POST `/api/inbounds` → lolos, POST `/api/sales` &
     `/api/stock-transfers/:id/approve` → 403; `super-admin` semua lolos ✅ (91 test vitest tetap hijau)

### 4.7 A3 — BU scoping (2026-08-28, DONE)

- `migrations/202608280001_add_warehouse_bu_id.js` — kolom `warehouses.bu_id INT NULL` (integer mentah,
  refer `business_units.id` di auth backend; NULL = belum di-assign, hanya super-admin yang boleh sentuh).
- `warehouses` create/update terima `bu_id` — super-admin bebas set, `admin-bu` dipaksa ke BU-nya sendiri.
- `src/shared/auth/bu-scope.js` — hook `preValidation` `buScope(resource)`. Menemukan warehouse target dari:
  body/query (`warehouse_id` / `source_warehouse_id` / `destination_warehouse_id` / `invoice_id`) **dan**
  `:id` dokumen (lookup per-resource). Tolak `403` kalau ada warehouse yang `bu_id`-nya ≠ `userContext.buId`.
  Super-admin (`buId === null`) bypass; tanpa identitas (hybrid/header) no-op.
- Di-wire ke: `warehouses`, `inbounds`, `outbounds`, `sales`, `purchases`, `stock-transfers`,
  `stock-opnames`, `returns`, `payments`, `invoices` (mutating + GET).
- **Tertest:** `admin-bu(X)` → GET/PUT/DELETE warehouse BU-Y = 403; POST inbounds/stock-transfers yang
  menyebut warehouse BU-Y = 403; list `?warehouse_id=<BU-Y>` = 403; aksi di BU sendiri lolos; super-admin bypass.

**Gap list-tanpa-filter — DITUTUP (2026-08-28):**
- Semua `findAll`/`count` (dan varian `findLowStock`/`findOutOfStock`/`summary`/dsb.) di 15 modul kini
  terima `buId` dan menambah kondisi `warehouse_id IN (SELECT id FROM warehouses WHERE bu_id = ?)` bila
  `buId != null` (super-admin tetap bypass karena `buId === null`). Tiga varian pola sesuai bentuk tabel:
  kolom `warehouse_id` tunggal (mayoritas modul), dua kolom (`stock-transfers`: `source_warehouse_id` OR
  `destination_warehouse_id`), dan JOIN (`payments`, yang tidak punya `warehouse_id` sendiri — JOIN ke
  `invoices`).
- Modul analytics read-only (`stocks`, `stock-mutations`, `cost-layers`, `cost-summary`, `dashboard`)
  sekarang juga di-`buScope` dan filter `buId`-nya sendiri (sebelumnya sama sekali tidak terpasang).
  `bu-scope.js`'s `DOC_WAREHOUSE_SQL` ditambah entry untuk `stock-mutations` dan `cost-layers` supaya
  `GET /:id` di situ juga tervalidasi (sebelumnya no-op karena resource-nya belum terdaftar).
- **Tertest ulang end-to-end** (bukan cuma unit test): login sebagai `admin-bu` BU-A (`bu_id=11`), lalu
  `GET /api/sales` tanpa `?warehouse_id` — sebelum fix mengembalikan baris dari warehouse `[22, 5, 1, 2]`
  (lintas-BU), sesudah fix hanya `[22]` (warehouse milik BU-A sendiri). `npm test` tetap 91/91 lolos.
- Body JSON rusak → `400` sebelum `403` (tidak berbahaya, tidak diubah).

**Test otomatis untuk hook auth — SELESAI (2026-08-28):**
- `tests/shared/user-context.test.js` (15 test) — `jose`'s `createRemoteJWKSet` di-`vi.mock` supaya
  diganti `createLocalJWKSet` dari keypair RSA yang di-generate di tempat (`generateKeyPair('RS256')`),
  jadi verifikasi signature/claim beneran jalan tanpa network call ke JWKS endpoint. Nutup: token valid,
  `bu_id: null` → super-admin, tanpa header → 401, token expired → 401, signature/kid salah → 401,
  audience/issuer salah → 401, public path lolos tanpa identitas, mode `header` (X- headers, JWKS resolver
  TIDAK pernah dipanggil), mode `hybrid` (bearer diutamakan, fallback ke header kalau verifikasi gagal atau
  token tidak dikirim, tidak pernah reject).
- `tests/shared/role-matrix.test.js` (12 test) — `can()` (super-admin bypass, default-deny resource tak
  dikenal, fallback ke `resourceRules.write` waktu action spesifik kosong, catatan eksplisit soal rule
  kosong `{}` yang jatuh ke `DEFAULT_WRITE_ROLES` bukan deny) dan `guard()` (no-op tanpa identitas, lolos
  role diizinkan, 403 role dilarang, super-admin bypass, default action `'write'`).
- `tests/shared/authorize.test.js` (5 test) — `authorize()`/`requireAuth`: 401 tanpa identitas, 403 role
  di luar allow-list, lolos role diizinkan, `authorize()` tanpa argumen = terima role apa pun asal login.
- `tests/shared/bu-scope.test.js` (13 test) — `buScope()` dengan `db.execute` di-mock (branch per bentuk
  SQL, bukan hardcode urutan panggilan): no-op tanpa identitas/super-admin/tanpa target warehouse, body
  vs query `warehouse_id`, lookup via `invoice_id` (payments), `:id` → warehouse langsung (`warehouses`),
  `:id` → lookup per-resource (`DOC_WAREHOUSE_SQL`, termasuk kolom ganda `stock-transfers` source+dest),
  warehouse tak ada → tidak throw (biar handler 404), resource tanpa entry `DOC_WAREHOUSE_SQL` → no-op.
- **Total suite: 136/136 lolos** (91 lama + 45 baru), `npm test` / `npx vitest run`.

### 4.8 Sisa pekerjaan lain

- Pindah `AUTH_MODE` → `jwt` setelah frontend kirim Bearer konsisten; lalu hapus path header.

---

## 5. Model role (2026-08-28)

```
super-admin      platform admin (auth backend). bu_id = NULL. Kelola business_units,
                 buat admin-bu untuk BU mana pun.
  admin-bu       puncak satu business unit. bu_id di-set. Kelola SEMUA user di BU-nya
                 (termasuk menunjuk admin-bu lain di BU yang sama) + semua operasi
                 warehouse untuk BU itu. Satu BU boleh punya beberapa admin-bu.
    staff-gudang
    kasir-sales    role operasional, dalam satu BU
    purchasing
    finance
```

`admin-gudang` (nama lama) = `admin-bu`. "gudang" menyesatkan karena peran ini memimpin
seluruh business unit, bukan satu gudang.

### 5.1 Matrix write final — REVIEWED (2026-08-28)

Isi `role-matrix.js` (mutating actions per resource) sudah direview dan dikonfirmasi, tidak
ada perubahan dari versi best-guess sebelumnya:

| Resource | write | sub-action |
|---|---|---|
| warehouses | admin-bu | — |
| items | admin-bu, purchasing | — |
| contacts | admin-bu, kasir-sales, purchasing | — |
| inbounds | admin-bu, staff-gudang, purchasing | — |
| outbounds | admin-bu, staff-gudang, kasir-sales | — |
| stock-transfers | admin-bu, staff-gudang | approve: admin-bu |
| stock-opnames | admin-bu, staff-gudang | submit: admin-bu, staff-gudang; approve: admin-bu |
| returns | admin-bu, staff-gudang, kasir-sales | approve/reject: admin-bu |
| sales | admin-bu, kasir-sales | — |
| purchases | admin-bu, purchasing | — |
| payments | admin-bu, finance | — |

`super-admin` bisa semua, di semua resource (bypass di `can()`). Resource read-only
(`stocks`, `stock-mutations`, `cost-layers`, `cost-summary`, `invoices`, `dashboard`,
`activity-logs`) tidak punya mutating route sama sekali.

### 5.2 Visibilitas HPP — DIBATASI (2026-08-28)

Sebelumnya semua GET terbuka untuk siapa pun yang login, termasuk data HPP (unit cost,
COGS, gross margin) — kontradiksi dengan keputusan awal ("blokir dari staff-gudang/kasir-sales").
Ditutup dengan `authorize(...HPP_VISIBLE_ROLES)` sebagai `onRequest` guard (terpisah dari
`role-matrix.js`'s `guard()` yang cuma untuk write) di tiga endpoint:

- `GET /api/cost-layers`, `GET /api/cost-layers/:id`
- `GET /api/cost-summary`
- `GET /api/dashboard/profit`

`HPP_VISIBLE_ROLES = ['super-admin', 'admin-bu', 'purchasing', 'finance']` — diekspor dari
`role-matrix.js` supaya satu sumber kebenaran, dipakai di `costing.routes.js` dan
`dashboard.routes.js`. **Tanpa identitas sama sekali → 401** (beda dari sisa endpoint yang
tetap lenient di mode hybrid/header tanpa identitas — untuk data sesensitif ini, "tidak tahu
siapa yang minta" berarti ditolak, bukan diloloskan).

**Tertest live:** `kasir-sales` (BU-A) → `403 FORBIDDEN` di ketiga endpoint; `admin-bu` (BU-A)
→ `200` normal; `GET /api/sales` (bukan endpoint HPP) tetap `200` untuk `kasir-sales`, tidak
kena efek samping. Juga tertutup di `tests/shared/role-matrix.test.js` (assert isi
`HPP_VISIBLE_ROLES`).

**Catatan gap terkait yang BELUM ditutup (di luar scope keputusan ini):** `GET /api/dashboard/stock`
dan `GET /api/dashboard/summary` juga membawa field `total_value` (nilai stok = `quantity_remaining
× unit_cost` yang diagregasi) — secara tidak langsung membocorkan rata-rata unit cost. Belum
diikutkan ke `HPP_VISIBLE_ROLES` karena keputusan yang diambil eksplisit cuma menyebut
`cost-layers`, `cost-summary`, `dashboard/profit`. Kalau mau ditutup juga, tinggal tambah
`onRequest: hppGuard` di dua route itu.

### 5.3 Scope finance — DIPUTUSKAN per-BU (2026-08-28)

Rencana awal "finance di-scope ke satu warehouse" tidak diimplementasikan — model token
sekarang cuma bawa `bu_id`, bukan `warehouse_id` per user, dan satu BU boleh punya banyak
warehouse (§3). Finance di-scope sama seperti role lain: semua warehouse di BU-nya sendiri,
via `buScope()` yang sudah jalan. Kalau nanti benar-benar perlu per-warehouse, itu perubahan
skema di auth-backend (assign `warehouse_id` ke user, tambah klaim token) — belum dikerjakan,
belum masuk rencana.

### 5.4 activity-logs — TETAP TERBUKA (2026-08-28)

Sempat dipertimbangkan untuk dibatasi ke `admin-bu`/`super-admin` saja, tapi diputuskan tetap
terbuka untuk semua role yang login. Tidak ada perubahan kode.

## 6. Yang TIDAK berubah di backend ini

- Kolom audit (`created_by` dll) tetap `INT NULL` tanpa FK — `users` tetap di auth backend.
- `activity_logs` di backend ini tetap jalan (beda tabel dari `activity_logs` milik auth backend).
- Semua service & repository tidak disentuh — auth murni di layer hook/route.
