# Panduan Integrasi — Mengajukan Permintaan Barang ke Gudang (warkas) lewat API

Untuk developer sistem yang akan terhubung (ERP/aplikasi lain). Dokumen ini berdiri sendiri: cukup untuk membangun,
menguji, dan menjalankan integrasinya.

---

## 1. Gambaran singkat

Sistem Anda mengirim **permintaan barang** ke gudang lewat API, lalu memantau statusnya. Staf gudang memprosesnya di
aplikasi warkas; Anda tidak memprosesnya.

Ada **dua jenis token** — ini yang paling sering membingungkan:

| | Token API | Token akses |
|---|---|---|
| Bentuk | `api_xxxxxxxx…` | JWT panjang (`eyJ…`) |
| Umur | berbulan-bulan (ditentukan admin, maks. 365 hari) | **15 menit** |
| Dikirim ke | **hanya** server otentikasi (`auth.itpintar.co.id`) | server warkas (`api-wms.itpintar.co.id`) |
| Fungsinya | "kunci" yang ditukar | "tiket" untuk memanggil API |
| Didapat dari | admin (satu kali, lewat kanal aman) | hasil menukar token API |

```
Sistem Anda                        Server otentikasi                    Server warkas
     │  1. POST /auth/api-token  ─────────▶│                                    │
     │     { "api_token": "api_…" }        │                                    │
     │◀──────────────  access_token (15 menit)                                  │
     │                                                                          │
     │  2. POST /api/item-requests  ───────────────────────────────────────────▶│
     │     Authorization: Bearer <access_token>                                 │
     │◀──────────────────────────────────────────  201 + data permintaan        │
```

**Satu hasil tukar bisa dipakai untuk banyak permintaan** selama masih berlaku. Jangan menukar token di setiap
permintaan (lihat §3).

### Yang bisa dan tidak bisa dilakukan akun integrasi Anda
- ✅ Mengajukan permintaan barang, melihat **permintaan yang Anda ajukan sendiri**, membatalkannya selama masih `OPEN`,
  dan melihat daftar gudang tujuan.
- ❌ Memproses permintaan (mulai, penuhi, tolak) — itu tugas staf gudang.
- ❌ Melihat permintaan milik orang lain, atau data lain (stok, item, kontak, penjualan, dst.). Semuanya dijawab `403`.
- ❌ Login dengan e-mail/password. Akun integrasi tidak punya password; jangan memakai `/auth/login`.

---

## 2. Yang Anda terima dari admin

| Item | Contoh / keterangan |
|---|---|
| **Token API** | `api_…` — tampil **sekali**. Simpan sebagai rahasia (secret manager / environment variable server) |
| URL otentikasi | `https://auth.itpintar.co.id` |
| URL API warkas | `https://api-wms.itpintar.co.id` |
| Masa berlaku token API | tanggal kedaluwarsa; minta token baru **sebelum** tanggal itu (§9) |
| Aturan IP | **IP Strict aktif** → penukaran hanya diterima dari IP yang didaftarkan; **mati** → dari IP mana pun |
| Kontak admin | untuk token baru, mencabut token, atau mendaftarkan IP |

Jika **IP Strict aktif**, berikan admin **IP keluar (egress/NAT) server produksi** Anda. Penukaran dari IP lain dijawab `401`
sama seperti token salah.

---

## 3. Langkah 1 — Tukar token API menjadi token akses

```
POST https://auth.itpintar.co.id/auth/api-token
Content-Type: application/json

{ "api_token": "api_…" }
```

(Alternatif: kirim token di header `X-Api-Key: api_…` tanpa body.)

Respons sukses `200`:

```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "access_token": "eyJhbGciOi…",
    "token_type": "Bearer",
    "expires_in": 900,
    "user": { "id": 34, "name": "ERP Acme", "role": "integration-requester", "bu_id": 10, "status": "ACTIVE", "kind": "api" }
  }
}
```

- `expires_in` dalam **detik** (900 = 15 menit). Tidak ada refresh token: kalau habis, tukar token API lagi.
- Simpan `access_token` beserta waktu kedaluwarsanya; **tukar lagi hanya ketika tinggal ±1 menit** atau saat menerima `401`
  dari server warkas.
