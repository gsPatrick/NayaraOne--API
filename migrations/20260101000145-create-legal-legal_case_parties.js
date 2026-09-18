'use strict';

/**
 * Migration: cria "legal"."legal_case_parties" (M5-26) — partes formais de um processo
 * jurídico (autor, réu, testemunha, terceiro interessado). Antes disso um processo só tinha
 * `responsible_user_id` (usuário interno responsável), nenhuma representação das partes reais.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'legal_case_parties', schema: 'legal' },
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
        person_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        party_role: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'PLAINTIFF|DEFENDANT|WITNESS|THIRD_PARTY',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint(
      { tableName: 'legal_case_parties', schema: 'legal' },
      {
        fields: ['legal_case_id', 'person_id', 'party_role'],
        type: 'unique',
        name: 'legal_case_parties_case_person_role_unique',
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."legal_case_parties" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."legal_case_parties" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."legal_case_parties"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."legal_case_parties";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."legal_case_parties" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'legal_case_parties', schema: 'legal' });
  },
};
