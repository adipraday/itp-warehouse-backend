# Deploy ke VPS — warehouse-system-api

Status: **LIVE** di produksi (deploy dieksekusi 2026-09-19). Domain `https://api-wms.itpintar.co.id`
sudah jalan dengan TLS, terintegrasi dengan `skinet-auth-api` yang live duluan di VPS yang sama.

Arsitektur ini **mengikuti persis pola yang sudah terbukti dipakai `skinet-auth-api`**
(`/opt/skinet-auth-api/docs/deployment-vps.md`) — 2 service Docker per aplikasi, nginx host
sebagai reverse-proxy TLS, database container tanpa port publik:

```
                    ┌─────────────── VPS (157.20.95.5) ───────────────┐
Internet ──443──▶  nginx (host, TLS via certbot)                       │
   (Cloudflare)     │                                                  │
                     ├─ auth.itpintar.co.id    ──▶ 127.0.0.1:5020      │
                     │    └─ skinet-auth-api-app-1 ─▶ skinet-auth-api-db-1 (no published port)
                     │                                                  │
                     └─ api-wms.itpintar.co.id ──▶ 127.0.0.1:3000      │
                          └─ warehouse-system-api-app-1 ─▶ warehouse-system-api-db-1 (no published port)
                    └──────────────────────────────────────────────────┘
```

Kedua aplikasi berjalan independen (compose project & docker network masing-masing:
`warehouse-system-api_internal` vs `skinet-auth-api_internal`), tapi warehouse-backend
**bergantung** ke auth-backend untuk verifikasi JWT (JWKS fetch ke
`https://auth.itpintar.co.id/.well-known/jwks.json`) dan resolve business-unit
(`X-Service-Key` ke `AUTH_API_URL`) — lihat `docs/auth-multitenant-coordination.md`.

**File siap pakai di repo ini:**
- `Dockerfile` — image `app` (multi-stage, Node 20 Debian slim, non-root user `warehouse` UID 10002)
- `docker-compose.yml` — service `app` + `db` (MariaDB 10.11), network internal, `db` tanpa port publik
- `.dockerignore`
- `deploy/nginx-api-wms.conf` — reverse-proxy host nginx → container `app` (starting point sebelum certbot)
- `deploy/backup-db.sh`, `deploy/restore-db.sh` — backup/restore otomatis (lihat §8)

---

## 1. Topologi VPS & akses

- Host: `157.20.95.5`, SSH port `2223`.
- User operasional: `adiprada` (member grup `sudo` dan `docker`; sudo **butuh password**,
  tidak ada NOPASSWD — perintah yang butuh root selalu dijalankan manual oleh operator, bukan
  lewat sesi asisten).
- Direktori app: `/opt/warehouse-system-api/`, dimiliki `adiprada:adiprada` (beda dengan
  `/opt/skinet-auth-api/` yang dimiliki `root:root` — riwayat setup berbeda, keduanya valid
  selama konsisten dengan siapa yang boleh baca `.env`-nya).
- `.env` produksi: `/opt/warehouse-system-api/.env`, `chmod 600`, **tidak pernah** ditampilkan
  ulang di sesi chat manapun setelah ditulis.

---

## 2. `.env` produksi

Satu file `.env` dipakai bareng oleh `docker-compose.yml` (substitusi `${DB_PASSWORD}` dst.)
dan di-mount ke container `app` lewat `env_file:`. Isinya:

```
NODE_ENV=production
HOST=0.0.0.0
PORT=3000

DB_HOST=db
DB_PORT=3306
DB_NAME=warehouse_db
DB_USER=warehouse_app
DB_PASSWORD=<generated, 48-hex>
DB_ROOT_PASSWORD=<generated, 48-hex>
DB_CONNECTION_LIMIT=10

LOG_LEVEL=info
CORS_ORIGIN=https://admin.itpintar.co.id
IDEMPOTENCY_TTL_HOURS=24

AUTH_MODE=jwt
AUTH_JWT_AUDIENCE=warehouse-system-api
AUTH_JWT_ISSUER=https://auth.itpintar.co.id/
AUTH_JWKS_URL=https://auth.itpintar.co.id/.well-known/jwks.json
AUTH_API_URL=https://auth.itpintar.co.id
SERVICE_API_KEY=<sama persis dengan nilai di /opt/skinet-auth-api/.env>
```