- Penukaran dibatasi **600 kali per 15 menit per IP**; lewat batas → `429`. Menukar di tiap permintaan pasti boros dan berisiko kena batas.

Kegagalan penukaran:

| HTTP | Artinya |
|---|---|
| `401` `Invalid or expired API token` | token API salah, kedaluwarsa, dicabut, akun ditangguhkan, **atau** IP tidak terdaftar (IP Strict). Pesannya sengaja sama |
| `429` | terlalu sering menukar; tunggu dan kurangi frekuensi |
| `5xx` / timeout | masalah sementara; ulangi dengan jeda (backoff) |

---

## 4. Langkah 2 — Ajukan permintaan barang

```
POST https://api-wms.itpintar.co.id/api/item-requests
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "description": "Mohon dikirim 20 pcs Kabel HDMI 1.5m dan 5 pcs Mouse Wireless untuk cabang Depok, paling lambat Jumat.",
  "subject": "Permintaan Kabel HDMI & Mouse",
  "requester_name": "Budi Santoso",
  "warehouse_id": 15,
  "source": "erp-acme",
  "external_ref": "PR-2026-0042"
}
```

| Field | Wajib | Aturan |
|---|---|---|
| `description` | **ya** | teks, maks. 5000 karakter. Isi permintaan |
| `subject` | tidak | maks. 200. Kosong → diambil dari baris pertama `description` |
| `requester_name` | tidak | maks. 150. **Nama orang** yang sebenarnya meminta di sistem Anda (akun API tercatat sebagai pemohon) |
| `warehouse_id` | tidak | **angka (id gudang)** atau `null`. **Bukan kode teks.** `null` = gudang mana saja di BU Anda. Ambil id dari §6 |
| `source` | tidak | maks. 50. Nama sistem Anda, mis. `erp-acme`. Default `app` — sebaiknya selalu diisi |
| `external_ref` | **sangat disarankan** | maks. 100. ID permintaan di sistem Anda, **unik** (lihat idempotensi di bawah) |

`requested_by` dan `bu_id` **tidak perlu dikirim**: diambil dari token Anda.

Respons sukses `201`:

```json
{
  "data": {
    "id": 1,
    "request_number": "REQ-000001",
    "bu_id": 10,
    "warehouse_id": 15,
    "warehouse_name": "SKI lantai 3",
    "requested_by": 34,
    "requester_name": "Budi Santoso",
    "subject": "Permintaan Kabel HDMI & Mouse",
    "description": "Mohon dikirim 20 pcs …",
    "status": "OPEN",
    "source": "erp-acme",
    "external_ref": "PR-2026-0042",
    "response_note": null,
    "handled_by": null,
    "handled_at": null,
    "created_at": "2026-10-31 10:04:17.033",
    "updated_at": "2026-10-31 10:04:17.033"
  }
}
```

Simpan `id` (dan/atau `request_number`) di sistem Anda untuk memantau status. Setiap permintaan baru **mengirim notifikasi
ke staf gudang tujuan**.

### Aman diulang (idempotensi) — wajib dimanfaatkan
Kirim **`external_ref` yang sama** untuk permintaan yang sama. Kalau koneksi putus atau timeout dan Anda tidak tahu apakah
permintaan masuk, **kirim ulang persis sama**:

- sudah masuk sebelumnya → `200` dengan `"meta": { "duplicate": true }` dan data permintaan yang lama (tidak dibuat ganda);
- belum masuk → `201`.

`external_ref` bersifat **unik per Business Unit**. Jika sudah dipakai **sistem/akun lain** di BU yang sama → `409 EXTERNAL_REF_TAKEN`.
Saran format: `<SISTEM>-<ID internal>` (mis. `ERP-ACME-PR-2026-0042`) agar tidak bertabrakan.

---

## 5. Memantau, membaca, dan membatalkan

Semua memakai `Authorization: Bearer <access_token>`.

| Kebutuhan | Panggilan |
|---|---|
| Satu permintaan | `GET /api/item-requests/{id}` |
| Cari dengan ID Anda | `GET /api/item-requests?external_ref=PR-2026-0042` |
| Semua yang masih berjalan | `GET /api/item-requests?source=erp-acme&status=OPEN,IN_PROGRESS` |
| Filter lain | `warehouse_id`, `q` (cari teks), `page`, `per_page` |
| Batalkan | `POST /api/item-requests/{id}/cancel` dengan body `{ "note": "alasan" }` (opsional) |

