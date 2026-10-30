'use strict';

/**
 * M9-D423 — marketing.reminder_pendings: as pendências abertas que a série de lembretes acompanha (documento faltando, restrição cadastral, regularização de financiamento,
 * ligadas a oportunidade, financiamento ou contrato). Quem abre, resolve ou cancela a pendência publica crm.pending.opened, crm.pending.resolved ou crm.pending.cancelled;
 * o Marketing guarda só o necessário para lembrar: a pessoa, o tipo (nunca o motivo), a origem, o responsável e as datas. O motivo sensível fica no portal autenticado.
 *
 * RLS FORCE por grupo e empresa (fail-closed); GRANT ao nayara_runtime só se o role existir (SELECT, INSERT, UPDATE). Idempotente, numa transação. O down recusa se houver dado.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS marketing.reminder_pendings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        pending_ref varchar(80) NOT NULL,
        person_id uuid NOT NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        kind varchar(24) NOT NULL,
        source_type varchar(24) NOT NULL,
        source_id uuid NULL,
        responsible_user_id uuid NULL,
        status varchar(12) NOT NULL DEFAULT 'OPEN',
        opened_at timestamptz NOT NULL,
        closed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mkt_reminder_pendings_ref_uq UNIQUE (company_id, pending_ref),
        CONSTRAINT mkt_reminder_pendings_kind_chk CHECK (kind IN ('DOCUMENT','RESTRICTION','REGULARIZATION')),
        CONSTRAINT mkt_reminder_pendings_source_chk CHECK (source_type IN ('OPPORTUNITY','FINANCING','CONTRACT')),
        CONSTRAINT mkt_reminder_pendings_status_chk CHECK (status IN ('OPEN','RESOLVED','CANCELLED')),
        CONSTRAINT mkt_reminder_pendings_closed_chk CHECK ((status = 'OPEN') = (closed_at IS NULL))
      )`);
      await q("CREATE INDEX IF NOT EXISTS mkt_reminder_pendings_open_idx ON marketing.reminder_pendings (company_id, opened_at) WHERE status = 'OPEN'");
      await q('CREATE INDEX IF NOT EXISTS mkt_reminder_pendings_person_idx ON marketing.reminder_pendings (company_id, person_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_reminder_pendings_group_idx ON marketing.reminder_pendings (group_id)');
      await q('ALTER TABLE marketing.reminder_pendings ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE marketing.reminder_pendings FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON marketing.reminder_pendings');
      await q(`CREATE POLICY tenant_isolation ON marketing.reminder_pendings
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) {
        await q('GRANT USAGE ON SCHEMA marketing TO nayara_runtime');
        await q('GRANT SELECT, INSERT, UPDATE ON marketing.reminder_pendings TO nayara_runtime');
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ reg }]] = await sequelize.query("SELECT to_regclass('marketing.reminder_pendings') AS reg", { transaction });
      if (reg) {
        const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM marketing.reminder_pendings', { transaction });
        if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} pendência(s) em marketing.reminder_pendings; o histórico dos lembretes não é apagado.`);
      }
      await sequelize.query('DROP TABLE IF EXISTS marketing.reminder_pendings', { transaction });
    });
  },
};
