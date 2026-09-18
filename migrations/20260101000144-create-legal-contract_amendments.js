'use strict';

/**
 * Migration: cria "legal"."contract_amendments" (M5-25) — aditivo contratual, entidade
 * distinta de uma nova ContractVersion: a versão troca o documento inteiro; o aditivo registra
 * QUAL termo mudou (changes_json), POR QUÊ (reason) e com que numeração sequencial por
 * contrato (amendment_number), servindo como histórico jurídico de alterações do contrato.
 *
 * APPEND-ONLY: sem updated_at/updated_by e sem soft delete, mesmo padrão de
 * legal.evidence_packages — um aditivo já criado nunca é editado. Exceção deliberada: a coluna
 * `status` (DRAFT -> SIGNED) é o único campo que muda, e só no sentido DRAFT->SIGNED, via
 * signAmendment (ver contractAmendments.service.js); o conteúdo (reason/changes_json/número)
 * é imutável.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'contract_amendments', schema: 'legal' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        group_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        contract_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        amendment_number: { type: Sequelize.INTEGER, allowNull: false },
        reason: { type: Sequelize.TEXT, allowNull: false },
        changes_json: {
          type: Sequelize.JSONB,
          allowNull: false,
          comment: 'Lista de {field, oldValue, newValue} com o que o aditivo alterou.',
        },
        document_file_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'DRAFT',
          comment: 'DRAFT|SIGNED',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint(
      { tableName: 'contract_amendments', schema: 'legal' },
      {
        fields: ['contract_id', 'amendment_number'],
        type: 'unique',
        name: 'contract_amendments_contract_number_unique',
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_amendments" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_amendments" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."contract_amendments"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."contract_amendments";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_amendments" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'contract_amendments', schema: 'legal' });
  },
};