Hasil daftar berbentuk `{ "data": [ … ], "meta": { "page": 1, "per_page": 20, "total": 3 } }`. Anda **hanya melihat
permintaan yang Anda ajukan sendiri**.

### Status
`OPEN` → `IN_PROGRESS` → `FULFILLED`. Dari `OPEN`/`IN_PROGRESS` bisa berakhir `REJECTED` atau `CANCELLED`.
`FULFILLED`, `REJECTED`, `CANCELLED` bersifat final. Saat ditolak atau diselesaikan, alasan/catatan staf ada di `response_note`.

- **Tidak ada webhook.** Pantau dengan **polling**: ambil `status=OPEN,IN_PROGRESS` secara berkala (jeda wajar, mis. 1–5 menit,
  bukan tiap detik) dan perbarui status di sistem Anda saat berubah.
- **Pembatalan** hanya bisa selama `OPEN`. Sesudah staf mulai memproses (`IN_PROGRESS`) → `409 INVALID_STATUS_TRANSITION`.

---

## 6. Daftar gudang (untuk mengisi `warehouse_id`)

```
GET https://api-wms.itpintar.co.id/api/warehouses
Authorization: Bearer <access_token>
```

Hasilnya berisi `id`, `code` (kode gudang), dan `name`. **Pakai `id`** (angka) di `warehouse_id`. Simpan pemetaan
kode → id di sistem Anda dan perbarui sesekali; gudang jarang berubah.

---

## 7. Contoh kode

Token API selalu dibaca dari **environment variable / secret manager**, bukan ditulis di kode.

### cURL

```bash
# 1) tukar token
curl -s -X POST https://auth.itpintar.co.id/auth/api-token \
  -H 'Content-Type: application/json' -d "{\"api_token\":\"$WARKAS_API_TOKEN\"}"

# 2) ajukan permintaan (ganti $ACCESS_TOKEN dengan access_token dari langkah 1)
curl -s -X POST https://api-wms.itpintar.co.id/api/item-requests \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"description":"Kardus L x 20","requester_name":"Budi","warehouse_id":null,"source":"erp-acme","external_ref":"PR-2026-0042"}'
```

### Node.js (18+)

```js
const AUTH_BASE = 'https://auth.itpintar.co.id';
const WMS_BASE = 'https://api-wms.itpintar.co.id';
const API_TOKEN = process.env.WARKAS_API_TOKEN;

let cache = { token: null, expiresAt: 0 };
let inflight = null; // cegah dua penukaran bersamaan

async function getAccessToken(force = false) {
  if (!force && cache.token && Date.now() < cache.expiresAt - 60_000) return cache.token;
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(`${AUTH_BASE}/auth/api-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: API_TOKEN }),
    });
    if (!res.ok) throw new Error(`Tukar token gagal: HTTP ${res.status}`);
    const { data } = await res.json();
    cache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cache.token;
  })().finally(() => { inflight = null; });
  return inflight;
}

