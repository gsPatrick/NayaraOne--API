'use strict';

/**
 * M9-D810 — governance.lineage_edges: as ligações do registro de lineage entre nós de camadas vizinhas (a ordem das camadas é validada pelo serviço, na mesma
 * transação da gravação). Única por par de nós dentro do grupo. RLS por grupo (ENABLE + FORCE, política `tenant_isolation`), GRANT ao role de runtime só se existir.
 * Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.lineage_edges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        from_node_id uuid NOT NULL REFERENCES governance.lineage_nodes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        to_node_id uuid NOT NULL REFERENCES governance.lineage_nodes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        transformation varchar(200) NULL,
        source varchar(4) NOT NULL DEFAULT 'API',
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_lineage_edge_uq UNIQUE (group_id, from_node_id, to_node_id),
        CONSTRAINT gov_lineage_edge_self_chk CHECK (from_node_id <> to_node_id),
        CONSTRAINT gov_lineage_edge_source_chk CHECK (source IN ('SEED', 'API'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_lineage_edge_to_idx ON governance.lineage_edges (group_id, to_node_id)');
      await q('ALTER TABLE governance.lineage_edges ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.lineage_edges FORCE ROW LEVEL SECURITY');
      await q(`DO $do$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.lineage_edges'::regclass AND polname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON governance.lineage_edges
            USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid) WITH CHECK (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.lineage_edges TO nayara_runtime;
        END IF;
      END $do$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.lineage_edges');
  },
};
