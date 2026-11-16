'use strict';

/**
 * Memória das leituras repetidas DENTRO de um GET de BI (correção de 16/11/2026). Um GET do Centro de Comando fazia ~720 consultas, ~450 delas
 * repetidas (a mesma definição de métrica, o mesmo estado de qualidade da empresa...). Só vale na transação READ ONLY de um GET de /analytics
 * (marcada por applyReadOnly): ali nada é gravado, e a requisição inteira enxerga o mesmo retrato. Fora dela (worker, escrita, outro módulo),
 * `memoInReadOnly` só chama `load` — nada muda. A memória vive enquanto a transação existir (WeakMap) e some com ela.
 */
const FLAG = Symbol.for('nayara.analytics.readOnlyTransaction');
const MEMO = new WeakMap();

function markReadOnly(transaction) {
  if (transaction) transaction[FLAG] = true;
}

const isReadOnly = (transaction) => Boolean(transaction && transaction[FLAG] === true);

/** Resultado de `load()` guardado por `key` na transação READ ONLY; erro não fica guardado (a próxima chamada tenta de novo). */
function memoInReadOnly(transaction, key, load) {
  if (!isReadOnly(transaction)) return load();
  let memo = MEMO.get(transaction);
  if (!memo) { memo = new Map(); MEMO.set(transaction, memo); }
  if (!memo.has(key)) {
    memo.set(key, Promise.resolve().then(load).catch((err) => { memo.delete(key); throw err; }));
  }
  return memo.get(key);
}

module.exports = { markReadOnly, isReadOnly, memoInReadOnly };
