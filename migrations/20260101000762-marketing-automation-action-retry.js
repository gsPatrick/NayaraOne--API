'use strict';

/**
 * Marco 9, automações (DI-M9F-1) — a ação SEND_MESSAGE com falha transitória do canal não vira OK com a mensagem presa na fila.
 *
 * O resultado por ação da run (marketing.automation_runs.actions_result, conferido pela função marketing.actions_result_valid da parte 2) passa a aceitar
 * o estado RETRY: falha transitória (429, 5xx, cofre fora por um instante); a ação volta em `due_at`, com backoff e limite de `integration.retry.*` (M9-D216),
 * e a run fica WAITING até lá (o executor das ações adiadas a retoma com o canSend na hora). O UNKNOWN já existia; com `due_at` ele é reconciliado pela
 * chave de idempotência antes de qualquer reenvio (`integration.unknown.*`, M9-D215).
 * Só a função muda (CREATE OR REPLACE): a lista de estados aceitos cresce, então toda linha existente continua válida. O down recusa se alguma run tiver
 * ação em RETRY (não apaga nem reescreve dados) e volta a lista anterior.
 */

const fn = (statuses) => `CREATE OR REPLACE FUNCTION marketing.actions_result_valid(j jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT jsonb_typeof(j) = 'array' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(j) AS t(e)
         WHERE jsonb_typeof(e) <> 'object'
            OR length(btrim(COALESCE(e->>'action_key', ''))) = 0
            OR COALESCE(e->>'status', '') NOT IN (${statuses.map((s) => `'${s}'`).join(',')}))
    $fn$`;

const BEFORE = ['PENDING', 'SCHEDULED', 'OK', 'SKIPPED', 'FAILED', 'UNKNOWN'];
const AFTER = [...BEFORE, 'RETRY'];

module.exports = {
  STATUSES: AFTER,

  async up(queryInterface) {
    await queryInterface.sequelize.query(fn(AFTER));
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query(
        `SELECT count(*)::int AS n FROM marketing.automation_runs r WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(r.actions_result) e WHERE e->>'status' = 'RETRY')`, { transaction });
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} run(s) de automação com ação em RETRY; o down não apaga nem reescreve dados.`);
      await sequelize.query(fn(BEFORE), { transaction });
    });
  },
};
