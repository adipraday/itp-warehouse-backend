#!/usr/bin/env node
// Seed data BU-C: warehouse utama + 1 cabang (contoh pemakaian fitur hierarki
// main/branch — lihat docs/warehouse-hierarchy.md), plus 2 contact.
//
// Sama seperti scripts/seed-baseline.mjs: `bu_id` SELALU di-resolve dari `code`
// ("BU-C") ke auth-backend di setiap run, tidak pernah hardcode angka — itu yang
// menyebabkan insiden di docs/bug-report-bu-id-mismatch.md sebelumnya.
//
// Prasyarat: business unit dengan code "BU-C" harus sudah ada di auth-backend
// (super-admin bikin lewat POST /business-units kalau belum ada) — script ini
// TIDAK membuat business unit-nya sendiri, cuma resolve id-nya.
//
// Item dipakai dari master data global yang sama seperti seed-baseline.mjs
// (SKU-001–005) — `items`/`contacts` tidak di-scope per-BU di skema ini, jadi
// jalankan seed-baseline.mjs dulu kalau item-nya belum ada.
//
// Cara pakai: node scripts/seed-bu-c.mjs

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { findBusinessUnitByCode } from '../src/shared/auth/business-units-client.js';

const BU_CODE = 'BU-C';
const config = {
  AUTH_API_URL: process.env.AUTH_API_URL || 'http://localhost:5020',
  SERVICE_API_KEY: process.env.SERVICE_API_KEY || 'dev-service-key-local'
};

// Reuses the same fetch/error-handling as the app's own bu_id validation
// (src/shared/auth/business-units-client.js) instead of duplicating it — one
// implementation of "how to talk to the auth-backend", not two that can drift apart.
async function resolveBuId(code) {
  let bu;
  try {
    bu = await findBusinessUnitByCode(config, code);
  } catch (error) {
    throw new Error(
      `Gagal menghubungi auth-backend di ${config.AUTH_API_URL} untuk resolve BU "${code}": ${error.message}. ` +
        `Pastikan auth-backend jalan dan SERVICE_API_KEY sama persis di .env kedua backend.`
    );
  }
  if (!bu) {
    throw new Error(
      `Business unit dengan code "${code}" tidak ditemukan di auth-backend. Buat dulu lewat ` +
        `POST /business-units (super-admin), baru jalankan ulang script ini.`
    );
  }
  if (bu.status !== 'ACTIVE') {
    throw new Error(`Business unit "${code}" (id ${bu.id}) statusnya ${bu.status}, bukan ACTIVE.`);
  }
  return bu.id;
}

async function main() {
  const buId = await resolveBuId(BU_CODE);
  console.log(`Resolved BU "${BU_CODE}" -> id ${buId} (dari auth-backend, bukan hardcode)`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'warehouse_db'
  });

  await conn.beginTransaction();
  try {
    const [mainResult] = await conn.execute(
      'INSERT INTO warehouses (code, name, address, bu_id, parent_warehouse_id) VALUES (?, ?, ?, ?, NULL)',
      ['WH-C-PUSAT', 'Gudang Utama BU-C', 'Jl. Diponegoro No. 7, Surabaya', buId]
    );
    const mainId = mainResult.insertId;
    console.log(`Warehouse utama dibuat: id ${mainId} (WH-C-PUSAT, bu_id ${buId})`);

    const [branchResult] = await conn.execute(
      'INSERT INTO warehouses (code, name, address, bu_id, parent_warehouse_id) VALUES (?, ?, ?, ?, ?)',
      ['WH-C-CABANG', 'Gudang Cabang BU-C', 'Jl. Ahmad Yani No. 22, Malang', buId, mainId]
    );
    console.log(`Warehouse cabang dibuat: id ${branchResult.insertId} (WH-C-CABANG, parent_warehouse_id ${mainId})`);

    const contacts = [
      [
        'supplier',
        'PT Surya Elektrindo',
        '031-5551122',
        'purchasing@suryaelektrindo.co.id',
        'Jl. Rungkut Industri No. 3, Surabaya'
      ],
      [
        'customer',
        'Toko Jaya Makmur Surabaya',
        '031-5559988',
        'jayamakmur.sby@example.com',
        'Jl. Basuki Rahmat No. 15, Surabaya'
      ]
    ];
    for (const contact of contacts) {
      await conn.execute('INSERT INTO contacts (type, name, phone, email, address) VALUES (?, ?, ?, ?, ?)', contact);
    }
    console.log(`${contacts.length} contact dibuat.`);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }

  console.log(
    '\nSelesai. Stok belum terisi — inbound-kan lewat API (ke warehouse utama dan/atau cabang) ' +
      'supaya stock_mutations/FIFO cost layer-nya konsisten, lihat docs/frontend-integration-guide.md §13.'
  );
}

main().catch((error) => {
  console.error('Seed gagal:', error.message);
  process.exit(1);
});
