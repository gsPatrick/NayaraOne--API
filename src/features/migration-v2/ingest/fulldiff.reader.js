'use strict';

const { mapRow, rowHash } = require('./row.canonical');

/**
 * Leitor do modo FULL_DIFF (M9-D900 §3.3): fonte sem coluna de controle confiável. Lê a exportação completa em ordem de chave; a "posição" de cada linha é o hash dela,
 * então a linha igual à já aplicada é descartada pela chave de idempotência e só a que mudou (ou é nova) é aplicada.
 */
async function plan(connector, source, { cursor, limit }) {
  const rows = await connector.readAllRows({ afterKey: cursor || '', limit });
  if (!rows.length) return null;
  const events = rows.map((row) => ({ sourceKey: row.sourceKey, op: 'U', position: rowHash(mapRow(row.record, source.config && source.config.columnMap)), record: row.record }));
  return { fromToken: cursor || null, toToken: events[events.length - 1].sourceKey, events };
}

async function readRange(connector, source, { fromToken, toToken }) {
  const out = [];
  let cursor = fromToken || '';
  for (;;) {
    const rows = await connector.readAllRows({ afterKey: cursor, upToKey: toToken, limit: 5000 });
    out.push(...rows.map((row) => ({ sourceKey: row.sourceKey, op: 'U', position: rowHash(mapRow(row.record, source.config && source.config.columnMap)), record: row.record })));
    if (rows.length < 5000) return out;
    cursor = rows[rows.length - 1].sourceKey;
  }
}

module.exports = { plan, readRange };
