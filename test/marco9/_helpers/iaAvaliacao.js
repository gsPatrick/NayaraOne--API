'use strict';

// Fábricas da avaliação da NAY (M9-D031/D032). Tudo roda com nayara_runtime (RLS real) em transação com rollback.

const agents = require('../../../src/features/ai/agents');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { uid, q, run, sequelize, carregarPessoas, ctxDe, BASE_AGENT, prepararTenants, expectDbError } = require('../../helpers/aiAgents');

const FERRAMENTA_LEITURA = {
  toolName: 'crm.getOpportunity', permissionCode: 'crm:opportunities:read', riskLevel: 'LOW', requiresHumanApproval: false, enabled: true,
};
const FERRAMENTA_ALTA = {
  toolName: 'legal.draftContract', permissionCode: 'legal:create', riskLevel: 'HIGH', requiresHumanApproval: true, enabled: true,
};

const codigoNovo = () => `T_${uid().slice(0, 8).toUpperCase()}`;

/** Versão 1 de um agente novo da empresa, com a allowlist informada (padrão: uma tool de leitura). */
async function criarAgente(tenant, tx, { code = codigoNovo(), tools = [FERRAMENTA_LEITURA], extra = {} } = {}) {
  const criador = ctxDe(tenant);
  const agent = await agents.createVersion(criador, code, { ...BASE_AGENT, tools, ...extra }, tx);
  return { code, agent, criador };
}

/** Enfileira, executa na mesma transação e devolve a avaliação com os itens. */
async function avaliar(svc, ctx, tx, body) {
  const { evaluation } = await svc.request(ctx, body, tx);
  await svc.processQueued(ctx, tx, { evaluationId: evaluation.id });
  return svc.get(ctx, evaluation.id, tx);
}

const dispensarAvaliacaoVerde = (ctx, tx) => upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, ctx, ctx.userId, tx);
const ajustar = (chave, valor, ctx, tx) => upsertSetting(chave, valor, ctx, ctx.userId, tx);

/** Insere um run por SQL, de uma pessoa, e devolve o id. */
async function inserirRunDe(tenant, userId, tx, agentName = 'NAY_TESTE') {
  const id = uid();
  await run('INSERT INTO ai.ai_runs (id, group_id, company_id, user_id, agent_name, status) VALUES (:id, :g, :c, :u, :a, \'RUNNING\')', { id, g: tenant.groupId, c: tenant.companyId, u: userId, a: agentName }, tx);
  return id;
}

async function rejeita(promessa, status, code) {
  const assert = require('node:assert/strict');
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}

module.exports = {
  uid, q, run, sequelize, carregarPessoas, ctxDe, prepararTenants, expectDbError, FERRAMENTA_LEITURA, FERRAMENTA_ALTA, codigoNovo,
  criarAgente, avaliar, dispensarAvaliacaoVerde, ajustar, inserirRunDe, rejeita,
};
