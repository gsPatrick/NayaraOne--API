'use strict';

/**
 * F02 — segunda rodada (revisor independente, 18/10/2026). Ajustes de banco do fechamento:
 *
 * - period_closures:
 *   - review_requested_by_user_id: quem pediu a revisão, explícito (antes saía de updated_by,
 *     que muda a cada save) — base da segregação "quem pede não aprova";
 *   - third_party_fingerprint_at_check: retrato item a item (id/status/valor) do caixa de
 *     terceiros conferido. Comparar só o líquido deixava passar +500/−500 depois da conferência;
 *   - returned_to_open_*: saída controlada de REVIEW para OPEN (antes o período podia ficar
 *     preso em REVIEW para sempre).
 * - finance.bank_statement_imports: cada importação de extrato registra o período que o extrato
 *   cobre (declarado ou deduzido das linhas) e o saldo final informado. A pré-condição "extratos
 *   importados" passa a exigir que o mês inteiro esteja coberto, não "uma transação qualquer".
 *   Append-only (sem UPDATE/DELETE para a aplicação).
 * - period_closure_snapshots: o trigger de imutabilidade também bloqueia TRUNCATE.
 */

const SNAPSHOT_TRUNCATE_FUNCTION = 'finance.block_period_closure_snapshots_truncate';
const SNAPSHOT_TRUNCATE_TRIGGER = 'trg_period_closure_snapshots_no_truncate';

module.exports = {
  async up(queryInterface, Sequelize) {
    const closures = { tableName: 'period_closures', schema: 'finance' };
    const userRef = {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    };

    await queryInterface.addColumn(closures, 'review_requested_by_user_id', userRef);
    await queryInterface.addColumn(closures, 'review_requested_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(closures, 'third_party_fingerprint_at_check', { type: Sequelize.STRING(64), allowNull: true });
    await queryInterface.addColumn(closures, 'returned_to_open_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(closures, 'returned_to_open_by_user_id', userRef);
    await queryInterface.addColumn(closures, 'return_to_open_reason', { type: Sequelize.TEXT, allowNull: true });

    await queryInterface.createTable(
      { tableName: 'bank_statement_imports', schema: 'finance' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        bank_account_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'bank_accounts', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        period_start: { type: Sequelize.DATEONLY, allowNull: false },
        period_end: { type: Sequelize.DATEONLY, allowNull: false },
        period_declared: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        closing_balance: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
        lines_total: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        lines_imported: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.addIndex(
      { tableName: 'bank_statement_imports', schema: 'finance' },
      ['company_id', 'bank_account_id', 'period_start', 'period_end'],
      { name: 'bank_statement_imports_account_period_idx' }
    );
    await queryInterface.sequelize.query(
      'ALTER TABLE "finance"."bank_statement_imports" ADD CONSTRAINT bank_statement_imports_period_chk CHECK (period_end >= period_start);'
    );
    await queryInterface.sequelize.query('ALTER TABLE "finance"."bank_statement_imports" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."bank_statement_imports" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."bank_statement_imports"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION ${SNAPSHOT_TRUNCATE_FUNCTION}()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'finance.period_closure_snapshots é imutável (F02/§16): TRUNCATE não é permitido.'
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS ${SNAPSHOT_TRUNCATE_TRIGGER} ON "finance"."period_closure_snapshots";
      CREATE TRIGGER ${SNAPSHOT_TRUNCATE_TRIGGER}
        BEFORE TRUNCATE ON "finance"."period_closure_snapshots"
        FOR EACH STATEMENT
        EXECUTE FUNCTION ${SNAPSHOT_TRUNCATE_FUNCTION}();
    `);

    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query('GRANT SELECT, INSERT ON "finance"."bank_statement_imports" TO nayara_runtime;');
    }
  },

  async down(queryInterface) {
    const closures = { tableName: 'period_closures', schema: 'finance' };
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${SNAPSHOT_TRUNCATE_TRIGGER} ON "finance"."period_closure_snapshots";`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS ${SNAPSHOT_TRUNCATE_FUNCTION}();`);
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."bank_statement_imports";');
    await queryInterface.dropTable({ tableName: 'bank_statement_imports', schema: 'finance' });
    for (const column of [
      'return_to_open_reason',
      'returned_to_open_by_user_id',
      'returned_to_open_at',
      'third_party_fingerprint_at_check',
      'review_requested_at',
      'review_requested_by_user_id',
    ]) {
      await queryInterface.removeColumn(closures, column);
    }
  },
};
