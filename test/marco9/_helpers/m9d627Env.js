'use strict';

// Apoio dos testes da M9-D627 (read models de Marketing e Atendimento): tenants, relógio fixo, eventos do outbox simulados, leitura das linhas
// e passada da agenda. Banco descartável (127.0.0.1). O que o teste grava com commit é removido em `teardown` (ver m9d627Sources.cleanup).
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');
const src = require('./m9d627Sources');

const NOW = new Date('2026-10-28T15:00:00Z'); // 12:00 de 28/10/2026 em São Paulo
const at = (day, hour = 15) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

async function setup() {
  const base = await sup.setup();
  return { ...base, created: [], now: NOW };
}

async function teardown(env) {
  await src.cleanup(env);
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${env.readModel}`);
  await env.admin.close();
  await sequelize.close();
}

function makeEvent(tenant, eventType, payload = {}, occurredAt = NOW) {
  return { id: src.uuid(), eventType, companyId: tenant.companyId, groupId: tenant.groupId, aggregateId: payload.id || src.uuid(), payloadJson: payload, occurredAt, retryCount: 0 };
}

/** Aplica o evento ao worker numa transação do tenant (com commit) e devolve o resumo. */
const apply = (tenant, event, options = {}) => sup.inTx(tenant, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW, ...options }));

/** Passada da agenda da empresa (sem nenhum evento), com o relógio informado. */
const schedule = (tenant, now = NOW) => sup.inTx(tenant, { commit: true }, async (tx) => {
  const params = await readModels.readRefreshParams(tenant, tx);
  return readModels.refreshCompanyScheduled({ companyId: tenant.companyId, groupId: tenant.groupId }, params, tx, { now });
});

const rowsOf = async (env, model, tenant) => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 3, 4`, { replacements: { c: tenant.companyId } }))[0];
const rowOf = async (env, model, tenant, where = {}) => {
  const names = Object.keys(where);
  const [[row]] = await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ${names.map((n) => `AND "${n}" = :${n}`).join(' ')}`, { replacements: { c: tenant.companyId, ...where } });
  return row || null;
};

/** Contexto do rebuild (M9-D608). */
const rebuildCtx = (tenant, reason = 'QA-M9: reprodução do incremental') => ({ groupId: tenant.groupId, actorUserId: tenant.userId, permissions: ['analytics:rebuild'], reason });

module.exports = { setup, teardown, makeEvent, apply, schedule, rowsOf, rowOf, rebuildCtx, at, NOW, inTx: sup.inTx, sequelize, src, readModels };
