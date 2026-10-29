'use strict';

/**
 * M9-D431 — atribuição (MKT-012): first-touch e last-touch com evidência.
 *
 * 1. crm.opportunities: lead_source, campaign_id, tracking_link_id e attribution_valid (referência de rastreio da origem do lead;
 *    attribution_valid = false quando a referência informada não existe, é de outra empresa ou não estava ativa na data do clique).
 *    Sem FK entre schemas: o serviço de atribuição confere a referência.
 * 2. marketing.attribution_events: dedupe_key (um CLICK por link, sessão e minuto; um LEAD_CREATED e um SALE por oportunidade) com
 *    índice único parcial por empresa, e índice único de SALE por oportunidade.
 * 3. marketing.resolve_tracking_link(short_code): função SECURITY DEFINER para a rota pública GET /t/:shortCode localizar o link
 *    (e a empresa dele) ANTES de abrir a sessão do tenant; devolve só o necessário e nunca lista links.
 *
 * Sem tabela nova (RLS e GRANT da 751 valem). EXECUTE da função só para os papéis de runtime existentes (guarda de existência).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS lead_source varchar(40) NULL');
      await q('ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS campaign_id uuid NULL');
      await q('ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS tracking_link_id uuid NULL');
      await q('ALTER TABLE crm.opportunities ADD COLUMN IF NOT EXISTS attribution_valid boolean NULL');
      await q('ALTER TABLE marketing.attribution_events ADD COLUMN IF NOT EXISTS dedupe_key varchar(200) NULL');
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS mkt_attribution_events_dedupe_uq
        ON marketing.attribution_events (company_id, dedupe_key) WHERE dedupe_key IS NOT NULL`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS mkt_attribution_events_one_sale_uq
        ON marketing.attribution_events (company_id, opportunity_id) WHERE event_type = 'SALE' AND opportunity_id IS NOT NULL`);
      await q(`CREATE OR REPLACE FUNCTION marketing.resolve_tracking_link(p_short_code text)
        RETURNS TABLE (id uuid, group_id uuid, company_id uuid)
        LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, marketing AS $f$
          SELECT t.id, t.group_id, t.company_id FROM marketing.tracking_links t
           WHERE t.short_code = p_short_code AND t.deleted_at IS NULL LIMIT 1
        $f$`);
      await q('REVOKE ALL ON FUNCTION marketing.resolve_tracking_link(text) FROM PUBLIC');
      const [roles] = await sequelize.query("SELECT rolname FROM pg_roles WHERE rolname IN ('nayara_runtime', 'nayara_ci', 'nayara_ci_app')", { transaction });
      for (const r of roles) await q(`GRANT EXECUTE ON FUNCTION marketing.resolve_tracking_link(text) TO ${r.rolname}`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const [[{ n }]] = await sequelize.query(
        'SELECT count(*)::int AS n FROM marketing.attribution_events WHERE dedupe_key IS NOT NULL', { transaction });
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} evento(s) de atribuição com dedupe_key; o down não apaga dados.`);
      await q('DROP FUNCTION IF EXISTS marketing.resolve_tracking_link(text)');
      await q('DROP INDEX IF EXISTS marketing.mkt_attribution_events_one_sale_uq');
      await q('DROP INDEX IF EXISTS marketing.mkt_attribution_events_dedupe_uq');
      await q('ALTER TABLE marketing.attribution_events DROP COLUMN IF EXISTS dedupe_key');
      await q('ALTER TABLE crm.opportunities DROP COLUMN IF EXISTS attribution_valid');
      await q('ALTER TABLE crm.opportunities DROP COLUMN IF EXISTS tracking_link_id');
      await q('ALTER TABLE crm.opportunities DROP COLUMN IF EXISTS campaign_id');
      await q('ALTER TABLE crm.opportunities DROP COLUMN IF EXISTS lead_source');
    });
  },
};
