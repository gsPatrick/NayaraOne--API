'use strict';

/** Grava, na empresa, os casos do golden dataset do agente (M9-D033) a partir da lista de casos da definição. Repetir cria a versão seguinte do caso. */
async function installGoldenCases(ctx, code, cases, transaction) {
  const { golden } = require('../../evaluations'); // adiado: as avaliações dependem dos agentes
  const saved = [];
  for (const c of cases) saved.push(await golden.saveCase(ctx, code, c, transaction));
  return saved;
}

module.exports = { installGoldenCases };