`SERVICE_API_KEY` **harus** identik dengan nilai yang dipakai `skinet-auth-api` (diambil dari
`docker inspect skinet-auth-api-app-1` saat setup) — beda nilai berarti
`GET /business-units?code=` ditolak. Nilai aslinya sengaja tidak dicatat di dokumen ini,
mengikuti aturan yang sama yang sudah berlaku di dokumentasi auth-backend.

---

## 3. Database (container `db`)

MariaDB 10.11, **tanpa port publik** — hanya reachable dari container `app` lewat docker
network internal. Migrasi dijalankan sekali dari dalam container `app` setelah `db` sehat:

```bash
docker compose exec app npm run migrate:latest
```

14 migrasi (termasuk 2 migrasi multi-tenant fix — `items.sku`/`items.barcode` di-scope per
`bu_id`, lihat `docs/api-documentation.md` §5) sudah dijalankan terhadap database produksi yang
fresh. Total 23 tabel aplikasi + `knex_migrations` + `knex_migrations_lock` = 25 tabel.

---

## 4. Menjalankan app (`docker compose`)

```bash
cd /opt/warehouse-system-api
docker compose up -d --build
docker compose ps        # app & db harus "healthy"
docker compose logs -f app
```

`knex` sengaja dipindah dari `devDependencies` ke `dependencies` di `package.json` — image
production di-build dengan `npm ci --omit=dev`, dan CLI `knex` tetap dibutuhkan di dalamnya
untuk `npm run migrate:latest`.

---

## 5. nginx (host) + TLS

```bash
sudo cp deploy/nginx-api-wms.conf /etc/nginx/sites-available/api-wms.itpintar.co.id
sudo ln -s /etc/nginx/sites-available/api-wms.itpintar.co.id /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api-wms.itpintar.co.id
```

Cloudflare di depan nginx: DNS record **Proxied** (orange-cloud), SSL/TLS mode **Full
(strict)** — harus sama dengan `auth.itpintar.co.id` yang sudah live, kalau tidak terjadi
redirect loop/timeout (origin menerima koneksi plain-HTTP dari edge Cloudflare padahal
mengharapkan HTTPS).

---

## 6. Verifikasi pasca-deploy (checklist)

- [x] `curl https://api-wms.itpintar.co.id/health` → `{"data":{"status":"ok"}}`
- [x] Semua 25 tabel ada di `warehouse_db` produksi
- [x] JWKS fetch dari `https://auth.itpintar.co.id/.well-known/jwks.json` sukses — dibuktikan
      dengan JWT hasil crafting manual (header valid, signature palsu) yang ditolak dengan
      error `"signature verification failed"` (bukan error fetch/network), artinya app benar
      benar mengambil public key dan mencoba verifikasi, bukan skip validasi.
- [ ] Request nyata dengan JWT asli (login via auth-backend) + `bu_id` asli ke
      `GET/POST /api/warehouses` — **belum dikonfirmasi user**, diverifikasi lewat script
      terpisah yang dijalankan user sendiri (agar kredensial asli tidak pernah masuk sesi
      asisten).

---

## 7. Backup & recovery

Sebelumnya **tidak ada** sistem backup untuk warehouse-backend maupun auth-backend — volume
Docker (`db_data`) persisten lintas restart, tapi bukan pengganti backup (satu
`docker compose down -v` yang salah = hilang semua). Dibangun 2026-09-20:

### 7.1 `deploy/backup-db.sh`

