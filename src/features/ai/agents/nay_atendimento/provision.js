'use strict';

const { provisionAgentVersion } = require('../kit/provision');
const { golden } = require('../../evaluations');
const { DEFINITION } = require('./definition');
const { GOLDEN_CASES } = require('./golden.cases');

/**
 * Cadastra a NAY Atendimento na empresa: versão em DRAFT e desabilitada, com o conteúdo da definição, e o golden dataset do agente.
 * Idempotente: repetir devolve a mesma versão e não duplica os casos. `ctx`: { groupId, companyId, userId, permissions } de quem
 * administra a NAY (ai:admin). Ativar é outra etapa (avaliação verde e homologação por outra pessoa, D032).
 */
async function provisionNayAtendimento(ctx, transaction) {
  const agent = await provisionAgentVersion(ctx, DEFINITION, transaction);
  const existentes = new Set((await golden.listCases(ctx, DEFINITION.code, {}, transaction)).map((c) => c.caseKey));
  for (const c of GOLDEN_CASES) if (!existentes.has(c.caseKey)) await golden.saveCase(ctx, DEFINITION.code, c, transaction);
  return agent;
}

module.exports = { provisionNayAtendimento };
