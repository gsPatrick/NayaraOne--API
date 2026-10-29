'use strict';

/**
 * score = 100 x (soma dos pesos que passam) / (soma dos pesos aplicáveis), 2 casas, arredondamento half-even (M9-D806 §3.2). Conta em inteiros:
 * nenhum erro de ponto flutuante decide o desempate. Sem regra aplicável a nota é 0.
 */
function computeScore(passedWeight, applicableWeight) {
  if (!applicableWeight || applicableWeight < 0) return 0;
  const numerator = 10000 * passedWeight;
  let quotient = Math.floor(numerator / applicableWeight);
  const twice = 2 * (numerator % applicableWeight);
  if (twice > applicableWeight || (twice === applicableWeight && quotient % 2 === 1)) quotient += 1;
  return quotient / 100;
}

/**
 * Aplica as regras ao contexto do cadastro. `rules` = regras ativas da entidade; `checks`/`applies` = verificações por nome. Devolve o que passou, o que
 * falhou, os pesos e a nota. Regra cuja condição (`applies_when`) é falsa sai do denominador.
 */
function scoreEntity(rules, ctx, cfg, { checks, applies }) {
  let passedWeight = 0;
  let applicableWeight = 0;
  const failed = [];
  const passed = [];
  for (const rule of rules) {
    if (rule.applies_when && !applies[rule.applies_when](ctx, cfg)) continue;
    applicableWeight += rule.weight;
    if (checks[rule.expression](ctx, cfg)) { passedWeight += rule.weight; passed.push(rule.code); } else failed.push(rule);
  }
  return { passedWeight, applicableWeight, score: computeScore(passedWeight, applicableWeight), failed, passed };
}

module.exports = { computeScore, scoreEntity };
