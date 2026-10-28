'use strict';

// Apoio dos testes da M9-D005 (ai.ai_runs e ai.ai_sources). Tudo roda com nayara_runtime (RLS real) em transação com rollback.

const { uid, q, run, sequelize, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('./aiAgents');

/** Insere um run por SQL (testa o banco, sem o serviço). */
async function inserirRun(tenant, tx, extra = {}) {
  const id = uid();
  const campos = {
    id, g: tenant.groupId, c: tenant.companyId, agent: extra.agentName || 'NAY_TESTE', status: extra.status || 'RUNNING',
    key: extra.idempotencyKey === undefined ? null : extra.idempotencyKey, parent: extra.parentRunId || null,
  };
  await run(
    `INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, status, idempotency_key, parent_run_id)
     VALUES (:id, :g, :c, :agent, :status, :key, :parent)`, campos, tx
  );
  return id;
}

async function lerRun(id, tx) {
  const [row] = await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx);
  return row;
}

module.exports = { uid, q, run, sequelize, carregarPessoas, ctxDe, prepararTenants, expectDbError, inserirRun, lerRun };
