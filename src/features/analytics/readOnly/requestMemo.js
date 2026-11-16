'use strict';

/**
 * Memória das leituras repetidas DENTRO de um GET de BI (correção de 16/11/2026: o estado de qualidade da empresa era relido dezenas de vezes
 * por GET do Centro de Comando). Só vale na transação READ ONLY de um GET de /analytics (marcada por applyReadOnly): ali nada é gravado. Fora
 * dela (worker, escrita, outro módulo), `memoInReadOnly` só chama `load` — nada muda. A memória vive enquanto a transação existir (WeakMap).
 *
 * A chave SEMPRE inclui a empresa e o grupo da sessão do banco (app.company_id, app.group_id), lidos na própria transação a cada chamada: a
 * consolidação do grupo troca de empresa dentro da mesma transação (consolidation/companyAccess.js), e um resultado lido sob uma empresa nunca
 * pode ser devolvido sob outra (RLS).
 */
const FLAG = Symbol.for('nayara.analytics.readOnlyTransaction');
const MEMO = new WeakMap();

function markReadOnly(transaction) {
  if (transaction) transaction[FLAG] = true;
}

const isReadOnly = (transaction) => Boolean(transaction && transaction[FLAG] === true);

/** Resultado de `load()` guardado por `key` + empresa/grupo da sessão, na transação READ ONLY; erro não fica guardado. */
async function memoInReadOnly(transaction, key, load) {
  if (!isReadOnly(transaction)) return load();
  const { sequelize } = require('../../../config/database');
  const [[sessao]] = await sequelize.query(
    "SELECT current_setting('app.company_id', true) AS c, current_setting('app.group_id', true) AS g", { transaction }
  );
  const chave = `${key}|empresa=${sessao.c || ''}|grupo=${sessao.g || ''}`;
  let memo = MEMO.get(transaction);
  if (!memo) { memo = new Map(); MEMO.set(transaction, memo); }
  if (!memo.has(chave)) {
    memo.set(chave, Promise.resolve().then(load).catch((err) => { memo.delete(chave); throw err; }));
  }
  return memo.get(chave);
}

module.exports = { markReadOnly, isReadOnly, memoInReadOnly };
