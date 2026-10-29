'use strict';

/**
 * M9-D843 — governance.rate_limit_counters (UNLOGGED): o contador do limite de requisições (M9-D843 §3.1, R29). Chave (scope_key, window_start), janela fixa de 60 s pelo relógio do
 * banco, incremento atômico por ON CONFLICT: N processos da API somam no mesmo contador. Não tem empresa (a chave já carrega a credencial e a empresa): RLS + FORCE com uma política que
 * só abre quando a transação liga `app.rate_limit = 'on'` (o limitador). O rateLimitCleanupJob apaga janelas com mais de 10 minutos. GRANT ao role de runtime só se ele existir. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE UNLOGGED TABLE IF NOT EXISTS governance.rate_limit_counters (
        scope_key varchar(200) NOT NULL,
        window_start timestamptz NOT NULL,
        count integer NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_key, window_start)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_rate_limit_window_idx ON governance.rate_limit_counters (window_start)');
      await q('ALTER TABLE governance.rate_limit_counters ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.rate_limit_counters FORCE ROW LEVEL SECURITY');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.rate_limit_counters'::regclass AND polname = 'rate_limit_writer') THEN
          CREATE POLICY rate_limit_writer ON governance.rate_limit_counters
            USING (current_setting('app.rate_limit', true) = 'on') WITH CHECK (current_setting('app.rate_limit', true) = 'on');
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.rate_limit_counters TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.rate_limit_counters');
  },
};
