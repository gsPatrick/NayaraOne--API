'use strict';

/**
 * Verificação M5, linha 69 (Caderno §7 "Imóvel usado: termo específico deixando clara natureza/estado conforme modelo jurídico
 * aprovado"). O texto do termo do imóvel usado sai do código e passa a ser um MODELO de contrato do tipo USED_PROPERTY_DELIVERY,
 * versionado e publicado pela alçada jurídica (mecanismo de modelos e versões da migration 9982).
 *  - legal.template_versions.origin: USER (padrão) ou CODE_SEED (versão inicial com o texto que vigorava no código, sem aprovador
 *    humano). O gatilho de versões passa a aceitar DRAFT -> PUBLISHED sem publicador SÓ para a versão 1 de origem CODE_SEED; todo
 *    o resto da regra do gatilho segue igual (publicação única, PUBLISHED -> SUPERSEDED, versão não editada).
 *  - legal.key_deliveries.term_template_version_id: a versão do modelo usada no termo gravado.
 *  - Dados: cada empresa existente sem modelo ativo do tipo recebe a cláusula TERMO_IMOVEL_USADO (v1, texto atual), o modelo
 *    "Termo de entrega de imóvel usado" e a versão 1 publicada (origem CODE_SEED). Nada existente é alterado.
 * Reversível: o down apaga só o que esta migration criou (sem entrega apontando para ele) e restaura o gatilho anterior.
 */
const BODY = 'O imóvel é entregue usado, no estado descrito na vistoria acima, que faz parte deste termo.';
const CODE = 'TERMO_IMOVEL_USADO';
const NAME = 'Termo de entrega de imóvel usado';
const TABLES = ['core.companies', 'legal.clause_library', 'legal.clause_versions', 'legal.contract_templates', 'legal.template_versions', 'legal.contract_template_clauses', 'legal.key_deliveries'];

const guard = (seedClause) => `
  CREATE OR REPLACE FUNCTION legal.template_versions_guard_update() RETURNS trigger AS $$
  BEGIN
    IF (to_jsonb(NEW) - ARRAY['status','published_by','published_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','published_by','published_at','updated_at']) THEN
      RAISE EXCEPTION 'legal.template_versions: a versão % do modelo % não é editada (crie uma nova versão).', OLD.version_number, OLD.template_id USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      IF NOT (
        (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED' AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
          AND (NEW.published_by IS NOT NULL${seedClause}))
        OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED' AND NEW.published_by IS NOT DISTINCT FROM OLD.published_by AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at)
      ) THEN
        RAISE EXCEPTION 'legal.template_versions: a versão % do modelo % só vai de DRAFT para PUBLISHED (uma vez) e de PUBLISHED para SUPERSEDED.', OLD.version_number, OLD.template_id USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;`;
