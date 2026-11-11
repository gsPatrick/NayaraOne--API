'use strict';

/**
 * Estende "finance"."payment_intents" (já existia desde o Marco 4, M4-07 — mecanismo de
 * integridade maker-checker via snapshot+hash) com os campos necessários para o novo caminho
 * de submissão bancária real via BankAdapter (ver PROVIDER_BANCARIO.md seção 2.1 bis).
 * Deliberadamente ALTER, não CREATE paralela — mesma tabela, dois caminhos de uso: liquidação
 * manual/interna (existente, intocada) e submissão bancária eletrônica (novo, aditivo).
 *
 * `status` ganha dois valores novos inseridos no meio do ciclo de vida existente
 * (PENDING -> APPROVED -> [SUBMITTED] -> EXECUTED | [FAILED] | CANCELLED) — nenhum valor
 * existente é removido ou reinterpretado.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'bank_account_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'bank_accounts', schema: 'finance' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'beneficiary_snapshot',
      {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: 'Cópia congelada dos dados bancários do favorecido no momento da submissão — bankCode/branch/account/pixKey.',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'payment_method',
      { type: Sequelize.STRING(16), allowNull: true, comment: 'PIX|BOLETO|TRANSFER|CHEQUE|MANUAL' }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'idempotency_key',
      { type: Sequelize.STRING(255), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'external_submission_id',
      { type: Sequelize.STRING(255), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'external_status',
      { type: Sequelize.STRING(64), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'submitted_at',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'failed_at',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'payment_intents', schema: 'finance' },
      'failure_reason',
      { type: Sequelize.TEXT, allowNull: true }
    );
    await queryInterface.addConstraint({ tableName: 'payment_intents', schema: 'finance' }, {
      fields: ['company_id', 'idempotency_key'],
      type: 'unique',
      name: 'payment_intents_company_idempotency_unique',
    });

    // Mesmo padrão de roteamento de webhook público já usado em
    // legal.signature_provider_routing: guarda só id opaco do provedor -> tenant, SEM RLS
    // (webhook do banco chega sem JWT/tenant conhecido de antemão).
    await queryInterface.createTable(
      { tableName: 'bank_payment_provider_routing', schema: 'finance' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },
        external_submission_id: { type: Sequelize.STRING, allowNull: false, unique: true },
        payment_intent_id: { type: Sequelize.UUID, allowNull: false },
        group_id: { type: Sequelize.UUID, allowNull: false },
        company_id: { type: Sequelize.UUID, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      }
    );
    await queryInterface.addIndex(
      { tableName: 'bank_payment_provider_routing', schema: 'finance' },
      ['payment_intent_id'],
      { name: 'bank_payment_provider_routing_intent_idx' }
    );
    // Deliberadamente SEM ENABLE ROW LEVEL SECURITY — mesmo motivo de signature_provider_routing.
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'bank_payment_provider_routing', schema: 'finance' });

    await queryInterface.removeConstraint({ tableName: 'payment_intents', schema: 'finance' }, 'payment_intents_company_idempotency_unique');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'failure_reason');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'failed_at');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'submitted_at');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'external_status');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'external_submission_id');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'idempotency_key');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'payment_method');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'beneficiary_snapshot');
    await queryInterface.removeColumn({ tableName: 'payment_intents', schema: 'finance' }, 'bank_account_id');
  },
};
