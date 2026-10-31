'use strict';

/**
 * Migration: cria "construction"."margin_rules" — versão vigente da margem mínima exigida
 * para aprovar orçamento de obra (M6-23/M6-61 do checklist do Marco 6).
 *
 * DECISÃO DE ENGENHARIA: o projeto já tem um Motor de Regras genérico (core.rules/rule_versions
 * em src/engines/rules), mas ele trabalha com AST de condição/escopo pensado para regras de
 * elegibilidade/aprovação por alçada — não há hoje nenhum "domain" nem schema de payload
 * modelado para margem de obra ali. Plugar a margem mínima no motor genérico exigiria desenhar
 * esse domínio novo (fora do escopo desta entrega). Em vez disso, criamos uma tabela dedicada
 * e versionada: cada linha é uma "versão" imutável da regra (nunca é dada UPDATE em
 * min_margin_pct de uma linha já usada por algum orçamento aprovado — só se cria uma linha
 * nova e desativa a anterior). O campo `id` desta tabela É o `rule_version_id` gravado em
 * "construction"."budgets" no momento da aprovação, preservando o histórico mesmo que a regra
 * mude depois (mesma garantia do M6-61). Migração futura para o Motor de Regras genérico é
 * possível sem perda de histórico, pois o identificador de versão já é estável.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'margin_rules', schema: 'construction' },
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
        min_margin_pct: {
          type: Sequelize.DECIMAL(5, 2),
          allowNull: false,
        },
        description: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        is_active: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        lock_version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // Só pode haver UMA versão ativa por empresa de cada vez — evita ambiguidade sobre qual
    // margem mínima está vigente no momento da aprovação de um orçamento.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX margin_rules_active_per_company
        ON "construction"."margin_rules" (company_id)
        WHERE is_active = true AND deleted_at IS NULL;
    `);

    await queryInterface.sequelize.query('ALTER TABLE "construction"."margin_rules" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."margin_rules" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."margin_rules"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."margin_rules";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."margin_rules" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'margin_rules', schema: 'construction' });
  },
};
