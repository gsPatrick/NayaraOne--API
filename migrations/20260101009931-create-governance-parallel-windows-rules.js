'use strict';

/**
 * M9-D903 — comparação paralela antigo x novo. governance.parallel_windows (janela: início e fim, entidades, intervalo, estado SCHEDULED|RUNNING|CLOSED) e
 * governance.parallel_rules (uma regra por campo mapeado: EXACT, MONEY, DATE, NUMERIC, ENUM_MAP, IGNORE). Dinheiro tem sempre tolerância 0 (CHECK). RLS + FORCE pela função do
 * alicerce (que também dá o GRANT ao runtime, só se o role existir). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.parallel_windows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        name varchar(120) NULL,
        source_system varchar(40) NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        entities jsonb NOT NULL,
        interval_min integer NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'SCHEDULED',
        created_by uuid NULL,
        closed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT parallel_windows_status_chk CHECK (status IN ('SCHEDULED', 'RUNNING', 'CLOSED')),
        CONSTRAINT parallel_windows_period_chk CHECK (ends_at > starts_at),
        CONSTRAINT parallel_windows_interval_chk CHECK (interval_min > 0)
      )`);
      await q('CREATE INDEX IF NOT EXISTS parallel_windows_company_status_idx ON governance.parallel_windows (company_id, status)');
      await q("SELECT governance.apply_tenant_rls('governance.parallel_windows'::regclass)");
      await q(`CREATE TABLE IF NOT EXISTS governance.parallel_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        window_id uuid NOT NULL REFERENCES governance.parallel_windows(id) ON UPDATE CASCADE ON DELETE CASCADE,
        entity varchar(30) NOT NULL,
        field varchar(80) NOT NULL,
        rule varchar(10) NOT NULL,
        tolerance numeric(24, 8) NOT NULL DEFAULT 0,
        enum_map jsonb NULL,
        options jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT parallel_rules_rule_chk CHECK (rule IN ('EXACT', 'MONEY', 'DATE', 'NUMERIC', 'ENUM_MAP', 'IGNORE')),
        CONSTRAINT parallel_rules_tolerance_chk CHECK (tolerance >= 0 AND (rule = 'NUMERIC' OR tolerance = 0)),
        CONSTRAINT parallel_rules_enum_chk CHECK ((rule = 'ENUM_MAP') = (enum_map IS NOT NULL)),
        CONSTRAINT parallel_rules_field_uq UNIQUE (window_id, entity, field)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.parallel_rules'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.parallel_rules');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.parallel_windows');
  },
};
