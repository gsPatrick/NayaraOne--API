'use strict';

const repo = require('./golden.repository');
const agentErrors = require('../../agents/agents.errors');

/**
 * Separação entre quem faz e quem aprova (M9-D033): quem alterou o golden dataset do agente (criou, corrigiu ou aposentou um
 * caso da empresa) não homologa a versão desse agente. Vale junto da segregação de funções da D004 (`ia.agente.segregacao_funcoes`).
 */
async function assertNotGoldenAuthor(ctx, agent, transaction) {
  if (!ctx.userId) return;
  const [authors, retirers] = await Promise.all([repo.activeAuthors(ctx, agent.code, transaction), repo.retiredAuthors(ctx, agent.code, transaction)]);
  if (authors.has(ctx.userId) || retirers.has(ctx.userId)) {
    throw agentErrors.segregation('Quem alterou o conjunto de testes do agente não pode homologar a versão; peça a outra pessoa com permissão de avaliação.');
  }
}

module.exports = { assertNotGoldenAuthor };
