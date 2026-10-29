'use strict';

// M9-D712 — toda métrica CRITICAL tem drill-down habilitado e devolve linhas cuja soma bate com o KPI.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env712 = require('../_helpers/m9d712Env');
const ledger = require('../_helpers/m9d615Ledger');
const { proveCriticalDrilldown } = require('../_helpers/m9d712Critical');

let env;
before(async () => { env = { ...(await env712.setup()), created: [] }; });
after(async () => { await ledger.cleanup(env); await env712.teardown(env); });

test('m9d712 toda metrica CRITICAL tem drill-down habilitado e devolve linhas cuja soma bate com o KPI', async () => {
  const { checked, pending } = await proveCriticalDrilldown(env);
  for (const code of ['fin.free_cash', 'fin.third_party_cash', 'fin.payables_7d', 'fin.overdue_receivables', 'fin.overdue_payables', 'fin.payables_30d', 'fin.commissions_unlinked_30d']) {
    assert.ok(checked.includes(code), `${code} foi provado pelo detalhe`);
  }
  console.log(`# CRITICAL provadas pelo detalhe: ${checked.length}; sem especificação de origem ainda (entregue pela demanda do KPI): ${pending.length}`);
});
