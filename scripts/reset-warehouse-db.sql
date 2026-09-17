-- Reset warehouse_db: mengosongkan SEMUA tabel data (bukan drop tabel, struktur tetap).
--
-- REVISI KE-2 (2026-08-28): versi pertama pakai TRUNCATE + SET FOREIGN_KEY_CHECKS=0 (gagal,
-- #1701 — client tidak mempertahankan session variable antar statement). Versi kedua pakai
-- DELETE FROM urutan child->parent tapi cuma menangani SATU kolom self-referencing
-- (warehouses.parent_warehouse_id) dan lupa 6 lainnya (gagal, #1451 di
-- inventory_cost_layers.origin_cost_layer_id).
--
-- Versi ini: di-grep ulang SEMUA constraint FOREIGN KEY di migrations/202608240001_initial_schema.js
-- + 202608280002_add_warehouse_parent.js secara sistematis (bukan baca manual lagi) untuk
-- pastikan semua kolom self-referencing ketemu. Totalnya ADA 7:
--   inventory_transactions.reversal_of_transaction_id   -> inventory_transactions
--   stock_transfers.reversal_of_transfer_id             -> stock_transfers
--   stock_opnames.reversal_of_stock_opname_id           -> stock_opnames
--   invoices.reversal_of_invoice_id                     -> invoices
--   item_returns.reversal_of_return_id                  -> item_returns
--   inventory_cost_layers.origin_cost_layer_id          -> inventory_cost_layers
--   warehouses.parent_warehouse_id                      -> warehouses
-- Semuanya di-NULL-kan dulu sebelum baris tabelnya sendiri dihapus, supaya tidak ada baris
-- yang masih menunjuk baris lain yang sedang/akan dihapus dalam tabel yang sama.
--
-- Urutan DELETE antar-tabel PERSIS sama seperti fungsi down() migration awal
-- (migrations/202608240001_initial_schema.js) — urutan itu sudah teruji lewat
-- migrate:rollback, jadi dijamin benar terhadap FK lintas-tabel.
--
-- TIDAK bergantung pada FOREIGN_KEY_CHECKS sama sekali — jadi tidak akan kena masalah
-- seperti revisi pertama, apapun client SQL yang dipakai.
--
-- Tabel `knex_migrations` & `knex_migrations_lock` SENGAJA tidak disentuh — itu tracking
-- state migration Knex, bukan data bisnis.
--
-- Cara pakai:
--   mysql -u root -h 127.0.0.1 -P 3306 warehouse_db < scripts/reset-warehouse-db.sql
-- atau tempel isinya ke client MySQL apa pun (Workbench/DBeaver/phpMyAdmin/dst).
--
-- ⚠️ IRREVERSIBLE. Ini menghapus SEMUA data bisnis (warehouses, items, sales, purchases, dst).

-- 1. Putus semua relasi self-referencing dulu, di 7 tabel yang punya kolom ini.
UPDATE inventory_transactions SET reversal_of_transaction_id = NULL WHERE reversal_of_transaction_id IS NOT NULL;
UPDATE stock_transfers SET reversal_of_transfer_id = NULL WHERE reversal_of_transfer_id IS NOT NULL;
UPDATE stock_opnames SET reversal_of_stock_opname_id = NULL WHERE reversal_of_stock_opname_id IS NOT NULL;
UPDATE invoices SET reversal_of_invoice_id = NULL WHERE reversal_of_invoice_id IS NOT NULL;
UPDATE item_returns SET reversal_of_return_id = NULL WHERE reversal_of_return_id IS NOT NULL;
UPDATE inventory_cost_layers SET origin_cost_layer_id = NULL WHERE origin_cost_layer_id IS NOT NULL;
UPDATE warehouses SET parent_warehouse_id = NULL WHERE parent_warehouse_id IS NOT NULL;

-- 2. Hapus semua baris, urutan child -> parent (sama seperti down() migration awal).
DELETE FROM inventory_cost_allocations;
DELETE FROM inventory_cost_layers;
DELETE FROM stock_mutations;
DELETE FROM item_return_details;
DELETE FROM item_returns;
DELETE FROM payments;
DELETE FROM invoice_details;
DELETE FROM invoices;
DELETE FROM stock_opname_details;
DELETE FROM stock_opnames;
DELETE FROM stock_transfer_details;
DELETE FROM stock_transfers;
DELETE FROM inventory_transaction_details;
DELETE FROM inventory_transactions;
DELETE FROM idempotency_requests;
DELETE FROM stocks;
DELETE FROM activity_logs;
DELETE FROM contacts;
DELETE FROM items;
DELETE FROM warehouses;

-- 3. Reset auto_increment tiap tabel balik ke 1 (DELETE, beda dari TRUNCATE, tidak otomatis
-- mereset ini). Kalau lo TIDAK mau id balik ke 1, hapus/comment blok ALTER TABLE di bawah.
ALTER TABLE inventory_cost_allocations AUTO_INCREMENT = 1;
ALTER TABLE inventory_cost_layers AUTO_INCREMENT = 1;
ALTER TABLE stock_mutations AUTO_INCREMENT = 1;
ALTER TABLE item_return_details AUTO_INCREMENT = 1;
ALTER TABLE item_returns AUTO_INCREMENT = 1;
ALTER TABLE payments AUTO_INCREMENT = 1;
ALTER TABLE invoice_details AUTO_INCREMENT = 1;
ALTER TABLE invoices AUTO_INCREMENT = 1;
ALTER TABLE stock_opname_details AUTO_INCREMENT = 1;
ALTER TABLE stock_opnames AUTO_INCREMENT = 1;
ALTER TABLE stock_transfer_details AUTO_INCREMENT = 1;
ALTER TABLE stock_transfers AUTO_INCREMENT = 1;
ALTER TABLE inventory_transaction_details AUTO_INCREMENT = 1;
ALTER TABLE inventory_transactions AUTO_INCREMENT = 1;
ALTER TABLE idempotency_requests AUTO_INCREMENT = 1;
ALTER TABLE stocks AUTO_INCREMENT = 1;
ALTER TABLE activity_logs AUTO_INCREMENT = 1;
ALTER TABLE contacts AUTO_INCREMENT = 1;
ALTER TABLE items AUTO_INCREMENT = 1;
ALTER TABLE warehouses AUTO_INCREMENT = 1;

-- Sanity check: semua harus menunjukkan 0 baris setelah ini dijalankan.
SELECT
  (SELECT COUNT(*) FROM warehouses)        AS warehouses,
  (SELECT COUNT(*) FROM items)             AS items,
  (SELECT COUNT(*) FROM contacts)          AS contacts,
  (SELECT COUNT(*) FROM invoices)          AS invoices,
  (SELECT COUNT(*) FROM stock_transfers)   AS stock_transfers,
  (SELECT COUNT(*) FROM stock_opnames)     AS stock_opnames,
  (SELECT COUNT(*) FROM item_returns)      AS item_returns,
  (SELECT COUNT(*) FROM activity_logs)     AS activity_logs;