Dump harian via `mariadb-dump --single-transaction --quick --routines --triggers`, di-gzip
dengan nama file `<DB_NAME>-<timestamp>.sql.gz`, ditulis dulu sebagai `.partial` lalu di-rename
setelah sukses (supaya dump yang gagal/ke-kill tidak pernah terlihat seperti backup valid).
Rotasi otomatis: file lebih tua dari `RETENTION_DAYS` (default 14 hari) dihapus.

Generik dengan sengaja — baca `DB_NAME`/`DB_ROOT_PASSWORD` langsung dari `.env` proyek target,
jadi **script yang sama, tanpa diedit**, dipakai untuk `skinet-auth-api` (lihat §7.3).

```bash
./deploy/backup-db.sh                 # pakai .env di direktori proyek sendiri
RETENTION_DAYS=30 ./deploy/backup-db.sh   # override retensi
```

Cron (crontab milik `adiprada`, **bukan** root — karena `/opt/warehouse-system-api` sudah
dimiliki `adiprada` dan dia ada di grup `docker`, jadi tidak perlu sudo untuk `docker compose
exec`):

```
15 2 * * * /opt/warehouse-system-api/deploy/backup-db.sh >> /opt/warehouse-system-api/backups/backup.log 2>&1
```

### 7.2 `deploy/restore-db.sh`

Sengaja **interaktif dan tidak bisa di-cron** — restore itu destruktif (menimpa database yang
sedang live), jadi script ini menolak berjalan tanpa TTY (`[ ! -t 0 ]`) dan mewajibkan operator
mengetik ulang nama database persis sebelum melanjutkan.

```bash
./deploy/restore-db.sh backups/warehouse_db-20260919-183815.sql.gz
```

### 7.3 Pola yang sama diterapkan ke `skinet-auth-api`

`/opt/skinet-auth-api/` dimiliki `root:root` (bukan `adiprada`), jadi setup di sana perlu sudo:
script disalin ke `/opt/skinet-auth-api/deploy/` dengan `sudo cp` + `chown root:root`, dan cron
harian dipasang di **crontab root** (`sudo crontab -e`, bukan crontab `adiprada`) karena hanya
root yang bisa baca `.env` (`chmod 600` milik root) dan menjalankan `docker compose exec` di
direktori itu:

```
20 2 * * * /opt/skinet-auth-api/deploy/backup-db.sh >> /opt/skinet-auth-api/backups/backup.log 2>&1
```

Karena `skinet-auth-api` punya git repo sendiri (`adipraday/itp-backend-auth`), kedua script
ini juga perlu di-commit ke repo itu oleh siapapun yang mengelolanya (dicatat sebagai catatan di
`docs/auth-multitenant-coordination.md`) — di VPS sendiri sudah aktif jalan terlepas dari itu.

### 7.4 Gap yang masih terbuka: off-site copy

Backup di atas **masih tersimpan di disk VPS yang sama** dengan database live-nya — tidak
melindungi dari kegagalan disk/VPS itu sendiri. `backup-db.sh` sudah punya hook
`OFFSITE_UPLOAD_CMD` (env var opsional, dieksekusi setelah dump berhasil) untuk menyalin ke
storage eksternal (mis. `rclone copy ... remote:bucket/` ke S3/R2/B2), tapi **belum ada akun/
kredensial storage yang dipilih** — ini keputusan terbuka, bukan sesuatu yang sudah diblokir
teknis.

---

## 8. Operasional lanjutan (belum otomatis — sadar ditunda)

Sama seperti catatan di `skinet-auth-api/docs/deployment-vps.md` §8:

- **Off-site backup** — lihat §7.4.
- **Monitoring/alerting** — belum ada (uptime check eksternal ke `/health` direkomendasikan).
- **CI** — belum ada pipeline, deploy masih manual (`git pull` + `docker compose up -d --build`).
- **Logging** — masih default Fastify logger ditangkap Docker (`docker compose logs app`).
