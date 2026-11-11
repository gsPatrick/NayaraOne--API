'use strict';

// M9-D618 — estrutura dos read models de Obras, Estoque/Patrimônio e Pós-obra: colunas do livro, RLS FORCE, nenhum dado pessoal, eventos
// conferidos nos serviços de origem e parâmetros no SETTINGS_SCHEMA.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bi = require('../_helpers/biObrasJuridicoEnv');
const { MODELS } = require('../_helpers/m9d618Scenario');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const events = require('../../../src/features/analytics/read-models/obra.events');
const { OBRA_DEFAULTS } = require('../../../src/features/analytics/read-models/obra.settings');

let env;
before(async () => { env = await bi.setup(MODELS); });
after(() => bi.teardown(env));

const COMMON = ['company_id', 'group_id', 'source_snapshot_at', 'refreshed_at', 'version'];
const LIVRO = {
  rm_project_progress: ['project_id', 'baseline_percent', 'actual_percent', 'forecast_finish_date', 'baseline_finish_date'],
  rm_project_cost: ['project_id', 'budget_cost', 'actual_cost', 'forecast_cost', 'contract_revenue'],
  rm_project_delays: ['project_id', 'delayed_stages', 'max_delay_days'],
  rm_project_measurements: ['project_id', 'measured_value', 'approved_value', 'pending_value'],
  rm_project_nonconformities: ['project_id', 'open', 'closed_30d', 'cause', 'team_id'],
  rm_project_waste: ['project_id', 'material_id', 'waste_value'],
  rm_postwork_cost: ['project_id', 'cases_open', 'warranty_cost', 'cause', 'team_id', 'material_id'],
  rm_inventory_health: ['stock_value', 'items_below_min', 'ruptures', 'losses_30d'],
  rm_tool_assets: ['loans_open', 'loans_overdue', 'assets_in_maintenance'],
};

const columnsOf = async (table) => (await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t", { replacements: { t: table } }))[0].map((r) => r.column_name);

test('m9d618 o read model existe com as colunas descritas e RLS FORCE', async () => {
  for (const model of MODELS) {
    const have = await columnsOf(model);
    for (const c of [...LIVRO[model], ...COMMON]) assert.ok(have.includes(c), `${model}: falta a coluna ${c}`);
    const [[r]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
      has_table_privilege('nayara_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS runtime_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = :model`, { replacements: { model } });
    assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies, r.runtime_grant], [true, true, 4, true], model);
    const def = bi.readModels.getReadModel(model);
    assert.ok(def, `${model} está registrado`);
    assert.deepEqual(await bi.readModels.assertReadModelTable(def, null), [], `${model}: colunas comuns e índice único da chave`);
  }
});

test('m9d618 nenhum dado pessoal restrito é copiado para o read model', async () => {
  const pii = /(^|_)(nome|name|document|cpf|cnpj|email|phone|telefone|person|pessoa|user|owner|beneficiary|holder|description|descricao)(_|$)/i;
  for (const model of MODELS) for (const c of await columnsOf(model)) assert.doesNotMatch(c, pii, `${model}.${c}`);
  // os arquivos do read model não leem nome nem documento de pessoa da fonte
  const dir = path.join(__dirname, '../../../src/features/analytics/read-models');
  const sources = fs.readdirSync(dir).filter((f) => /^(obras|estoque)-.*\.readmodel\.js$/.test(f));
  assert.ok(sources.length >= 9);
  for (const file of sources) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\b(cpf|cnpj|email|phone|full_name|person_id|responsible_user_id|person_user_id|description)\b/i, file);
  }
});

test('m9d618 eventos conferem com os serviços de origem e os parâmetros estão no SETTINGS_SCHEMA', () => {
  const root = path.join(__dirname, '../../../src/features');
  const text = ['construction/constructionEvents.service.js', 'construction/constructionCalendarEvents.service.js', 'inventory/inventoryEvents.service.js', '../modules/finance/application/services/finance-events.service.js', '../modules/legal/shared/legalEvents.service.js']
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const all = new Set(Object.values(events).filter(Array.isArray).flat());
  assert.ok(all.size >= 30);
  for (const name of all) assert.ok(text.includes(`'${name}'`), `${name} existe nos serviços de origem`);
  for (const key of ['analytics.obra.previsao_metodo', 'analytics.obra.receita_contrato_status', 'analytics.estoque.tipos_item']) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} no SETTINGS_SCHEMA`);
    assert.ok(Object.prototype.hasOwnProperty.call(OBRA_DEFAULTS, key));
  }
  assert.deepEqual(SETTINGS_SCHEMA['analytics.obra.previsao_metodo'].enum, ['RITMO', 'PLANEJADO']);
  assert.throws(() => SETTINGS_SCHEMA['analytics.obra.receita_contrato_status'].validate('k', 'ativo, assinado'), /lista de códigos/);
});
