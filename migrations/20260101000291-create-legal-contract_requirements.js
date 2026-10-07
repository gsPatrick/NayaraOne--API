'use strict';

/**
 * Migration: auditoria externa (contrato bruto, Anexo I "7. Checklist documental" + "4.
 * Entidades/tabelas obrigatórias") — "legal.contract_requirements: Checklist/documentos
 * exigidos." / "Requirements são gerados por tipo de contrato + regras + características das
 * partes/imóvel." Hoje só existia o checklist de PAPÉIS das partes (REQUIRED_ROLES_BY_TYPE em
 * contracts.service.js) — nada de DOCUMENTOS obrigatórios por tipo de contrato. Esta tabela
 * registra cada requirement individual (um documento/garantia/vistoria/termo exigido) gerado
 * para um contrato específico, com status próprio (PENDING/SATISFIED/WAIVED), para que
 * `assertRequirementsSatisfied` (requirementsEngine.service.js) possa bloquear o avanço de
 * etapa (JUR-003 "Etapa não avança com documento obrigatório faltante", teste JUR-TS-003).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable({ tableName: 'contract_requirements', schema: 'legal' }, {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      group_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      company_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      contract_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      requirement_code: { type: Sequelize.STRING(64), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: false },
      // PF_DOCUMENT|PJ_DOCUMENT|GUARANTEE|POWER_OF_ATTORNEY|INSPECTION|OWNERSHIP_PROOF|
      // OBLIGATIONS|BUYER_DOCUMENT|SELLER_DOCUMENT|PROPERTY_REGISTRATION|CERTIFICATES|
      // FINANCING|PAYMENT_DATA|DELIVERY_TERM|FINAL_INSPECTION|OWNER_MANUAL|PHOTOS|KEYS|
      // USED_PROPERTY_TERM
      requirement_type: { type: Sequelize.STRING(32), allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'PENDING' }, // PENDING|SATISFIED|WAIVED
      satisfied_by_file_id: { type: Sequelize.UUID, allowNull: true },
      satisfied_at: { type: Sequelize.DATE, allowNull: true },
      waived_reason: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex({ tableName: 'contract_requirements', schema: 'legal' }, ['contract_id']);

    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_requirements" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_requirements" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."contract_requirements"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
    await queryInterface.sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "legal"."contract_requirements" TO nayara_runtime;');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'contract_requirements', schema: 'legal' });
  },
};
