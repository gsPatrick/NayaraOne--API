'use strict';

// Apoio dos testes da reconciliação (M9-D215): o ambiente do Dispatch Service mais a limpeza dos envios incertos que outros arquivos deixaram.
const base = require('./m9d214Env');
const { bancoReconciliavel, timeout } = require('./m9d215Banco');
const { erroHttp, mensagemProgramavel } = require('./m9d214Scripted');

const { sequelize, comTenant } = base;

/** Tira de cena o que outros testes deixaram em andamento (inclusive UNKNOWN e SUBMITTED), para a rodada do job só pegar o do teste. */
async function limparTudo(tenant) {
  await base.limparPendentes(tenant);
  await comTenant(tenant, (t) => sequelize.query(
    `UPDATE integration.dispatches SET status = 'CANCELLED' WHERE company_id = :c AND status IN ('UNKNOWN', 'SUBMITTED')`, { replacements: { c: tenant.companyId }, transaction: t },
  ));
  // As falhas seguidas de um teste não podem abrir o circuito no seguinte (cinco abrem): zera o contador mesmo com o circuito fechado.
  await comTenant(tenant, (t) => sequelize.query(
    'UPDATE integration.provider_health SET consecutive_failures = 0 WHERE company_id = :c AND window_minutes = 0', { replacements: { c: tenant.companyId }, transaction: t },
  ));
}

/** Linhas da auditoria de um envio (ordem cronológica). */
const auditoria = (tenant, id, action) => comTenant(tenant, async (t) => (await sequelize.query(
  'SELECT * FROM audit.audit_log WHERE entity_id = :id AND action = :a ORDER BY occurred_at, id', { replacements: { id, a: action }, transaction: t },
))[0]);

/** Abre uma tentativa que nunca terminou (o processo morreu no meio). */
const tentativaAberta = (tenant, dispatchRow) => comTenant(tenant, (t) => sequelize.query(
  `INSERT INTO integration.dispatch_attempts (group_id, company_id, dispatch_id, connection_id, provider_code, attempt_no, started_at)
   VALUES (:g, :c, :d, :k, :p, 1, now() - interval '10 minutes')`,
  { replacements: { g: tenant.groupId, c: tenant.companyId, d: dispatchRow.id, k: dispatchRow.connection_id, p: dispatchRow.provider_code }, transaction: t },
));

const pausa = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

module.exports = { ...base, limparTudo, auditoria, tentativaAberta, pausa, bancoReconciliavel, timeout, erroHttp, mensagemProgramavel };
