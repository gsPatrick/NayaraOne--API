'use strict';

// M9-D617 — estrutura dos read models de Locação: colunas do livro, RLS FORCE, nenhum dado pessoal, eventos conferidos no código e parâmetros no
// SETTINGS_SCHEMA. Banco descartável (ver analytics.m9d603.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bi = require('../_helpers/biEnv');
const readModels = require('../../../src/features/analytics/read-models');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { LOCACAO_DEFAULTS, parseTypes, KEYS } = require('../../../src/features/analytics/read-models/locacao.settings');
const { LEASE_LIKE_TYPES } = require('../../../src/features/legal/contracts.service');

let env;
before(async () => { env = await bi.setup(); });
after(() => bi.teardown(env));

const COMMON = ['company_id', 'group_id', 'source_snapshot_at', 'refreshed_at', 'version'];
const TABLES = {
  rm_rental_contracts: ['status', 'count', 'rent_total'],
  rm_rental_vacancy: ['as_of_date', 'rentable_total', 'rented_total', 'vacant_total', 'vacant_days_sum'],
  rm_rental_arrears: ['as_of_date', 'billed_90d', 'overdue_amount', 'overdue_amount_in_window_90d', 'overdue_amount_outside_window_90d', 'overdue_count'],
  rm_rental_guarantees: ['type', 'expiring_30d', 'expiring_60d', 'expired'],
  rm_rental_obligations: ['kind', 'pending', 'overdue'],
  rm_rental_inspections_keys: ['as_of_date', 'inspections_pending', 'inspections_done', 'keys_out', 'keys_overdue'],
  rm_rental_tickets: ['as_of_date', 'opened', 'closed', 'open_total', 'resolution_hours_sum'],
  rm_rental_satisfaction: ['month', 'responses', 'score_sum'],
  rm_rental_repasses: ['as_of_date', 'pending', 'paid', 'overdue'],
};

const columnsOf = async (table) => (await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t", { replacements: { t: table } }))[0].map((r) => r.column_name);

test('m9d617 os read models existem com as colunas descritas e RLS FORCE', async () => {
  for (const [table, wanted] of Object.entries(TABLES)) {
    const have = await columnsOf(table);
    for (const c of [...COMMON, ...wanted]) assert.ok(have.includes(c), `${table}: falta a coluna ${c}`);
    const [[r]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = :table`, { replacements: { table } });
    assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], table);
    assert.ok(readModels.getReadModel(table), `${table} registrado no worker`);
    const [[ts]] = await env.admin.query("SELECT data_type FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t AND column_name = 'source_snapshot_at'", { replacements: { t: table } });
    assert.equal(ts.data_type, 'timestamp with time zone', table);
  }
});

test('m9d617 nenhum dado pessoal restrito é copiado para o read model', async () => {
  const pii = /(nome|name|document|cpf|cnpj|email|phone|telefone|person_id|pessoa|titular|holder|tenant_person|owner_person|beneficiary)/i;
  for (const table of Object.keys(TABLES)) for (const c of await columnsOf(table)) assert.doesNotMatch(c, pii, `${table}.${c}`);
  const dir = path.join(__dirname, '../../../src/features/analytics/read-models/locacao');
  for (const file of fs.readdirSync(dir)) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const selected = [...code.matchAll(/SELECT[\s\S]*?(?:FROM|,\s*\(SELECT)/gi)].map((m) => m[0]).join('\n');
    assert.doesNotMatch(selected, /\b(name|document|cpf|cnpj|email|phone|owner_person_id|delivered_to_person_id)\b/i, `${file}: a consulta não traz dado pessoal`);
  }
});

test('m9d617 eventos do read model conferem com os serviços de origem', () => {
  const root = path.join(__dirname, '../../../src/features');
  const files = ['legal/legalEvents.service.js', 'legal/legalCalendarEvents.service.js', 'legal/contractRequirements.js', 'legal/requirements.service.js', 'finance/financeEvents.service.js', 'construction/constructionEvents.service.js', 'crm/feedbackCases.service.js',
    'properties/propertyEvents.service.js', 'properties/propertyMerge.service.js', 'properties/properties.service.js'].filter((f) => fs.existsSync(path.join(root, f)));
  const text = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const types = new Set(readModels.listReadModels().filter((d) => d.name in TABLES).flatMap((d) => d.eventTypes));
  assert.ok(types.size >= 20);
  // finance.entry.canceled ainda não tem quem publique no Financeiro (DI-D615-3): o read model já o consome e o cancelamento entra pela agenda.
  for (const type of [...types].filter((t) => t !== 'finance.entry.canceled')) assert.ok(text.includes(`'${type}'`), `${type} existe nos serviços de origem`);
});

test('m9d617 parâmetros do administrador estão no SETTINGS_SCHEMA e o padrão dos tipos é o do jurídico', () => {
  assert.deepEqual(parseTypes(LOCACAO_DEFAULTS[KEYS.contractTypes]), LEASE_LIKE_TYPES, 'o padrão é LEASE_LIKE_TYPES de legal/contracts.service.js');
  assert.deepEqual(SETTINGS_SCHEMA['analytics.locacao.repasse_prazo_dias'], { type: 'integer', min: 0, max: 90 });
  for (const k of ['nota_elogio', 'nota_reclamacao', 'nota_conflito']) assert.deepEqual(SETTINGS_SCHEMA[`analytics.locacao.${k}`], { type: 'integer', min: 0, max: 10 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.inadimplencia.janela_dias'], { type: 'integer', min: 1, max: 3650 }, 'a janela é a do Financeiro');
  const types = SETTINGS_SCHEMA['analytics.locacao.tipos_contrato'];
  for (const bad of ['', 'lease contract', 'A', ',,']) assert.throws(() => types.validate('analytics.locacao.tipos_contrato', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  assert.doesNotThrow(() => types.validate('analytics.locacao.tipos_contrato', 'LEASE,PROPERTY_ADMIN'));
});
