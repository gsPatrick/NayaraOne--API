'use strict';

// Apoio dos testes da M9-D017: oportunidade de cada empresa, agente com allowlist, contexto de execução e gravador de tool calls.
// Dados da empresa B são COMMITADOS (a transação da A não enxerga transação aberta de outra empresa); o banco é o descartável.

const { sequelize, withTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const peopleService = require('../../../src/features/people/people.service');
const opportunityService = require('../../../src/features/crm/opportunity.service');
const { buildUserContext } = require('../../../src/features/ai/orchestrator/executionContext');

async function criarOportunidade(tenant, transaction) {
  const pessoa = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `QA-M9 Lead ${uniqueSuffix()}` }, tenant.userId, transaction);
  const opp = await opportunityService.createOpportunity({
    groupId: tenant.groupId, companyId: tenant.companyId, personId: pessoa.id,
    nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 86400000).toISOString(),
  }, tenant.userId, transaction);
  return { pessoa, opp };
}

/** Cria e COMMITA uma oportunidade na empresa informada (para provar que outra empresa não a enxerga). */
const criarOportunidadeCommitada = (tenant) => withTenantTransaction(tenant, (tx) => criarOportunidade(tenant, tx));

/** Agente (como o resolveActiveAgent devolve) com a allowlist informada. */
const agenteCom = (...nomes) => ({ id: 'ag-1', code: 'NAY_COMERCIAL', version: 1, tools: nomes.map((toolName) => ({ toolName, enabled: true })) });

const contextoDe = (tenant, permissions, extra = {}) => buildUserContext(
  { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roles: ['TESTE'], permissions },
  { correlationId: 'corr-m9d017', runId: 'run-m9d017', ...extra }
);

/** Gravador de tool calls em memória (o mesmo contrato do executor: record + emit). */
function gravador() {
  const linhas = [];
  const eventos = [];
  return { linhas, eventos, record: async (l) => { linhas.push(l); }, emit: async (e) => { eventos.push(e); } };
}

const LIMITES = Object.freeze({ stringMax: 500, arrayMax: 50 });

module.exports = { sequelize, criarOportunidade, criarOportunidadeCommitada, agenteCom, contextoDe, gravador, LIMITES };
