'use strict';

/**
 * audit.audit_log append-only (MAPA_SEGURANCA.md §8).
 * - REVOKE UPDATE, DELETE, TRUNCATE da role de runtime (guarda de existência do role).
 * - Triggers BEFORE UPDATE OR DELETE (row) e BEFORE TRUNCATE (statement) que lançam exceção,
 *   valendo inclusive para owner/superuser (só um DROP TRIGGER deliberado reabre a tabela).
 * Nenhum código da aplicação faz UPDATE/DELETE em audit.audit_log (só INSERT via audit.service).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE OR REPLACE FUNCTION audit.audit_log_block_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit.audit_log é append-only: % não permitido', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$;
    `);
    await q('DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit.audit_log;');
    await q(`CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit.audit_log
             FOR EACH ROW EXECUTE FUNCTION audit.audit_log_block_mutation();`);
    await q('DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit.audit_log;');
    await q(`CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log
             FOR EACH STATEMENT EXECUTE FUNCTION audit.audit_log_block_mutation();`);

    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await q('REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_log FROM nayara_runtime;');
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit.audit_log;');
    await q('DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit.audit_log;');
    await q('DROP FUNCTION IF EXISTS audit.audit_log_block_mutation();');
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      // Estado anterior: UPDATE e DELETE concedidos; TRUNCATE não.
      await q('GRANT UPDATE, DELETE ON audit.audit_log TO nayara_runtime;');
    }
  },
};
