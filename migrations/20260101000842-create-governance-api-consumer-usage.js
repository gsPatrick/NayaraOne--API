'use strict';

/**
 * M9-D841 — governance.api_consumer_usage: o uso da API por consumidor e alvo (M9-D841 §3.1). `target_key` = `ROUTE:<MÉTODO> <caminho com parâmetros>` ou `MAJOR:<n>`; uma linha por
 * (consumidor, alvo), com o último instante visto, atualizada no máximo uma vez por hora. Sem ela "consumidor usando a rota deprecada" não é calculável. RLS + FORCE pela função
 * do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.api_consumer_usage (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        consumer_id uuid NOT NULL REFERENCES governance.api_consumers(id) ON UPDATE CASCADE ON DELETE CASCADE,
        target_key varchar(300) NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_api_usage_uq UNIQUE (consumer_id, target_key)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_api_usage_target_idx ON governance.api_consumer_usage (company_id, target_key, last_seen_at)');
      await q("SELECT governance.apply_tenant_rls('governance.api_consumer_usage'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.api_consumer_usage');
  },
};
