# Catatan Desain: Hierarki Warehouse per-BU & Aturan Provisioning User

Status: **hasil diskusi, belum diimplementasikan.** Dokumen ini dibuat di sesi terpisah (di luar sesi pengembangan backend) sebagai catatan untuk dibawa & direview ulang di sesi pengembangan sebelum dieksekusi. Bukan spec final.

---

## 1. Konteks (baseline yang sudah ada di backend)

Sudah dikonfirmasi ada di project saat ini, dicatat di sini sebagai baseline supaya nyambung:

- Auth & user management **didelegasikan ke backend auth terpisah** (lihat `docs/auth-backend-requirements.md`). Backend warehouse ini tidak punya tabel `users`/`business_units` — hanya memverifikasi JWT (RS256 via JWKS) dan membaca klaim `{user_id, role, bu_id}`.
- Kolom `bu_id` (nullable) sudah ada di tabel `warehouses`, dipakai untuk scoping. `bu_id = NULL` pada token = super-admin (akses global).
- Role yang sudah didefinisikan di `role-matrix.js`: `super-admin`, `admin-bu`, `staff-gudang`, `kasir-sales`, `purchasing`, `finance`.
- Satu `bu_id` boleh memiliki banyak warehouse, tapi **belum ada pembedaan formal warehouse utama vs cabang** — semua warehouse di bawah satu BU saat ini setara/flat. Sudah dicek: konsep ini belum dibahas di `auth-integration-guide.md` maupun `auth-backend-requirements.md`.

---

## 2. Hierarki Warehouse Utama / Cabang

### Keputusan yang disarankan

Jangan pakai `sub_bu_id` sebagai id BU kedua — karena identitas tenant (BU) tetap satu untuk warehouse utama maupun cabangnya. Yang berbeda hanyalah **relasi antar-warehouse**, bukan tenant-nya.

**Model yang disarankan:** tambah kolom `parent_warehouse_id` (nullable, self-reference ke `warehouses.id`) di tabel `warehouses`.

```
warehouses
  id
  bu_id                 -- tetap sama untuk warehouse utama & semua cabangnya
  parent_warehouse_id   -- NULL = warehouse utama; diisi id warehouse utama = warehouse cabang
  code, name, address, ...
```

### Aturan bisnis yang perlu ditegakkan di service layer

- `parent_warehouse_id` yang diisi **wajib** punya `bu_id` sama dengan `bu_id` milik warehouse anak (cabang tidak boleh nempel ke warehouse BU lain).
- Kedalaman dibatasi **2 level saja**: warehouse yang jadi `parent_warehouse_id` tidak boleh punya `parent_warehouse_id` sendiri (parent-nya harus warehouse utama, bukan cabang lain). Cegah rantai cabang-dari-cabang yang tidak perlu.
- Warehouse utama = row dengan `parent_warehouse_id IS NULL`.

### Pertanyaan terbuka — perlu diputuskan di sesi dev

1. Apakah satu BU boleh punya **lebih dari satu** warehouse utama (lebih dari satu row `parent_warehouse_id IS NULL` dalam satu `bu_id`), atau harus tepat satu? Kalau harus tepat satu, ini perlu divalidasi di service layer (bukan constraint DB murni, karena MySQL tidak punya partial unique index bawaan).
2. Migration tambahan: `ALTER TABLE warehouses ADD COLUMN parent_warehouse_id INT NULL`, index, dan FK self-reference (`ON DELETE RESTRICT`, mengikuti pola FK lain di project ini). Sifatnya additive/non-breaking seperti migration `bu_id` sebelumnya.
3. Apakah `DELETE /warehouses/:id` perlu tambahan validasi: warehouse utama tidak boleh dihapus kalau masih punya warehouse cabang aktif di bawahnya?

---

## 3. Aturan Provisioning User (untuk backend auth terpisah)

### Hierarki role & siapa boleh membuat siapa

```
super-admin
  -> bisa membuat admin-bu untuk BU MANAPUN (lintas tenant)

admin-bu
  -> bisa membuat admin-bu LAIN, TAPI HANYA untuk BU yang sama dengan dirinya
     (co-admin dalam satu company — bukan admin-bu untuk BU lain)
  -> bisa membuat & mengelola staff (staff-gudang, kasir-sales, purchasing, finance)
     dalam BU yang sama
```

### Poin penegakan yang wajib ada di endpoint provisioning user

- Kalau requester `role = super-admin`: `bu_id` target boleh apa saja (termasuk BU manapun yang sudah ada).
- Kalau requester `role = admin-bu`: `bu_id` target **wajib di-force ke `bu_id` milik requester sendiri** di server — jangan pernah percaya `bu_id` yang dikirim client meskipun requester mengirim nilai berbeda. Sama persis dengan pola `effectiveBuId()` yang sudah dipakai di `warehouses.routes.js` untuk kasus serupa (BU tidak boleh diisi bebas oleh non-super-admin).
- Tidak ada role manapun yang bisa membuat `super-admin` lewat endpoint biasa — provisioning super-admin di luar alur normal (manual/seed).

### Pertanyaan terbuka — perlu diputuskan di sesi dev

1. Apakah admin-bu boleh menghapus/menonaktifkan admin-bu lain di BU yang sama (termasuk dirinya sendiri)? Kalau ya, perlu safeguard: satu BU **harus selalu punya minimal satu admin-bu aktif** — cegah skenario BU kehilangan seluruh admin karena admin terakhir menonaktifkan dirinya sendiri atau saling menghapus.
2. Apakah ada batas jumlah admin-bu per BU, atau bebas?
3. Apakah admin-bu co-admin yang dibuat sesama admin-bu punya hak yang persis sama (full parity), atau ada admin-bu "pertama/owner" yang punya privilege ekstra (misal cuma owner yang bisa hapus BU-nya sendiri)?

---

## 4. Ringkasan Rekomendasi

| Area | Rekomendasi | Status |
|---|---|---|
| Hierarki warehouse | Tambah `parent_warehouse_id` (self-reference) di `warehouses`, bukan `sub_bu_id` terpisah | Diusulkan, belum ada migration |
| Validasi hierarki | Parent wajib `bu_id` sama, kedalaman max 2 level | Diusulkan |
| Provisioning admin-bu | Super-admin: lintas BU. Admin-bu: hanya BU sendiri (co-admin) | Disepakati arahnya, implementasi ada di backend auth terpisah |
| Provisioning staff | Admin-bu bisa kelola staff di BU sendiri | Sudah disepakati sebelumnya |
| Safeguard admin minimal | BU harus selalu punya >= 1 admin-bu aktif | Belum diputuskan, perlu dibahas |

---

*Dokumen ini dibuat di luar sesi pengembangan backend, sebagai bahan diskusi/handoff. Silakan direview dan disesuaikan sebelum dieksekusi jadi migration/kode.*
