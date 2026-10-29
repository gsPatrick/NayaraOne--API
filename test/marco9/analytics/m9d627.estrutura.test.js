'use strict';

// M9-D627 — estrutura dos read models de Marketing e Atendimento: colunas do livro, RLS FORCE, nenhum dado pessoal, eventos do catálogo
// do Marketing (M9-D434) e tabelas reais das fontes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env627 = require('../_helpers/m9d627Env');
const { MODELS } = require('../_helpers/m9d627Sources');
const { EVENT_NAMES } = require('../../../src/features/marketing/marketing.events.catalog');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const readModels = require('../../../src/features/analytics/read-models');

let env;
before(async () => { env = await env627.setup(); });
after(() => env627.teardown(env));

const DIR = path.join(__dirname, '../../../src/features/analytics/read-models');
const columnsOf = async (table) => (await env.admin.query('SELECT column_name FROM information_schema.columns WHERE table_schema = \'analytics\' AND table_name = :t', { replacements: { t: table } }))[0].map((r) => r.column_name);
const mktFiles = () => fs.readdirSync(DIR).filter((f) => /^marketingAtendimento\..*\.js$|^marketing-atendimento\.readmodel\.js$/.test(f));
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WANTED = {
  rm_mkt_campaigns: ['campaign_id', 'cost_total', 'leads_total', 'attributed_leads'],
  rm_mkt_delivery: ['day', 'channel', 'sent', 'delivered', 'failed', 'opt_out'],
  rm_mkt_frequency: ['day', 'contacts_reached', 'contacts_over_cap'],
  rm_mkt_reviews: ['month', 'platform', 'reviews', 'rating_sum'],
  rm_mkt_automation: ['day', 'executed', 'blocked', 'failed'],
  rm_support_satisfaction: ['month', 'responses', 'score_sum'],
  rm_support_complaints: ['month', 'reason', 'count'],
  rm_support_sla: ['month', 'resolved', 'within_sla', 'open_overdue'],
};

test('m9d627 os 8 read models existem com as colunas descritas e RLS FORCE', async () => {
  assert.deepEqual(Object.keys(WANTED).sort(), [...MODELS].sort());
  for (const [table, wanted] of Object.entries(WANTED)) {
    const have = await columnsOf(table);
    for (const c of ['company_id', 'group_id', ...wanted, 'source_snapshot_at', 'refreshed_at', 'version']) assert.ok(have.includes(c), `${table}: falta a coluna ${c}`);
    const [[r]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = :table`, { replacements: { table } });
    assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], table);
    const registered = readModels.getReadModel(table);
    assert.ok(registered, `${table} registrado no worker`);
    assert.equal(registered.version, 1);
  }
});

test('m9d627 nenhum dado pessoal restrito é copiado para o read model', async () => {
  const pii = /(nome|name|document|cpf|cnpj|e_?mail|phone|telefone|person|pessoa|address|endereco|description|descricao|body)/i;
  for (const table of MODELS) for (const c of await columnsOf(table)) assert.doesNotMatch(c, pii, `${table}.${c}`);
  for (const f of mktFiles()) {
    const sql = stripComments(fs.readFileSync(path.join(DIR, f), 'utf8'));
    assert.doesNotMatch(sql, /\b(address_hash|description|body|legal_name|phone|email)\b/i, `${f}: não lê campo de contato, nome ou texto livre`);
  }
});

test('m9d627 só assina eventos do catálogo de M9-D434 e lê as tabelas reais', async () => {
  const allowed = new Set([...EVENT_NAMES, 'crm.feedback_case.created', 'crm.feedback_case.resolved', 'crm.feedback_case.escalated', 'crm.interaction.recorded', 'crm.message.status_changed']);
  const proibidos = /^(marketing\.(message|consent|automation)\.|marketing\.suppression|marketing\.review)/;
  const catalogEventsUsed = new Set();
  for (const name of MODELS) {
    for (const type of readModels.getReadModel(name).eventTypes) {
      assert.ok(allowed.has(type), `${name} assina ${type}, fora do catálogo`);
      assert.doesNotMatch(type, proibidos);
      if (EVENT_NAMES.includes(type)) catalogEventsUsed.add(type);
    }
  }
  for (const wanted of ['marketing.campaign.started', 'marketing.campaign.ended', 'automation.run.started', 'automation.run.completed', 'automation.run.blocked', 'customer.opted_out', 'review.requested', 'attribution.recorded']) {
    assert.ok(catalogEventsUsed.has(wanted), `${wanted} do catálogo é consumido`);
  }
  // tabelas lidas: toda referência schema.tabela dos SQL existe de verdade, e as inexistentes do livro (marketing.messages etc.) não aparecem
  const referenced = new Set();
  for (const f of mktFiles()) {
    const text = stripComments(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)\.([a-z_]+)/g)) referenced.add(`${m[1]}.${m[2]}`);
  }
  for (const bad of ['marketing.messages', 'marketing.suppressions', 'marketing.reviews']) assert.ok(!referenced.has(bad), `${bad} não existe`);
  assert.ok(referenced.has('crm.messages') && referenced.has('marketing.suppression_list') && referenced.has('marketing.review_requests') && referenced.has('marketing.automation_runs'));
  for (const ref of referenced) {
    const [schema, table] = ref.split('.');
    const [[r]] = await env.admin.query('SELECT to_regclass(:name) AS t', { replacements: { name: `${schema}.${table}` } });
    assert.ok(r.t, `${ref} existe no banco`);
  }
});

test('m9d627 o parâmetro da agenda está no SETTINGS_SCHEMA e a agenda o lê', async () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.marketing_atendimento.janela_reconferencia_dias'], { type: 'integer', min: 1, max: 90 });
  const { readReconferenceDays } = require('../../../src/features/analytics/read-models/marketingAtendimento.settings');
  assert.equal(await env627.inTx(env.tenantA, {}, (tx) => readReconferenceDays(env.tenantA, tx)), 7);
  const source = fs.readFileSync(path.join(DIR, 'marketing-atendimento.readmodel.js'), 'utf8');
  assert.match(source, /readReconferenceDays/, 'a agenda lê o parâmetro (nada fixo no código)');
});

test('m9d627 os estados de mensagem e o teto de frequência do BI seguem os do Marketing', async () => {
  const mine = require('../../../src/features/analytics/read-models/marketingAtendimento.statuses');
  const marketing = require('../../../src/features/marketing/automations/policy.statuses');
  const cadence = require('../../../src/features/marketing/automations/cadence/cadence.defaults');
  const { getMarketingParam } = require('../../../src/features/marketing/automations/cadence/marketingParam.service');
  assert.deepEqual([...mine.COUNTED_STATUSES], [...marketing.COUNTED_MESSAGE_STATUSES]);
  assert.deepEqual([...mine.FAILED_STATUSES], [...marketing.NOT_COUNTED_MESSAGE_STATUSES]);
  assert.equal(mine.FREQUENCY_CAP_KEY, cadence.FREQUENCY_CAP_KEY);
  assert.equal(mine.FREQUENCY_CAP_DEFAULT, cadence.CADENCE_DEFAULTS[cadence.FREQUENCY_CAP_KEY]);
  const viaBi = await env627.inTx(env.tenantA, {}, (tx) => mine.readFrequencyCap(env.tenantA, tx));
  const viaMarketing = await env627.inTx(env.tenantA, {}, (tx) => getMarketingParam(cadence.FREQUENCY_CAP_KEY, env.tenantA, tx));
  assert.deepEqual(viaBi, { messages: viaMarketing.messages, days: viaMarketing.days }, 'o mesmo teto que o canSend usa');
});
