'use strict';

const { canonicalLine } = require('../integrity/canonical');
const { leafHash, merkleRoot } = require('../integrity/merkle');
const { RECORD } = require('./ingest.constants');

/** O registro está (ou deveria estar) no destino? Só esses entram na árvore: quarentena, revisão, excluídos e exclusões lógicas não têm linha a conferir. */
const inDestination = (record) => [RECORD.MIGRATED, RECORD.RECONCILED].includes(record.state) && !record.source_deleted && Boolean(record.target_entity_id);

/**
 * Raiz do lote (M9-D905, no lugar do resumo simples da M9-D900): árvore Merkle SHA-256 sobre a linha canônica do que foi LIDO na origem (`source_payload`), na ordem do esquema
 * da entidade, com as folhas ordenadas pela chave de origem. Depende só do estado final das chaves, então reaplicar o mesmo intervalo dá a mesma raiz.
 * Devolve { root, empty, count, leaves: [{ key, hash }] } (hash em hexadecimal).
 */
function batchRoot(schema, target, records) {
  const leaves = records.filter(inDestination).map((record) => ({ key: record.source_key, hash: leafHash(canonicalLine(schema, target.canonical(record.source_payload || {}))) }));
  const result = merkleRoot(leaves);
  return { ...result, leaves: leaves.map((leaf) => ({ key: leaf.key, hash: leaf.hash.toString('hex') })) };
}

module.exports = { batchRoot, inDestination };
