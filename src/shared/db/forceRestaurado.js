'use strict';

/**
 * Migration que tira o FORCE ROW LEVEL SECURITY de uma tabela durante a carga e o devolve no fim (padrão das migrations dos Marcos 3 a 6).
 * Com `try { ... } finally { FORCE }`, uma falha no corpo dentro de uma transação deixava a transação abortada e o FORCE do finally falhava
 * com "current transaction is aborted", ESCONDENDO o erro original (verificador independente da integração, 14/11/2026). Aqui:
 *   - deu certo: devolve o FORCE e o resultado;
 *   - falhou: TENTA devolver o FORCE (fora de transação, ou em transação ainda utilizável, ele volta); se a devolução também falhar
 *     (transação abortada — o rollback já desfaz o NO FORCE), o erro que sobe é SEMPRE o original.
 */
async function forceRestaurado(corpo, restaurar) {
  let resultado;
  try {
    resultado = await corpo();
  } catch (erro) {
    try { await restaurar(); } catch (_e) { /* transação abortada: o rollback devolve o FORCE; vale o erro original */ }
    throw erro;
  }
  await restaurar();
  return resultado;
}

module.exports = { forceRestaurado };
