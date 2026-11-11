'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Verificação M5, linha 124 (Caderno §4 "legal.clause_versions | Versões homologadas"; §17 "Sugere minuta usando biblioteca
 * homologada"; JUR-008 "NAY resume/sugere; decisão jurídica é humana").
 *  1) Homologação da versão da cláusula: homologation_status (PENDING | HOMOLOGATED), homologated_by, homologated_at. Gatilho:
 *     só PENDING -> HOMOLOGATED, uma vez, por pessoa diferente de quem criou a versão. "Ativa" deixa de valer como "homologada".
 *     Legado: versão usada por modelo PUBLICADO por pessoa diferente do autor da versão conta como homologada por esse
 *     publicador (a publicação do modelo já era a aprovação jurídica, legal:approve); as demais ficam PENDING.
 *  2) legal.nay_draft_suggestions: a minuta sugerida pela NAY (texto montado pelo servidor só com versões homologadas, hash, versões
 *     usadas, método IA ou regra, run da IA) fica PENDING_REVIEW até uma pessoa aceitar (vira versão DRAFT do contrato) ou descartar.
 *     Texto e versões não mudam; a decisão é única.
 * Reversível.
 */
const HOMOLOGATION_GUARD = `
  CREATE OR REPLACE FUNCTION legal.clause_versions_homologation_guard() RETURNS trigger AS $$
  BEGIN
    IF NEW.homologation_status IS DISTINCT FROM OLD.homologation_status OR NEW.homologated_by IS DISTINCT FROM OLD.homologated_by
       OR NEW.homologated_at IS DISTINCT FROM OLD.homologated_at THEN
      IF NOT (OLD.homologation_status = 'PENDING' AND NEW.homologation_status = 'HOMOLOGATED' AND OLD.homologated_by IS NULL
              AND NEW.homologated_by IS NOT NULL AND NEW.homologated_at IS NOT NULL AND NEW.homologated_by IS DISTINCT FROM OLD.created_by) THEN
        RAISE EXCEPTION 'legal.clause_versions: a homologação da cláusula % v% vai de PENDING para HOMOLOGATED uma única vez, por quem não criou a versão.', OLD.code, OLD.version_number USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;`;