// Publicação sem publicador (DI-M5CT-4): SÓ a versão 1 de origem CODE_SEED do modelo do termo do imóvel usado cujas cláusulas são todas a
// TERMO_IMOVEL_USADO com o texto da semente (hash do BODY) ou uma versão dela escrita por pessoa (created_by). A semente é gravada também em
// runtime (usedPropertyTermModel.seedModel, empresa criada depois desta migration); uma versão CODE_SEED forjada com outro texto ou outro tipo
// de modelo cai na regra de sempre: publicação com quem publicou (JUR-002).
const SEED_BODY_MD5 = '337c79781a1c14b0d915798b4ebeef67';
const SEED_CLAUSE = ` OR (OLD.origin = 'CODE_SEED' AND OLD.version_number = 1 AND NEW.published_by IS NULL
          AND EXISTS (SELECT 1 FROM legal.contract_templates t WHERE t.id = OLD.template_id AND t.contract_type = 'USED_PROPERTY_DELIVERY')
          AND EXISTS (SELECT 1 FROM legal.contract_template_clauses tc WHERE tc.template_version_id = OLD.id)
          AND NOT EXISTS (SELECT 1 FROM legal.contract_template_clauses tc JOIN legal.clause_versions cv ON cv.id = tc.contract_clause_id
            WHERE tc.template_version_id = OLD.id AND NOT (cv.code = '${CODE}' AND (cv.created_by IS NOT NULL OR md5(cv.body_text) = '${SEED_BODY_MD5}'))))`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q("ALTER TABLE legal.template_versions ADD COLUMN IF NOT EXISTS origin varchar(16) NOT NULL DEFAULT 'USER'");
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'template_versions_origin_chk') THEN
          ALTER TABLE legal.template_versions ADD CONSTRAINT template_versions_origin_chk CHECK (origin IN ('USER','CODE_SEED'));
        END IF;
      END $c$`);
      await q(guard(SEED_CLAUSE));
      await q('ALTER TABLE legal.key_deliveries ADD COLUMN IF NOT EXISTS term_template_version_id uuid NULL REFERENCES legal.template_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT');

      for (const t of TABLES) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      const companies = (await q(`SELECT c.id, c.group_id FROM core.companies c
        WHERE NOT EXISTS (SELECT 1 FROM legal.contract_templates t WHERE t.company_id = c.id AND t.contract_type = 'USED_PROPERTY_DELIVERY' AND t.is_active)`))[0];
      for (const c of companies) {
        const r = { g: c.group_id, c: c.id, code: CODE, body: BODY, name: NAME };
        let [[lib]] = await q('SELECT id FROM legal.clause_library WHERE company_id = :c AND code = :code', r);
        if (!lib) [[lib]] = await q('INSERT INTO legal.clause_library (id, group_id, company_id, code, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :code, now(), now()) RETURNING id', r);
        let [[clause]] = await q('SELECT id FROM legal.clause_versions WHERE company_id = :c AND code = :code AND is_active ORDER BY version_number DESC LIMIT 1', r);
        if (!clause) {
          [[clause]] = await q(`INSERT INTO legal.clause_versions (id, group_id, company_id, clause_library_id, code, title, body_text, category, version_number, is_active, created_at)
            VALUES (gen_random_uuid(), :g, :c, :lib, :code, 'Natureza e estado do imóvel usado', :body, 'GENERAL', 1, true, now()) RETURNING id`, { ...r, lib: lib.id });
        }
        const [[tpl]] = await q("INSERT INTO legal.contract_templates (id, group_id, company_id, name, contract_type, is_active, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :name, 'USED_PROPERTY_DELIVERY', true, now(), now()) RETURNING id", r);
        const [[ver]] = await q("INSERT INTO legal.template_versions (id, group_id, company_id, template_id, version_number, status, origin, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :t, 1, 'DRAFT', 'CODE_SEED', now(), now()) RETURNING id", { ...r, t: tpl.id });
        await q('INSERT INTO legal.contract_template_clauses (id, group_id, company_id, contract_template_id, contract_clause_id, template_version_id, sort_order, created_at) VALUES (gen_random_uuid(), :g, :c, :t, :cl, :v, 0, now())', { ...r, t: tpl.id, cl: clause.id, v: ver.id });
        await q("UPDATE legal.template_versions SET status = 'PUBLISHED', published_at = now() WHERE id = :v", { v: ver.id });
      }
      for (const t of TABLES) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const t of TABLES) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await q('ALTER TABLE legal.key_deliveries DROP COLUMN IF EXISTS term_template_version_id');
      // Só o que veio da semente (origem CODE_SEED): vínculos, versões e modelos; a cláusula da semente sai quando nada mais a usa.
      await q('ALTER TABLE legal.contract_template_clauses DISABLE TRIGGER template_clauses_version_guard');
      await q("DELETE FROM legal.contract_template_clauses WHERE template_version_id IN (SELECT id FROM legal.template_versions WHERE origin = 'CODE_SEED')");
      await q('ALTER TABLE legal.contract_template_clauses ENABLE TRIGGER template_clauses_version_guard');
      await q(`DELETE FROM legal.template_versions v WHERE v.origin = 'CODE_SEED'
        AND NOT EXISTS (SELECT 1 FROM legal.contract_versions cv WHERE cv.template_version_id = v.id)`);
      await q(`DELETE FROM legal.contract_templates t WHERE t.contract_type = 'USED_PROPERTY_DELIVERY' AND t.name = '${NAME}'
        AND NOT EXISTS (SELECT 1 FROM legal.template_versions v WHERE v.template_id = t.id)`);
      await q(`DELETE FROM legal.clause_versions cv WHERE cv.code = '${CODE}' AND cv.version_number = 1 AND cv.created_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM legal.contract_template_clauses l WHERE l.contract_clause_id = cv.id)`);
      await q(`DELETE FROM legal.clause_library l WHERE l.code = '${CODE}' AND NOT EXISTS (SELECT 1 FROM legal.clause_versions cv WHERE cv.clause_library_id = l.id)`);
      for (const t of TABLES) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      await q(guard(''));
      await q('ALTER TABLE legal.template_versions DROP CONSTRAINT IF EXISTS template_versions_origin_chk');
      await q('ALTER TABLE legal.template_versions DROP COLUMN IF EXISTS origin');
    });
  },
};
