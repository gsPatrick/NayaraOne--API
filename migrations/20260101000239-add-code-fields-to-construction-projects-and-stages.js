'use strict';

/**
 * M6-01/M6-02 (fechado em 30/09/2026, 2ª rodada pós-re-auditoria) — campos que faltavam:
 * `code` (identificador legível, único por empresa) e `actual_end_date` em `projects`;
 * `stage_code` e `planned_cost` em `project_stages`. Tudo nullable/sem UNIQUE hard no banco
 * pra `code` (usa índice único PARCIAL — só quando preenchido — pra não quebrar linhas
 * existentes sem código ainda gerado). Também cria `construction.project_code_sequences`,
 * mesmo padrão atômico de `legal.contract_number_sequences` (INSERT...ON CONFLICT...DO UPDATE),
 * pra gerar `code` automaticamente sem corrida de concorrência.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'projects', schema: 'construction' },
      'code',
      { type: Sequelize.STRING(40), allowNull: true }
    );
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX projects_company_code_uk ON "construction"."projects" (company_id, code) WHERE code IS NOT NULL`
    );
    await queryInterface.addColumn(
      { tableName: 'projects', schema: 'construction' },
      'actual_end_date',
      { type: Sequelize.DATEONLY, allowNull: true }
    );

    await queryInterface.addColumn(
      { tableName: 'project_stages', schema: 'construction' },
      'stage_code',
      { type: Sequelize.STRING(40), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'project_stages', schema: 'construction' },
      'planned_cost',
      { type: Sequelize.DECIMAL(18, 2), allowNull: true }
    );

    await queryInterface.createTable(
      { tableName: 'project_code_sequences', schema: 'construction' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true, allowNull: false },
        company_id: { type: Sequelize.UUID, allowNull: false },
        year: { type: Sequelize.INTEGER, allowNull: false },
        last_seq: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      }
    );
    await queryInterface.addIndex(
      { tableName: 'project_code_sequences', schema: 'construction' },
      ['company_id', 'year'],
      { unique: true, name: 'project_code_sequences_company_year_uk' }
    );
    await queryInterface.sequelize.query(`ALTER TABLE "construction"."project_code_sequences" ENABLE ROW LEVEL SECURITY`);
    await queryInterface.sequelize.query(`ALTER TABLE "construction"."project_code_sequences" FORCE ROW LEVEL SECURITY`);
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."project_code_sequences"
      USING (company_id = current_setting('app.company_id', true)::uuid)
      WITH CHECK (company_id = current_setting('app.company_id', true)::uuid)
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'project_code_sequences', schema: 'construction' });
    await queryInterface.removeColumn({ tableName: 'project_stages', schema: 'construction' }, 'planned_cost');
    await queryInterface.removeColumn({ tableName: 'project_stages', schema: 'construction' }, 'stage_code');
    await queryInterface.removeColumn({ tableName: 'projects', schema: 'construction' }, 'actual_end_date');
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "construction"."projects_company_code_uk"`);
    await queryInterface.removeColumn({ tableName: 'projects', schema: 'construction' }, 'code');
  },
};