// Panggil API warkas. 401 = token akses basi -> tukar ulang SEKALI lalu coba lagi.
async function warkas(method, path, payload) {
  let res;
  for (const force of [false, true]) {
    const token = await getAccessToken(force);
    res = await fetch(`${WMS_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (res.status !== 401) break;
  }
  return res;
}

// Ajukan permintaan; aman diulang karena external_ref tetap sama.
async function ajukanPermintaan(req, maxTry = 3) {
  for (let i = 1; i <= maxTry; i++) {
    try {
      const res = await warkas('POST', '/api/item-requests', req);
      if (res.status < 500 && res.status !== 429) return { status: res.status, body: await res.json() };
    } catch { /* jaringan putus -> ulangi */ }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // jeda 2s, 4s, 8s
  }
  throw new Error('Gagal mengirim permintaan setelah beberapa percobaan');
}

// contoh
ajukanPermintaan({
  description: 'Kardus L x 20',
  requester_name: 'Budi',
  warehouse_id: null,
  source: 'erp-acme',
  external_ref: 'PR-2026-0042',
}).then((r) => console.log(r.status, r.body.data?.request_number));
```

### Python (requests)

```python
import os, time, requests

AUTH = "https://auth.itpintar.co.id"
WMS = "https://api-wms.itpintar.co.id"
API_TOKEN = os.environ["WARKAS_API_TOKEN"]
_cache = {"token": None, "exp": 0.0}

def access_token(force=False):
    if not force and _cache["token"] and time.time() < _cache["exp"] - 60:
        return _cache["token"]
    r = requests.post(f"{AUTH}/auth/api-token", json={"api_token": API_TOKEN}, timeout=10)
    r.raise_for_status()
    d = r.json()["data"]
    _cache.update(token=d["access_token"], exp=time.time() + d["expires_in"])
    return _cache["token"]

def warkas(method, path, **kw):
    for force in (False, True):   # 401 -> tukar ulang sekali
        r = requests.request(method, f"{WMS}{path}",
                             headers={"Authorization": f"Bearer {access_token(force)}"}, timeout=15, **kw)
        if r.status_code != 401:
            break
    return r

r = warkas("POST", "/api/item-requests", json={
    "description": "Kardus L x 20", "requester_name": "Budi",
    "warehouse_id": None, "source": "erp-acme", "external_ref": "PR-2026-0042"})
print(r.status_code, r.json())
```

### PHP (cURL)

```php
<?php
function warkasToken(bool $force = false): string {
    static $token = null, $exp = 0;          // di PHP-FPM cache ini hilang tiap request: simpan di APCu/Redis/file
    if (!$force && $token && time() < $exp - 60) return $token;
    $ch = curl_init('https://auth.itpintar.co.id/auth/api-token');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['api_token' => getenv('WARKAS_API_TOKEN')]),
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200) throw new RuntimeException("Tukar token gagal: HTTP $code");
    $data = json_decode($body, true)['data'];
    $token = $data['access_token'];
    $exp = time() + $data['expires_in'];
    return $token;
}

function warkas(string $method, string $path, ?array $payload = null): array {
    foreach ([false, true] as $force) {      // 401 -> tukar ulang sekali
        $ch = curl_init('https://api-wms.itpintar.co.id' . $path);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . warkasToken($force), 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS => $payload ? json_encode($payload) : null,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code !== 401) break;
    }
    return ['status' => $code, 'body' => json_decode($body, true)];
}
```

---

## 8. Referensi kesalahan

Andalkan **kode HTTP**; isi pesan bisa berbeda antar jenis kesalahan.

| HTTP | Kapan | Yang dilakukan |
|---|---|---|
| `200` | permintaan dengan `external_ref` yang sama sudah ada (`meta.duplicate: true`) | anggap sukses, pakai `id` yang dikembalikan |
| `201` | permintaan baru dibuat | simpan `id` |
| `400` `VALIDATION_ERROR` | body tidak sesuai (mis. `warehouse_id` berupa teks, `description` kosong). Rinciannya ada di `error.details` | perbaiki data, **jangan** diulang apa adanya |
| `401` | token akses kedaluwarsa/salah | tukar token API lagi **sekali**, lalu ulangi. Kalau penukarannya sendiri `401` → hubungi admin |
| `403` | endpoint/aksi di luar hak akun integrasi (mis. membaca stok, memproses permintaan) | itu memang tidak diizinkan; periksa panggilan Anda |
| `404` | permintaan tidak ada **atau bukan milik Anda** | periksa `id` |
| `409` `EXTERNAL_REF_TAKEN` | `external_ref` sudah dipakai pihak lain di BU yang sama | ganti format `external_ref` |
| `409` `INVALID_STATUS_TRANSITION` | mis. membatalkan permintaan yang sudah diproses | ambil status terbaru; tidak bisa dibatalkan |
| `429` | terlalu banyak panggilan | jeda lalu coba lagi, kurangi frekuensi |
| `5xx` / timeout | gangguan sementara | ulangi dengan jeda (2s, 4s, 8s…), tetap dengan `external_ref` yang sama |

Aturan ulang: **ulangi hanya untuk `5xx`, `429`, atau jaringan putus** — dan karena `external_ref` sama, tidak akan ada permintaan ganda.
Jangan mengulang `4xx` lain tanpa mengubah penyebabnya.

---

## 9. Keamanan dan operasional

- 🔐 **Token API adalah kata sandi.** Simpan di secret manager/environment server. **Jangan** di kode, repository, log,
  chat, e-mail, aplikasi mobile, atau JavaScript browser. Panggil API hanya dari **server** Anda.
- Selalu **HTTPS**. Jangan mencatat token (API maupun akses) ke log; catat hanya `request_number`, `external_ref`, dan status HTTP.
- **Token bocor/dicurigai?** Segera hubungi admin untuk **mencabut**-nya; token baru diterbitkan. Token akses yang sudah beredar
  habis sendiri dalam ≤15 menit.
- **Masa berlaku & rotasi.** Catat tanggal kedaluwarsa token API. Minta token baru **minimal 2 minggu sebelumnya**: admin
  menerbitkan yang baru, Anda memindahkan sistem ke token itu dan memastikan jalan, lalu admin mencabut yang lama (kedua token
  boleh aktif bersamaan selama peralihan).
- **Perubahan IP server** (jika IP Strict aktif): kabari admin **sebelum** pindah, kalau tidak penukaran akan `401`.
- Pasang **alarm** untuk kegagalan penukaran token (`401` berulang) — itu tanda token dicabut/kedaluwarsa/IP berubah.
- Satu proses tidak boleh menukar token berulang-ulang secara paralel (lihat `inflight` pada contoh Node.js).

---

## 10. Uji coba sebelum go-live

Mintalah admin menyiapkan **API User uji** dan token uji. Setiap permintaan yang Anda buat **mengirim notifikasi sungguhan ke staf
gudang**, jadi:
- awali `description` dengan `[UJI COBA]`;
- **batalkan** permintaan ujinya setelah selesai (`POST /api/item-requests/{id}/cancel`);
- informasikan tim gudang bahwa uji sedang berlangsung.

Daftar periksa:

- [ ] Tukar token → `200`, `expires_in` = 900
- [ ] Token API salah → `401`
- [ ] Ajukan permintaan (`warehouse_id` angka) → `201`
- [ ] Kirim ulang `external_ref` yang sama → `200` + `duplicate: true`
- [ ] `GET …?external_ref=…` → tepat 1 hasil
- [ ] `warehouse_id` berupa teks → `400` (dan sistem Anda menanganinya, tidak crash/ulang tanpa henti)
- [ ] Baca stok `GET /api/stocks` → `403` (memang tidak diizinkan)
- [ ] Batalkan permintaan uji → `200`, status `CANCELLED`
- [ ] Token akses kedaluwarsa (tunggu >15 menit atau pakai token basi) → klien menukar ulang otomatis dan berhasil
- [ ] Putuskan jaringan di tengah pengiriman → pengiriman ulang tidak membuat permintaan ganda
- [ ] Token disimpan di secret manager, tidak muncul di log

Tersedia **koleksi Postman** berisi enam langkah di atas (impor, isi variabel `api_token`, jalankan berurutan) — minta ke admin.

---

## 11. Pertanyaan umum

**Kenapa harus dua langkah?** Token API berumur panjang dan hanya dikirim ke server otentikasi; yang dikirim ke server warkas
adalah token akses 15 menit. Kalau token akses bocor, bahayanya hanya 15 menit, dan admin bisa mencabut token API kapan saja.

**Apakah tiap permintaan barang harus menukar token dulu?** Tidak. Satu token akses dipakai untuk banyak permintaan selama
masih berlaku (§3).

**Bisakah saya melihat permintaan yang diajukan sistem lain/staf?** Tidak; akun integrasi hanya melihat permintaannya sendiri.

**Bagaimana tahu permintaan sudah dipenuhi?** Lakukan polling (§5) dan baca `status` serta `response_note`.

**Berapa banyak permintaan sekaligus?** Kirim satu per satu (satu panggilan per permintaan). Tidak ada endpoint massal.

**Lupa `external_ref` untuk permintaan yang gagal dikirim?** Simpan `external_ref` di sistem Anda **sebelum** mengirim, supaya
pengiriman ulang memakai nilai yang sama.

---

## 12. Kontak

| Keperluan | Hubungi |
|---|---|
| Token baru / pencabutan / pendaftaran IP / token uji | `[nama & kontak admin integrasi]` |
| Gangguan layanan | `[kontak teknis]` |
