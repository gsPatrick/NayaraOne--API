'use strict';

/**
 * Concorrência determinística entre duas transações COMMITADAS (pedido da esteira de qualidade do M6: o teste dependia de um
 * atraso de 200 ms). A ordem é garantida por sincronização explícita, sem tempo fixo:
 *   1. a transação A executa `primeira` (que trava a linha disputada) e avisa que está com a trava;
 *   2. só então a transação B começa `segunda`;
 *   3. A só faz commit quando o PostgreSQL mostra a sessão de B BLOQUEADA pela de A (pg_blocking_pids);
 *   4. B continua depois do commit de A e enxerga o que A gravou.
 * Devolve o Promise.allSettled das duas. Se B não ficar bloqueada (a trava não existe), A faz commit mesmo assim depois do
 * prazo de segurança, e o teste que chama mostra o efeito (é exatamente o defeito que ele procura).
 */
async function emOrdemComTrava(sequelize, comCommit, primeira, segunda, { prazoMs = 30000 } = {}) {
  let avisarTrava;
  const aTemATrava = new Promise((r) => { avisarTrava = r; });
  let liberarCommit;
  const podeCommitar = new Promise((r) => { liberarCommit = r; });
  let avisarPid;
  const pidDeB = new Promise((r) => { avisarPid = r; });

  const a = comCommit(async (t) => {
    const r = await primeira(t);
    const [[{ pid }]] = await sequelize.query('SELECT pg_backend_pid() AS pid', { transaction: t });
    avisarTrava(pid);
    await podeCommitar;
    return r;
  });
  const b = (async () => {
    await aTemATrava;
    return comCommit(async (t) => {
      const [[{ pid }]] = await sequelize.query('SELECT pg_backend_pid() AS pid', { transaction: t });
      avisarPid(pid);
      return segunda(t);
    });
  })();

  const pidA = await aTemATrava;
  const pidB = await pidDeB;
  const limite = Date.now() + prazoMs;
  // Espera pelo ESTADO do banco (B bloqueada por A), não por um tempo fixo.
  for (;;) {
    const [[{ bloqueada }]] = await sequelize.query('SELECT :a = ANY(pg_blocking_pids(:b)) AS bloqueada', { replacements: { a: pidA, b: pidB } });
    if (bloqueada || Date.now() > limite) break;
    await new Promise((r) => setImmediate(r));
  }
  liberarCommit();
  return Promise.allSettled([a, b]);
}

module.exports = { emOrdemComTrava };
