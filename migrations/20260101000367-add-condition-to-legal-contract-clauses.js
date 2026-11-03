'use strict';

/**
 * F01 (conferência Nayara, 18/10/2026 — Caderno, Jurídico §6: "Cláusula condicional usa regras
 * declarativas, não texto livre executável"). A condição fica NA VERSÃO da cláusula (a
 * biblioteca já é append-only por versão): mudar a condição = nova versão, e contratos já
 * emitidos continuam apontando para a versão antiga com o texto/hash gravados.
 *
 * condition_json      — regra estruturada { match, rules[] } validada em clauseConditions.js.
 * condition_status    — PENDING_APPROVAL | APPROVED (null quando a cláusula não tem condição).
 * condition_approved_by/at — quem aprovou a regra (segregação: não pode ser quem criou a versão).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = { tableName: 'contract_clauses', schema: 'legal' };
    await queryInterface.addColumn(table, 'condition_json', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn(table, 'condition_status', { type: Sequelize.STRING(32), allowNull: true });
    await queryInterface.addColumn(table, 'condition_approved_by', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn(table, 'condition_approved_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.sequelize.query(`
      ALTER TABLE "legal"."contract_clauses"
        ADD CONSTRAINT contract_clauses_condition_status_chk
        CHECK (condition_status IS NULL OR condition_status IN ('PENDING_APPROVAL', 'APPROVED'));
    `);

    // Guarda de existência do role: em banco recém-criado (CI descartável) nayara_runtime não
    // existe — o grant é pulado; o runtime do CI recebe grants no workflow.
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query('GRANT SELECT, INSERT, UPDATE ON "legal"."contract_clauses" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const table = { tableName: 'contract_clauses', schema: 'legal' };
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_clauses" DROP CONSTRAINT IF EXISTS contract_clauses_condition_status_chk;');
    await queryInterface.removeColumn(table, 'condition_approved_at');
    await queryInterface.removeColumn(table, 'condition_approved_by');
    await queryInterface.removeColumn(table, 'condition_status');
    await queryInterface.removeColumn(table, 'condition_json');
  },
};
