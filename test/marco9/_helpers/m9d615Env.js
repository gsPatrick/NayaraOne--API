'use strict';

// Apoio dos testes da M9-D615 (read model financeiro): tenants, relógio fixo, eventos do outbox simulados e leitura das linhas.
// Banco descartável (127.0.0.1). O que o teste grava com commit é removido em `teardown` (ver m9d615Ledger.cleanup).
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const ledger = require('./m9d615Ledger');

const NOW = new Date('2026-10-28T15:00:00Z'); // 12:00 de 28/10/2026 em São Paulo
const AS_OF = '2026-10-28';

async function setup() {
  const base = await sup.setup();
  return { ...base, created: [], now: NOW, asOf: AS_OF };
}

async function teardown(env) {
  await ledger.cleanup(env);
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${env.readModel}`);
  await env.admin.close();
  await sequelize.close();
}

function makeEvent(tenant, eventType, payload = {}, { id } = {}) {
  return {
    id: id || ledger.uuid(), eventType, companyId: tenant.companyId, groupId: tenant.groupId, aggregateId: payload.id || ledger.uuid(),
    payloadJson: payload, occurredAt: NOW, retryCount: 0,
  };
}

/** Aplica o evento ao read model numa transação do tenant (com commit) e devolve o resumo do worker. */
const apply = (tenant, event, options = {}) => sup.inTx(tenant, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW, ...options }));

async function healthRow(env, tenant, asOf = AS_OF) {
  const [[row]] = await env.admin.query('SELECT * FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d', { replacements: { c: tenant.companyId, d: asOf } });
  return row || null;
}

const ledgerRows = async (env, tenant) => (await env.admin.query('SELECT * FROM finance.financial_entries WHERE company_id = :c', { replacements: { c: tenant.companyId } }))[0];

module.exports = { setup, teardown, makeEvent, apply, healthRow, ledgerRows, NOW, AS_OF, inTx: sup.inTx, sequelize, ledger };
