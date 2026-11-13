'use strict';

/**
 * Migration 20260101010312 (livro do Marco 3 §7, REG-IMO-FIELDS-001): publica a regra dos campos obrigatórios nas empresas que
 * já tinham o catálogo de Imóveis, com antes/depois no audit_log; rodar de novo não duplica; o down desfaz só o que ela criou.
 * Só em banco descartável (DATABASE_ADMIN_URL executa a migration como o dono das tabelas). Rodar isolado.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Sequelize } = require('sequelize');
const { sequelize, getSeedTenant, withTenantTransaction } = require('./testHelpers');
const { seedImoRules } = require('../scripts/seedRealEstateRules');
const migration = require('../migrations/20260101010312-m3im-regra-campos-obrigatorios-publicacao');

let tenant;
let admin;
let empresa;

before(async () => {
  if (!process.env.DATABASE_ADMIN_URL || process.env.DISPOSABLE_DB !== '1') throw new Error('Rode em banco descartável (scripts/withDisposableDb.js).');
  tenant = await getSeedTenant();
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  // Empresa "antiga": tem o catálogo de Imóveis de antes (sem REG-IMO-FIELDS-001).
  empresa = { groupId: tenant.groupId, companyId: crypto.randomUUID(), userId: tenant.userId };
  await admin.query('INSERT INTO core.companies (id, group_id, name, status, created_at, updated_at) VALUES (:id, :g, :n, \'ACTIVE\', now(), now())', { replacements: { id: empresa.companyId, g: empresa.groupId, n: `Empresa legado M3IM ${empresa.companyId.slice(0, 8)}` } });
  await withTenantTransaction(empresa, (t) => seedImoRules(empresa, t));
  const [[regra]] = await admin.query("SELECT id FROM core.rules WHERE company_id = :c AND code = 'REG-IMO-FIELDS-001'", { replacements: { c: empresa.companyId } });
  const [[versao]] = await admin.query('SELECT id FROM core.rule_versions WHERE rule_id = :r', { replacements: { r: regra.id } });
  for (const sql of ['DELETE FROM core.rule_publications WHERE rule_version_id = :v', 'DELETE FROM core.rule_scopes WHERE rule_version_id = :v', 'DELETE FROM core.rule_versions WHERE id = :v']) {
    await admin.query(sql, { replacements: { v: versao.id } });
  }
  await admin.query('DELETE FROM core.rules WHERE id = :r', { replacements: { r: regra.id } });
});

after(async () => {
  await admin.close();
  await sequelize.close();
});

const regrasDaEmpresa = async () => (await admin.query(
  `SELECT r.id, v.status, v.condition_ast_json, v.published_by_user_id FROM core.rules r JOIN core.rule_versions v ON v.rule_id = r.id
    WHERE r.company_id = :c AND r.code = 'REG-IMO-FIELDS-001'`, { replacements: { c: empresa.companyId } }
))[0];

test('up publica REG-IMO-FIELDS-001 na empresa que já tinha o catálogo, audita, não duplica e restaura o FORCE RLS; down desfaz só o que criou', async () => {
  assert.equal((await regrasDaEmpresa()).length, 0, 'antes: empresa sem a regra');
  await migration.up(admin.getQueryInterface());
  const depois = await regrasDaEmpresa();
  assert.equal(depois.length, 1);
  assert.equal(depois[0].status, 'PUBLISHED');
  assert.deepEqual(depois[0].condition_ast_json, { fact: 'hasRequiredFields', op: '==', value: true });
  assert.equal(depois[0].published_by_user_id, tenant.userId, 'mesmo autor da publicação da REG-IMO-001');
  const [aud] = await admin.query("SELECT before_json, after_json FROM audit.audit_log WHERE action = 'rule.seeded_by_migration' AND company_id = :c", { replacements: { c: empresa.companyId } });
  assert.equal(aud.length, 1);
  assert.equal(aud[0].before_json.exists, false);
  assert.equal(aud[0].after_json.ruleId, depois[0].id);

  await migration.up(admin.getQueryInterface());
  assert.equal((await regrasDaEmpresa()).length, 1, 'rodar de novo não duplica');
  for (const t of ['core.rules', 'core.rule_versions', 'core.rule_scopes', 'core.rule_publications', 'core.rule_evaluation_log', 'audit.audit_log']) {
    const [[rls]] = await admin.query(`SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = '${t}'::regclass`);
    assert.equal(rls.force, true, `FORCE RLS restaurado em ${t}`);
  }

  // Ainda não avaliada: o down apaga exatamente o que a migration criou; o up de novo republica.
  await migration.down(admin.getQueryInterface());
  assert.equal((await regrasDaEmpresa()).length, 0, 'down desfaz a regra criada pela migration');
  await migration.up(admin.getQueryInterface());
  assert.equal((await regrasDaEmpresa()).length, 1);

  // A regra entra no Motor de Regras da empresa: o gate decide por ela.
  const { evaluateRule } = require('../src/engines/rules/rulesEngine');
  const decisao = await withTenantTransaction(empresa, (t) => evaluateRule('REG-IMO-FIELDS-001', { hasRequiredFields: true }, empresa, { transaction: t }));
  assert.equal(decisao.decision, 'APPLY');
  const nega = await withTenantTransaction(empresa, (t) => evaluateRule('REG-IMO-FIELDS-001', { hasRequiredFields: false }, empresa, { transaction: t }));
  assert.equal(nega.decision, 'DENY');

  // Já avaliada (há registro no rule_evaluation_log): o down preserva o histórico do Motor de Regras.
  await migration.down(admin.getQueryInterface());
  assert.equal((await regrasDaEmpresa()).length, 1, 'regra avaliada não é apagada pelo down');
  const [[seed]] = await admin.query("SELECT count(*)::int AS n FROM core.rules WHERE company_id = :c AND code = 'REG-IMO-FIELDS-001'", { replacements: { c: tenant.companyId } });
  assert.equal(seed.n, 1, 'o down não toca a regra que o seed criou (não foi a migration)');
});
