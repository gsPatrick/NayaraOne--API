'use strict';

const { latestDrillReports } = require('../contingency/drill/drill.archive');
const { currentAdapterHash } = require('../contract/contract.version');

/**
 * Evidência 3 (M9-D256 3.1): ensaio de falha do fornecedor em laboratório com resultado verde em cada cenário exigido (derrubar, 429, 401, timeout e recuperação),
 * arquivado e do adapter atual (relatório de adapter alterado não vale; não há prazo próprio). Devolve null ou { code, message, detail: [cenário: motivo] }.
 */
function drillProblem(providerCode, scenarios) {
  const hash = currentAdapterHash(providerCode);
  const relatorios = latestDrillReports(providerCode);
  const motivos = [];
  const classes = new Set();
  for (const cenario of scenarios) {
    const r = relatorios.get(cenario);
    if (!r) { motivos.push(`${cenario}: ensaio não arquivado`); classes.add('MISSING'); continue; }
    if (!r.adapterHash || r.adapterHash !== hash) { motivos.push(`${cenario}: relatório de outra versão do adapter`); classes.add('OUTDATED'); continue; }
    if (r.passed !== true) { motivos.push(`${cenario}: ensaio reprovado`); classes.add('FAILED'); }
  }
  if (!motivos.length) return null;
  const classe = ['OUTDATED', 'FAILED', 'MISSING'].find((c) => classes.has(c));
  return { code: `INTEGRATION_RELEASE_DRILL_${classe}`, message: 'Falta o ensaio de falha aprovado deste fornecedor, do adapter atual.', detail: motivos };
}

module.exports = { drillProblem };
