'use strict';

/**
 * Marco 8 — lacunas apontadas na revisão de 24/10/2026 contra o caderno:
 *  - correspondent.proposals: condições que o banco devolve (valor aprovado, taxa, prazo, validade);
 *  - financing_cases.product: "produto" usado pela elegibilidade (COR_PROVIDER_ELIGIBILITY);
 *  - commission_entitlements: "fato gerador, provider, base e rule_version_id" e o split corretor/gerente.
 * Linhas antigas são preenchidas com o único fato gerador que existia: o registro manual do direito.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'proposals', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        financing_case_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'financing_cases', schema: 'correspondent' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        provider_code: { type: Sequelize.STRING(32), allowNull: false },
        source: { type: Sequelize.STRING(16), allowNull: false },
        approved_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        annual_rate_pct: { type: Sequelize.DECIMAL(7, 4), allowNull: true },
        term_months: { type: Sequelize.INTEGER, allowNull: false },
        monthly_payment: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
        valid_until: { type: Sequelize.DATEONLY, allowNull: true },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'ACTIVE' },
        response_snapshot: { type: Sequelize.JSONB, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await sequelize.query(`ALTER TABLE "correspondent"."proposals"
      ADD CONSTRAINT proposals_source_check CHECK (source IN ('PROVIDER','MANUAL')),
      ADD CONSTRAINT proposals_status_check CHECK (status IN ('ACTIVE','SUPERSEDED')),
      ADD CONSTRAINT proposals_amount_check CHECK (approved_amount > 0),
      ADD CONSTRAINT proposals_term_check CHECK (term_months BETWEEN 1 AND 480),
      ADD CONSTRAINT proposals_rate_check CHECK (annual_rate_pct IS NULL OR (annual_rate_pct >= 0 AND annual_rate_pct <= 100)),
      ADD CONSTRAINT proposals_payment_check CHECK (monthly_payment IS NULL OR monthly_payment > 0);`);
    await sequelize.query('CREATE INDEX proposals_case_idx ON "correspondent"."proposals" (financing_case_id, created_at DESC);');
    await sequelize.query('CREATE UNIQUE INDEX proposals_one_active_per_case_idx ON "correspondent"."proposals" (financing_case_id) WHERE status = \'ACTIVE\';');
    await sequelize.query('ALTER TABLE "correspondent"."proposals" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."proposals" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`CREATE POLICY tenant_isolation ON "correspondent"."proposals"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);

    await queryInterface.addColumn(
      { tableName: 'financing_cases', schema: 'correspondent' },
      'product',
      { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'FINANCIAMENTO_IMOBILIARIO' }
    );

    const cols = {
      provider_code: { type: Sequelize.STRING(32), allowNull: true },
      trigger_event: { type: Sequelize.STRING(40), allowNull: true },
      broker_share_pct: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      manager_share_pct: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      broker_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
      manager_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: true },
    };
    for (const [name, def] of Object.entries(cols)) {
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.addColumn({ tableName: 'commission_entitlements', schema: 'correspondent' }, name, def);
    }
    await sequelize.query(`UPDATE "correspondent"."commission_entitlements" ce
         SET provider_code = fc.provider_code, trigger_event = 'REGISTRO_MANUAL',
             broker_share_pct = 100, manager_share_pct = 0, broker_amount = ce.amount, manager_amount = 0
        FROM "correspondent"."financing_cases" fc WHERE fc.id = ce.financing_case_id;`);
    await sequelize.query(`ALTER TABLE "correspondent"."commission_entitlements"
      ALTER COLUMN provider_code SET NOT NULL, ALTER COLUMN trigger_event SET NOT NULL,
      ALTER COLUMN broker_share_pct SET NOT NULL, ALTER COLUMN manager_share_pct SET NOT NULL,
      ALTER COLUMN broker_amount SET NOT NULL, ALTER COLUMN manager_amount SET NOT NULL,
      ADD CONSTRAINT commission_split_sum_check CHECK (broker_share_pct + manager_share_pct = 100 AND broker_share_pct >= 0 AND manager_share_pct >= 0),
      ADD CONSTRAINT commission_split_amount_check CHECK (broker_amount + manager_amount = amount);`);

    const [[{ exists: runtimeExists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE ON "correspondent"."proposals" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`ALTER TABLE "correspondent"."commission_entitlements"
      DROP CONSTRAINT IF EXISTS commission_split_amount_check, DROP CONSTRAINT IF EXISTS commission_split_sum_check;`);
    for (const c of ['manager_amount', 'broker_amount', 'manager_share_pct', 'broker_share_pct', 'trigger_event', 'provider_code']) {
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.removeColumn({ tableName: 'commission_entitlements', schema: 'correspondent' }, c);
    }
    await queryInterface.removeColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'product');
    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."proposals";');
    await queryInterface.dropTable({ tableName: 'proposals', schema: 'correspondent' });
  },
};
