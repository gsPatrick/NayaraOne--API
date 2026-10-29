'use strict';

/**
 * M9-D810 — governance.lineage_nodes: os nós do registro de lineage (campo de origem, campo de domínio, evento, read model, métrica, exportação).
 * O registro é do GRUPO (catálogo técnico igual para as empresas, sem dado de negócio): a RLS isola pelo grupo da sessão (`app.group_id`), ENABLE + FORCE,
 * política `tenant_isolation`, GRANT ao role de runtime só se ele existir. Código único por tipo dentro do grupo. `source` diz quem manda no nó: SEED (semente)
 * ou API (editado pela área; a semente não sobrescreve). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.lineage_nodes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        node_type varchar(20) NOT NULL,
        code varchar(200) NOT NULL,
        description text NOT NULL,
        owner_domain varchar(40) NOT NULL,
        criticality varchar(10) NOT NULL DEFAULT 'NORMAL',
        area varchar(20) NOT NULL,
        source varchar(4) NOT NULL DEFAULT 'API',
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        updated_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_lineage_node_uq UNIQUE (group_id, node_type, code),
        CONSTRAINT gov_lineage_node_type_chk CHECK (node_type IN ('SOURCE_FIELD', 'DOMAIN_FIELD', 'EVENT', 'READ_MODEL', 'METRIC', 'EXPORT')),
        CONSTRAINT gov_lineage_node_crit_chk CHECK (criticality IN ('NORMAL', 'CRITICAL')),
        CONSTRAINT gov_lineage_node_area_chk CHECK (area IN ('MONEY', 'CONTRACT', 'COMMISSION', 'DIMOB', 'EXEC_KPI', 'MIGRATION', 'OTHER')),
        CONSTRAINT gov_lineage_node_source_chk CHECK (source IN ('SEED', 'API')),
        CONSTRAINT gov_lineage_node_locked_chk CHECK (area = 'OTHER' OR criticality = 'CRITICAL'),
        CONSTRAINT gov_lineage_node_owner_chk CHECK (length(btrim(owner_domain)) > 0 AND length(btrim(description)) > 0)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_lineage_node_area_idx ON governance.lineage_nodes (group_id, area, node_type)');
      await q('ALTER TABLE governance.lineage_nodes ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.lineage_nodes FORCE ROW LEVEL SECURITY');
      await q(`DO $do$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.lineage_nodes'::regclass AND polname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON governance.lineage_nodes
            USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid) WITH CHECK (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.lineage_nodes TO nayara_runtime;
        END IF;
      END $do$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.lineage_nodes');
  },
};
