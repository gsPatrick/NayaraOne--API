'use strict';

/**
 * Regra 4 — "Não mudar fórmula sem versionar". Cada versão publicada guarda o SHA-256 do arquivo da fórmula
 * (`metric_versions.formula_code_hash`). Reprova versão sem hash, versão cuja fórmula sumiu do código e versão cujo hash difere do
 * arquivo atual: o código mudou sem nova versão publicada. `rows`: [{ metricCode, version, formulaId, formulaCodeHash }].
 */
const { violation } = require('./files');

function checkRule4(rows, catalog) {
  const out = [];
  for (const r of rows) {
    const where = `${r.metricCode} v${r.version}`;
    if (!catalog.has(r.formulaId)) out.push(violation(4, where, `A fórmula ${r.formulaId} da versão publicada não existe mais no código (a versão histórica precisa continuar reproduzível).`));
    else if (!r.formulaCodeHash) out.push(violation(4, where, 'Versão publicada sem formula_code_hash: não dá para provar que a fórmula não mudou.'));
    else if (r.formulaCodeHash !== catalog.codeHash(r.formulaId)) {
      out.push(violation(4, where, `Fórmula alterada sem nova versão: publique a v${r.version + 1} (fórmula ${r.formulaId}).`));
    }
  }
  return { scanned: rows.length, violations: out };
}

module.exports = { checkRule4 };
