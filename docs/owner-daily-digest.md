# Ringkasan harian owner (2026-10-12)

Setiap pagi tiap **owner** menerima satu notifikasi (inbox + push FCM ke perangkat yang terdaftar) berisi ringkasan
**kemarin** (hari bisnis WIB) untuk semua BU di perusahaannya. Tipe notifikasi: `owner_digest`,
`data = { type: 'owner_digest', date: 'YYYY-MM-DD' }`. Di web, klik notifikasi membuka `/branch-comparison`.

## Isi

Hanya bagian yang membawa informasi yang dimasukkan, jadi hari sepi tetap singkat:

> **Ringkasan 11 Okt 2026** — Penjualan Rp 1.250.000 (12 transaksi, naik 8% dari hari sebelumnya). Margin 24.5%.
> Terbaik: Cabang 1. Kas: 1 sesi berselisih (kurang Rp 50.000). 2 sesi kasir belum ditutup lebih dari 24 jam.
> Stok: 3 habis, 5 menipis.

Sumber angka = `getBranchComparison` dan `getCashVariance` (modul dashboard, `owner-insights.service.js`) untuk satu hari,
dibatasi ke `bu_ids` milik owner itu (dari `user_directory`), jadi satu perusahaan tidak pernah melihat angka perusahaan
lain. Owner tanpa daftar BU, atau tanpa warehouse di BU-nya, tidak dikirimi apa pun.

## Cara kerja

- `src/shared/scheduler/owner-digest-scheduler.js` — timer in-process (cek tiap 5 menit, plus sekali 30 detik setelah boot
  supaya restart setelah jam kirim langsung menyusul). Dimulai dari `server.js`, bukan `buildApp()`, jadi tes tidak
  menyalakan timer.
- `owner-digest.service.js#runOwnerDigest` — kirim hanya antara `OWNER_DIGEST_HOUR` (default 07:00 WIB) dan 21:00 WIB.
  Lewat 21:00 tidak dikirim lagi: ringkasan "kemarin" di malam hari tidak berguna.
- **Idempotent**: tabel `owner_digest_log (user_id, digest_date)`; hari "diklaim" dengan `INSERT IGNORE` dan hanya
  pemanggil yang benar-benar menyisipkan baris yang mengirim. Restart, tick susulan, atau dua instance tidak bisa
  mengirim ganda. Bila membangun/menyimpan notifikasi gagal, klaim dikembalikan (`release`) dan tick berikutnya mencoba
  lagi; kegagalan push saja tidak di-retry karena baris inbox sudah ada (akan terduplikasi).
- `push.js#notifyUsers` — pengiriman ke user tertentu (bukan audiens role/BU).

## Konfigurasi (`.env`, semua opsional)

| Variabel | Default | Arti |
|---|---|---|
| `OWNER_DIGEST_ENABLED` | `true` | `false` mematikan scheduler sepenuhnya |
| `OWNER_DIGEST_HOUR` | `7` | Jam paling awal kirim, WIB (0–23) |

## Zona waktu

Server dan MariaDB berjalan di UTC; "hari ini/kemarin" dan jam kirim dihitung di WIB (`shared/utils/business-time.js`).
Pantauan selisih kas ikut dikelompokkan per hari WIB (`CONVERT_TZ(closed_at, '+00:00', '+07:00')`).

## Batasan yang diketahui

- Belum ada pengaturan per-owner untuk berhenti berlangganan (hanya saklar global lewat env).
- Hanya role `owner`; admin-bu belum menerima ringkasan.
- Stok kritis adalah kondisi saat dikirim, bukan akhir hari kemarin.
