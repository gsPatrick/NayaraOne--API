'use strict';

const { sha256 } = require('./row.canonical');

/**
 * Resumo do lote (M9-D900 §3.5): SHA-256 das linhas `chave|hash-da-linha|excluída` das chaves do lote, em ordem de chave. Depende só do estado final das chaves,
 * então reaplicar o mesmo intervalo dá o mesmo resumo. A árvore Merkle e a verificação contra a origem são da M9-D905.
 */
function batchDigest(records) {
  const lines = [...records].sort((a, b) => (a.source_key < b.source_key ? -1 : (a.source_key > b.source_key ? 1 : 0)))
    .map((record) => `${record.source_key}|${record.row_hash || ''}|${record.source_deleted ? 1 : 0}`);
  return sha256(lines.join('\n'));
}

module.exports = { batchDigest };
