'use strict';

// M9-D616 — estrutura dos read models de Comercial/CRM e Imóveis: colunas do livro, RLS FORCE, nenhum dado pessoal, eventos conferidos no código
// e parâmetros no SETTINGS_SCHEMA. Banco descartável (ver analytics.m9d603.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bi = require('../_helpers/biEnv');
const readModels = require('../../../src/features/analytics/read-models');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { parseBands } = require('../../../src/features/analytics/read-models/comercial.settings');

let env;
before(async () => { env = await bi.setup(); });
after(() => bi.teardown(env));

const COMMON = ['company_id', 'group_id', 'source_snapshot_at', 'refreshed_at', 'version'];
const TABLES = {
  rm_crm_lead_daily: ['day', 'origin', 'broker_id', 'leads', 'first_response_count', 'first_response_seconds_sum'],
  rm_crm_opportunity_stage: ['stage', 'broker_id', 'count', 'stalled_count'],
  rm_crm_outcome: ['month', 'broker_id', 'won', 'lost', 'lost_reason', 'lost_count'],
  rm_crm_next_action: ['broker_id', 'open_total', 'without_next_action'],
  rm_crm_visits_proposals: ['day', 'visits_scheduled', 'visits_done', 'proposals_sent', 'proposals_accepted'],
  rm_property_portfolio: ['status', 'active_count', 'no_sale_days_bucket'],
  rm_property_price_changes: ['day', 'changes', 'avg_change_pct'],
  rm_radar_matches: ['day', 'matches', 'converted'],
  rm_broker_performance: ['broker_id', 'month', 'captured', 'leads_assigned', 'won'],
};

const columnsOf = async (table) => (await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t", { replacements: { t: table } }))[0].map((r) => r.column_name);

test('m9d616 os read models existem com as colunas descritas e RLS FORCE', async () => {
  for (const [table, wanted] of Object.entries(TABLES)) {
    const have = await columnsOf(table);
    for (const c of [...COMMON, ...wanted]) assert.ok(have.includes(c), `${table}: falta a coluna ${c}`);
    const [[r]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = :table`, { replacements: { table } });
    assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], table);
    assert.ok(readModels.getReadModel(table), `${table} registrado no worker`);
  }
});

test('m9d616 source_snapshot_at, refreshed_at e version têm o tipo e o padrão do worker', async () => {
  for (const table of Object.keys(TABLES)) {
    const [defs] = await env.admin.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t
      AND column_name IN ('source_snapshot_at', 'refreshed_at', 'version')`, { replacements: { t: table } });
    const by = Object.fromEntries(defs.map((d) => [d.column_name, d]));
    assert.equal(by.source_snapshot_at.data_type, 'timestamp with time zone', table);
    assert.equal(by.refreshed_at.is_nullable, 'NO', table);
    assert.equal(by.version.is_nullable, 'NO', table);
  }
});

test('m9d616 nenhum dado pessoal restrito é copiado para o read model', () => {
  const pii = /(nome|name|document|cpf|cnpj|email|phone|telefone|person_id|pessoa|titular|holder|owner_user)/i;
  return (async () => {
    for (const table of Object.keys(TABLES)) for (const c of await columnsOf(table)) assert.doesNotMatch(c, pii, `${table}.${c}`);
    const dir = path.join(__dirname, '../../../src/features/analytics/read-models/comercial-imoveis');
    for (const file of fs.readdirSync(dir)) {
      const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const selected = [...code.matchAll(/SELECT[\s\S]*?FROM/gi)].map((m) => m[0]).join('\n');
      assert.doesNotMatch(selected, /\b(\w+\.)?(name|document|cpf|cnpj|email|phone|title|address_line)\b/i, `${file}: a consulta não traz dado pessoal`);
    }
  })();
});

test('m9d616 eventos do read model conferem com os serviços de origem', () => {
  const root = path.join(__dirname, '../../../src/features');
  const text = ['crm/opportunityEvents.service.js', 'crm/messages.service.js', 'crm/visits.service.js', 'crm/proposals.service.js', 'crm/crmCalendarEvents.service.js', 'properties/propertyEvents.service.js', 'properties/propertyMerge.service.js', 'properties/properties.service.js', 'radar/radarEvents.service.js']
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const types = new Set(readModels.listReadModels().filter((d) => d.name in TABLES).flatMap((d) => d.eventTypes));
  assert.ok(types.size >= 10);
  for (const type of types) assert.ok(text.includes(`'${type}'`) || text.includes(`\`${type}`) || text.includes(`${type}'`), `${type} existe nos serviços de origem`);
});

test('m9d616 parâmetros do administrador estão no SETTINGS_SCHEMA com faixa e validação', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.centro.opp_parada_dias'], { type: 'integer', min: 1, max: 365 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.comercial.janela_recalculo_dias'], { type: 'integer', min: 1, max: 90 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.comercial.primeira_resposta_inclui_nay'], { type: 'boolean' });
  const bands = SETTINGS_SCHEMA['analytics.imoveis.faixas_sem_venda_dias'];
  assert.equal(bands.type, 'string');
  assert.deepEqual(parseBands('30,60,90,180'), [30, 60, 90, 180]);
  for (const bad of ['', '30,30', '60,30', 'a,b', '0,10', '1,2,3,4,5,6,7,8,9,10,11']) {
    assert.equal(parseBands(bad), null, bad);
    assert.throws(() => bands.validate('analytics.imoveis.faixas_sem_venda_dias', bad), (e) => e.code === 'SETTING_INVALID_VALUE');
  }
});
