'use strict';

const { forceRestaurado } = require('../src/shared/db/forceRestaurado');
const crypto = require('crypto');

/**
 * Marco 3 §7 (verificação independente de 11/11/2026): "Publicação usa Motor de Regras para checar vídeo, quantidade/qualidade
 * de fotos, documentos e campos obrigatórios" — faltava a regra dos campos. REG-IMO-FIELDS-001 entra no catálogo de Imóveis
 * (scripts/seedRealEstateRules.js, para empresa nova) e esta migration a publica nas empresas que JÁ têm o catálogo de Imóveis
 * (REG-IMO-001 publicada), com o mesmo autor da publicação da REG-IMO-001 da empresa. Sem a regra, o gate é fail-closed e nada
 * publicaria. Cada empresa semeada deixa um registro no audit_log (antes: sem a regra; depois: regra e versão criadas).
 * Mesmo padrão de RLS das migrations 20260101000530 e 9975 (NO FORCE só durante a operação).
 * Desfazer: apaga exatamente as linhas criadas aqui (marcadas em created_by_migration no audit_log e pelo código + versão 1
 * sem outras versões); a auditoria fica (append-only).
 */
const CODE = 'REG-IMO-FIELDS-001';
const CONDITION = { fact: 'hasRequiredFields', op: '==', value: true };
const ACTION = { allow: true, reason: 'REQUIRED_FIELDS_MISSING' };
const NAME = 'Campos obrigatórios preenchidos para publicação';
const DESCRIPTION = 'Bloqueia a publicação se faltar algum campo da lista configurada em real_estate.publication.required_fields.';
const TABLES = ['core.rules', 'core.rule_versions', 'core.rule_scopes', 'core.rule_publications', 'core.rule_evaluation_log', 'audit.audit_log'];
const MIGRATION = '20260101010312';

module.exports = {
  CODE,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const hash = crypto.createHash('sha256').update(JSON.stringify(CONDITION)).digest('hex');
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      for (const t of TABLES) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await forceRestaurado(async () => {
        const [empresas] = await q(
          `SELECT r.group_id, r.company_id, v.published_by_user_id AS autor
             FROM core.rules r
             JOIN core.rule_versions v ON v.rule_id = r.id AND v.status = 'PUBLISHED'
            WHERE r.code = 'REG-IMO-001' AND r.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM core.rules x WHERE x.code = :code AND x.company_id = r.company_id AND x.deleted_at IS NULL)
            GROUP BY r.group_id, r.company_id, v.published_by_user_id`,
          { code: CODE }
        );
        const feitas = new Set();
        for (const e of empresas) {
          if (feitas.has(e.company_id)) continue;
          feitas.add(e.company_id);
          const ids = { rule: crypto.randomUUID(), version: crypto.randomUUID(), scope: crypto.randomUUID(), pub: crypto.randomUUID() };
          const base = { g: e.group_id, c: e.company_id, u: e.autor };
          await q(`INSERT INTO core.rules (id, group_id, company_id, code, name, description, domain, created_by, updated_by, created_at, updated_at)
                   VALUES (:id, :g, :c, :code, :name, :description, 'real_estate', :u, :u, now(), now())`, { ...base, id: ids.rule, code: CODE, name: NAME, description: DESCRIPTION });
          await q(`INSERT INTO core.rule_versions (id, group_id, company_id, rule_id, version_number, condition_ast_json, content_hash, action_json, effective_from, effective_until, status, published_by_user_id, created_by, updated_by, created_at, updated_at)
                   VALUES (:id, :g, :c, :rule, 1, :cond::jsonb, :hash, :action::jsonb, now(), NULL, 'PUBLISHED', :u, :u, :u, now(), now())`,
          { ...base, id: ids.version, rule: ids.rule, cond: JSON.stringify(CONDITION), hash, action: JSON.stringify(ACTION) });
          await q(`INSERT INTO core.rule_scopes (id, group_id, company_id, rule_version_id, scope_type, scope_ref_id, precedence, created_by, updated_by, created_at, updated_at)
                   VALUES (:id, :g, :c, :v, 'GLOBAL', NULL, 7, :u, :u, now(), now())`, { ...base, id: ids.scope, v: ids.version });
          await q(`INSERT INTO core.rule_publications (id, group_id, company_id, rule_version_id, published_by_user_id, published_at, created_by, updated_by, created_at, updated_at)
                   VALUES (:id, :g, :c, :v, :u, now(), :u, :u, now(), now())`, { ...base, id: ids.pub, v: ids.version });
          await q(`INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
                   VALUES (gen_random_uuid(), :g, :c, NULL, 'rule.seeded_by_migration', 'Rule', :rule, :b::jsonb, :a::jsonb, :r, now(), now(), now())`, {
            ...base, rule: ids.rule,
            b: JSON.stringify({ code: CODE, exists: false }),
            a: JSON.stringify({ code: CODE, ruleId: ids.rule, ruleVersionId: ids.version, condition: CONDITION, status: 'PUBLISHED', createdByMigration: MIGRATION }),
            r: `Migration ${MIGRATION} (livro do Marco 3 §7): regra ${CODE} publicada para a empresa que já tinha o catálogo de Imóveis.`,
          });
        }
      }, async () => {
        for (const t of TABLES) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      });
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      for (const t of TABLES) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await forceRestaurado(async () => {
        const [criadas] = await q(
          `SELECT (after_json->>'ruleId')::uuid AS rule_id, (after_json->>'ruleVersionId')::uuid AS version_id
             FROM audit.audit_log WHERE action = 'rule.seeded_by_migration' AND after_json->>'createdByMigration' = :m`, { m: MIGRATION }
        );
        for (const c of criadas) {
          // Só desfaz a regra que continua só com a versão desta migration (nenhuma versão nova publicada depois).
          const [[{ outras }]] = await q('SELECT count(*)::int AS outras FROM core.rule_versions WHERE rule_id = :r AND id <> :v', { r: c.rule_id, v: c.version_id });
          if (outras > 0) continue;
          const [[{ usos }]] = await q('SELECT count(*)::int AS usos FROM core.rule_evaluation_log WHERE rule_version_id = :v', { v: c.version_id });
          if (usos > 0) continue; // avaliada em produção: fica (histórico do Motor de Regras)
          await q('DELETE FROM core.rule_publications WHERE rule_version_id = :v', { v: c.version_id });
          await q('DELETE FROM core.rule_scopes WHERE rule_version_id = :v', { v: c.version_id });
          await q('DELETE FROM core.rule_versions WHERE id = :v', { v: c.version_id });
          await q('DELETE FROM core.rules WHERE id = :r', { r: c.rule_id });
        }
      }, async () => {
        for (const t of TABLES) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      });
    });
  },
};
