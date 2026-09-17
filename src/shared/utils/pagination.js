const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

export function parsePagination(query = {}) {
  const rawPage = Number.parseInt(query.page, 10);
  const rawPerPage = Number.parseInt(query.per_page, 10);

  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : DEFAULT_PAGE;
  const perPage = Number.isInteger(rawPerPage) && rawPerPage >= 1 ? rawPerPage : DEFAULT_PER_PAGE;
  const per_page = Math.min(perPage, MAX_PER_PAGE);
  const offset = (page - 1) * per_page;

  return { page, per_page, offset };
}
