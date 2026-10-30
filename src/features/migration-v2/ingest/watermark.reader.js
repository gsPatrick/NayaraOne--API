'use strict';

const { watermarkToken, parseWatermark, minusSeconds, compareWatermark } = require('./tokens');
const errors = require('./ingest.errors');

/**
 * Posição de partida da leitura por watermark: o checkpoint recuado em `migracao.watermark.sobreposicao_s` (a linha de commit tardio que o checkpoint já passou é relida e o
 * upsert idempotente descarta o que já foi aplicado). Sem checkpoint, lê desde o começo. Ex.: checkpoint 02:00:00 e 120 s => a leitura começa em 01:58:00.
 */
function startCursor(checkpointToken, overlapSeconds) {
  const parsed = checkpointToken ? parseWatermark(checkpointToken) : null;
  return parsed ? `${minusSeconds(parsed.ts, overlapSeconds)}|` : null;
}

/** Lê o próximo lote depois do cursor `ts|chave`: a consulta `(updated_at, chave) > (ts, chave) ORDER BY updated_at, chave LIMIT lote`. */
async function plan(connector, { cursor, limit }) {
  const from = cursor ? parseWatermark(cursor) : null;
  const rows = await connector.readRows({ afterTs: from ? from.ts : null, afterKey: from ? from.key : '', limit });
  if (!rows.length) return null;
  const events = rows.map((row) => ({ sourceKey: row.sourceKey, op: 'U', position: watermarkToken(row.updatedAt, row.sourceKey), record: row.record }));
  for (let i = 1; i < events.length; i += 1) if (compareWatermark(events[i - 1].position, events[i].position) >= 0) throw errors.eventsOutOfOrder();
  return { fromToken: cursor || null, toToken: events[events.length - 1].position, events };
}

/** Linhas de um intervalo já delimitado (replay): `(from, to]`. */
async function readRange(connector, { fromToken, toToken }) {
  const to = parseWatermark(toToken);
  const out = [];
  let cursor = fromToken || null;
  for (;;) {
    const from = cursor ? parseWatermark(cursor) : null;
    const rows = await connector.readRows({ afterTs: from ? from.ts : null, afterKey: from ? from.key : '', upTo: to, limit: 5000 });
    const events = rows.map((row) => ({ sourceKey: row.sourceKey, op: 'U', position: watermarkToken(row.updatedAt, row.sourceKey), record: row.record }));
    out.push(...events);
    if (rows.length < 5000) return out;
    cursor = events[events.length - 1].position;
  }
}

module.exports = { startCursor, plan, readRange };
