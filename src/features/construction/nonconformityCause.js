'use strict';

/**
 * M9-D618 / DI-BI2-8 — causa da não conformidade (dimensão do KPI de recorrência, M9:794). O livro não exige a causa (M6:23, M6:138-140): ela é
 * opcional na abertura e no fechamento. Normalização única: texto aparado, até 64 caracteres, em maiúsculas; vazio vira null.
 */
function normalizeCauseCode(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().slice(0, 64).toUpperCase();
  return text || null;
}

module.exports = { normalizeCauseCode };
