'use strict';

// Recalcula, DENTRO da transação do teste, o read model financeiro que o worker do BI mantém (analytics.rm_finance_health da data de hoje e
// analytics.rm_finance_sector_margin dos setores/meses com lançamento liquidado) — o mesmo recompute + upsert da agenda (readModel.scheduled.js),
// para o teste da NAY Financeira (Guia M4 §13) ler o retrato sem depender do worker em segundo plano.
const { businessDateKey } = require('../../src/utils/businessDate');
const { enableAnalyticsWriter } = require('../../src/features/analytics/metricStore.service');
const { upsertAggregate } = require('../../src/features/analytics/read-models/readModel.upsert');
const { getReadModel } = require('../../src/features/analytics/read-models/readModel.registry');
require('../../src/features/analytics/read-models/financeiro-finance-health.readmodel');
require('../../src/features/analytics/read-models/financeiro-finance-sector-margin.readmodel');

async function refreshFinanceReadModels(tenant, transaction, now = new Date()) {
  await enableAnalyticsWriter(transaction);
  const scope = { companyId: tenant.companyId, groupId: tenant.groupId };
  for (const name of ['rm_finance_health', 'rm_finance_sector_margin']) {
    const def = getReadModel(name);
    const keys = await def.scheduled.keys({ ...scope, now, limit: 5000, transaction });
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      const result = await def.recompute({ ...scope, key, limit: null, asOfDate: businessDateKey(now), now, event: null, transaction });
      // eslint-disable-next-line no-await-in-loop
      await upsertAggregate(def, { ...scope, key, fields: result.fields, rows: result.rows, sourceSnapshotAt: result.sourceSnapshotAt || now }, transaction);
    }
  }
}

module.exports = { refreshFinanceReadModels };
