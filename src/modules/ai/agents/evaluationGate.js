'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const E = require('./agents.errors');
const { evaluationsTableExists, passedEvaluationSuites } = require('../readmodels/agentSupport.readmodel');

const REQUIRE_GREEN_KEY = 'ia.agente.avaliacao_verde_obrigatoria';

/**
 * Homologar exige avaliação verde da versão (livro; AI-015 mantém a decisão humana depois dela). A avaliação é a tabela
 * ai.evaluations da M9-D032: verde = PASSED na suíte ALL, ou PASSED em GOLDEN e em ADVERSARIAL. O administrador pode
 * dispensar a exigência pelo parâmetro `ia.agente.avaliacao_verde_obrigatoria`. Sem a tabela entregue, a exigência não
 * se cumpre e a homologação é recusada (falha fechada).
 */
async function assertGreenEvaluation(ctx, agent, transaction) {
  const required = await getSetting(REQUIRE_GREEN_KEY, ctx, transaction, true);
  if (required === false) return { checked: false };
  if (!(await evaluationsTableExists(transaction))) throw E.evaluationRequired();
  const suites = await passedEvaluationSuites(ctx.companyId, agent.code, agent.version, transaction);
  if (!(suites.has('ALL') || (suites.has('GOLDEN') && suites.has('ADVERSARIAL')))) throw E.evaluationRequired();
  return { checked: true };
}

module.exports = { assertGreenEvaluation, REQUIRE_GREEN_KEY };
