'use strict';

const { isStepActive } = require('../../../core-governance/finops/degradation/state');

const STEP = 'SWITCH_AI_MODEL_CHEAPER';

/**
 * Degradação por custo no roteador (M9-D863 §3.2, passo SWITCH_AI_MODEL_CHEAPER). Com o passo aplicado à empresa, a tarefa classificada como SIMPLES
 * (caminho SMALL_MODEL, criticidade não CRITICAL) troca o modelo escolhido pela alternativa que o catálogo marca como `cheaperAlternative`. A lista normal já
 * vem ordenada por custo; o que a degradação acrescenta é aceitar a alternativa MAIS BARATA E MAIS LENTA que o orçamento de latência da chamada deixou de
 * fora (`loadRelaxed` refaz a busca sem o limite de latência, mantendo política, capacidade e tamanho). Sem alternativa marcada, elegível e de fato mais
 * barata, a decisão não muda. Tarefa avançada nunca é tocada.
 * Devolve a lista (alternativa primeiro, o resto atrás) e se houve troca.
 */
async function preferCheaper(path, lista, ctx, transaction, { critical = false, loadRelaxed } = {}) {
  const same = { lista, switched: false };
  if (path !== 'SMALL_MODEL' || critical || lista.length === 0) return same;
  const [chosen] = lista;
  if (!chosen.cheaperAlternative) return same;
  if (!(await isStepActive(STEP, { groupId: ctx.groupId, companyId: ctx.companyId }, transaction))) return same;
  const pool = typeof loadRelaxed === 'function' ? await loadRelaxed() : lista;
  const alternative = pool.find((c) => c.providerCode === chosen.providerCode && c.model === chosen.cheaperAlternative && c.estimatedCostMicros < chosen.estimatedCostMicros);
  if (!alternative) return same;
  return { lista: [alternative, ...lista.filter((c) => !(c.providerCode === alternative.providerCode && c.model === alternative.model))], switched: true };
}

module.exports = { preferCheaper, STEP };
