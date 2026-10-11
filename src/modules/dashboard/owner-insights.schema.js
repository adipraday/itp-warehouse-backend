const periodQuerystring = {
  from: { type: 'string', format: 'date' },
  to: { type: 'string', format: 'date' }
};

const branchProperties = {
  warehouse_id: { type: 'integer' },
  code: { type: 'string' },
  name: { type: 'string' },
  bu_id: { type: ['integer', 'null'] },
  sales_count: { type: 'integer' },
  sales_total: { type: 'string' },
  previous_sales_total: { type: 'string' },
  sales_growth_pct: { type: ['number', 'null'] },
  revenue: { type: 'string' },
  cogs: { type: 'string' },
  gross_profit: { type: 'string' },
  gross_margin_pct: { type: 'number' },
  stock_value: { type: 'string' },
  low_stock_count: { type: 'integer' },
  out_of_stock_count: { type: 'integer' }
};

export const branchComparisonSchema = {
  tags: ['dashboard'],
  querystring: { type: 'object', properties: periodQuerystring },
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            period: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                previous_from: { type: 'string' },
                previous_to: { type: 'string' }
              }
            },
            totals: {
              type: 'object',
              properties: {
                sales_count: { type: 'integer' },
                sales_total: { type: 'string' },
                previous_sales_total: { type: 'string' },
                sales_growth_pct: { type: ['number', 'null'] },
                revenue: { type: 'string' },
                gross_profit: { type: 'string' },
                gross_margin_pct: { type: 'number' },
                stock_value: { type: 'string' },
                low_stock_count: { type: 'integer' },
                out_of_stock_count: { type: 'integer' }
              }
            },
            branches: { type: 'array', items: { type: 'object', properties: branchProperties } }
          }
        }
      }
    }
  }
};

const varianceSessionProperties = {
  id: { type: 'integer' },
  warehouse_id: { type: 'integer' },
  user_id: { type: 'integer' },
  opened_at: { type: 'string' },
  closed_at: { type: 'string' },
  opening_amount: { type: 'string' },
  expected_cash_amount: { type: 'string' },
  closing_amount: { type: 'string' },
  cash_difference: { type: 'string' },
  notes: { type: ['string', 'null'] }
};

export const cashVarianceSchema = {
  tags: ['dashboard'],
  querystring: {
    type: 'object',
    properties: {
      ...periodQuerystring,
      warehouse_id: { type: 'integer' },
      min_abs_difference: { type: 'number', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            period: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
            min_abs_difference: { type: 'string' },
            summary: {
              type: 'object',
              properties: {
                sessions_closed: { type: 'integer' },
                sessions_with_variance: { type: 'integer' },
                total_shortage: { type: 'string' },
                total_overage: { type: 'string' },
                net_difference: { type: 'string' },
                overdue_open_count: { type: 'integer' }
              }
            },
            by_warehouse: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  warehouse_id: { type: 'integer' },
                  sessions_closed: { type: 'integer' },
                  sessions_with_variance: { type: 'integer' },
                  shortage: { type: 'string' },
                  overage: { type: 'string' },
                  net: { type: 'string' }
                }
              }
            },
            sessions: { type: 'array', items: { type: 'object', properties: varianceSessionProperties } },
            overdue_open_sessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'integer' },
                  warehouse_id: { type: 'integer' },
                  user_id: { type: 'integer' },
                  opened_at: { type: 'string' },
                  opening_amount: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }
};

export const stuckQueueSchema = {
  tags: ['dashboard'],
  querystring: {
    type: 'object',
    properties: {
      warehouse_id: { type: 'integer' },
      min_age_days: { type: 'integer', minimum: 0, maximum: 365 },
      limit: { type: 'integer', minimum: 1, maximum: 200 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            min_age_days: { type: 'integer' },
            as_of: { type: 'string' },
            summary: {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                by_group: {
                  type: 'object',
                  properties: {
                    approval: { type: 'integer' },
                    completion: { type: 'integer' },
                    draft: { type: 'integer' },
                    held: { type: 'integer' }
                  }
                },
                by_kind: { type: 'object', additionalProperties: { type: 'integer' } },
                truncated: { type: 'boolean' }
              }
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string' },
                  group: { type: 'string' },
                  document_id: { type: 'integer' },
                  document_number: { type: 'string' },
                  warehouse_id: { type: 'integer' },
                  to_warehouse_id: { type: ['integer', 'null'] },
                  status: { type: 'string' },
                  waiting_since: { type: 'string' },
                  age_days: { type: 'integer' },
                  created_by: { type: ['integer', 'null'] }
                }
              }
            }
          }
        }
      }
    }
  }
};

export const agingSchema = {
  tags: ['dashboard'],
  querystring: {
    type: 'object',
    required: ['side'],
    properties: {
      side: { type: 'string', enum: ['receivable', 'payable'] },
      warehouse_id: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 200 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            side: { type: 'string' },
            as_of: { type: 'string' },
            total_outstanding: { type: 'string' },
            invoice_count: { type: 'integer' },
            overdue_total: { type: 'string' },
            overdue_count: { type: 'integer' },
            buckets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  label: { type: 'string' },
                  count: { type: 'integer' },
                  amount: { type: 'string' }
                }
              }
            },
            by_contact: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  contact_id: { type: ['integer', 'null'] },
                  contact_name: { type: ['string', 'null'] },
                  count: { type: 'integer' },
                  amount: { type: 'string' },
                  oldest_days_overdue: { type: 'integer' }
                }
              }
            },
            by_warehouse: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  warehouse_id: { type: 'integer' },
                  count: { type: 'integer' },
                  amount: { type: 'string' }
                }
              }
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  invoice_id: { type: 'integer' },
                  invoice_number: { type: 'string' },
                  warehouse_id: { type: 'integer' },
                  contact_id: { type: ['integer', 'null'] },
                  contact_name: { type: ['string', 'null'] },
                  invoice_date: { type: 'string' },
                  due_date: { type: ['string', 'null'] },
                  total_amount: { type: 'string' },
                  paid_amount: { type: 'string' },
                  outstanding: { type: 'string' },
                  days_overdue: { type: 'integer' }
                }
              }
            },
            truncated: { type: 'boolean' }
          }
        }
      }
    }
  }
};

export const unusualActivitySchema = {
  tags: ['dashboard'],
  querystring: { type: 'object', properties: periodQuerystring },
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            period: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
            thresholds: { type: 'object', additionalProperties: { type: 'integer' } },
            summary: {
              type: 'object',
              properties: {
                findings: { type: 'integer' },
                flagged_users: { type: 'integer' },
                high_severity: { type: 'integer' },
                by_type: { type: 'object', additionalProperties: { type: 'integer' } },
                row_limit_reached: { type: 'boolean' }
              }
            },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  user_id: { type: 'integer' },
                  count: { type: 'integer' },
                  severity: { type: 'string', enum: ['medium', 'high'] },
                  warehouse_id: { type: ['integer', 'null'] },
                  first_at: { type: 'string' },
                  last_at: { type: 'string' },
                  documents_created: { type: ['integer', 'null'] },
                  cancel_rate_pct: { type: ['number', 'null'] },
                  examples: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        action: { type: 'string' },
                        entity_type: { type: 'string' },
                        entity_id: { type: ['integer', 'null'] },
                        warehouse_id: { type: ['integer', 'null'] },
                        at: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
