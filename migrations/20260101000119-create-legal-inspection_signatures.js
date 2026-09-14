'use strict';

/**
 * Migration: cria "legal"."inspection_signatures" — assinatura digital de uma parte
 * (locador/locatário/vistoriador) confirmando o resultado de uma vistoria.
 *
 * FIX (reportado pela cliente 14/09/2026, escopo Marco 5 — Vistorias): vistoria não tinha
 * nenhum mecanismo de assinatura — append-only (sem paranoid: uma assinatura nunca é
 * "apagada", só existe ou não existe), igual ao padrão já usado em "legal"."signatures" para
 * contratos.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'inspection_signatures', schema: 'legal' },
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
        inspection_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'inspections', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        party_role: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'LANDLORD|TENANT|INSPECTOR',
        },
        signed_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        signature_hash: {
          type: Sequelize.STRING(64),
          allowNull: false,
          comment: 'SHA-256 do payload de assinatura (imagem/texto de consentimento + timestamp + IP)',
        },
        signed_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."inspection_signatures" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."inspection_signatures" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."inspection_signatures"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."inspection_signatures";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."inspection_signatures" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'inspection_signatures', schema: 'legal' });
  },
};
