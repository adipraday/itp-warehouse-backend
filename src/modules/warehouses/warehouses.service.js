import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import { assertBusinessUnitIsUsable, getBusinessUnitById } from '../../shared/auth/business-units-client.js';
import * as repository from './warehouses.repository.js';

const FK_VIOLATION_CODES = new Set(['ER_ROW_IS_REFERENCED_2', 'ER_ROW_IS_REFERENCED']);

// Main-warehouse/branch hierarchy rules (see docs/warehouse-hierarchy-and-provisioning.md):
//   - a branch's parent_warehouse_id must point at an existing warehouse in the
//     SAME bu_id that is itself a main warehouse (depth capped at 2 levels)
//   - a warehouse cannot be its own parent
//   - at most one main warehouse (parent_warehouse_id IS NULL) per bu_id
//   - a warehouse that currently has branches attached cannot itself become a
//     branch, change bu_id, or be deleted — branches must be detached first
async function validateParent(db, { id = null, bu_id, parent_warehouse_id }) {
  if (parent_warehouse_id == null) return;

  if (id != null && Number(parent_warehouse_id) === Number(id)) {
    throw new BadRequestError('INVALID_PARENT_WAREHOUSE', 'A warehouse cannot be its own parent');
  }

  const parent = await repository.findById(db, parent_warehouse_id);
  if (!parent) {
    throw new BadRequestError('INVALID_PARENT_WAREHOUSE', `Parent warehouse ${parent_warehouse_id} not found`);
  }
  if (parent.parent_warehouse_id != null) {
    throw new BadRequestError(
      'INVALID_PARENT_WAREHOUSE',
      `Warehouse ${parent_warehouse_id} is itself a branch — a branch's parent must be a main warehouse (max depth 2)`
    );
  }
  if (bu_id == null || Number(parent.bu_id) !== Number(bu_id)) {
    throw new BadRequestError(
      'INVALID_PARENT_WAREHOUSE',
      `Parent warehouse ${parent_warehouse_id} belongs to a different business unit`
    );
  }
}

async function validateMainUniqueness(db, { id = null, bu_id, parent_warehouse_id }) {
  if (parent_warehouse_id != null) return; // this row is a branch, not competing to be "main"
  if (bu_id == null) return; // unassigned warehouses aren't subject to the one-main-per-BU rule

  const existing = await repository.findMainWarehouseInBu(db, bu_id, id);
  if (existing) {
    throw new ConflictError(
      'MAIN_WAREHOUSE_EXISTS',
      `Business unit ${bu_id} already has a main warehouse (id=${existing.id}); only one is allowed`
    );
  }
}

// Blocks anything that would orphan-mismatch a warehouse's current branches:
// becoming a branch itself, or moving to a different bu_id, while it still has
// branches pointing at it.
async function guardAgainstOrphaningBranches(db, id, existing, payload) {
  const becomingBranch = payload.parent_warehouse_id != null;
  const changingBu = Number(payload.bu_id) !== Number(existing.bu_id);
  if (!becomingBranch && !changingBu) return;

  const childCount = await repository.countChildren(db, id);
  if (childCount > 0) {
    const reason = becomingBranch ? 'become a branch itself' : 'change business unit';
    throw new ConflictError(
      'WAREHOUSE_HAS_BRANCHES',
      `Warehouse ${id} still has ${childCount} branch warehouse(s) attached — cannot ${reason} until they are detached`
    );
  }
}

