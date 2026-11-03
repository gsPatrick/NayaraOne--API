'use strict';

/**
 * Revisão independente da conferência Nayara 18/10/2026 — F03, F04 e PAY-04/05/06.
 *
 * financial_entries
 *   settlement_evidence_attached_by / _at — o comprovante da baixa manual passa a ser ANEXADO
 *     ao lançamento antes da aprovação (quem aprova vê o arquivo). Guardar quem anexou e quando
 *     permite exigir que a aprovação seja posterior e de outra pessoa.
 *   third_party_release_type — saída de dinheiro de terceiro: RETURN (devolução em dinheiro) ou
 *     COMPENSATION (abate de dívida do titular, sem caixa).
 *   third_party_compensated_entry_id — na compensação, a dívida (RECEIVABLE) que foi abatida.
 *   índice único parcial em settlement_evidence_file_id (lançamentos-raiz): o mesmo comprovante
 *     não serve para duas baixas diferentes.
 *
 * payment_intents
 *   uncertain_since / last_reconciled_at / reconciliation_attempts — intenção cuja submissão ao
 *     banco ficou sem resposta confiável (status SUBMITTING) ou em trânsito (SUBMITTED); o job de
 *     reconciliação consulta o banco e registra as tentativas.
 *   índice único parcial "uma intenção aberta por lançamento": fecha a corrida de
 *     createPaymentIntent (duas requisições simultâneas criavam duas intenções).
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const entries = { tableName: 'financial_entries', schema: 'finance' };
    const intents = { tableName: 'payment_intents', schema: 'finance' };

    await queryInterface.addColumn(entries, 'settlement_evidence_attached_by', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.addColumn(entries, 'settlement_evidence_attached_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(entries, 'third_party_release_type', {
      type: Sequelize.STRING(16),
      allowNull: true,
      comment: 'RETURN | COMPENSATION (só saída de dinheiro de terceiro)',
    });
    await queryInterface.addColumn(entries, 'third_party_compensated_entry_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS financial_entries_settlement_evidence_root_unique
        ON finance.financial_entries (settlement_evidence_file_id)
        WHERE parent_entry_id IS NULL AND settlement_evidence_file_id IS NOT NULL;
    `);

    await queryInterface.addColumn(intents, 'uncertain_since', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(intents, 'last_reconciled_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(intents, 'reconciliation_attempts', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_one_open_per_entry
        ON finance.payment_intents (financial_entry_id)
        WHERE status IN ('PENDING', 'APPROVED', 'SUBMITTING', 'SUBMITTED');
    `);
  },

  async down(queryInterface) {
    const entries = { tableName: 'financial_entries', schema: 'finance' };
    const intents = { tableName: 'payment_intents', schema: 'finance' };
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS finance.payment_intents_one_open_per_entry;');
    for (const column of ['reconciliation_attempts', 'last_reconciled_at', 'uncertain_since']) {
      await queryInterface.removeColumn(intents, column);
    }
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS finance.financial_entries_settlement_evidence_root_unique;');
    for (const column of ['third_party_compensated_entry_id', 'third_party_release_type', 'settlement_evidence_attached_at', 'settlement_evidence_attached_by']) {
      await queryInterface.removeColumn(entries, column);
    }
  },
};
