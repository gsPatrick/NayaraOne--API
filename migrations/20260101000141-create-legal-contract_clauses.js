'use strict';

/**
 * Migration: cria "legal"."contract_clauses" — biblioteca de cláusulas contratuais
 * versionadas (M5-01, Caderno CURRENT — Marco 5).
 *
 * DECISÃO DE ENGENHARIA: a tabela é APPEND-ONLY POR VERSÃO. Uma cláusula nunca tem seu
 * `body_text` atualizado depois de criada; "editar" uma cláusula significa inserir uma NOVA
 * linha com o mesmo `code` e `version_number + 1`, desativando (is_active = false) a versão
 * anterior. Isso preserva a prova de qual texto exato foi usado em qualquer contrato antigo.
 * Por isso a UNIQUE é (company_id, code, version_number) — não (company_id, code).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'contract_clauses', schema: 'legal' },
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
        code: {
          type: Sequelize.STRING(64),
          allowNull: false,
          comment: 'Código estável da cláusula entre versões, ex.: CLAUSE-MULTA-01',
        },
        title: { type: Sequelize.STRING(255), allowNull: false },
        body_text: { type: Sequelize.TEXT, allowNull: false },
        category: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'PAYMENT|TERMINATION|GUARANTEE|GENERAL',
        },
        version_number: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint(
      { tableName: 'contract_clauses', schema: 'legal' },
      {
        fields: ['company_id', 'code', 'version_number'],
        type: 'unique',
        name: 'contract_clauses_company_code_version_unique',
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_clauses" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_clauses" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."contract_clauses"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."contract_clauses";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_clauses" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'contract_clauses', schema: 'legal' });
  },
};