export async function listWarehouses(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const [data, total] = await Promise.all([
    repository.findAll(db, { limit: per_page, offset, buIds, assignedWarehouseIds }),
    repository.count(db, buIds, assignedWarehouseIds)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getWarehouse(db, id) {
  const warehouse = await repository.findById(db, id);
  if (!warehouse) throw new NotFoundError(`Warehouse ${id} not found`);
  return { data: warehouse };
}

export async function createWarehouse(db, payload, userId = null, config = null) {
  const duplicate = await repository.findByCode(db, payload.code);
  if (duplicate) {
    throw new ConflictError('WAREHOUSE_CODE_EXISTS', `Warehouse code "${payload.code}" already exists`);
  }

  // bu_id is a raw number from the client — it means nothing on its own and must be
  // confirmed against the auth-backend before we trust it (docs/bug-report-bu-id-mismatch.md).
  if (config) await assertBusinessUnitIsUsable(config, payload.bu_id);

  await validateParent(db, payload);
  await validateMainUniqueness(db, payload);

  const warehouse = await repository.create(db, payload, userId);
  return { data: warehouse };
}

export async function updateWarehouse(db, id, payload, config = null) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Warehouse ${id} not found`);

  if (payload.code !== existing.code) {
    const duplicate = await repository.findByCode(db, payload.code);
    if (duplicate) {
      throw new ConflictError('WAREHOUSE_CODE_EXISTS', `Warehouse code "${payload.code}" already exists`);
    }
  }

  // Only re-validate against the auth-backend when bu_id is actually changing —
  // it was already confirmed usable when it was first set (create, or an earlier update).
  if (config && Number(payload.bu_id) !== Number(existing.bu_id)) {
    await assertBusinessUnitIsUsable(config, payload.bu_id);
  }

  await validateParent(db, { id, ...payload });
  await validateMainUniqueness(db, { id, ...payload });
  await guardAgainstOrphaningBranches(db, id, existing, payload);

  const warehouse = await repository.update(db, id, payload);
  return { data: warehouse };
}

export async function deleteWarehouse(db, id) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Warehouse ${id} not found`);

  const childCount = await repository.countChildren(db, id);
  if (childCount > 0) {
    throw new ConflictError(
      'WAREHOUSE_HAS_BRANCHES',
      `Warehouse ${id} still has ${childCount} branch warehouse(s) attached — detach them first`
    );
  }

  try {
    await repository.remove(db, id);
  } catch (error) {
    if (FK_VIOLATION_CODES.has(error.code)) {
      throw new ConflictError(
        'WAREHOUSE_REFERENCED',
        'Warehouse cannot be deleted because it is referenced by other records'
      );
    }
    throw error;
  }

  return { data: { id: Number(id) } };
}

// Deterministic, collision-resistant-enough code derived from the BU's own
// `code` (unique in auth-backend) — not from its numeric id, which is exactly
// the kind of value docs/bug-report-bu-id-mismatch.md says never to lean on
// for anything user-facing/persistent beyond the raw scoping column itself.
function deriveMainWarehouseCode(bu) {
  const base = String(bu.code)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .slice(0, 46); // leaves room for the "WH-" prefix under the 50-char column limit
  return `WH-${base}`;
}

// Auto-provisioning: "give this BU a main warehouse if it doesn't have one yet."
// Idempotent by design — safe to call right after creating a BU (or repeatedly,
// e.g. if the caller doesn't know whether provisioning already happened):
// returns the existing main warehouse untouched if one is already there,
// otherwise creates one named after the BU. Requested feature, 2026-09-08 —
// see docs/bug-report-items-contacts-cross-tenant-leak.md's closing note.
export async function provisionDefaultWarehouse(db, buId, userId = null, config = null) {
  if (config) await assertBusinessUnitIsUsable(config, buId);

  const existingRef = await repository.findMainWarehouseInBu(db, buId, null);
  if (existingRef) {
    const warehouse = await repository.findById(db, existingRef.id);
    return { data: warehouse, created: false };
  }

  const bu = config ? await getBusinessUnitById(config, buId) : null;
  const name = bu ? `Gudang Utama ${bu.name}` : `Gudang Utama BU ${buId}`;
  const baseCode = bu ? deriveMainWarehouseCode(bu) : `WH-BU-${buId}`;

  // The derived code is deterministic, so a collision is possible if a
  // warehouse with that exact code was already created some other way —
  // append a numeric suffix rather than failing an otherwise-automatic call.
  let code = baseCode;
  for (let attempt = 1; await repository.findByCode(db, code); attempt += 1) {
    code = `${baseCode}-${attempt}`.slice(0, 50);
  }

  const warehouse = await repository.create(db, { code, name, address: null, bu_id: buId, parent_warehouse_id: null }, userId);
  return { data: warehouse, created: true };
}

export async function listWarehouseStocks(db, id, query) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Warehouse ${id} not found`);

  const { page, per_page, offset } = parsePagination(query);
  const [data, total] = await Promise.all([
    repository.findStocksByWarehouse(db, id, { limit: per_page, offset }),
    repository.countStocksByWarehouse(db, id)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getWarehouseStockSummary(db, id) {
  const existing = await repository.findById(db, id);
  if (!existing) throw new NotFoundError(`Warehouse ${id} not found`);

  const summary = await repository.stockSummary(db, id);
  return { data: summary };
}
