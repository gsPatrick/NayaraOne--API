'use strict';

// M9-D615 — estrutura do read model financeiro: colunas do livro, RLS FORCE, nenhum dado pessoal e eventos conferidos no Financeiro.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env615 = require('../_helpers/m9d615Env');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { HEALTH_EVENTS } = require('../../../src/features/analytics/read-models/financeHealth.events');

let env;
before(async () => { env = await env615.setup(); });
after(() => env615.teardown(env));

const columnsOf = async (table) => (await env.admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t`, { replacements: { t: table } }))[0].map((r) => r.column_name);

test('m9d615 o read model existe com as colunas descritas e RLS FORCE', async () => {
  const have = await columnsOf('rm_finance_health');
  const wanted = ['company_id', 'as_of_date', 'free_cash', 'third_party_cash', 'payables_7d', 'payables_30d', 'payables_60d', 'receivables_7d', 'receivables_30d', 'receivables_60d',
    'overdue_payables', 'overdue_amount', 'overdue_amount_in_window_90d', 'overdue_amount_outside_window_90d', 'receivables_base_90d', 'pending_reconciliations', 'pending_owner_repasses',
    'provisioned_commissions', 'paid_commissions', 'open_anomalies', 'breathing_need', 'source_snapshot_at', 'refreshed_at', 'version'];
  for (const c of wanted) assert.ok(have.includes(c), `falta a coluna ${c}`);
  const margin = await columnsOf('rm_finance_sector_margin');
  for (const c of ['company_id', 'result_center_id', 'competence_month', 'revenue_actual', 'cost_actual', 'source_snapshot_at', 'refreshed_at', 'version']) assert.ok(margin.includes(c), `margem: falta ${c}`);
  for (const table of ['rm_finance_health', 'rm_finance_sector_margin']) {
    const [[r]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = :table`, { replacements: { table } });
    assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], table);
  }
  const [[pk]] = await env.admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rm_finance_health_pk'`);
  assert.match(pk.def, /company_id, as_of_date/, 'uma linha por empresa e data-base');
});

test('m9d615 nenhum dado pessoal restrito é copiado para o read model', async () => {
  const pii = /(nome|name|document|cpf|cnpj|email|phone|telefone|person|pessoa|owner_person|beneficiary|holder)/i;
  for (const table of ['rm_finance_health', 'rm_finance_sector_margin']) {
    for (const c of await columnsOf(table)) assert.doesNotMatch(c, pii, `${table}.${c}`);
  }
  const text = fs.readFileSync(path.join(__dirname, '../../../src/features/analytics/read-models/financeHealth.criteria.js'), 'utf8');
  assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ''), pii, 'os critérios guardam tabela, período, status e natureza, nunca pessoa');
});

test('m9d615 eventos do read model conferem com o Financeiro e o parâmetro está no SETTINGS_SCHEMA', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../src/features/finance/financeEvents.service.js'), 'utf8');
  for (const name of ['finance.entry.created', 'finance.entry.settled', 'finance.entry.reversed', 'finance.owner_repasse.created', 'finance.commission.created', 'finance.reconciliation.matched', 'finance.anomaly.opened']) {
    assert.ok(HEALTH_EVENTS.includes(name), `${name} consumido`);
    assert.ok(source.includes(`'${name}'`), `${name} existe em financeEvents.service.js`);
  }
  assert.deepEqual(SETTINGS_SCHEMA['analytics.inadimplencia.janela_dias'], { type: 'integer', min: 1, max: 3650 });
});