const SUGGESTION_GUARD = `
  CREATE OR REPLACE FUNCTION legal.nay_draft_suggestions_guard() RETURNS trigger AS $$
  BEGIN
    IF (to_jsonb(NEW) - ARRAY['status','decided_by','decided_at','decision_reason','contract_version_id','updated_at','updated_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','decided_by','decided_at','decision_reason','contract_version_id','updated_at','updated_by']) THEN
      RAISE EXCEPTION 'legal.nay_draft_suggestions: a minuta sugerida não é editada.' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('ACCEPTED','DISCARDED') AND NEW.decided_by IS NOT NULL) THEN
      RAISE EXCEPTION 'legal.nay_draft_suggestions: a decisão sobre a minuta é única (PENDING_REVIEW -> ACCEPTED ou DISCARDED).' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = OLD.status AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.contract_version_id IS DISTINCT FROM OLD.contract_version_id) THEN
      RAISE EXCEPTION 'legal.nay_draft_suggestions: a decisão sobre a minuta não é reescrita.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`ALTER TABLE legal.clause_versions
        ADD COLUMN IF NOT EXISTS homologation_status varchar(16) NOT NULL DEFAULT 'PENDING',
        ADD COLUMN IF NOT EXISTS homologated_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS homologated_at timestamptz NULL`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clause_versions_homologation_chk') THEN
          ALTER TABLE legal.clause_versions ADD CONSTRAINT clause_versions_homologation_chk CHECK (
            (homologation_status = 'PENDING' AND homologated_by IS NULL AND homologated_at IS NULL)
            OR (homologation_status = 'HOMOLOGATED' AND homologated_at IS NOT NULL));
        END IF;
      END $c$`);
      // Legado (antes do gatilho): homologada por quem publicou, com outra pessoa como autora, um modelo que usa a versão.
      await q('ALTER TABLE legal.clause_versions NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE legal.clause_versions DISABLE TRIGGER contract_clauses_append_only');
      const [antes] = await q("SELECT homologation_status, count(*)::int AS n FROM legal.clause_versions GROUP BY 1 ORDER BY 1");
      await q(`UPDATE legal.clause_versions cv SET homologation_status = 'HOMOLOGATED', homologated_by = p.published_by, homologated_at = p.published_at
        FROM (SELECT DISTINCT ON (l.contract_clause_id) l.contract_clause_id, v.published_by, v.published_at
                FROM legal.contract_template_clauses l JOIN legal.template_versions v ON v.id = l.template_version_id
                JOIN legal.clause_versions c ON c.id = l.contract_clause_id
               WHERE v.status IN ('PUBLISHED','SUPERSEDED') AND v.published_by IS NOT NULL AND v.published_by IS DISTINCT FROM c.created_by
               ORDER BY l.contract_clause_id, v.published_at ASC) p
        WHERE cv.id = p.contract_clause_id AND cv.homologation_status = 'PENDING'`);
      const [depois] = await q("SELECT homologation_status, count(*)::int AS n FROM legal.clause_versions GROUP BY 1 ORDER BY 1");
      // eslint-disable-next-line no-console
      console.log(`[20260101015104] versões de cláusula antes ${JSON.stringify(antes)} depois ${JSON.stringify(depois)}`);
      await q('ALTER TABLE legal.clause_versions ENABLE TRIGGER contract_clauses_append_only');
      await q('ALTER TABLE legal.clause_versions FORCE ROW LEVEL SECURITY');
      await q(HOMOLOGATION_GUARD);
      await q('DROP TRIGGER IF EXISTS clause_versions_homologation_guard ON legal.clause_versions');
      await q('CREATE TRIGGER clause_versions_homologation_guard BEFORE UPDATE ON legal.clause_versions FOR EACH ROW EXECUTE FUNCTION legal.clause_versions_homologation_guard()');

      await q(`CREATE TABLE IF NOT EXISTS legal.nay_draft_suggestions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        contract_id uuid NOT NULL REFERENCES legal.contracts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ai_run_id uuid NULL,
        method varchar(16) NOT NULL,
        mode_reason varchar(64) NULL,
        provider_code varchar(60) NULL,
        model_code varchar(120) NULL,
        content text NOT NULL,
        content_hash varchar(64) NOT NULL,
        clause_version_ids jsonb NOT NULL,
        grounding_json jsonb NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING_REVIEW',
        decided_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        decided_at timestamptz NULL,
        decision_reason varchar(500) NULL,
        contract_version_id uuid NULL REFERENCES legal.contract_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT nay_draft_suggestions_method_chk CHECK (method IN ('AI','RULE_BASED')),
        CONSTRAINT nay_draft_suggestions_status_chk CHECK (status IN ('PENDING_REVIEW','ACCEPTED','DISCARDED')),
        CONSTRAINT nay_draft_suggestions_accepted_chk CHECK (status <> 'ACCEPTED' OR contract_version_id IS NOT NULL)
      )`);
      await q('CREATE INDEX IF NOT EXISTS nay_draft_suggestions_contract_idx ON legal.nay_draft_suggestions (company_id, contract_id, created_at DESC)');
      await applyLegalTenantRls(q, 'legal.nay_draft_suggestions');
      await q(SUGGESTION_GUARD);
      await q('DROP TRIGGER IF EXISTS nay_draft_suggestions_guard ON legal.nay_draft_suggestions');
      await q('CREATE TRIGGER nay_draft_suggestions_guard BEFORE UPDATE ON legal.nay_draft_suggestions FOR EACH ROW EXECUTE FUNCTION legal.nay_draft_suggestions_guard()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS legal.nay_draft_suggestions');
      await q('DROP FUNCTION IF EXISTS legal.nay_draft_suggestions_guard()');
      await q('DROP TRIGGER IF EXISTS clause_versions_homologation_guard ON legal.clause_versions');
      await q('DROP FUNCTION IF EXISTS legal.clause_versions_homologation_guard()');
      await q('ALTER TABLE legal.clause_versions DROP CONSTRAINT IF EXISTS clause_versions_homologation_chk');
      await q('ALTER TABLE legal.clause_versions DROP COLUMN IF EXISTS homologated_at, DROP COLUMN IF EXISTS homologated_by, DROP COLUMN IF EXISTS homologation_status');
    });
  },
};
