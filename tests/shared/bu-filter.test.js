import { describe, it, expect } from 'vitest';
import { buIdsCondition, directBuIdsCondition, assignedWarehouseCondition } from '../../src/shared/auth/bu-filter.js';

describe('buIdsCondition', () => {
  it('returns null (unrestricted) for buIds null', () => {
    expect(buIdsCondition('warehouse_id', null)).toBeNull();
  });

  it('returns a matches-nothing clause for an empty array', () => {
    expect(buIdsCondition('warehouse_id', [])).toEqual({ clause: '1 = 0', params: [] });
  });

  it('builds an IN-subquery over warehouses for a populated array', () => {
    expect(buIdsCondition('warehouse_id', [11, 12])).toEqual({
      clause: 'warehouse_id IN (SELECT id FROM warehouses WHERE bu_id IN (?,?))',
      params: [11, 12]
    });
  });
});

describe('directBuIdsCondition', () => {
  it('returns null for buIds null', () => {
    expect(directBuIdsCondition('bu_id', null)).toBeNull();
  });

  it('returns a matches-nothing clause for an empty array', () => {
    expect(directBuIdsCondition('bu_id', [])).toEqual({ clause: '1 = 0', params: [] });
  });

  it('builds a plain IN clause for a populated array', () => {
    expect(directBuIdsCondition('bu_id', [11])).toEqual({ clause: 'bu_id IN (?)', params: [11] });
  });
});

describe('assignedWarehouseCondition', () => {
  it('returns null (not restricted at this layer) for assignedWarehouseIds null', () => {
    expect(assignedWarehouseCondition('warehouse_id', null)).toBeNull();
  });

  it('returns a matches-nothing clause for an empty array', () => {
    expect(assignedWarehouseCondition('warehouse_id', [])).toEqual({ clause: '1 = 0', params: [] });
  });

  it('builds a plain IN clause (no subquery — the ids are warehouse ids already)', () => {
    expect(assignedWarehouseCondition('s.warehouse_id', [2, 5])).toEqual({
      clause: 's.warehouse_id IN (?,?)',
      params: [2, 5]
    });
  });
});
