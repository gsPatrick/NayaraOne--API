'use strict';

/**
 * M9-D698 (3.4) — proteção do OLTP no refresh dos read models. Todo refresh que lê a fonte roda com `statement_timeout`
 * (`analytics.refresh.timeout_ms`, padrão 30.000) e `lock_timeout` (`analytics.refresh.lock_timeout_ms`, padrão 2.000 = o '2s' do livro) locais
 * à transação: o refresh nunca espera nem segura uma trava que atrase uma transação de usuário, e uma leitura lenta é cancelada. Os valores
 * anteriores voltam ao fim; se o passo falhou, a própria reversão do savepoint já os devolveu.
 */
const { sequelize } = require('../../../models');

async function setLocal(transaction, statementMs, lockMs) {
  await sequelize.query("SELECT set_config('statement_timeout', :s, true), set_config('lock_timeout', :l, true)", { replacements: { s: String(statementMs), l: String(lockMs) }, transaction });
}

/** Roda `fn` com os limites do refresh. `params` = readRefreshParams (timeoutMs e lockTimeoutMs). */
async function withOltpGuards(transaction, params, fn) {
  const [[prev]] = await sequelize.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock", { transaction });
  await setLocal(transaction, params.timeoutMs, params.lockTimeoutMs);
  try {
    return await fn();
  } finally {
    try {
      await setLocal(transaction, prev.statement, prev.lock);
    } catch (_err) {
      // transação (ou savepoint) abortada pelo erro do passo: o rollback do savepoint já desfez o SET LOCAL
    }
  }
}

module.exports = { withOltpGuards };
