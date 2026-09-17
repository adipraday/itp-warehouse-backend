#!/usr/bin/env node
// Seed data awal: 1 warehouse utama (BU: PUSAT) + item & contact dasar.
//
// Kenapa .mjs, bukan `seed-baseline.sql` lagi: `business_units.id` itu auto-increment
// di auth-backend dan BERGESER tiap `auth_db` di-reseed (lihat
// docs/bug-report-bu-id-mismatch.md — insiden nyata, `WH-C-*` sempat nempel ke
// `bu_id` yang sudah tidak match apa pun di auth-backend, admin.buc jadi tidak bisa
// lihat warehouse-nya sendiri sama sekali). `seed-baseline.sql` yang lama hardcode
// `bu_id: 13` — begitu auth_db reseed dan PUSAT dapat id lain, data di sini langsung
// nyasar tanpa ada yang sadar. Script ini SELALU resolve `bu_id` dari `code` ("PUSAT")
// ke auth-backend di setiap run, jadi tidak pernah stale.
//
// Prasyarat: business unit dengan code "PUSAT" harus sudah ada di auth-backend
// (super-admin bikin lewat POST /business-units kalau belum ada) — script ini
// TIDAK membuat business unit-nya sendiri, cuma resolve id-nya.
//
// Cara pakai: node scripts/seed-baseline.mjs
// Butuh auth-backend jalan (default http://localhost:5020, SERVICE_API_KEY harus
// sama persis dengan .env auth-backend). Warehouse-backend sendiri TIDAK perlu
// jalan — script ini connect langsung ke MySQL, bukan lewat API.

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { findBusinessUnitByCode } from '../src/shared/auth/business-units-client.js';

const BU_CODE = 'PUSAT';
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
    const [whResult] = await conn.execute(
      'INSERT INTO warehouses (code, name, address, bu_id, parent_warehouse_id) VALUES (?, ?, ?, ?, NULL)',
      ['WH-PUSAT', 'Gudang Pusat', 'Jl. Industri Raya No. 1, Jakarta', buId]
    );
    console.log(`Warehouse utama dibuat: id ${whResult.insertId} (WH-PUSAT, bu_id ${buId})`);

    const items = [
      ['SKU-001', 'Router TP-Link', 'pcs', 5, 150000],
      ['SKU-002', 'Kabel LAN Cat6 100m', 'roll', 3, 450000],
      ['SKU-003', 'Switch 8 Port', 'pcs', 5, 250000],
      ['SKU-004', 'Access Point WiFi', 'pcs', 4, 320000],
      ['SKU-005', 'Kabel Power', 'pcs', 10, 25000]
    ];
    for (const item of items) {
      await conn.execute(
        'INSERT INTO items (sku, name, unit, min_stock, selling_price) VALUES (?, ?, ?, ?, ?)',
        item
      );
    }
    console.log(`${items.length} item dibuat.`);

    const contacts = [
      [
        'supplier',
        'PT Sumber Jaya Elektronik',
        '021-5551234',
        'purchasing@sumberjaya.co.id',
        'Jl. Gatot Subroto No. 45, Jakarta'
      ],
      ['supplier', 'CV Mitra Teknologi', '021-5555678', 'sales@mitratek.co.id', 'Jl. Sudirman No. 12, Jakarta'],
      ['customer', 'Budi Santoso', '0812-3456-7890', 'budi.santoso@example.com', null],
      [
        'customer',
        'Toko Makmur Jaya',
        '021-5559999',
        'tokomakmurjaya@example.com',
        'Jl. Pasar Baru No. 8, Jakarta'
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
    '\nSelesai. Stok belum terisi (sengaja) — inbound-kan lewat API supaya stock_mutations/' +
      'FIFO cost layer-nya konsisten, lihat docs/frontend-integration-guide.md §13.'
  );
}

main().catch((error) => {
  console.error('Seed gagal:', error.message);
  process.exit(1);
});
