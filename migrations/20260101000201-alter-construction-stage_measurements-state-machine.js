'use strict';

/**
 * Migration: evolui "construction"."stage_measurements" do fluxo binário
 * PENDING_APPROVAL -> APPROVED/REJECTED para a máquina de estados completa exigida pelo
 * Marco 6 (M6-10/M6-21): DRAFT -> SUBMITTED -> REVIEWED -> APPROVED -> PAYABLE, com REJECTED e
 * SUPERSEDED como estados terminais alternativos.
 *
 * DECISÃO DE ENGENHARIA: mantém a coluna `status` como STRING(32) livre (sem CHECK constraint
 * de banco) — mesmo padrão já usado nas demais máquinas de estado do módulo (construction.projects,
 * project_stages) — a validação de transição vive no service (stageMeasurements.service.js).
 *
 * Novas colunas:
 *  - submitted_at/reviewed_at/approved_at: timestamps de cada transição (decided_at, já
 *    existente, passa a ser preenchido só na decisão final REJECTED — aprovação usa approved_at).
 *  - reviewed_by_user_id/review_notes: quem revisou e observação da revisão (REVIEWED).
 *  - total_amount: valor total da medição (soma dos measurement_items) — é o valor usado para
 *    gerar a obrigação financeira ao aprovar (M6-55/M6-68).
 *  - payable_financial_entry_id: aponta para o lançamento (finance.financial_entries) gerado
 *    ao aprovar — nulo até a medição virar PAYABLE. Não é a chave de idempotência (essa é o
 *    `idempotency_key` do lançamento, derivado do id da medição) — é só referência de leitura.
 *  - parent_measurement_id/revision_number: cadeia de revisão (M6-10 — "alteração após
 *    SUBMITTED cria uma revisão nova, nunca sobrescreve"). Uma medição SUPERSEDED aponta, via
 *    seu sucessor, para a revisão vigente.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'submitted_at',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'reviewed_at',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'reviewed_by_user_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'review_notes',
      { type: Sequelize.TEXT, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'approved_at',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'total_amount',
      { type: Sequelize.DECIMAL(18, 2), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'payable_financial_entry_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'parent_measurement_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'stage_measurements', schema: 'construction' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'revision_number',
      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 }
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE "construction"."stage_measurements" ALTER COLUMN status SET DEFAULT 'DRAFT';`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "construction"."stage_measurements" ALTER COLUMN status SET DEFAULT 'PENDING_APPROVAL';`
    );
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'revision_number');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'parent_measurement_id');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'payable_financial_entry_id');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'total_amount');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'approved_at');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'review_notes');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'reviewed_by_user_id');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'reviewed_at');
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'submitted_at');
  },
};
