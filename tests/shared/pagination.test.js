import { describe, it, expect } from 'vitest';
import { parsePagination } from '../../src/shared/utils/pagination.js';

describe('parsePagination', () => {
  it('defaults to page 1 and per_page 20 when nothing is provided', () => {
    expect(parsePagination({})).toEqual({ page: 1, per_page: 20, offset: 0 });
  });

  it('computes offset from page and per_page', () => {
    expect(parsePagination({ page: '3', per_page: '10' })).toEqual({ page: 3, per_page: 10, offset: 20 });
  });

  it('clamps per_page to a maximum of 100', () => {
    expect(parsePagination({ per_page: '500' })).toMatchObject({ per_page: 100 });
  });

  it('falls back to defaults when page is below 1', () => {
    expect(parsePagination({ page: '0' })).toMatchObject({ page: 1 });
  });

  it('falls back to defaults on non-numeric input', () => {
    expect(parsePagination({ page: 'abc', per_page: 'xyz' })).toEqual({ page: 1, per_page: 20, offset: 0 });
  });
});
