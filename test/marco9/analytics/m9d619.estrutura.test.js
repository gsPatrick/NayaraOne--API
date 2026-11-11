'use strict';

// M9-D619 — estrutura dos read models de Jurídico e Correspondente: colunas do livro, RLS FORCE, nenhum dado pessoal, eventos conferidos nos serviços
// de origem e parâmetro no SETTINGS_SCHEMA.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bi = require('../_helpers/biObrasJuridicoEnv');
const { MODELS } = require('../_helpers/m9d619Scenario');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const events = require('../../../src/features/analytics/read-models/juridico.events');
const { JURIDICO_DEFAULTS } = require('../../../src/features/analytics/read-models/juridico.settings');

let env;
before(async () => { env = await bi.setup(MODELS); });
after(() => bi.teardown(env));

const COMMON = ['company_id', 'group_id', 'source_snapshot_at', 'refreshed_at', 'version'];
const LIVRO = {
  rm_legal_deadlines: ['due_next_7d', 'due_7_to_29d', 'overdue', 'oldest_overdue_days'],
  rm_legal_cases_risk: ['risk_level', 'count'],
  rm_legal_values: ['estimated_total', 'confirmed_total'],
  rm_legal_missing_docs: ['contracts_missing', 'requirements_pending'],
  rm_fin_cases_stage: ['stage', 'count'],
  rm_fin_provider_outcome: ['provider', 'approved', 'rejected', 'analysis_hours_sum', 'analysis_count'],
  rm_fin_commission: ['expected', 'confirmed', 'received'],
};
const columnsOf = async (table) => (await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t", { replacements: { t: table } }))[0].map((r) => r.column_name);

test('m9d619 o read model existe com as colunas descritas e RLS FORCE', async () => {
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

test('m9d619 nenhum dado pessoal restrito é copiado para o read model', async () => {
  const pii = /(^|_)(nome|name|document|cpf|cnpj|email|phone|telefone|person|pessoa|user|owner|party|parte|lawyer|advogado|summary|teor|description|descricao|applicant)(_|$)/i;
  for (const model of MODELS) for (const c of await columnsOf(model)) assert.doesNotMatch(c, pii, `${model}.${c}`);
  const dir = path.join(__dirname, '../../../src/features/analytics/read-models');
  const sources = fs.readdirSync(dir).filter((f) => /^(juridico|correspondente)-.*\.readmodel\.js$/.test(f));
  assert.ok(sources.length >= 7);
  for (const file of sources) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\b(cpf|cnpj|email|phone|full_name|person_id|applicant|summary|description|legal_case_parties|case_applicants)\b/i, file);
  }
});

test('m9d619 eventos conferem com os serviços de origem e o parâmetro está no SETTINGS_SCHEMA', () => {
  const root = path.join(__dirname, '../../../src/features');
  const text = ['../modules/legal/shared/legalEvents.service.js', '../modules/legal/cases/legalDeadlineCalendarEvents.service.js', '../modules/legal/shared/legalBiEvents.service.js', 'correspondent/correspondentEvents.service.js']
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const all = new Set(Object.values(events).flat());
  assert.ok(all.size >= 20);
  for (const name of all) assert.ok(text.includes(`'${name}'`), `${name} existe nos serviços de origem`);
  const key = 'analytics.juridico.processo_encerrado_status';
  assert.ok(SETTINGS_SCHEMA[key] && JURIDICO_DEFAULTS[key]);
  assert.throws(() => SETTINGS_SCHEMA[key].validate(key, 'encerrado'), /lista de códigos/);
});
