const stockSummaryProperties = {
  total_items: { type: 'integer' },
  total_quantity: { type: 'integer' },
  total_value: { type: 'string' },
  low_stock_count: { type: 'integer' },
  out_of_stock_count: { type: 'integer' }
};

const invoiceSummaryProperties = {
  count: { type: 'integer' },
  subtotal: { type: 'string' },
  tax: { type: 'string' },
  total_amount: { type: 'string' }
};

const warehouseFilterQuerystring = {
  type: 'object',
  properties: { warehouse_id: { type: 'integer' } }
};

const dateRangeQuerystring = {
  type: 'object',
  properties: {
    warehouse_id: { type: 'integer' },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' }
  }
};

export const dashboardSummarySchema = {
  tags: ['dashboard'],
  querystring: {
    type: 'object',
    properties: {
      warehouse_id: { type: 'integer' },
      date: { type: 'string', format: 'date' }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            stock: { type: 'object', properties: stockSummaryProperties },
            sales: { type: 'object', properties: invoiceSummaryProperties },
            purchases: { type: 'object', properties: invoiceSummaryProperties }
          }
        }
      }
    }
  }
};

export const dashboardStockSchema = {
  tags: ['dashboard'],
  querystring: warehouseFilterQuerystring,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: stockSummaryProperties } } }
  }
};

export const dashboardSalesSchema = {
  tags: ['dashboard'],
  querystring: dateRangeQuerystring,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: invoiceSummaryProperties } } }
  }
};

export const dashboardSalesTrendSchema = {
  tags: ['dashboard'],
  querystring: dateRangeQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, ...invoiceSummaryProperties } } }
      }
    }
  }
};

export const dashboardPurchasesSchema = {
  tags: ['dashboard'],
  querystring: dateRangeQuerystring,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: invoiceSummaryProperties } } }
  }
};

export const dashboardProfitSchema = {
  tags: ['dashboard'],
  querystring: dateRangeQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            revenue: { type: 'string' },
            cogs: { type: 'string' },
            gross_profit: { type: 'string' },
            gross_margin_pct: { type: 'number' }
          }
        }
      }
    }
  }
};
