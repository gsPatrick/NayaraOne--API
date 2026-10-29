'use strict';

// M9-D708 — estrutura: tabela analytics.metric_acceptance (RLS por empresa, FORCE, sem DELETE, GRANT guardado), parâmetros do administrador
// (analytics.ambiente e analytics.aceite.tolerancia: schema, leitura e tela) e a migration idempotente e reversível. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const e708 = require('../_helpers/m9d708Env');
const settings = require('../../../src/features/analytics/metrics/acceptance.settings');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

let env;
before(async () => { env = await e708.setup(); });
after(() => e708.teardown(env));

const q = async (sql, replacements = {}) => (await env.admin.query(sql, { replacements }))[0];
const ROOT = path.join(__dirname, '../../..');

test('m9d708 a tabela metric_acceptance existe com as colunas do livro, RLS e FORCE', async () => {
  const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'metric_acceptance'")).map((r) => r.column_name);
  for (const c of ['company_id', 'group_id', 'metric_code', 'metric_version', 'owner_user_id', 'reference_report', 'reference_value', 'bi_value', 'difference', 'tolerance', 'evidence_file_id', 'status', 'accepted_by', 'accepted_at', 'comment']) {
    assert.ok(cols.includes(c), `coluna ${c}`);
  }
  const [t] = await q("SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'metric_acceptance'");
  assert.deepEqual([t.relrowsecurity, t.relforcerowsecurity], [true, true]);
  const policies = (await q("SELECT polname FROM pg_policy WHERE polrelid = 'analytics.metric_acceptance'::regclass")).map((r) => r.polname).sort();
  assert.deepEqual(policies, ['analytics_insert', 'analytics_select', 'analytics_update'], 'sem política de DELETE: o histórico do aceite não se apaga');
});

test('m9d708 o status só aceita PENDING, ACCEPTED e REJECTED e a versão da métrica é única por empresa', async () => {
  const bad = (status) => env.admin.query("INSERT INTO analytics.metric_acceptance (company_id, group_id, metric_code, metric_version, status) VALUES (:c, :g, 'fin.x_y', 1, :s)",
    { replacements: { c: env.cX.companyId, g: env.cX.groupId, s: status } });
  await assert.rejects(bad('TALVEZ'), /check constraint/);
  await bad('PENDING');
  await assert.rejects(bad('PENDING'), (e) => e.name === 'SequelizeUniqueConstraintError');
  await env.admin.query("DELETE FROM analytics.metric_acceptance WHERE metric_code = 'fin.x_y'");
});

test('m9d708 a empresa B não enxerga nem altera a linha da empresa A (RLS)', async () => {
  const id = e708.uuid();
  await env.admin.query("INSERT INTO analytics.metric_acceptance (id, company_id, group_id, metric_code, metric_version, status) VALUES (:id, :c, :g, 'fin.rls_teste', 1, 'PENDING')",
    { replacements: { id, c: env.cX.companyId, g: env.cX.groupId } });
  const seenByY = await e708.inTx(env.cY, {}, (tx) => e708.sequelize.query('SELECT id FROM analytics.metric_acceptance WHERE id = :id', { replacements: { id }, transaction: tx }));
  assert.equal(seenByY[0].length, 0);
  const seenByX = await e708.inTx(env.cX, {}, (tx) => e708.sequelize.query('SELECT id FROM analytics.metric_acceptance WHERE id = :id', { replacements: { id }, transaction: tx }));
  assert.equal(seenByX[0].length, 1);
  await assert.rejects(e708.inTx(env.cY, { commit: true }, async (tx) => {
    await e708.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    await e708.sequelize.query("INSERT INTO analytics.metric_acceptance (company_id, group_id, metric_code, metric_version, status) VALUES (:c, :g, 'fin.rls_teste', 2, 'PENDING')",
      { replacements: { c: env.cX.companyId, g: env.cX.groupId }, transaction: tx });
  }), /row-level security/);
  await env.admin.query('DELETE FROM analytics.metric_acceptance WHERE id = :id', { replacements: { id } });
});

