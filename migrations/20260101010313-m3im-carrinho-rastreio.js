'use strict';

/**
 * Marco 3 §14 ("Gera link/coleção com expiração e tracking"; "Visualização/clique podem gerar eventos para CRM"): rastreio do
 * carrinho em crm.cart_events, uma linha por visualização do link e por clique num imóvel, com a versão vista (o carrinho é
 * versionado "para saber o que foi enviado"). Antes, o rastreio existia só como evento no outbox (que tem retenção própria) e a
 * tela não tinha de onde ler. Histórico: append-only (gatilho recusa UPDATE e DELETE; o runtime só tem SELECT e INSERT).
 * RLS por empresa como crm.carts. Nenhum dado existente muda. Desfazer: apaga a tabela (o outbox continua com os eventos).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE TABLE IF NOT EXISTS crm.cart_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES core.groups(id) ON DELETE RESTRICT,
      company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
      cart_id uuid NOT NULL REFERENCES crm.carts(id) ON DELETE RESTRICT,
      version_number integer NOT NULL,
      event_type varchar(20) NOT NULL CHECK (event_type IN ('VIEWED', 'PROPERTY_CLICKED')),
      property_id uuid NULL REFERENCES real_estate.properties(id) ON DELETE RESTRICT,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT cart_events_click_has_property CHECK (event_type <> 'PROPERTY_CLICKED' OR property_id IS NOT NULL)
    )`);
    await q('CREATE INDEX IF NOT EXISTS cart_events_cart_idx ON crm.cart_events (cart_id, occurred_at DESC)');
    await q(`CREATE OR REPLACE FUNCTION crm.cart_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'CART_EVENTS_APPEND_ONLY: crm.cart_events é rastreio append-only (% não permitido)', TG_OP USING ERRCODE = 'insufficient_privilege';
      END $fn$`);
    await q('DROP TRIGGER IF EXISTS cart_events_immutable_trg ON crm.cart_events');
    await q('CREATE TRIGGER cart_events_immutable_trg BEFORE UPDATE OR DELETE ON crm.cart_events FOR EACH ROW EXECUTE FUNCTION crm.cart_events_immutable()');
    await q('ALTER TABLE crm.cart_events ENABLE ROW LEVEL SECURITY');
    await q('ALTER TABLE crm.cart_events FORCE ROW LEVEL SECURITY');
    await q('DROP POLICY IF EXISTS tenant_isolation ON crm.cart_events');
    await q(`CREATE POLICY tenant_isolation ON crm.cart_events
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
    await q(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        REVOKE ALL ON crm.cart_events FROM nayara_runtime;
        GRANT SELECT, INSERT ON crm.cart_events TO nayara_runtime;
      END IF;
    END $$`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS crm.cart_events');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS crm.cart_events_immutable()');
  },
};
