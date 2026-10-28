'use strict';

/**
 * M9-D801 — Calendário operacional unificado: `governance.calendar_items` (read model, uma linha por item de origem) e
 * `governance.calendar_commitments` (origem dos compromissos avulsos).
 *
 *  - `calendar_items` guarda só as colunas da lista única do §3.1 (nenhuma outra demanda acrescenta coluna) e o
 *    UNIQUE (company_id, source_type, source_id) que garante "um item por origem" mesmo com evento repetido.
 *  - "Vencido" NÃO é coluna: é derivado na leitura (status = OPEN e due_at < now()).
 *  - As duas tabelas usam governance.apply_tenant_rls (M9-D800): RLS + FORCE RLS + política por company_id + GRANT guardado
 *    por IF EXISTS do role nayara_runtime.
 *
 * Idempotente, em transação única. O down remove as duas tabelas.
 */
const SOURCE_TYPES = ['CRM_TASK', 'VISIT', 'LEGAL_DEADLINE', 'RENEWAL', 'GUARANTEE', 'BILLING', 'CONSTRUCTION', 'MAINTENANCE', 'FISCAL', 'COMMITMENT'];
const STATUSES = ['OPEN', 'DONE', 'CANCELLED'];
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];
const list = (arr) => arr.map((v) => `'${v}'`).join(', ');

const common = `
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,`;
const stamps = `
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`;

module.exports = {
  SOURCE_TYPES,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });

      await q(`CREATE TABLE IF NOT EXISTS governance.calendar_commitments (${common}
        title varchar(300) NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        owner_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        status varchar(12) NOT NULL DEFAULT 'OPEN',${stamps},
        CONSTRAINT gov_cal_commitments_title_chk CHECK (length(btrim(title)) > 0),
        CONSTRAINT gov_cal_commitments_period_chk CHECK (ends_at > starts_at),
        CONSTRAINT gov_cal_commitments_status_chk CHECK (status IN (${list(STATUSES)}))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_cal_commitments_company_start_idx ON governance.calendar_commitments (company_id, starts_at)');
      await q('CREATE INDEX IF NOT EXISTS gov_cal_commitments_owner_idx ON governance.calendar_commitments (owner_user_id)');
      await q("SELECT governance.apply_tenant_rls('governance.calendar_commitments'::regclass)");

      await q(`CREATE TABLE IF NOT EXISTS governance.calendar_items (${common}
        source_type varchar(20) NOT NULL,
        source_id uuid NOT NULL,
        title varchar(300) NOT NULL,
        owner_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        owner_team text NULL,
        due_at timestamptz NOT NULL,
        end_at timestamptz NULL,
        severity varchar(10) NOT NULL DEFAULT 'INFO',
        status varchar(12) NOT NULL DEFAULT 'OPEN',
        deep_link text NOT NULL,
        source_kind text NULL,
        cancel_reason text NULL,
        projection_version integer NOT NULL DEFAULT 1,
        last_event_id uuid NULL,
        last_event_occurred_at timestamptz NULL,${stamps},
        CONSTRAINT gov_cal_items_source_uq UNIQUE (company_id, source_type, source_id),
        CONSTRAINT gov_cal_items_source_type_chk CHECK (source_type IN (${list(SOURCE_TYPES)})),
        CONSTRAINT gov_cal_items_status_chk CHECK (status IN (${list(STATUSES)})),
        CONSTRAINT gov_cal_items_severity_chk CHECK (severity IN (${list(SEVERITIES)})),
        CONSTRAINT gov_cal_items_title_chk CHECK (length(btrim(title)) > 0),
        CONSTRAINT gov_cal_items_window_chk CHECK (end_at IS NULL OR end_at >= due_at),
        CONSTRAINT gov_cal_items_deep_link_chk CHECK (deep_link ~ '^/[A-Za-z0-9_./-]*$' AND deep_link !~ '//'),
        CONSTRAINT gov_cal_items_version_chk CHECK (projection_version >= 1)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_cal_items_company_due_idx ON governance.calendar_items (company_id, due_at, id)');
      await q('CREATE INDEX IF NOT EXISTS gov_cal_items_company_source_status_idx ON governance.calendar_items (company_id, source_type, status)');
      await q('CREATE INDEX IF NOT EXISTS gov_cal_items_owner_idx ON governance.calendar_items (company_id, owner_user_id, due_at)');
      await q("SELECT governance.apply_tenant_rls('governance.calendar_items'::regclass)");
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP TABLE IF EXISTS governance.calendar_items', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS governance.calendar_commitments', { transaction });
    });
  },
};