test('m9d708 a escrita exige o marcador do escritor do BI e o papel de execução não apaga linhas', async () => {
  await assert.rejects(e708.inTx(env.cX, { commit: true }, (tx) => e708.sequelize.query(
    "INSERT INTO analytics.metric_acceptance (company_id, group_id, metric_code, metric_version, status) VALUES (:c, :g, 'fin.sem_marca', 1, 'PENDING')",
    { replacements: { c: env.cX.companyId, g: env.cX.groupId }, transaction: tx })), /row-level security/);
  const id = e708.uuid();
  await env.admin.query("INSERT INTO analytics.metric_acceptance (id, company_id, group_id, metric_code, metric_version, status) VALUES (:id, :c, :g, 'fin.sem_delete', 1, 'PENDING')",
    { replacements: { id, c: env.cX.companyId, g: env.cX.groupId } });
  const deleted = await e708.inTx(env.cX, { commit: true }, async (tx) => {
    await e708.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    return e708.sequelize.query('DELETE FROM analytics.metric_acceptance WHERE id = :id RETURNING id', { replacements: { id }, transaction: tx });
  });
  assert.equal(deleted[0].length, 0, 'sem política de DELETE: nem o escritor do BI apaga a linha');
  await env.admin.query('DELETE FROM analytics.metric_acceptance WHERE id = :id', { replacements: { id } });
});

test('m9d708 os parâmetros do administrador existem no schema com o padrão do livro', () => {
  assert.equal(settings.KEYS.ambiente, 'analytics.ambiente');
  assert.equal(settings.KEYS.tolerancia, 'analytics.aceite.tolerancia');
  assert.deepEqual(SETTINGS_SCHEMA['analytics.ambiente'], { type: 'string', enum: ['LAB', 'PRODUCAO'] });
  assert.equal(SETTINGS_SCHEMA['analytics.aceite.tolerancia'].type, 'string');
  assert.equal(settings.DEFAULTS[settings.KEYS.ambiente], 'LAB');
  assert.deepEqual(settings.parseTolerance(settings.DEFAULTS[settings.KEYS.tolerancia]), { dinheiro: '0.00', contagem: '0', demais: '0' });
  assert.deepEqual(settings.parseTolerance('dinheiro=1,50; contagem=2; demais=0,5'), { dinheiro: '1.50', contagem: '2', demais: '0.5' });
  assert.equal(settings.parseTolerance('lixo'), null, 'entrada inválida cai no padrão');
  assert.equal(settings.toleranceFor({ dinheiro: '1.50', contagem: '2', demais: '0.5' }, 'BRL'), '1.50');
  assert.equal(settings.toleranceFor({ dinheiro: '1.50', contagem: '2', demais: '0.5' }, 'COUNT'), '2');
  assert.equal(settings.toleranceFor({ dinheiro: '1.50', contagem: '2', demais: '0.5' }, 'PERCENT'), '0.5');
});

test('m9d708 a aba "BI e Centro de Comando" do Front tem os dois parâmetros', () => {
  const dir = path.join(ROOT, '../NayaraOne--FRONT/app/painel/configuracoes');
  const groups = fs.readFileSync(path.join(dir, 'biAceiteGroups.js'), 'utf8');
  assert.match(groups, /analytics\.ambiente/);
  assert.match(groups, /analytics\.aceite\.tolerancia/);
  const tab = fs.readFileSync(path.join(dir, 'BiTab.js'), 'utf8');
  assert.match(tab, /BI_ACEITE_GROUPS/);
});

test('m9d708 a migration 9926 é idempotente e reversível', async () => {
  const mig = require('../../../migrations/20260101009926-create-analytics-metric-acceptance');
  const qi = env.admin.getQueryInterface();
  await mig.up(qi);
  await mig.up(qi);
  const [{ n }] = await q("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'analytics' AND tablename = 'metric_acceptance'");
  assert.equal(n, 1);
  assert.equal(typeof mig.down, 'function');
  assert.ok(fs.readFileSync(path.join(ROOT, 'migrations/20260101009926-create-analytics-metric-acceptance.js'), 'utf8').includes('pg_roles'), 'GRANT dentro de guarda de existência do role');
});
