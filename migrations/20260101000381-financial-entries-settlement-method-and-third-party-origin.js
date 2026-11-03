'use strict';

/**
 * F03 + F04 (conferência Nayara 18/10/2026).
 *
 * F03 — Baixa direta versus confirmação bancária (Caderno Financeiro §8: "integração bancária
 * retorna estado; sistema nunca presume sucesso; confirmação efetiva cria ledger"). Um PAYABLE
 * com conta bancária passa a registrar COMO foi liquidado:
 *   - BANK_CONFIRMED: confirmação efetiva do banco (webhook/polling de bankPayments).
 *   - MANUAL_WITH_EVIDENCE: exceção formal — comprovante (arquivo real) + motivo + aprovação
 *     de outro usuário. Nunca é apresentado como confirmação bancária.
 * settlement_evidence_file_id / settlement_reason guardam o comprovante e o motivo da exceção.
 *
 * F04 — Rastreabilidade de caução (Caderno §13: "movimentação exige vínculo com contrato e
 * titular; devolução/compensação cria evento e ledger próprio"). Uma saída de dinheiro de
 * terceiro (devolução/compensação) passa a apontar para o recebimento de origem
 * (third_party_origin_entry_id) e o titular do dinheiro fica registrado
 * (third_party_holder_person_id), permitindo validar contrato, titular e saldo.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = { tableName: 'financial_entries', schema: 'finance' };

    await queryInterface.addColumn(table, 'settlement_method', {
      type: Sequelize.STRING(32),
      allowNull: true,
      comment: 'BANK_CONFIRMED | MANUAL_WITH_EVIDENCE (só PAYABLE com conta bancária)',
    });
    await queryInterface.addColumn(table, 'settlement_evidence_file_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn(table, 'settlement_reason', { type: Sequelize.TEXT, allowNull: true });

    await queryInterface.addColumn(table, 'third_party_origin_entry_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn(table, 'third_party_holder_person_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addIndex(table, ['third_party_origin_entry_id'], {
      name: 'financial_entries_third_party_origin_idx',
    });
  },

  async down(queryInterface) {
    const table = { tableName: 'financial_entries', schema: 'finance' };
    await queryInterface.removeIndex(table, 'financial_entries_third_party_origin_idx');
    for (const column of [
      'third_party_holder_person_id',
      'third_party_origin_entry_id',
      'settlement_reason',
      'settlement_evidence_file_id',
      'settlement_method',
    ]) {
      await queryInterface.removeColumn(table, column);
    }
  },
};
