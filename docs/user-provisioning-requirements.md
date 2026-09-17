# Spec Addendum: Aturan Provisioning User

**Status: §2 (force-`bu_id`, larangan provisioning super-admin) SUDAH DIIMPLEMENTASIKAN di
auth-backend (dikonfirmasi 2026-09-06 lewat baca langsung `user.controller.js` —
`resolveBusinessUnit()` + `assertCanAssignRole()` sudah persis sesuai §2). §3 (pertanyaan
terbuka soal safeguard admin minimal, batas jumlah, parity co-admin) masih belum diputuskan.**
Disusun dari "Catatan Desain: Hierarki Warehouse per-BU & Aturan Provisioning User" (§3, sesi
diskusi terpisah, 2026-08-28), direview di sesi pengembangan warehouse-backend, lalu ditulis
ulang di sini biar siap dibawa ke sesi auth-backend. Bagian hierarki warehouse (§2 draft asli)
sudah diimplementasikan — lihat [`warehouse-hierarchy.md`](./warehouse-hierarchy.md), tidak
relevan buat dokumen ini.

Ini **bukan** perpanjangan dari [`auth-backend-requirements.md`](./auth-backend-requirements.md)
(yang sudah ditandai basi oleh sesi auth-backend sendiri) — anggap dokumen ini spec tambahan
berdiri sendiri yang menumpuk di atas model role & auth yang sudah berjalan sekarang (lihat
[`auth-integration-guide.md`](./auth-integration-guide.md) untuk state terkini).

---

## 1. Konteks

Baseline yang sudah ada & dikonfirmasi jalan di auth-backend saat ini (lihat
`src/routes/user.routes.js`, `src/routes/businessUnit.routes.js`):

- `POST /users` — buat user baru, `authenticate + authorize('super-admin', 'admin-bu')`.
- `PUT /users/:id` — update user (termasuk `role`, `bu_id`, `status`), authorize sama.
- `GET /users`, `GET /users/:id` — admin-only (`super-admin`/`admin-bu`).
- **KOREKSI (2026-09-06):** waktu pertama ditulis, gue kira "belum ada pembeda perilaku
  antara requester `super-admin` vs `admin-bu`" — itu **salah**, ternyata sudah ada.
  `user.controller.js` punya `resolveBusinessUnit(requester, role, buIdInput)` yang persis
  menegakkan aturan §2 di bawah: `admin-bu` **di-force** ke `bu_id` sendiri (input diabaikan),
  `super-admin` bebas pilih `bu_id` mana pun (divalidasi `assertBusinessUnitUsable()`). Ada
  juga `assertCanAssignRole()` yang membatasi role apa yang boleh di-assign non-super-admin.
  §2 di bawah ini sebenarnya sudah **deskripsi kondisi yang sudah berjalan**, bukan lagi gap.

## 2. Hierarki role provisioning (SUDAH DIIMPLEMENTASIKAN — dikonfirmasi 2026-09-06)

```
super-admin
  -> bisa membuat admin-bu untuk BU MANAPUN (lintas tenant)
admin-bu
  -> bisa membuat admin-bu LAIN, TAPI HANYA untuk BU yang sama dengan dirinya
     (co-admin dalam satu company — bukan admin-bu untuk BU lain)
  -> bisa membuat & mengelola staff (staff-gudang, kasir-sales, purchasing, finance)
     dalam BU yang sama
```

### Poin penegakan wajib di `POST /users` dan `PUT /users/:id`

- Requester `role = super-admin`: `bu_id` target boleh apa saja (termasuk BU manapun yang
  sudah ada, lewat `GET /business-units` yang juga sudah super-admin-only).
- Requester `role = admin-bu`: `bu_id` target **wajib di-force ke `bu_id` milik requester
  sendiri** di server-side — **jangan pernah percaya** `bu_id` yang dikirim client meski
  requester mengirim nilai berbeda. Pola yang sama seperti `effectiveBuId()` di warehouse-backend
  (`src/modules/warehouses/warehouses.routes.js`) — kalau requester bukan super-admin,
  override nilai dari body, jangan cuma validasi-lalu-tolak.
