'use strict';

const errors = require('./canary.errors');

/**
 * Qual é a etapa pedida (M9-D904 §3.2/§6). Sem `percent`, a próxima etapa depois da atual. Com `percent`: a atual (200 sem efeito), ou a próxima. Qualquer outra (pular etapa,
 * voltar sem rollback, valor fora da lista, tipo errado, já no último degrau sem `percent`) é 422 GOV_CANARY_STEP_INVALID.
 */
function pickTarget(stages, current, requested) {
  const next = stages.find((stage) => stage > current);
  const detail = { current, stages, next: next === undefined ? null : next };
  if (requested === undefined || requested === null || requested === '') {
    if (next === undefined) throw errors.stepInvalid(detail);
    return { target: next, unchanged: false };
  }
  if (!Number.isInteger(requested)) throw errors.stepInvalid({ ...detail, requested });
  if (requested === current && stages.includes(requested)) return { target: current, unchanged: true };
  if (requested !== next) throw errors.stepInvalid({ ...detail, requested });
  return { target: next, unchanged: false };
}

module.exports = { pickTarget };
