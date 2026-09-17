# Auth Backend — Requirements Specification

> ⚠️ **Sebagian dokumen ini sudah tidak akurat sejak implementasi (2026-08-28).** Yang berubah:
> klaim scope namanya **`bu_id`** (bukan `warehouse_id`); role **`admin-bu`** (bukan `admin-gudang`);
> auth backend punya tabel kanonik `business_units`; 1 BU boleh punya banyak warehouse & beberapa admin-bu.
> **Sumber kebenaran terkini: [`auth-integration-guide.md`](auth-integration-guide.md).** Dokumen ini
> disimpan sebagai rekam jejak requirement awal.

Rincian kebutuhan untuk backend authentication & authorization yang **terpisah** dari backend warehouse ini. Dokumen ini adalah spesifikasi fungsional/teknis untuk dibangun sebagai service sendiri — bukan bagian dari `warehouse-system-api`.

Kontrak integrasi ke backend warehouse — lihat bagian [8. Kontrak Integrasi](#8-kontrak-integrasi-dengan-backend-warehouse).

---

## Daftar Isi

1. [Ruang Lingkup](#1-ruang-lingkup)
2. [Model Data](#2-model-data)
3. [Registration](#3-registration)
4. [Login](#4-login)
5. [Strategi Token: Common vs Single-Use](#5-strategi-token-common-vs-single-use)
6. [Update Data User](#6-update-data-user)
7. [Reset Password](#7-reset-password)
8. [Kontrak Integrasi dengan Backend Warehouse](#8-kontrak-integrasi-dengan-backend-warehouse)
9. [Daftar Endpoint Lengkap](#9-daftar-endpoint-lengkap)
10. [Token Middleware — Implementasi](#10-token-middleware--implementasi)
11. [Checklist Keamanan](#11-checklist-keamanan)
12. [Keputusan yang Masih Perlu Diambil](#12-keputusan-yang-masih-perlu-diambil)

---

## 1. Ruang Lingkup

Backend ini bertanggung jawab penuh atas:
- Identitas user (registrasi, profil, kredensial)
- Autentikasi (login, logout, refresh session)
- Penerbitan token yang dipercaya backend lain (termasuk backend warehouse)
- Reset password & (opsional) verifikasi email
- Otorisasi tingkat identitas: role apa yang dimiliki user, warehouse apa yang jadi scope-nya

**Bukan** tanggung jawab backend ini:
- Aturan bisnis "role X boleh akses endpoint Y" pada resource warehouse — itu tetap ditegakkan di backend warehouse sendiri (lihat [update 28082612031.md](update%2028082612031.md) bagian pembagian tanggung jawab).
- Validasi bahwa `warehouse_id` yang di-assign ke user benar-benar ada — backend warehouse yang punya data warehouse, jadi validasi ini idealnya lewat pemanggilan API warehouse saat admin membuat/mengubah user (lihat [12. Keputusan yang Masih Perlu Diambil](#12-keputusan-yang-masih-perlu-diambil) poin 1).

---

## 2. Model Data

### `users`

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | `INT AUTO_INCREMENT PK` | |
| `name` | `VARCHAR(150) NOT NULL` | |
| `email` | `VARCHAR(150) NOT NULL UNIQUE` | dipakai sebagai username login |
| `password_hash` | `VARCHAR(255) NOT NULL` | **bcrypt/argon2**, jangan pernah simpan plaintext |
| `role` | `VARCHAR(20) NOT NULL` | enum: `super-admin`, `admin-bu`, `staff-gudang`, `kasir-sales`, `purchasing`, `finance` (dulu `admin-gudang` → `admin-bu`) |
| `warehouse_id` | `INT NULL` | **wajib diisi kecuali role `super-admin`** (lihat validasi di bawah) |
| `status` | `VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'` | enum: `ACTIVE`, `SUSPENDED` — dipakai untuk nonaktifkan user tanpa hapus data |
| `email_verified_at` | `DATETIME(3) NULL` | opsional, kalau verifikasi email dipakai |
| `last_login_at` | `DATETIME(3) NULL` | |
| `created_by` | `INT NULL` | user id admin yang membuat akun ini (self-referencing) |
| `created_at`, `updated_at` | `DATETIME(3)` | |

**Constraint bisnis (dicek di aplikasi, bukan DB):** `role != 'super-admin' → warehouse_id IS NOT NULL`; `role == 'super-admin' → warehouse_id IS NULL`.

### `refresh_tokens`

Token yang bisa dicabut (revocable) — tidak disimpan sebagai JWT stateless karena harus bisa di-invalidate kapan saja (logout, ganti password, akun disuspend).

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | `BIGINT AUTO_INCREMENT PK` | |
| `user_id` | `INT NOT NULL` | |
| `token_hash` | `VARCHAR(255) NOT NULL UNIQUE` | **hash** dari token (SHA-256), bukan token mentah |
| `expires_at` | `DATETIME(3) NOT NULL` | |
| `revoked_at` | `DATETIME(3) NULL` | diisi saat logout / rotasi / suspend |
| `replaced_by_token_id` | `BIGINT NULL` | untuk audit trail rotasi token |
| `created_at` | `DATETIME(3) NOT NULL` | |

### `single_use_tokens`

Satu tabel generik untuk semua token sekali-pakai (reset password, verifikasi email, undangan user baru) — dibedakan lewat kolom `purpose`. Pola ini **identik** dengan `idempotency_requests` di backend warehouse: buat record, tandai `used_at` begitu dikonsumsi, jangan pernah bisa dipakai dua kali.

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | `BIGINT AUTO_INCREMENT PK` | |
| `user_id` | `INT NOT NULL` | |
| `token_hash` | `VARCHAR(255) NOT NULL UNIQUE` | hash dari token mentah yang dikirim ke user (via email) |
| `purpose` | `VARCHAR(30) NOT NULL` | enum: `PASSWORD_RESET`, `EMAIL_VERIFICATION` |
| `expires_at` | `DATETIME(3) NOT NULL` | |
| `used_at` | `DATETIME(3) NULL` | `NULL` = belum dipakai; begitu diisi, token mati permanen |
| `created_at` | `DATETIME(3) NOT NULL` | |

---

## 3. Registration

### Keputusan desain: **tidak ada self-registration publik**

Karena keenam role yang ada (`super-admin`, `admin-gudang`, `staff-gudang`, `kasir-sales`, `purchasing`, `finance`) semuanya adalah role internal/operasional milik satu perusahaan — bukan aplikasi consumer-facing — user baru **dibuat oleh admin**, bukan daftar sendiri. Pola ini sama seperti kebanyakan sistem ERP/POS internal.

- `super-admin` bisa membuat user dengan role apa pun, warehouse mana pun.
- `admin-gudang` hanya bisa membuat user dengan role di bawahnya (`staff-gudang`, `kasir-sales`, `purchasing`, `finance`) **di warehouse miliknya sendiri** — tidak bisa membuat `super-admin`/`admin-gudang` lain, tidak bisa membuat user di warehouse lain.

### Alur

1. Admin mengisi form: `name`, `email`, `role`, `warehouse_id` (kalau relevan) — **tanpa password**.
2. Backend generate password sementara ATAU generate `single_use_token` bertipe `EMAIL_VERIFICATION`/`SET_PASSWORD` dan kirim link ke email user baru.
3. User baru buka link → set password sendiri lewat endpoint yang sama seperti reset password (lihat bagian 7) → akun aktif.

Ini menghindari admin harus tahu/mengatur password user lain, dan otomatis jadi bentuk verifikasi email (kalau user tidak bisa akses email itu, akun tidak pernah aktif).

### Validasi

- `email` unik, format valid.
- `role` harus salah satu dari 6 enum yang sah.
- `warehouse_id` wajib untuk semua role kecuali `super-admin`; kosongkan otomatis kalau `super-admin`.
- Requester (`admin-gudang`) hanya boleh set `warehouse_id` = warehouse miliknya sendiri (dari klaim JWT requester itu sendiri).

---

## 4. Login

**Input:** `email`, `password`.

**Proses:**
1. Cari user by email. Kalau tidak ada, atau `status = SUSPENDED`, atau password salah → response **sama persis** (`401 INVALID_CREDENTIALS`) untuk ketiganya. Jangan bocorkan mana yang salah (email tidak terdaftar vs password salah) — mencegah enumerasi akun.
2. Bandingkan password dengan `password_hash` (bcrypt/argon2 compare, bukan compare string biasa).
3. Kalau cocok: terbitkan **access token** (JWT, short-lived) + **refresh token** (opaque random string, disimpan hash-nya di `refresh_tokens`).
4. Update `last_login_at`.
5. Response: `{ access_token, refresh_token, expires_in, user: { id, name, email, role, warehouse_id } }`.

**Rate limiting:** wajib — maksimal N percobaan gagal per email/IP dalam window waktu tertentu (mis. 5x/15 menit), baik untuk mencegah brute-force maupun credential stuffing.

---

## 5. Strategi Token: Common vs Single-Use

Ini dua konsep token yang **beda tujuan** — jangan dicampur jadi satu mekanisme.

| | **Access Token (Common)** | **Refresh Token** | **Single-Use Token** |
|---|---|---|---|
| Tujuan | Otorisasi tiap request API (dikirim ke backend warehouse juga) | Menerbitkan access token baru tanpa login ulang | Aksi sekali-pakai yang sensitif (reset password, set password awal) |
| Format | JWT (self-contained, stateless) | String random opaque (bukan JWT) | String random opaque |
| Umur | Pendek: **15–30 menit** | Panjang: **7–30 hari** | Pendek: **15–60 menit** |
| Disimpan di server? | **Tidak** — hanya diverifikasi via signature | **Ya** (hash-nya) di `refresh_tokens` — supaya bisa dicabut | **Ya** (hash-nya) di `single_use_tokens` |
| Bisa dicabut sebelum expired? | Tidak langsung (harus tunggu expired karena stateless) | Ya — set `revoked_at` | Otomatis "tercabut" begitu dipakai (`used_at`) |
| Reuse setelah dipakai? | Boleh dipakai berkali-kali sampai expired | Direkomendasikan **rotasi**: setiap dipakai untuk refresh, token lama direvoke, token baru diterbitkan | **Tidak boleh** — pemakaian kedua harus ditolak |
| Dikirim ke mana | Header `Authorization: Bearer <token>` di setiap request ke API manapun (termasuk backend warehouse) | Hanya ke endpoint `POST /auth/refresh` milik auth backend sendiri | Hanya lewat link email, dikonsumsi sekali di endpoint reset/set password |

### Kenapa access token pendek + refresh token terpisah?

Access token yang pendek (15-30 menit) membatasi jendela risiko kalau token bocor — sedangkan pengalaman user tetap mulus karena frontend otomatis minta access token baru pakai refresh token begitu yang lama expired, tanpa user harus login ulang. Refresh token yang bisa dicabut (disimpan di DB) memberi kontrol: begitu user logout / password diganti / akun disuspend, semua refresh token miliknya langsung mati — meski access token lama mungkin masih berlaku beberapa menit sampai expired sendiri (trade-off yang wajar untuk kesederhanaan stateless JWT).

### Refresh token rotation (wajib)

Setiap kali `POST /auth/refresh` dipanggil: refresh token lama **langsung direvoke** dan yang baru diterbitkan (bukan dipakai berulang). Kalau ada yang mencoba pakai refresh token yang sudah direvoke → **revoke semua refresh token user itu** dan paksa login ulang — ini indikasi kuat token dicuri (replay attack).

---

## 6. Update Data User

Bedakan dua konteks:

### A. Self-update (user mengubah datanya sendiri)
- Endpoint: `PUT /users/me`
- Field yang boleh diubah: `name`, `email` (dengan verifikasi ulang kalau email berubah).
- **Tidak boleh** ubah `role`, `warehouse_id`, `status` sendiri.
- Ganti password: endpoint terpisah, **wajib** kirim password lama untuk verifikasi (`PATCH /users/me/password` dengan `current_password` + `new_password`).

### B. Admin-update (admin mengubah data user lain)
- Endpoint: `PUT /users/:id` (khusus `super-admin`, atau `admin-gudang` untuk user di warehouse-nya sendiri).
- Field yang boleh diubah: `name`, `role`, `warehouse_id`, `status`.
- **Tidak bisa** set password langsung — kalau admin perlu reset password user lain, gunakan alur "kirim link reset" (bagian 7), jangan endpoint yang menerima password mentah dari admin.
- Efek samping wajib: kalau `status` diubah jadi `SUSPENDED`, atau `role`/`warehouse_id` diubah → **revoke semua refresh token user itu** (paksa logout dari semua sesi, supaya perubahan akses langsung berlaku, tidak menunggu access token lama expired).

---

## 7. Reset Password

Dua alur berbeda, jangan disatukan:

### A. "Lupa password" (belum login)

1. `POST /auth/forgot-password` dengan `{ email }`.
2. Backend cari user. **Response selalu sama** (`200 "Kalau email terdaftar, link reset sudah dikirim"`) baik email ditemukan atau tidak — mencegah enumerasi akun.
3. Kalau ditemukan: generate token random, simpan hash-nya di `single_use_tokens` (`purpose: PASSWORD_RESET`, `expires_at`: +30 menit), kirim token **mentah** ke email user via link (`https://app.../reset-password?token=...`).
4. `POST /auth/reset-password` dengan `{ token, new_password }`.
5. Backend hash token yang diterima, cari di `single_use_tokens` yang cocok, belum `used_at`, belum expired.
6. Kalau valid: update `password_hash`, set `used_at = NOW()`, **revoke semua refresh token user itu** (paksa logout semua sesi lama).
7. Kalau token invalid/expired/sudah dipakai → `400/410`, jangan bocorkan alasan detail.

### B. "Ganti password" (sudah login)

- `PATCH /users/me/password` dengan `{ current_password, new_password }` (lihat bagian 6A).
- Verifikasi `current_password` dulu sebelum update.
- Sama seperti alur A: revoke semua refresh token lain setelah ganti password berhasil.

### Kebijakan password

- Minimal 8 karakter (atau sesuaikan kebijakan perusahaan).
- Rate-limit `POST /auth/forgot-password` per email/IP — mencegah spam email reset.

---

## 8. Kontrak Integrasi dengan Backend Warehouse

Backend warehouse (`warehouse-system-api`) mengharapkan setiap request terautentikasi membawa identitas dalam bentuk ini (lihat [update 28082612031.md](update%2028082612031.md) bagian 4 — saat ini masih pakai header sementara `X-User-Id`/`X-User-Role`/`X-Warehouse-Id`, akan diganti validasi token asli):

```json
{
  "user_id": 42,
  "role": "admin-gudang",
  "warehouse_id": 2
}
```

**Klaim JWT access token harus memuat persis field ini** (`sub`/`user_id`, `role`, `warehouse_id`, plus `exp`/`iat` standar JWT), supaya backend warehouse bisa langsung memverifikasi signature dan membaca klaim tanpa panggilan balik (call-back) ke backend auth di setiap request — ini penting untuk performa (autentikasi tetap stateless dari sisi backend warehouse).

**Secret/public key** untuk verifikasi signature JWT harus dibagikan ke backend warehouse (kalau pakai HMAC/simetris, shared secret lewat env var; kalau pakai RSA/asimetris — **direkomendasikan** — backend warehouse cukup punya public key, backend auth pegang private key).

---

## 9. Daftar Endpoint Lengkap

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| POST | `/auth/login` | Publik | Login, terbitkan access + refresh token |
| POST | `/auth/refresh` | Refresh token | Tukar refresh token dengan access token baru (rotasi) |
| POST | `/auth/logout` | Access token | Revoke refresh token yang dipakai sesi ini |
| POST | `/auth/logout-all` | Access token | Revoke **semua** refresh token milik user (mis. "logout dari semua device") |
| POST | `/auth/forgot-password` | Publik | Kirim link reset password |
| POST | `/auth/reset-password` | Single-use token | Konsumsi token reset, set password baru |
| GET | `/users/me` | Access token | Profil user yang sedang login |
| PUT | `/users/me` | Access token | Update `name`/`email` sendiri |
| PATCH | `/users/me/password` | Access token | Ganti password (butuh `current_password`) |
| GET | `/users` | Access token (`super-admin`, `admin-gudang`) | List user — `admin-gudang` hanya lihat warehouse-nya |
| GET | `/users/:id` | Access token (`super-admin`, `admin-gudang`) | Detail user |
| POST | `/users` | Access token (`super-admin`, `admin-gudang`) | Buat user baru (lihat bagian 3) |
| PUT | `/users/:id` | Access token (`super-admin`, `admin-gudang`) | Admin-update (role/warehouse/status) |
| POST | `/users/:id/send-password-reset` | Access token (`super-admin`, `admin-gudang`) | Admin trigger reset link untuk user lain (bukan set password langsung) |

---

## 10. Token Middleware — Implementasi

### Middleware autentikasi (`authenticate`)

1. Ambil header `Authorization: Bearer <token>`. Kalau tidak ada → `401`.
2. Verifikasi signature JWT + `exp` belum lewat. Kalau invalid/expired → `401`.
3. Set `request.user = { userId, role, warehouseId }` dari klaim token.
4. Lanjut ke handler berikutnya.

Middleware ini **stateless** — tidak query database sama sekali per request (itulah inti keuntungan JWT). Konsekuensinya: kalau user di-suspend di tengah masa berlaku access token, dia baru benar-benar kehilangan akses setelah access token itu expired (maksimal 15-30 menit) — bukan seketika. Kalau butuh revoke seketika (mis. untuk kasus suspend darurat), perlu tambahan **denylist** token/`user_id` yang dicek di middleware (trade-off: menambah state, mengurangi kemurnian stateless).

### Middleware otorisasi (`authorize(...roles)`)

Dipasang setelah `authenticate`, mengecek `request.user.role` termasuk dalam daftar role yang diizinkan untuk endpoint tsb. Ini yang dipakai backend warehouse (bukan backend auth) untuk aturan "role X boleh akses resource Y" sesuai matrix yang sudah disepakati sebelumnya.

### Middleware single-use token

**Bukan** middleware generik yang dipasang di banyak endpoint — cukup logic satu kali di handler `POST /auth/reset-password`:
1. Hash token yang diterima dari body.
2. `SELECT ... WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() FOR UPDATE` (lock supaya dua request paralel dengan token sama tidak lolos berdua — persis pola yang sudah dipakai `idempotency_requests` di backend warehouse).
3. Kalau tidak ketemu → tolak.
4. Kalau ketemu → proses reset password, lalu `UPDATE ... SET used_at = NOW()` **dalam transaction yang sama**.

---

## 11. Checklist Keamanan

- [ ] Password di-hash dengan bcrypt (cost ≥ 10) atau argon2 — jangan pernah simpan/log plaintext.
- [ ] Token mentah (refresh token, single-use token) **tidak pernah** disimpan di database — hanya hash-nya (SHA-256 cukup, karena token sudah random & panjang, bukan low-entropy seperti password).
- [ ] Rate limiting di `POST /auth/login` dan `POST /auth/forgot-password`.
- [ ] Response login/forgot-password tidak membocorkan apakah email terdaftar.
- [ ] Refresh token rotation + deteksi reuse (revoke semua sesi kalau token bekas dipakai lagi).
- [ ] Semua endpoint yang mengubah password/role/status memicu revoke refresh token terkait.
- [ ] HTTPS wajib di production (token di header/body tidak boleh lewat plain HTTP).
- [ ] `expires_at` untuk single-use token pendek (≤ 30-60 menit).
- [ ] Audit: setiap login sukses/gagal, reset password, perubahan role dicatat (bisa reuse pola `activity_logs` yang sudah ada di backend warehouse, dibuat tabel serupa di backend auth).

---

## 12. Keputusan yang Masih Perlu Diambil

1. **Validasi `warehouse_id` lintas-service** — saat admin membuat/update user dengan `warehouse_id` tertentu, siapa yang pastikan warehouse itu benar-benar ada di backend warehouse? Opsi: (a) backend auth panggil API `GET /api/warehouses/:id` ke backend warehouse saat validasi, (b) percaya saja input admin tanpa validasi cross-service (lebih simpel, risiko: `warehouse_id` yatim kalau warehouse dihapus). Rekomendasi: opsi (a) kalau kedua backend bisa saling panggil dengan mudah, sederhanakan jadi (b) untuk MVP kalau belum sempat.
2. **Algoritma signing JWT** — HMAC (shared secret, lebih simpel setup) vs RSA/EdDSA (asimetris, lebih aman untuk multi-service karena backend warehouse cukup pegang public key, tidak pernah pegang secret yang bisa dipakai untuk **menerbitkan** token). Rekomendasi: asimetris (RS256/EdDSA) kalau realistis untuk effort saat ini.
3. **Verifikasi email saat registrasi** — wajib atau opsional untuk MVP? Kalau opsional, alur "set password awal" di bagian 3 masih tetap valid sebagai cara distribusi password pertama, hanya saja tanpa gate verifikasi.
4. **Tech stack backend auth** — dokumen ini sengaja ditulis stack-agnostic (endpoint & data model, bukan kode). Kalau mau konsisten dengan backend warehouse (Fastify + MySQL + `mysql2`), gue bisa bantu detailkan lebih jauh sesuai stack itu.
