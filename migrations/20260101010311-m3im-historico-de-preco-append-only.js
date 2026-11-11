'use strict';

/**
 * Marco 3, M3-08 (verificação independente de 11/11/2026): o histórico de preço é append-only também no banco. Antes, só o
 * serviço deixava de alterar: o papel de runtime fazia UPDATE e DELETE em real_estate.property_price_history. Mesmo padrão do
 * audit.audit_log (migration 20260101000490):
 *  - gatilhos BEFORE UPDATE OR DELETE (linha) e BEFORE TRUNCATE (comando) que recusam a alteração, para qualquer papel
 *    (só um DROP TRIGGER deliberado reabre a tabela; limpeza de banco descartável usa session_replication_role=replica);
 *  - REVOKE UPDATE, DELETE, TRUNCATE do papel de runtime (com guarda de existência do papel), reaplicado por
 *    scripts/aplicarPermissoesRuntime.js e pelo cluster descartável.
 * Nenhum dado muda. Desfazer: remove os gatilhos e a função e devolve UPDATE e DELETE ao runtime (estado anterior).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE OR REPLACE FUNCTION real_estate.property_price_history_block_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'PROPERTY_PRICE_HISTORY_APPEND_ONLY: real_estate.property_price_history é append-only (% não permitido)', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$`);
    await q('DROP TRIGGER IF EXISTS property_price_history_no_update_delete ON real_estate.property_price_history');
    await q(`CREATE TRIGGER property_price_history_no_update_delete BEFORE UPDATE OR DELETE ON real_estate.property_price_history
             FOR EACH ROW EXECUTE FUNCTION real_estate.property_price_history_block_mutation()`);
    await q('DROP TRIGGER IF EXISTS property_price_history_no_truncate ON real_estate.property_price_history');
    await q(`CREATE TRIGGER property_price_history_no_truncate BEFORE TRUNCATE ON real_estate.property_price_history
             FOR EACH STATEMENT EXECUTE FUNCTION real_estate.property_price_history_block_mutation()`);
    await q(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON real_estate.property_price_history FROM nayara_runtime;
      END IF;
    END $$`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TRIGGER IF EXISTS property_price_history_no_truncate ON real_estate.property_price_history');
    await q('DROP TRIGGER IF EXISTS property_price_history_no_update_delete ON real_estate.property_price_history');
    await q('DROP FUNCTION IF EXISTS real_estate.property_price_history_block_mutation()');
    await q(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT UPDATE, DELETE ON real_estate.property_price_history TO nayara_runtime;
      END IF;
    END $$`);
  },
};
