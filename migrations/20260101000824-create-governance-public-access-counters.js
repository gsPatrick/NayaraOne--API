'use strict';

/**
 * M9-D823 — governance.public_access_counters: o contador de acessos por minuto das rotas SEM login (hoje /public/share/:token), por IP. Fica no banco, e não na memória
 * do processo, para N processos da API somarem no mesmo contador (janela fixa de 60 s pelo relógio do banco, incremento atômico por ON CONFLICT). Não tem empresa (o
 * visitante é anônimo): RLS + FORCE com uma política que só abre quando a transação liga `app.public_counter = 'on'` (o limitador). GRANT ao role de runtime só se ele existir.
 * Reversível. (M9-D843 pode generalizar este contador.)
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.public_access_counters (
        scope_key varchar(200) NOT NULL,
        window_start timestamptz NOT NULL,
        hits integer NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_key, window_start)
      )`);
      await q('ALTER TABLE governance.public_access_counters ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.public_access_counters FORCE ROW LEVEL SECURITY');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.public_access_counters'::regclass AND polname = 'public_counter_writer') THEN
          CREATE POLICY public_counter_writer ON governance.public_access_counters
            USING (current_setting('app.public_counter', true) = 'on') WITH CHECK (current_setting('app.public_counter', true) = 'on');
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.public_access_counters TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.public_access_counters');
  },
};
