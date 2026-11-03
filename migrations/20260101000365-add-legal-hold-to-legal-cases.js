'use strict';

/**
 * Gap real (auditoria Nayara, PDF "Conferência complementar Marcos 4 e 5", 14/10/2026,
 * Seção 4, grupo "Dossiê/cadeia de custódia/legal hold §16/JUR-010/011"): não existia nenhum
 * mecanismo de "legal hold" — a capacidade de travar um processo jurídico (e, por extensão,
 * seus dossiês de evidência) contra alteração de status/fase enquanto uma retenção legal está
 * ativa. EvidencePackage já era append-only por design; faltava o equivalente no próprio
 * LegalCase, que É mutável (status/fase mudam normalmente ao longo do processo).
 *
 * `legal_hold` (boolean, default false) + `legal_hold_reason` (motivo obrigatório quando
 * ativado) + `legal_hold_set_by`/`legal_hold_set_at` (quem/quando ativou, trilha própria além
 * do audit log genérico, já que isso é consultado com frequência na tela do processo).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'legal_cases', schema: 'legal' },
      'legal_hold',
      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    );
    await queryInterface.addColumn(
      { tableName: 'legal_cases', schema: 'legal' },
      'legal_hold_reason',
      { type: Sequelize.TEXT, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'legal_cases', schema: 'legal' },
      'legal_hold_set_by',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'legal_cases', schema: 'legal' },
      'legal_hold_set_at',
      { type: Sequelize.DATE, allowNull: true }
    );

    // Guard de existência do role: em banco recém-criado (CI descartável) nayara_runtime não
    // existe — o grant é pulado; o runtime do CI (nayara_ci_app) recebe grants no workflow.
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query(
        'GRANT SELECT, INSERT, UPDATE ON "legal"."legal_cases" TO nayara_runtime;'
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'legal_cases', schema: 'legal' }, 'legal_hold');
    await queryInterface.removeColumn({ tableName: 'legal_cases', schema: 'legal' }, 'legal_hold_reason');
    await queryInterface.removeColumn({ tableName: 'legal_cases', schema: 'legal' }, 'legal_hold_set_by');
    await queryInterface.removeColumn({ tableName: 'legal_cases', schema: 'legal' }, 'legal_hold_set_at');
  },
};
