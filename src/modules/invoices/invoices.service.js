import { NotFoundError } from '../../shared/errors/app-error.js';
import { parsePagination } from '../../shared/utils/pagination.js';
import * as repository from './invoices.repository.js';

export async function listInvoices(db, query, buIds = null, assignedWarehouseIds = null) {
  const { page, per_page, offset } = parsePagination(query);
  const filter = {
    type: query.type ?? null,
    status: query.status ?? null,
    paymentStatus: query.payment_status ?? null,
    warehouseId: query.warehouse_id ?? null,
    buIds,
    assignedWarehouseIds
  };
  const [data, total] = await Promise.all([
    repository.findAll(db, { ...filter, limit: per_page, offset }),
    repository.count(db, filter)
  ]);
  return { data, meta: { page, per_page, total } };
}

export async function getInvoice(db, id) {
  const invoice = await repository.findByIdWithDetails(db, id);
  if (!invoice) throw new NotFoundError(`Invoice ${id} not found`);
  return { data: invoice };
}
