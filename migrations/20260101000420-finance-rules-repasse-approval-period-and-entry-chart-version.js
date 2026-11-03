'use strict';

/**
 * Frente 3 (Regras do Financeiro, Marco 4) — complemento da migration 400.
 *
 *  - §12 Repasse ao proprietário: aprovação por OUTRA pessoa (maker-checker, também no banco),
 *    confirmação com comprovante (o lançamento a pagar por trás foi liquidado com confirmação do
 *    banco ou com comprovante aprovado — o arquivo fica gravado no repasse), período obrigatório
 *    (`reference_month`) e um único repasse vivo por proprietário/imóvel/contrato/período (índice
 *    único parcial — a segunda tentativa concorrente falha no banco, além do FOR UPDATE).
 *  - §4 Plano de contas versionado: o lançamento grava a versão da conta vigente na data do fato
 *    (`chart_of_account_version_id`), não só a conta "atual".
 *
 * Linhas anteriores a esta migration ficam fora das regras novas (mesmo critério da 400).
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[{ cutoff }]] = await queryInterface.sequelize.query(
      "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cutoff;"
    );
    const legacy = `created_at < TIMESTAMPTZ '${cutoff}'`;

    const rep = { tableName: 'owner_repasses', schema: 'finance' };
    for (const col of ['approved_by_user_id', 'confirmed_by_user_id']) {
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.addColumn(rep, col, {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      });
    }
    await queryInterface.addColumn(rep, 'approved_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(rep, 'payment_evidence_file_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn(rep, 'payment_settlement_method', { type: Sequelize.STRING(32), allowNull: true });

    await q(`
      ALTER TABLE "finance"."owner_repasses"
        ADD CONSTRAINT owner_repasses_status_ck
        CHECK (${legacy} OR status IN ('PENDING', 'APPROVED', 'PAID', 'CANCELLED'));
    `);
    await q(`
      ALTER TABLE "finance"."owner_repasses"
        ADD CONSTRAINT owner_repasses_period_required_ck
        CHECK (${legacy} OR (reference_month IS NOT NULL AND reference_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'));
    `);
    await q(`
      ALTER TABLE "finance"."owner_repasses"
        ADD CONSTRAINT owner_repasses_maker_checker_ck
        CHECK (${legacy} OR status NOT IN ('APPROVED', 'PAID') OR (
          approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND financial_entry_id IS NOT NULL
          AND (created_by IS NULL OR approved_by_user_id <> created_by)
        ));
    `);
    await q(`
      ALTER TABLE "finance"."owner_repasses"
        ADD CONSTRAINT owner_repasses_paid_confirmation_ck
        CHECK (${legacy} OR status <> 'PAID' OR (
          paid_at IS NOT NULL AND confirmed_by_user_id IS NOT NULL AND payment_settlement_method IS NOT NULL
          AND (payment_settlement_method IN ('BANK_CONFIRMED', 'SANDBOX_CONFIRMED') OR payment_evidence_file_id IS NOT NULL)
        ));
    `);
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS owner_repasses_one_per_period_uq
        ON "finance"."owner_repasses" (
          company_id, owner_person_id, property_id,
          COALESCE(contract_id, '00000000-0000-0000-0000-000000000000'::uuid), reference_month
        )
        WHERE status <> 'CANCELLED' AND created_at >= TIMESTAMPTZ '${cutoff}';
    `);

    await queryInterface.addColumn({ tableName: 'financial_entries', schema: 'finance' }, 'chart_of_account_version_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'chart_of_account_versions', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await q(`
      ALTER TABLE "finance"."financial_entries"
        ADD CONSTRAINT financial_entries_chart_version_ck
        CHECK (${legacy} OR chart_of_account_id IS NULL OR chart_of_account_version_id IS NOT NULL);
    `);

    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await q('GRANT SELECT, INSERT, UPDATE ON "finance"."owner_repasses" TO nayara_runtime;');
      await q('GRANT SELECT, INSERT, UPDATE ON "finance"."chart_of_account_versions" TO nayara_runtime;');
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "finance"."financial_entries" DROP CONSTRAINT IF EXISTS financial_entries_chart_version_ck;');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'chart_of_account_version_id');
    await q('DROP INDEX IF EXISTS "finance".owner_repasses_one_per_period_uq;');
    for (const c of ['owner_repasses_paid_confirmation_ck', 'owner_repasses_maker_checker_ck', 'owner_repasses_period_required_ck', 'owner_repasses_status_ck']) {
      // eslint-disable-next-line no-await-in-loop
      await q(`ALTER TABLE "finance"."owner_repasses" DROP CONSTRAINT IF EXISTS ${c};`);
    }
    for (const col of ['payment_settlement_method', 'payment_evidence_file_id', 'approved_at', 'confirmed_by_user_id', 'approved_by_user_id']) {
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.removeColumn({ tableName: 'owner_repasses', schema: 'finance' }, col);
    }
  },
};
