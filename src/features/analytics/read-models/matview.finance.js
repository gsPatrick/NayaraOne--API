'use strict';

/** M9-D698 — série mensal do caixa e dos horizontes do Financeiro (migration 9742): últimos 24 meses, o último dia-base de cada mês por empresa. */
const { registerMaterializedView } = require('./matview.registry');

registerMaterializedView({
  name: 'mv_finance_health_monthly',
  uniqueColumns: ['company_id', 'month'],
  readFunction: 'read_mv_finance_health_monthly',
  source: 'rm_finance_health',
});
