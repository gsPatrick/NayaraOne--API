'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const E = require('./agents.errors');
const { evaluationsTableExists, passedEvaluationSuites, homologatedEvaluationSuites } = require('../readmodels/agentSupport.readmodel');
const { isHighImpact } = require('../evaluations/highImpact');
const { EVALUATION_KEYS, EVALUATION_SETTING_DEFAULTS } = require('../evaluations/evaluations.settings');

const REQUIRE_GREEN_KEY = 'ia.agente.avaliacao_verde_obrigatoria';

/** Verde = PASSED na suíte ALL, ou PASSED em GOLDEN e em ADVERSARIAL. */
const isGreen = (suites) => suites.has('ALL') || (suites.has('GOLDEN') && suites.has('ADVERSARIAL'));

/**
 * Homologar exige avaliação verde da versão (livro; AI-015 mantém a decisão humana depois dela). A avaliação é a tabela
 * ai.evaluations da M9-D032. O administrador pode dispensar a exigência pelo parâmetro `ia.agente.avaliacao_verde_obrigatoria`.
 * Sem a tabela entregue, a exigência não se cumpre e a homologação é recusada (falha fechada).
 */
async function assertGreenEvaluation(ctx, agent, transaction) {
  const required = await getSetting(REQUIRE_GREEN_KEY, ctx, transaction, true);
  if (required === false) return { checked: false };
  if (!(await evaluationsTableExists(transaction))) throw E.evaluationRequired();
  const suites = await passedEvaluationSuites(ctx.companyId, agent.code, agent.version, transaction);
  if (!isGreen(suites)) throw E.evaluationRequired();
  return { checked: true };
}

/**
 * Ativar exige a avaliação verde HOMOLOGADA por uma pessoa (AI-015: avaliação automática não substitui a homologação humana).
 * Obrigatório para agente de alto impacto (NAY_FINANCEIRA, NAY_JURIDICA, NAY_CORRESPONDENTE ou tool HIGH/CRITICAL), sempre; para
 * os demais, quando `ia.avaliacao.homologacao_humana_todos` está ligado (padrão) e a avaliação verde não foi dispensada.
 * Falha: 409 AI_AGENT_NOT_HOMOLOGATED. Nenhum código promove a versão a ACTIVE só porque a avaliação passou.
 */
async function assertHumanHomologatedEvaluation(ctx, agent, transaction) {
  const greenRequired = (await getSetting(REQUIRE_GREEN_KEY, ctx, transaction, true)) !== false;
  const humanForAll = (await getSetting(EVALUATION_KEYS.humanForAll, ctx, transaction, EVALUATION_SETTING_DEFAULTS[EVALUATION_KEYS.humanForAll])) !== false;
  const required = isHighImpact(agent) || (greenRequired && humanForAll);
  if (!required) return { checked: false };
  if (!(await evaluationsTableExists(transaction))) throw E.notHomologated();
  const suites = await homologatedEvaluationSuites(ctx.companyId, agent.code, agent.version, transaction);
  if (!isGreen(suites)) throw E.notHomologated();
  return { checked: true };
}

module.exports = { assertGreenEvaluation, assertHumanHomologatedEvaluation, REQUIRE_GREEN_KEY };