- **Tidak ada role manapun** yang bisa membuat `role: super-admin` lewat endpoint `POST /users`
  biasa — kalau field `role` di body = `super-admin` dan requester bukan super-admin (atau
  bahkan requester super-admin sekalipun — ini juga perlu diputuskan, lihat pertanyaan terbuka
  #4), endpoint publik ini sebaiknya tetap tolak. Provisioning `super-admin` lewat jalur
  terpisah (manual/seed script), bukan API ini.

## 3. Pertanyaan terbuka — BELUM diputuskan, perlu dibahas di sesi auth-backend

Ini bukan rekomendasi gue, murni pertanyaan yang perlu keputusan bisnis dari yang punya
otoritas atas auth-backend:

1. **Boleh admin-bu menghapus/menonaktifkan admin-bu lain di BU yang sama** (termasuk dirinya
   sendiri)? Kalau ya, wajib ada safeguard: satu BU **harus selalu punya minimal satu admin-bu
   aktif** — cegah skenario BU kehilangan seluruh admin karena admin terakhir menonaktifkan
   dirinya sendiri atau saling menghapus. Tanpa safeguard ini, BU itu jadi orphan (tidak ada
   yang bisa provisioning staff baru di situ selain super-admin turun tangan manual).
2. **Ada batas jumlah admin-bu per BU**, atau bebas?
3. **Admin-bu co-admin yang dibuat sesama admin-bu punya hak yang persis sama (full parity)**,
   atau ada admin-bu "pertama/owner" dengan privilege ekstra (misal cuma owner yang bisa hapus
   BU-nya sendiri, atau cuma owner yang bisa menonaktifkan co-admin lain)?
4. (Ditambahkan saat review) — kalau jawaban #1 "ya boleh hapus/nonaktifkan", apakah aturan
   force-`bu_id` di §2 juga berlaku untuk **update role/status** user lain (bukan cuma create),
   termasuk kasus admin-bu mencoba menonaktifkan/mengubah role user yang **bukan** anggota
   BU-nya (harus ditolak, tapi perlu dipastikan `PUT /users/:id` juga cross-check `bu_id` target
   user terhadap `bu_id` requester, bukan cuma pas create)?

## 4. Ringkasan

| Area | Arah | Status |
|---|---|---|
| Provisioning admin-bu | Super-admin: lintas BU. Admin-bu: hanya BU sendiri (co-admin), `bu_id` di-force server-side | **SUDAH diimplementasikan** (`resolveBusinessUnit()`), dikonfirmasi 2026-09-06 |
| Provisioning staff | Admin-bu bisa kelola staff di BU sendiri | **SUDAH diimplementasikan** (`assertCanAssignRole()`), dikonfirmasi 2026-09-06 |
| Larangan provisioning super-admin lewat API biasa | Selalu ditolak di `POST /users` | Perlu dicek ulang di `assertCanAssignRole()`/`ADMIN_BU_ASSIGNABLE_ROLES` — belum diverifikasi eksplisit |
| Safeguard admin minimal per BU | — | **Belum diputuskan** (§3.1) |
| Batas jumlah admin-bu per BU | — | **Belum diputuskan** (§3.2) |
| Parity antar co-admin vs owner | — | **Belum diputuskan** (§3.3) |
| Force-`bu_id` pada update (bukan cuma create) | — | **Belum diputuskan** (§3.4) |

---

*Dibawa dari sesi warehouse-backend sebagai bahan siap-eksekusi. Empat pertanyaan di §3 wajib
diputuskan dulu sebelum implementasi — jangan default ke salah satu tanpa konfirmasi eksplisit,
karena masing-masing berdampak ke availability BU (kehilangan admin) atau keamanan
(cross-BU tampering) kalau salah pilih.*
