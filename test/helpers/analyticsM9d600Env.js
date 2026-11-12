'use strict';

// Apoio comum dos testes do M9-D600 (schema "analytics"): ambiente de dois tenants, transação como a do usuário e fábricas.
// Roda SÓ em banco descartável (precisa de DATABASE_ADMIN_URL para DDL e para achar a 2ª empresa).

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant, uniqueSuffix } = require('../testHelpers');
const store = require('../../src/features/analytics/metricStore.service');
const { removerMetricasPorCodigo } = require('../marco9/_helpers/analyticsResiduo');

const UNITS = ['BRL', 'PERCENT', 'COUNT', 'DAYS', 'HOURS', 'MINUTES', 'SECONDS', 'SCORE', 'NUMBER', 'PP', 'BRL_PER_UNIT'];

// Abre o admin (superusuário do cluster descartável) e resolve os dois tenants do seed.
async function setupEnv() {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL ausente: rode via scripts/withDisposableDb.js (nunca contra o banco compartilhado).');
  assert.match(process.env.DATABASE_ADMIN_URL, /@127\.0\.0\.1:/, 'o destino precisa ser 127.0.0.1');
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const tenantA = await getSeedTenant();
  const [[b]] = await admin.query(
    `SELECT c.id AS "companyId", c.group_id AS "groupId" FROM core.companies c WHERE c.name = 'CI — Empresa Fictícia B' LIMIT 1`
  );
  assert.ok(b, 'empresa B do seed-ci-two-tenants não encontrada');
  const [[u]] = await admin.query(`SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'`);
  const tenantB = { groupId: b.groupId, companyId: b.companyId, userId: u.id };
  assert.notEqual(tenantA.groupId, tenantB.groupId);
  return { admin, tenantA, tenantB };
}

// Os testes do M9-D600 COMMITAM definições (inclusive GLOBAL e de grupo). Cada código gerado por `code()` é anotado e apagado no `closeEnv`:
// a definição global que sobrava (glob.m9d600_*) entrava no catálogo de todas as empresas do banco e derrubava m9d712.tabela e m9d712.semente.
const codigosCriados = new Set();

async function closeEnv(admin) {
  await removerMetricasPorCodigo(admin, [...codigosCriados]);
  codigosCriados.clear();
  await admin.close();
  await sequelize.close();
}

// Transação como a requisição do usuário (role nayara_runtime + GUCs de tenant). writer = worker de BI.
async function inTx(tenant, opts, fn) {
  const { writer = false, commit = false } = opts;
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    if (writer) await store.enableAnalyticsWriter(transaction);
    const result = await fn(transaction);
    if (commit) await transaction.commit();
    else await transaction.rollback();
    return result;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

const ctxOf = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId });
const code = (prefix = 'qa') => {
  const c = `${prefix}.m9d600_${uniqueSuffix()}_${Math.floor(Math.random() * 1000)}`;
  codigosCriados.add(c);
  return c;
};
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');

function versionInput(definitionId, extra = {}) {
  return {
    definitionId,
    expectedVersion: 0,
    formulaId: 'fin.free_cash.v1',
    formulaSemantic: 'Saldo disponível menos obrigações do período.',
    sourceReadModel: 'rm_finance_cash',
    dimensions: ['company'],
    filters: {},
    unit: 'BRL',
    refreshPolicy: { mode: 'SCHEDULE', cron: '0 3 * * *', maxStalenessMinutes: 1440 },
    qualityRule: null,
    valueNature: 'ACTUAL',
    formulaTestHash: hash('dry-run'),
    validFrom: '2026-01-01',
    ...extra,
  };
}

async function newMetric(tx, tenant, { scopeLevel = 'COMPANY', metricCode = code() } = {}) {
  return store.createMetricDefinition(
    {
      scopeLevel,
      groupId: tenant.groupId,
      companyId: scopeLevel === 'COMPANY' ? tenant.companyId : null,
      metricCode,
      name: 'Caixa livre',
      description: 'Teste D600',
      domain: 'FINANCE',
      criticality: 'CRITICAL',
      ownerRole: 'CFO',
    },
    ctxOf(tenant),
    tx
  );
}

function snapshotInput(def, version, tenant, extra = {}) {
  return {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    metricId: def.id,
    metricVersionId: version.id,
    scopeType: 'COMPANY',
    scopeId: tenant.companyId,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    asOfDate: '2026-10-30',
    valueNumeric: '1234.5600',
    status: 'OK',
    sourceSnapshotAt: new Date('2026-10-30T23:00:00Z'),
    readModelVersion: 3,
    sourceRefs: [{ table: 'finance.financial_entries', rows: 12 }],
    calcHash: hash('entrada-1'),
    ...extra,
  };
}


module.exports = { UNITS, setupEnv, closeEnv, inTx, ctxOf, code, hash, versionInput, newMetric, snapshotInput };
