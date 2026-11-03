'use strict';

/**
 * Migration: Marco 8 — fechamentos da auditoria independente de 25/10/2026.
 *
 * 1) commission_entitlements.confirmed_at / received_at: a competência fiscal da comissão (DIMOB,
 *    exportação) é a data em que ela foi confirmada/recebida, não a de criação.
 * 2) Unicidade das linhas ORIGINAIS de exportação contábil por origem (empresa + tipo + id): duas
 *    exportações simultâneas não exportam a mesma origem duas vezes (ajustes não entram na regra).
 * 3) Tabelas append-only perdem UPDATE/DELETE para o papel de runtime (a imutabilidade deixa de
 *    depender só do código): linhas exportadas, registros do DIMOB e eventos de NFS-e.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;
    await queryInterface.addColumn({ tableName: 'commission_entitlements', schema: 'correspondent' }, 'confirmed_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn({ tableName: 'commission_entitlements', schema: 'correspondent' }, 'received_at', { type: Sequelize.DATE, allowNull: true });
    await sequelize.query(`UPDATE "correspondent"."commission_entitlements"
      SET confirmed_at = updated_at WHERE status IN ('RECEIVABLE','RECEIVED') AND confirmed_at IS NULL;`);
    await sequelize.query(`UPDATE "correspondent"."commission_entitlements"
      SET received_at = updated_at WHERE status = 'RECEIVED' AND received_at IS NULL;`);

    await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounting_export_lines_original_source_unique
      ON "correspondent"."accounting_export_lines" (company_id, source_type, source_id)
      WHERE adjustment_of_line_id IS NULL;`);

    const [[{ exists: runtimeExists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      for (const table of ['accounting_export_lines', 'dimob_records', 'invoice_events']) {
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(`REVOKE UPDATE, DELETE ON "correspondent"."${table}" FROM nayara_runtime;`);
      }
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const [[{ exists: runtimeExists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      for (const table of ['accounting_export_lines', 'dimob_records', 'invoice_events']) {
        // eslint-disable-next-line no-await-in-loop
        await sequelize.query(`GRANT UPDATE, DELETE ON "correspondent"."${table}" TO nayara_runtime;`);
      }
    }
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."accounting_export_lines_original_source_unique";');
    await queryInterface.removeColumn({ tableName: 'commission_entitlements', schema: 'correspondent' }, 'received_at');
    await queryInterface.removeColumn({ tableName: 'commission_entitlements', schema: 'correspondent' }, 'confirmed_at');
  },
};
