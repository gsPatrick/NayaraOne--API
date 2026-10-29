'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/**
 * Contador compartilhado entre processos (M9-D843 §3.1, R29): tabela governance.rate_limit_counters (UNLOGGED), chave (scope_key, window_start), janela fixa de 60 s pelo relógio
 * do BANCO (date_trunc('minute', now())), incremento atômico por INSERT ... ON CONFLICT DO UPDATE ... RETURNING. Transação própria e confirmada: a contagem nunca se desfaz.
 */
async function hit(scopeKey) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.rate_limit', 'on', true)", { transaction });
    const rows = await sequelize.query(
      `INSERT INTO governance.rate_limit_counters AS c (scope_key, window_start, count) VALUES (:key, date_trunc('minute', now()), 1)
       ON CONFLICT (scope_key, window_start) DO UPDATE SET count = c.count + 1
       RETURNING count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (date_trunc('minute', now()) + interval '1 minute' - now()))))::int AS "retryAfter",
                 EXTRACT(EPOCH FROM (date_trunc('minute', now()) + interval '1 minute'))::bigint AS "resetAt"`,
      { type: QueryTypes.SELECT, transaction, replacements: { key: scopeKey } }
    );
    return { count: rows[0].count, retryAfter: rows[0].retryAfter, resetAt: Number(rows[0].resetAt) };
  });
}

/** Apaga as janelas com mais de 10 minutos (rateLimitCleanupJob). Devolve quantas apagou. */
async function cleanupWindows() {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.rate_limit', 'on', true)", { transaction });
    const [, meta] = await sequelize.query("DELETE FROM governance.rate_limit_counters WHERE window_start < now() - interval '10 minutes'", { transaction });
    return meta && meta.rowCount ? meta.rowCount : 0;
  });
}

module.exports = { hit, cleanupWindows };
