'use strict';

/**
 * Marco 3 §13 ("Match guarda score, critérios atendidos/falhos e rule/version quando aplicável") e Guia §9 ("Salvar radar_match
 * com criteria_version/fingerprint para idempotência"): crm.radar_matches guarda cada match do Radar com o score, os critérios
 * atendidos e os que falharam, a explicação completa, a impressão digital dos critérios (SHA-256) e a versão da pontuação.
 * UNIQUE (radar_id, property_id, criteria_fingerprint): reprocessar o mesmo radar não duplica; critério mudou, nasce outro registro.
 * Histórico imutável: o runtime só recebe SELECT e INSERT; o gatilho BEFORE UPDATE recusa alterar um match gravado (vale mesmo
 * se um GRANT em massa por schema devolver UPDATE ao runtime) e o DELETE sai do runtime também no GRANT em massa
 * (scripts/lib/runtimeNoDelete.js). Radar e imóvel são apagados por soft delete, então o histórico fica; o CASCADE só age na
 * remoção física (limpeza administrativa), feita pelo dono da tabela. RLS + FORCE por company_id (USING e WITH CHECK). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS crm.radar_matches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        radar_id uuid NOT NULL REFERENCES crm.property_radars(id) ON UPDATE CASCADE ON DELETE CASCADE,
        property_id uuid NOT NULL REFERENCES real_estate.properties(id) ON UPDATE CASCADE ON DELETE CASCADE,
        score numeric(5,4) NOT NULL,
        matched_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
        failed_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
        explanation jsonb NOT NULL,
        criteria_fingerprint varchar(64) NOT NULL,
        criteria_version varchar(32) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT radar_matches_score_chk CHECK (score >= 0 AND score <= 1),
        CONSTRAINT radar_matches_unique_fingerprint UNIQUE (radar_id, property_id, criteria_fingerprint)
      )`);
      await q('CREATE INDEX IF NOT EXISTS radar_matches_radar_idx ON crm.radar_matches (radar_id, created_at DESC)');
      await q(`CREATE OR REPLACE FUNCTION crm.radar_matches_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'crm.radar_matches é histórico imutável: alterar um match gravado não é permitido' USING ERRCODE = 'P0001';
        END $fn$`);
      await q('DROP TRIGGER IF EXISTS radar_matches_immutable_trg ON crm.radar_matches');
      await q('CREATE TRIGGER radar_matches_immutable_trg BEFORE UPDATE ON crm.radar_matches FOR EACH ROW EXECUTE FUNCTION crm.radar_matches_immutable()');
      await q('ALTER TABLE crm.radar_matches ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE crm.radar_matches FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON crm.radar_matches');
      await q(`CREATE POLICY tenant_isolation ON crm.radar_matches
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
        WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          REVOKE ALL ON crm.radar_matches FROM nayara_runtime;
          GRANT SELECT, INSERT ON crm.radar_matches TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS crm.radar_matches');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS crm.radar_matches_immutable()');
  },
};
