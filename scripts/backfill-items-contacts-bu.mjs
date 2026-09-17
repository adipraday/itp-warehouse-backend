#!/usr/bin/env node
// One-time backfill: assign every currently-unassigned item/contact (bu_id IS
// NULL, i.e. every row that existed before migrations/202609080001) to a target
// business unit, resolved by `code` — never hardcoded, same reasoning as
// scripts/seed-baseline.mjs (docs/bug-report-bu-id-mismatch.md).
//
// Run once after migrating, before relying on item/contact BU-scoping:
//   node scripts/backfill-items-contacts-bu.mjs [CODE]
// CODE defaults to "PUSAT" (where this dev DB's original seed data came from).

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { findBusinessUnitByCode } from '../src/shared/auth/business-units-client.js';

const BU_CODE = process.argv[2] || 'PUSAT';
const config = {
  AUTH_API_URL: process.env.AUTH_API_URL || 'http://localhost:5020',
  SERVICE_API_KEY: process.env.SERVICE_API_KEY || 'dev-service-key-local'
};

async function resolveBuId(code) {
  let bu;
  try {
    bu = await findBusinessUnitByCode(config, code);
  } catch (error) {
    throw new Error(
      `Gagal menghubungi auth-backend di ${config.AUTH_API_URL} untuk resolve BU "${code}": ${error.message}.`
    );
  }
  if (!bu) {
    throw new Error(`Business unit dengan code "${code}" tidak ditemukan di auth-backend.`);
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

  try {
    const [itemsResult] = await conn.execute('UPDATE items SET bu_id = ? WHERE bu_id IS NULL', [buId]);
    console.log(`items: ${itemsResult.affectedRows} baris di-assign ke bu_id ${buId}`);

    const [contactsResult] = await conn.execute('UPDATE contacts SET bu_id = ? WHERE bu_id IS NULL', [buId]);
    console.log(`contacts: ${contactsResult.affectedRows} baris di-assign ke bu_id ${buId}`);
  } finally {
    await conn.end();
  }

  console.log('\nSelesai. Item/contact yang baru dibuat SETELAH ini otomatis ter-scope ke BU pembuatnya sendiri.');
}

main().catch((error) => {
  console.error('Backfill gagal:', error.message);
  process.exit(1);
});
