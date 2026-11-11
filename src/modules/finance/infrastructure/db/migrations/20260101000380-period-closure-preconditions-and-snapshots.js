'use strict';

/**
 * F02 (conferência Nayara 18/10/2026) — pré-condições do fechamento financeiro e snapshot.
 *
 * Caderno Financeiro §16: "Antes de fechar: extratos importados, pendências de conciliação
 * classificadas, caixa de terceiros conferido, comissões/repasses revisados." Guia §12:
 * "calculate closing snapshot". Até aqui o fechamento só trocava status REVIEW/CLOSED.
 *
 * - period_closures ganha as duas conferências explícitas que o sistema não consegue deduzir
 *   sozinho (caixa de terceiros conferido; comissões/repasses revisados): quem conferiu, quando,
 *   observação e o "retrato" do que foi conferido (saldo de terceiros / fingerprint das
 *   comissões e repasses do mês), para detectar conferência desatualizada na aprovação.
 * - period_closure_snapshots é o retrato imutável gravado no momento do CLOSED (append-only por
 *   trigger: nunca UPDATE/DELETE). Reabrir e fechar de novo gera um snapshot NOVO; o anterior
 *   fica preservado como histórico.
 */

const SNAPSHOT_FUNCTION = 'finance.enforce_period_closure_snapshots_append_only';
const SNAPSHOT_TRIGGER = 'trg_period_closure_snapshots_append_only';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = { tableName: 'period_closures', schema: 'finance' };
    const userRef = {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    };

    await queryInterface.addColumn(table, 'third_party_checked_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(table, 'third_party_checked_by_user_id', userRef);
    await queryInterface.addColumn(table, 'third_party_check_note', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn(table, 'third_party_balance_at_check', { type: Sequelize.DECIMAL(18, 2), allowNull: true });
    await queryInterface.addColumn(table, 'commissions_reviewed_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(table, 'commissions_reviewed_by_user_id', userRef);
    await queryInterface.addColumn(table, 'commissions_review_note', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.addColumn(table, 'commissions_fingerprint_at_review', { type: Sequelize.STRING(64), allowNull: true });

    await queryInterface.createTable(
      { tableName: 'period_closure_snapshots', schema: 'finance' },
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
        period_closure_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'period_closures', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        reference_month: { type: Sequelize.STRING(7), allowNull: false },
        snapshot_json: { type: Sequelize.JSONB, allowNull: false },
        snapshot_hash: { type: Sequelize.STRING(64), allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.addIndex(
      { tableName: 'period_closure_snapshots', schema: 'finance' },
      ['period_closure_id'],
      { name: 'period_closure_snapshots_closure_idx' }
    );

    await queryInterface.addColumn(table, 'current_snapshot_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'period_closure_snapshots', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });

    await queryInterface.sequelize.query('ALTER TABLE "finance"."period_closure_snapshots" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."period_closure_snapshots" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."period_closure_snapshots"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION ${SNAPSHOT_FUNCTION}()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'finance.period_closure_snapshots é imutável (F02/§16): o snapshot do fechamento nunca é alterado nem apagado (id=%). Reabrir e fechar de novo gera um snapshot novo.', OLD.id
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS ${SNAPSHOT_TRIGGER} ON "finance"."period_closure_snapshots";
      CREATE TRIGGER ${SNAPSHOT_TRIGGER}
        BEFORE UPDATE OR DELETE ON "finance"."period_closure_snapshots"
        FOR EACH ROW
        EXECUTE FUNCTION ${SNAPSHOT_FUNCTION}();
    `);

    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query('GRANT SELECT, INSERT ON "finance"."period_closure_snapshots" TO nayara_runtime;');
      await queryInterface.sequelize.query('GRANT SELECT, INSERT, UPDATE ON "finance"."period_closures" TO nayara_runtime;');
    }
  },

  async down(queryInterface) {
    const table = { tableName: 'period_closures', schema: 'finance' };
    await queryInterface.removeColumn(table, 'current_snapshot_id');
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${SNAPSHOT_TRIGGER} ON "finance"."period_closure_snapshots";`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS ${SNAPSHOT_FUNCTION}();`);
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."period_closure_snapshots";');
    await queryInterface.dropTable({ tableName: 'period_closure_snapshots', schema: 'finance' });
    for (const column of [
      'third_party_checked_at',
      'third_party_checked_by_user_id',
      'third_party_check_note',
      'third_party_balance_at_check',
      'commissions_reviewed_at',
      'commissions_reviewed_by_user_id',
      'commissions_review_note',
      'commissions_fingerprint_at_review',
    ]) {
      await queryInterface.removeColumn(table, column);
    }
  },
};
