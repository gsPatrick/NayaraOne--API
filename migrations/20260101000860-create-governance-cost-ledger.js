'use strict';

/**
 * M9-D860 — governance.cost_ledger: o livro-razão dos gastos técnicos (nuvem, provider, IA, storage, egress, mensageria).
 * Dinheiro em centavos inteiros (`amount_cents bigint`); `cost_kind` separa ESTIMATED de BILLED (nunca somados); `line_type` CHARGE ou CREDIT.
 * Negativo só em CREDIT de BILLED (fatura de crédito). Unicidade com empresa (nula = custo compartilhado) e domínio, para a fatura repetida
 * não duplicar e as linhas de domínios diferentes da mesma fatura não colidirem. `superseded_by` marca o ESTIMATED que a fatura substituiu.
 *
 * Também cria `governance.apply_group_rls(regclass)`: RLS + FORCE pelo GRUPO, com a empresa opcional (company_id nulo = custo compartilhado
 * do grupo; com company_id preenchido, só a empresa da sessão enxerga). GRANT ao nayara_runtime protegido por existência do role.
 */
const FN = `
CREATE OR REPLACE FUNCTION governance.apply_group_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = p_table AND polname = 'tenant_isolation') THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (group_id = NULLIF(current_setting(''app.group_id'', true), '''')::uuid AND (company_id IS NULL OR company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid)) WITH CHECK (group_id = NULLIF(current_setting(''app.group_id'', true), '''')::uuid AND (company_id IS NULL OR company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid))',
      p_table);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO nayara_runtime', p_table);
  END IF;
END
$fn$;`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(FN);
      await q(`CREATE TABLE IF NOT EXISTS governance.cost_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        environment varchar(8) NOT NULL,
        domain varchar(40) NOT NULL,
        category varchar(14) NOT NULL,
        service varchar(120) NOT NULL,
        usage_quantity numeric(30,6) NOT NULL DEFAULT 0,
        usage_unit varchar(20) NOT NULL DEFAULT 'unit',
        amount_cents bigint NOT NULL,
        currency char(3) NOT NULL DEFAULT 'BRL',
        cost_kind varchar(9) NOT NULL,
        line_type varchar(6) NOT NULL DEFAULT 'CHARGE',
        period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL,
        source_ref varchar(200) NOT NULL,
        superseded_by uuid NULL REFERENCES governance.cost_ledger(id) ON UPDATE CASCADE ON DELETE SET NULL,
        collected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_cost_ledger_env_chk CHECK (environment IN ('PROD', 'HOMOLOG', 'DEV')),
        CONSTRAINT gov_cost_ledger_cat_chk CHECK (category IN ('CLOUD_SERVICE', 'PROVIDER', 'AI', 'STORAGE', 'EGRESS', 'MESSAGING')),
        CONSTRAINT gov_cost_ledger_kind_chk CHECK (cost_kind IN ('ESTIMATED', 'BILLED')),
        CONSTRAINT gov_cost_ledger_line_chk CHECK (line_type IN ('CHARGE', 'CREDIT')),
        CONSTRAINT gov_cost_ledger_cur_chk CHECK (currency = 'BRL'),
        CONSTRAINT gov_cost_ledger_amount_chk CHECK (amount_cents >= 0 OR (line_type = 'CREDIT' AND cost_kind = 'BILLED')),
        CONSTRAINT gov_cost_ledger_period_chk CHECK (period_end >= period_start),
        CONSTRAINT gov_cost_ledger_usage_chk CHECK (usage_quantity >= 0),
        CONSTRAINT gov_cost_ledger_super_chk CHECK (superseded_by IS NULL OR cost_kind = 'ESTIMATED')
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS gov_cost_ledger_key_uq ON governance.cost_ledger
        (group_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), environment, domain, category, service, period_start, period_end, cost_kind, source_ref)`);
      await q('CREATE INDEX IF NOT EXISTS gov_cost_ledger_period_idx ON governance.cost_ledger (group_id, cost_kind, period_start) WHERE superseded_by IS NULL');
      await q("SELECT governance.apply_group_rls('governance.cost_ledger'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.cost_ledger');
  },
};
