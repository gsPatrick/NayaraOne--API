'use strict';

/**
 * Migration: cria "legal"."contract_template_clauses" (M5-01) — junção template x cláusula.
 *
 * DECISÃO DE ENGENHARIA (documentada conforme pedido): entre "coluna clause_ids UUID[]" e
 * "tabela de junção", escolhemos a TABELA DE JUNÇÃO. Motivos concretos:
 *  - a ordem das cláusulas no documento final é um dado de negócio (renderTemplate concatena
 *    na ordem certa) e fica explícita em `sort_order`, em vez de implícita na posição do array;
 *  - permite FK real para legal.contract_clauses (um array de UUID não tem integridade
 *    referencial no Postgres), garantindo no banco que o template só aponta para cláusulas
 *    que existem;
 *  - permite ativar/desativar um vínculo sem reescrever o array inteiro.
 * O custo é uma tabela a mais — aceitável pelo ganho de integridade e ordenação explícita.
 *
 * O vínculo aponta para a VERSÃO específica da cláusula (contract_clauses.id é único por
 * versão), então um template renderizado hoje continua renderizando exatamente o mesmo texto
 * mesmo depois de alguém criar uma nova versão da cláusula.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'contract_template_clauses', schema: 'legal' },
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
        contract_template_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contract_templates', schema: 'legal' }, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        contract_clause_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contract_clauses', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint(
      { tableName: 'contract_template_clauses', schema: 'legal' },
      {
        fields: ['contract_template_id', 'contract_clause_id'],
        type: 'unique',
        name: 'contract_template_clauses_template_clause_unique',
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_template_clauses" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_template_clauses" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."contract_template_clauses"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."contract_template_clauses";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_template_clauses" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'contract_template_clauses', schema: 'legal' });
  },
};
