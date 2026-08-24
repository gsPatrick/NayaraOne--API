'use strict';

/**
 * Migration: cria "legal"."evidence_packages" — Pacote de evidências (manifest) imutável
 * anexado a um processo jurídico, com hash SHA-256 do manifest calculado na criação.
 *
 * DECISÃO DE ENGENHARIA: tabela append-only por design (mesmo espírito de
 * "legal"."contract_versions" — nunca editada após criada). Por isso: SEM updated_at, SEM
 * updated_by, SEM soft delete (deleted_at/deleted_by) — evidência jurídica não pode ser
 * "apagada" pela aplicação, apenas criada; expurgo, se necessário, é operação de banco fora do
 * escopo da API. Mantém created_by/created_at para rastreabilidade de quem gerou o pacote.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'evidence_packages', schema: 'legal' },
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
        legal_case_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'legal_cases', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        manifest_json: {
          type: Sequelize.JSONB,
          allowNull: false,
          comment: 'Lista de itens [{type, description, referenceId, hash}]',
        },
        package_hash: {
          type: Sequelize.STRING(64),
          allowNull: false,
          comment: 'SHA-256 do manifest_json serializado, calculado na criação — imutável',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "legal"."evidence_packages" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."evidence_packages" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."evidence_packages"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."evidence_packages";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."evidence_packages" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'evidence_packages', schema: 'legal' });
  },
};
