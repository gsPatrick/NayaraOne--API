'use strict';

const { isCdcToken, compareCdc } = require('./tokens');
const errors = require('./ingest.errors');

/**
 * Leitor do modo CDC (M9-D900 §3.2): lê o log de mudanças depois da posição `cursor` e devolve o lote planejado (intervalo `(from, to]`). Posição que não cresce
 * (ou que não é token numérico) é 409 GOV_MIG_POSITION_GAP. Devolve null quando não há evento novo.
 */
async function plan(connector, { cursor, limit }) {
  const events = await connector.readEvents({ after: cursor || '0', limit });
  if (!events.length) return null;
  let previous = cursor || '0';
  for (const event of events) {
    if (!isCdcToken(event.position) || compareCdc(event.position, previous) <= 0) throw errors.eventsOutOfOrder();
    previous = event.position;
  }
  return { fromToken: cursor || null, toToken: previous, events };
}

/** Eventos de um intervalo já delimitado (replay): `(from, to]`. */
async function readRange(connector, { fromToken, toToken }) {
  const out = [];
  let cursor = fromToken || '0';
  for (;;) {
    const page = await connector.readEvents({ after: cursor, upTo: toToken, limit: 5000 });
    out.push(...page.filter((event) => compareCdc(event.position, toToken) <= 0));
    if (page.length < 5000) return out;
    cursor = page[page.length - 1].position;
  }
}

module.exports = { plan, readRange };
