'use strict';

const { sequelize } = require('../../../../models');

/** Janelas do limite local (M9-D218 3.1 item 1), em segundos. */
const WINDOWS = Object.freeze([['per_second', 1], ['per_minute', 60], ['per_day', 86400]]);

/**
 * acquireLocalToken — limitador local por connection (M9-D218 3.2): janela deslizante sobre as tentativas já abertas
 * (`dispatch_attempts`), exato entre instâncias porque a conferência e a abertura da tentativa acontecem sob o mesmo lock da
 * connection, na mesma transação. Devolve { granted:true } ou { granted:false, until } com o instante do próximo "token" (quando a
 * mais antiga das tentativas que ocupam a janela sai dela). Não grava nada: quem abre a tentativa é o worker, depois do OK.
 */
async function acquireLocalToken(connectionId, rateLimit, now, transaction) {
  const limites = WINDOWS.filter(([chave]) => Number.isInteger(rateLimit && rateLimit[chave]));
  if (limites.length === 0) return { granted: true };
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:chave))', { replacements: { chave: `dispatch-rate:${connectionId}` }, transaction });
  let espera = null;
  for (const [chave, segundos] of limites) {
    const limite = rateLimit[chave];
    const desde = new Date(now.getTime() - segundos * 1000);
    const [rows] = await sequelize.query(
      `SELECT started_at FROM "integration"."dispatch_attempts" WHERE connection_id = :id AND started_at > :desde ORDER BY started_at DESC LIMIT :n`,
      { replacements: { id: connectionId, desde, n: limite }, transaction },
    );
    if (rows.length >= limite) {
      const libera = new Date(new Date(rows[rows.length - 1].started_at).getTime() + segundos * 1000);
      if (!espera || libera > espera) espera = libera;
    }
  }
  return espera ? { granted: false, until: espera } : { granted: true };
}

module.exports = { acquireLocalToken, WINDOWS };
