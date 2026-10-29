'use strict';

// Asserções compartilhadas dos read models do BI (M9-D607 replay, M9-D608 rebuild): cada demanda de read model só as executa sobre o seu.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

/** Hash estável das colunas de negócio de uma linha (fora instantes de gravação, que mudam a cada passada). */
const IGNORED = ['refreshed_at', 'source_snapshot_at'];
const clean = (row, ignore) => Object.fromEntries(Object.entries(row || {}).filter(([k]) => !ignore.includes(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
const rowHash = (row, ignore = IGNORED) => crypto.createHash('sha256').update(JSON.stringify(clean(row, ignore))).digest('hex');
/** Hash de várias linhas (ordem das linhas pela chave textual para não depender da ordem de leitura). */
const rowsHash = (rows, ignore = IGNORED) => crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => clean(r, ignore)).map((r) => JSON.stringify(r)).sort())).digest('hex');

/** Entrega o MESMO evento duas vezes: a segunda é ignorada e a linha (inclusive refreshed_at) não muda. */
async function assertReplayIdempotent({ applyEvent, readRow }) {
  const first = await applyEvent();
  const before = await readRow();
  const second = await applyEvent();
  const after = await readRow();
  assert.ok(first.upserted >= 1, 'a primeira entrega aplicou');
  assert.equal(second.replayIgnored, first.upserted, 'a segunda entrega é registrada como replay ignorado em cada read model já aplicado');
  assert.equal(second.upserted, 0);
  assert.deepEqual(after, before, 'nada mudou na segunda entrega, nem refreshed_at');
  return { first, before };
}

/** Constrói pelo caminho incremental (eventos), guarda o hash, apaga e reconstrói a partir das fontes: o hash tem de ser igual. */
async function assertRebuildEqualsIncremental({ buildIncremental, readRows, wipe, rebuild }) {
  await buildIncremental();
  const incremental = rowsHash(await readRows());
  await wipe();
  assert.equal((await readRows()).length, 0, 'tabela vazia antes do rebuild');
  await rebuild();
  const rebuilt = rowsHash(await readRows());
  assert.equal(rebuilt, incremental, 'o rebuild reproduz o incremental (hash por empresa)');
  return incremental;
}

module.exports = { rowHash, rowsHash, assertReplayIdempotent, assertRebuildEqualsIncremental };
