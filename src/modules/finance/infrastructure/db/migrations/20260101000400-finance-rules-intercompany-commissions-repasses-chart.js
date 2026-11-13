'use strict';

/**
 * Conferência Nayara 18/10/2026 — matriz do Marco 4, "conferir X" sem implementação:
 *
 *  - §15 Intercompany: motivo, documento, aprovação e contas correspondentes. A transferência
 *    passa a nascer PENDING_APPROVAL, sem lançamentos; os dois lados só são criados quando outra
 *    pessoa aprova. from/to_entry_id deixam de ser NOT NULL (só existem depois da aprovação).
 *  - §14 Comissões: fato gerador (lançamento a receber de origem), componente e rule_version_id
 *    obrigatórios para comissões criadas depois desta migration (linhas antigas isentas).
 *  - §12 Repasses: o pagamento do repasse passa por um lançamento a pagar comum (aprovação,
 *    confirmação bancária ou exceção com comprovante) — financial_entry_id liga os dois.
 *  - §4 Plano de contas: versões append-only com vigência; o fato usa a versão vigente na data.
 *    Nova permissão `finance:chartOfAccounts` (governança: usuário comum não cria categoria).
 */

const VERSION_FUNCTION = 'finance.enforce_chart_of_account_versions_append_only';
const VERSION_TRIGGER = 'trg_chart_of_account_versions_append_only';

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);
    // Linhas anteriores a esta migration ficam fora das regras novas (histórico preservado e
    // ainda atualizável — ex.: conciliar uma transferência antiga, cancelar comissão antiga).
    // CHECK com NOT VALID não bastaria: o Postgres também confere linhas ATUALIZADAS.
    const [[{ cutoff }]] = await q("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cutoff;");
    const legacy = `created_at < TIMESTAMPTZ '${cutoff}'`;

    // --- §15 Intercompany ----------------------------------------------------------------
    const ict = { tableName: 'intercompany_transfers', schema: 'finance' };
    await q('ALTER TABLE "finance"."intercompany_transfers" ALTER COLUMN from_entry_id DROP NOT NULL;');
    await q('ALTER TABLE "finance"."intercompany_transfers" ALTER COLUMN to_entry_id DROP NOT NULL;');
    await queryInterface.addColumn(ict, 'evidence_file_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn(ict, 'from_bank_account_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'bank_accounts', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn(ict, 'to_bank_account_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'bank_accounts', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    for (const col of ['requested_by_user_id', 'approved_by_user_id', 'rejected_by_user_id']) {
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.addColumn(ict, col, {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      });
    }
    await queryInterface.addColumn(ict, 'approved_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(ict, 'rejected_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn(ict, 'rejection_reason', { type: Sequelize.TEXT, allowNull: true });
    await q(`
      ALTER TABLE "finance"."intercompany_transfers"
        ADD CONSTRAINT intercompany_transfers_status_ck
        CHECK (status IN ('PENDING_APPROVAL', 'REJECTED', 'PENDING', 'RECONCILED'));
    `);
    await q(`
      ALTER TABLE "finance"."intercompany_transfers"
        ADD CONSTRAINT intercompany_transfers_legs_after_approval_ck
        CHECK (status IN ('PENDING_APPROVAL', 'REJECTED') OR (from_entry_id IS NOT NULL AND to_entry_id IS NOT NULL));
    `);
    await q(`
      ALTER TABLE "finance"."intercompany_transfers"
        ADD CONSTRAINT intercompany_transfers_maker_checker_ck
        CHECK (approved_by_user_id IS NULL OR requested_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id);
    `);
    // Linhas antigas (criadas antes desta regra) não têm documento/motivo/contas — ver `legacy`.
    await q(`
      ALTER TABLE "finance"."intercompany_transfers"
        ADD CONSTRAINT intercompany_transfers_formal_requirements_ck
        CHECK (
          ${legacy} OR (
          reason IS NOT NULL AND btrim(reason) <> ''
          AND evidence_file_id IS NOT NULL
          AND from_bank_account_id IS NOT NULL
          AND to_bank_account_id IS NOT NULL
          AND requested_by_user_id IS NOT NULL
        ));
    `);

    // --- §14 Comissões ---------------------------------------------------------------------
    const com = { tableName: 'commissions', schema: 'finance' };
    await queryInterface.addColumn(com, 'source_entry_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn(com, 'component', { type: Sequelize.STRING(32), allowNull: true });
    await q(`
      ALTER TABLE "finance"."commissions"
        ADD CONSTRAINT commissions_rule_fact_component_ck
        CHECK (${legacy} OR (rule_version_id IS NOT NULL AND source_entry_id IS NOT NULL AND component IN ('BROKER', 'MANAGER', 'CORRESPONDENT')));
    `);
    await q(`
      ALTER TABLE "finance"."commissions"
        ADD CONSTRAINT commissions_rule_version_fk FOREIGN KEY (rule_version_id)
        REFERENCES "core"."rule_versions"(id) ON DELETE RESTRICT NOT VALID;
    `);

    // --- §12 Repasses ----------------------------------------------------------------------
    const rep = { tableName: 'owner_repasses', schema: 'finance' };
    await queryInterface.addColumn(rep, 'financial_entry_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addColumn(rep, 'paid_at', { type: Sequelize.DATE, allowNull: true });
    await q(`
      CREATE UNIQUE INDEX IF NOT EXISTS owner_repasses_financial_entry_uq
        ON "finance"."owner_repasses" (financial_entry_id) WHERE financial_entry_id IS NOT NULL;
    `);
    // Nenhum repasse vira PAID sem o lançamento a pagar por trás (linhas antigas: ver `legacy`).
    await q(`
      ALTER TABLE "finance"."owner_repasses"
        ADD CONSTRAINT owner_repasses_paid_requires_entry_ck
        CHECK (${legacy} OR status <> 'PAID' OR financial_entry_id IS NOT NULL);
    `);

    // --- §4 Plano de contas versionado -----------------------------------------------------
    await queryInterface.createTable(
      { tableName: 'chart_of_account_versions', schema: 'finance' },
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
        group_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        chart_of_account_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'chart_of_accounts', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
        },
        version_number: { type: Sequelize.INTEGER, allowNull: false },
        code: { type: Sequelize.STRING(32), allowNull: false },
        name: { type: Sequelize.STRING(255), allowNull: false },
        account_type: { type: Sequelize.STRING(16), allowNull: false },
        parent_account_id: { type: Sequelize.UUID, allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false },
        change_reason: { type: Sequelize.TEXT, allowNull: true },
        effective_from: { type: Sequelize.DATE, allowNull: false },
        effective_until: { type: Sequelize.DATE, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await q(`
      CREATE UNIQUE INDEX chart_of_account_versions_number_uq
        ON "finance"."chart_of_account_versions" (chart_of_account_id, version_number);
    `);
    await q(`
      CREATE UNIQUE INDEX chart_of_account_versions_one_open_uq
        ON "finance"."chart_of_account_versions" (chart_of_account_id) WHERE effective_until IS NULL;
    `);

    // Backfill: v1 de cada conta existente, vigente desde a criação. chart_of_accounts tem
    // FORCE RLS inclusive para o dono — mesmo procedimento da migration 253.
    await q('ALTER TABLE "finance"."chart_of_accounts" NO FORCE ROW LEVEL SECURITY');
    try {
      await q(`
        INSERT INTO "finance"."chart_of_account_versions"
          (group_id, company_id, chart_of_account_id, version_number, code, name, account_type,
           parent_account_id, is_active, change_reason, effective_from, effective_until, created_by, created_at)
        SELECT a.group_id, a.company_id, a.id, 1, a.code, a.name, a.account_type,
               a.parent_account_id, a.is_active, 'Versão inicial (backfill da migration 400)',
               a.created_at, NULL, a.created_by, now()
        FROM "finance"."chart_of_accounts" a;
      `);
    } finally {
      await q('ALTER TABLE "finance"."chart_of_accounts" FORCE ROW LEVEL SECURITY');
    }

    await q('ALTER TABLE "finance"."chart_of_account_versions" ENABLE ROW LEVEL SECURITY;');
    await q('ALTER TABLE "finance"."chart_of_account_versions" FORCE ROW LEVEL SECURITY;');
    await q(`
      CREATE POLICY tenant_isolation ON "finance"."chart_of_account_versions"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // Append-only: nunca DELETE; UPDATE só fecha a vigência (effective_until de NULL para um
    // valor, uma única vez). Nenhum outro campo de uma versão muda depois de criada.
    await q(`
      CREATE OR REPLACE FUNCTION ${VERSION_FUNCTION}()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'finance.chart_of_account_versions é append-only: DELETE não é permitido (id=%).', OLD.id
            USING ERRCODE = '23514';
        END IF;
        IF OLD.effective_until IS NOT NULL
           OR NEW.effective_until IS NULL
           OR (to_jsonb(NEW) - 'effective_until') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_until') THEN
          RAISE EXCEPTION 'finance.chart_of_account_versions é append-only: só é permitido encerrar a vigência de uma versão aberta (id=%).', OLD.id
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await q(`
      DROP TRIGGER IF EXISTS ${VERSION_TRIGGER} ON "finance"."chart_of_account_versions";
      CREATE TRIGGER ${VERSION_TRIGGER}
        BEFORE UPDATE OR DELETE ON "finance"."chart_of_account_versions"
        FOR EACH ROW EXECUTE FUNCTION ${VERSION_FUNCTION}();
    `);

    // --- Permissão de governança do plano de contas ----------------------------------------
    await q(`
      INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
      SELECT gen_random_uuid(), 'finance:chartOfAccounts',
             'Governança do plano de contas: criar, versionar e desativar contas contábeis.', 'HIGH', now(), now()
      WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = 'finance:chartOfAccounts');
    `);
    await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    try {
      await q(`
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r
        CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN'
          AND p.code = 'finance:chartOfAccounts'
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);
      `);
    } finally {
      await q('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    }

    const [[{ exists: runtimeExists }]] = await q(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await q('GRANT SELECT, INSERT, UPDATE ON "finance"."chart_of_account_versions" TO nayara_runtime;');
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TRIGGER IF EXISTS ${VERSION_TRIGGER} ON "finance"."chart_of_account_versions";`);
    await q(`DROP FUNCTION IF EXISTS ${VERSION_FUNCTION}();`);
    await q('DROP TABLE IF EXISTS "finance"."chart_of_account_versions";');
    await q('ALTER TABLE "finance"."owner_repasses" DROP CONSTRAINT IF EXISTS owner_repasses_paid_requires_entry_ck;');
    await q('DROP INDEX IF EXISTS "finance".owner_repasses_financial_entry_uq;');
    await queryInterface.removeColumn({ tableName: 'owner_repasses', schema: 'finance' }, 'paid_at');
    await queryInterface.removeColumn({ tableName: 'owner_repasses', schema: 'finance' }, 'financial_entry_id');
    await q('ALTER TABLE "finance"."commissions" DROP CONSTRAINT IF EXISTS commissions_rule_version_fk;');
    await q('ALTER TABLE "finance"."commissions" DROP CONSTRAINT IF EXISTS commissions_rule_fact_component_ck;');
    await queryInterface.removeColumn({ tableName: 'commissions', schema: 'finance' }, 'component');
    await queryInterface.removeColumn({ tableName: 'commissions', schema: 'finance' }, 'source_entry_id');
    for (const c of [
      'intercompany_transfers_formal_requirements_ck',
      'intercompany_transfers_maker_checker_ck',
      'intercompany_transfers_legs_after_approval_ck',
      'intercompany_transfers_status_ck',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await q(`ALTER TABLE "finance"."intercompany_transfers" DROP CONSTRAINT IF EXISTS ${c};`);
    }
    for (const col of [
      'rejection_reason', 'rejected_at', 'approved_at', 'rejected_by_user_id', 'approved_by_user_id',
      'requested_by_user_id', 'to_bank_account_id', 'from_bank_account_id', 'evidence_file_id',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.removeColumn({ tableName: 'intercompany_transfers', schema: 'finance' }, col);
    }
  },
};
