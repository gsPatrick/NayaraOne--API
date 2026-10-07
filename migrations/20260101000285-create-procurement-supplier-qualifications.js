'use strict';

/**
 * Migration: contrato (Anexo I, linhas 9505-9507) exige "Fornecedores: documentos/vigência;
 * due diligence para alto risco" — requisito textual não capturado no MARCO_7_CHECKLIST.md
 * original e ausente do código até esta auditoria (2026-10-07). Fornecedor hoje é só uma
 * Person com papel SUPPLIER, sem controle de documentos/vigência nem due diligence por risco.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable({ tableName: 'supplier_qualifications', schema: 'procurement' }, {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      group_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      company_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      supplier_person_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
      },
      document_file_ids: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      valid_until: { type: Sequelize.DATEONLY, allowNull: true },
      high_risk: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      due_diligence_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'NOT_REQUIRED' },
      due_diligence_notes: { type: Sequelize.TEXT, allowNull: true },
      approved_by_user_id: { type: Sequelize.UUID, allowNull: true },
      approved_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      updated_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
    });

    await queryInterface.addConstraint({ tableName: 'supplier_qualifications', schema: 'procurement' }, {
      fields: ['company_id', 'supplier_person_id'],
      type: 'unique',
      name: 'procurement_supplier_qualifications_company_supplier_uniq',
      where: { deleted_at: null },
    });

    await queryInterface.sequelize.query('ALTER TABLE "procurement"."supplier_qualifications" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "procurement"."supplier_qualifications" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "procurement"."supplier_qualifications"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
    await queryInterface.sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "procurement"."supplier_qualifications" TO nayara_runtime;');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'supplier_qualifications', schema: 'procurement' });
  },
};
