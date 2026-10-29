'use strict';

/**
 * M9-D810 — governance.lineage_seed_state: o hash do conjunto de sementes já aplicado a cada grupo (uma linha por grupo). A semente de uma demanda nova muda o
 * hash e é aplicada na próxima leitura, sem migration por KPI. RLS por grupo (ENABLE + FORCE, política `tenant_isolation`), GRANT ao role de runtime só se
 * existir. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.lineage_seed_state (
        group_id uuid PRIMARY KEY REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        seed_hash varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await q('ALTER TABLE governance.lineage_seed_state ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.lineage_seed_state FORCE ROW LEVEL SECURITY');
      await q(`DO $do$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.lineage_seed_state'::regclass AND polname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON governance.lineage_seed_state
            USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid) WITH CHECK (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.lineage_seed_state TO nayara_runtime;
        END IF;
      END $do$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.lineage_seed_state');
  },
};
