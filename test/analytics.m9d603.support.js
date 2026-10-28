'use strict';

// Apoio dos testes da M9-D603 (registro de métricas): tenants, transação, fórmulas e read model de teste.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const metrics = require('../src/features/analytics/metricStore.service');

const GOOD_FORMULA = `module.exports = { id: 'fin.m9d603_soma', version: 1,
  compute: (rows) => ({ value: String(rows.reduce((a, r) => a + Number(r.v), 0)) }),
  testCases: [{ name: 'dois itens', input: [{ v: 1 }, { v: 2 }], expected: { value: '3' } }, { name: 'vazio', input: [], expected: { value: '0' } }] };`;
const BAD_FORMULA = `module.exports = { id: 'fin.m9d603_errada', version: 1, compute: () => ({ value: '1' }),
  testCases: [{ name: 'espera 2', input: [], expected: { value: '2' } }] };`;
const NO_TESTS_FORMULA = `module.exports = { id: 'fin.m9d603_sem_testes', version: 1, compute: () => ({ value: '1' }) };`;

async function setup() {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL ausente: rode via scripts/withDisposableDb.js (nunca contra o banco compartilhado).');
  assert.match(process.env.DATABASE_ADMIN_URL, /@127\.0\.0\.1:/, 'o destino precisa ser 127.0.0.1');
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const tenantA = await getSeedTenant();
  const [[b]] = await admin.query(`SELECT c.id AS "companyId", c.group_id AS "groupId" FROM core.companies c WHERE c.name = 'CI — Empresa Fictícia B' LIMIT 1`);
  const [[u]] = await admin.query(`SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'`);
  const tenantB = { groupId: b.groupId, companyId: b.companyId, userId: u.id };
  const formulaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d603-formulas-'));
  fs.writeFileSync(path.join(formulaDir, 'soma.js'), GOOD_FORMULA);
  fs.writeFileSync(path.join(formulaDir, 'errada.js'), BAD_FORMULA);
  fs.writeFileSync(path.join(formulaDir, 'sem_testes.js'), NO_TESTS_FORMULA);
  const readModel = `rm_m9d603_${uniqueSuffix()}`.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  await admin.query(`CREATE TABLE analytics.${readModel} (id int)`);
  return { admin, tenantA, tenantB, formulaDir, readModel };
}

async function teardown(env) {
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${env.readModel}`);
  fs.rmSync(env.formulaDir, { recursive: true, force: true });
  await env.admin.close();
  await sequelize.close();
}

async function inTx(tenant, { commit = false } = {}, fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    const result = await fn(transaction);
    if (commit) await transaction.commit();
    else await transaction.rollback();
    return result;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

const ctxOf = (t, permissions = ['analytics:manage']) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });
const sfx = () => `${uniqueSuffix()}${Math.floor(Math.random() * 1000)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const codeOf = () => `fin.m9d603_${sfx()}`;

function metricInput(env, extra = {}) {
  return {
    scopeLevel: 'COMPANY', metricCode: codeOf(), name: 'Caixa livre', description: 'Saldo disponível menos obrigações.',
    formulaId: 'fin.m9d603_soma', formulaSemantic: 'Soma dos saldos disponíveis menos as obrigações do período.',
    sourceReadModel: env.readModel, dimensions: ['company'], filters: { status: 'OPEN' }, unit: 'BRL', ownerRole: 'CFO',
    refreshPolicy: { mode: 'SCHEDULE', cron: '0 3 * * *', maxStalenessMinutes: 1440 }, version: 1, validFrom: '2026-01-01',
    qualityRule: { referenceReport: 'Saldo bancário conciliado menos terceiros' }, valueNature: 'ACTUAL', criticality: 'CRITICAL', ...extra,
  };
}

module.exports = { setup, teardown, inTx, ctxOf, sfx, codeOf, metricInput, metrics, sequelize };
