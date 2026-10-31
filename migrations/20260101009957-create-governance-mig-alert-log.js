'use strict';

/**
 * M9-D908 §3.5 — governance.mig_alert_log: reserva da chave de cada alerta da migração v2 (janela de comparação vencida). A chave é UNIQUE por empresa: o mesmo alerta nunca sai
 * duas vezes no dia, nem com dois processos rodando o job. RLS + FORCE pela função do alicerce; GRANT ao runtime dentro de guarda de existência do papel. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_alert_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        alert_key text NOT NULL,
        alert_type varchar(32) NOT NULL,
        window_id uuid NULL,
        recipients integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mig_alert_log_key_uq UNIQUE (company_id, alert_key)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.mig_alert_log'::regclass)");
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.mig_alert_log TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_alert_log');
  },
};
