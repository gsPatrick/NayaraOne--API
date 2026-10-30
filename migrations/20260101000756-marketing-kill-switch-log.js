'use strict';

/**
 * M9-D425 — marketing.kill_switch_log: histórico imutável do kill switch do Marketing (quem, quando, escopo, motivo, estado antes e depois).
 * Cada acionamento (ACTIVATE) e cada reativação (RESTORE) que muda o estado de um escopo (GLOBAL, CHANNEL, CAMPAIGN, AUTOMATION) grava uma linha.
 * `source` diz de onde veio o acionamento (MANUAL, INCIDENT_CRITICAL com `incident_id`, COMPROMISED_ACCOUNT): é por ele que a reativação de um
 * acionamento por incidente CRITICAL exige o incidente resolvido. Só INSERT (o gatilho recusa UPDATE e DELETE). RLS FORCE por grupo e empresa
 * (fail-closed); GRANT ao nayara_runtime só se o role existir. `seq` (identidade) dá a ordem exata dos registros, mesmo vários na mesma transação.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS marketing');
      await q(`CREATE TABLE IF NOT EXISTS marketing.kill_switch_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigint GENERATED ALWAYS AS IDENTITY,
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        scope varchar(10) NOT NULL,
        target_id varchar(64) NULL,
        action varchar(10) NOT NULL,
        source varchar(24) NOT NULL DEFAULT 'MANUAL',
        incident_id varchar(64) NULL,
        compromised boolean NOT NULL DEFAULT false,
        reason text NOT NULL,
        actor_user_id uuid NULL,
        active_before boolean NOT NULL,
        active_after boolean NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mkt_kill_log_scope_chk CHECK (scope IN ('GLOBAL','CHANNEL','CAMPAIGN','AUTOMATION')),
        CONSTRAINT mkt_kill_log_action_chk CHECK (action IN ('ACTIVATE','RESTORE')),
        CONSTRAINT mkt_kill_log_source_chk CHECK (source IN ('MANUAL','INCIDENT_CRITICAL','COMPROMISED_ACCOUNT')),
        CONSTRAINT mkt_kill_log_target_chk CHECK ((scope = 'GLOBAL' AND target_id IS NULL) OR (scope <> 'GLOBAL' AND target_id IS NOT NULL)),
        CONSTRAINT mkt_kill_log_incident_chk CHECK (source <> 'INCIDENT_CRITICAL' OR incident_id IS NOT NULL),
        CONSTRAINT mkt_kill_log_reason_chk CHECK (length(btrim(reason)) > 0)
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_kill_log_target_idx ON marketing.kill_switch_log (company_id, scope, target_id, seq DESC)');
      await q('CREATE INDEX IF NOT EXISTS mkt_kill_log_group_idx ON marketing.kill_switch_log (group_id)');

      await q(`CREATE OR REPLACE FUNCTION marketing.kill_switch_log_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'marketing.kill_switch_log é somente de inserção' USING ERRCODE = 'check_violation';
        END
      $fn$`);
      await q('DROP TRIGGER IF EXISTS kill_switch_log_guard ON marketing.kill_switch_log');
      await q(`CREATE TRIGGER kill_switch_log_guard BEFORE UPDATE OR DELETE ON marketing.kill_switch_log
        FOR EACH ROW EXECUTE FUNCTION marketing.kill_switch_log_guard()`);

      await q('ALTER TABLE marketing.kill_switch_log ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE marketing.kill_switch_log FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON marketing.kill_switch_log');
      await q(`CREATE POLICY tenant_isolation ON marketing.kill_switch_log
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);

      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) {
        await q('GRANT USAGE ON SCHEMA marketing TO nayara_runtime');
        await q('GRANT SELECT, INSERT ON marketing.kill_switch_log TO nayara_runtime');
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ reg }]] = await sequelize.query("SELECT to_regclass('marketing.kill_switch_log') AS reg", { transaction });
      if (reg) {
        const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM marketing.kill_switch_log', { transaction });
        if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} registro(s) em marketing.kill_switch_log; o histórico do kill switch não é apagado.`);
      }
      await sequelize.query('DROP TABLE IF EXISTS marketing.kill_switch_log', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS marketing.kill_switch_log_guard()', { transaction });
    });
  },
};
