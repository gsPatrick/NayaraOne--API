'use strict';

const { readRouterParams } = require('./router.params');
const { REASONS } = require('./router.tasks');
const { eligibleOf, modelDecision, assertBudgetAllows } = require('./decide');

/**
 * Escalonamento do pequeno para o avançado (M9-D012, regra 5): só UMA vez, só a partir do modelo pequeno, só se a saída não passou
 * na validação de schema ou veio com `confidence` abaixo de `ia.router.confianca_minima`, só se `ia.router.escalonar_para_avancado`
 * está Ligado e só se o orçamento permite o avançado. Devolve a nova decisão (`escalated: true`) ou `null` quando não escala.
 */
async function escalate(decision, outcome, input, ctx, transaction, { registry }) {
  if (!decision || decision.path !== 'SMALL_MODEL' || decision.escalated === true) return null;
  const params = await readRouterParams(ctx, transaction);
  if (!params.escalate) return null;
  const invalid = outcome && outcome.schemaValid === false;
  const lowConfidence = outcome && Number.isFinite(outcome.confidence) && outcome.confidence < params.minConfidence;
  if (!invalid && !lowConfidence) return null;
  try {
    assertBudgetAllows('ADVANCED_MODEL', input.budgetState);
  } catch (err) {
    return null; // sem orçamento para o avançado: o pequeno fica (a saída ruim cai no passo 11)
  }
  const lista = await eligibleOf('ADVANCED_MODEL', input, params, ctx, transaction, registry);
  return lista.length ? modelDecision('ADVANCED_MODEL', REASONS.ESCALATED, lista, { escalated: true }) : null;
}

module.exports = { escalate };
