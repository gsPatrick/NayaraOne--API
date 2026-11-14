'use strict';

const { forceRestaurado } = require('../src/shared/db/forceRestaurado');
/**
 * DI-M3CA-1 (livro do Marco 3 §2 CRMX-006 "Oportunidade aberta precisa de responsável"; Guia §7 assertResponsibleUser; matriz
 * M3-11 e CRMX-006). Oportunidade gravada sem responsável recebe um, pela mesma ordem da aplicação (crmUsers.resolveOwnerUserId),
 * sempre um usuário ATIVO com vínculo ATIVO na empresa da oportunidade:
 *   1. quem criou (created_by);  2. quem alterou por último (updated_by);
 *   3. o responsável padrão do lead automático da empresa (core.tenant_settings `crm.lead_automatico.responsavel_padrao`);
 *   4. o gestor mais antigo da empresa (permissão de `crm.gerencia.permissao`, padrão crm:dashboard:read);
 *   5. o membro ativo mais antigo da empresa.
 * Cada linha preenchida deixa no audit_log (`opportunity.owner_backfilled`) o antes (nulo), o depois e a regra usada. Empresa sem
 * nenhum membro ativo não tem a quem atribuir: a linha continua sem responsável e fica registrada no audit_log
 * (`opportunity.owner_backfill_without_candidate`). O down devolve o nulo às linhas que esta migration preencheu e que ainda
 * estão com o responsável dado por ela.
 */
const MIGRATION = '20261111031002';
const TABLES = ['crm.opportunities', 'audit.audit_log', 'core.tenant_settings', 'core.user_memberships'];
const lit = (text) => `'${String(text).replace(/'/g, "''")}'`;

async function withoutForcedRls(sequelize, transaction, fn) {
  const [rows] = await sequelize.query(
    `SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relforcerowsecurity AND n.nspname || '.' || c.relname IN (${TABLES.map(lit).join(', ')})`,
    { transaction }
  );
  const forced = rows.map((r) => r.t);
  for (const t of forced) await sequelize.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`, { transaction });
  return await forceRestaurado(async () => {
    return await fn();
  }, async () => {
    for (const t of forced) await sequelize.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`, { transaction });
  });
}

const ACTIVE = `SELECT um.user_id, um.created_at FROM core.user_memberships um
  JOIN core.users u ON u.id = um.user_id AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
 WHERE um.company_id = o.company_id AND um.status = 'ACTIVE' AND um.deleted_at IS NULL`;

// Uma consulta escolhe o candidato de cada oportunidade sem responsável, na ordem da regra, e diz qual regra valeu.
const CANDIDATES = `
  SELECT o.id, o.group_id, o.company_id,
         COALESCE(c1.user_id, c2.user_id, c3.user_id, c4.user_id, c5.user_id) AS owner,
         CASE WHEN c1.user_id IS NOT NULL THEN 'CREATED_BY' WHEN c2.user_id IS NOT NULL THEN 'UPDATED_BY'
              WHEN c3.user_id IS NOT NULL THEN 'DEFAULT_LEAD_OWNER' WHEN c4.user_id IS NOT NULL THEN 'OLDEST_MANAGER'
              WHEN c5.user_id IS NOT NULL THEN 'OLDEST_MEMBER' END AS rule
    FROM crm.opportunities o
    LEFT JOIN LATERAL (SELECT a.user_id FROM (${ACTIVE}) a WHERE a.user_id = o.created_by LIMIT 1) c1 ON true
    LEFT JOIN LATERAL (SELECT a.user_id FROM (${ACTIVE}) a WHERE a.user_id = o.updated_by LIMIT 1) c2 ON true
    LEFT JOIN LATERAL (SELECT a.user_id FROM (${ACTIVE}) a
                        WHERE a.user_id::text = (SELECT ts.value #>> '{}' FROM core.tenant_settings ts
                                                  WHERE ts.company_id = o.company_id AND ts.key = 'crm.lead_automatico.responsavel_padrao') LIMIT 1) c3 ON true
    LEFT JOIN LATERAL (SELECT um.user_id FROM core.user_memberships um
                         JOIN core.users u ON u.id = um.user_id AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
                         JOIN core.role_permissions rp ON rp.role_id = um.role_id
                         JOIN core.permissions p ON p.id = rp.permission_id
                        WHERE um.company_id = o.company_id AND um.status = 'ACTIVE' AND um.deleted_at IS NULL
                          AND p.code = COALESCE((SELECT ts.value #>> '{}' FROM core.tenant_settings ts
                                                  WHERE ts.company_id = o.company_id AND ts.key = 'crm.gerencia.permissao'), 'crm:dashboard:read')
                        ORDER BY um.created_at ASC, um.user_id ASC LIMIT 1) c4 ON true
    LEFT JOIN LATERAL (SELECT a.user_id FROM (${ACTIVE}) a ORDER BY a.created_at ASC, a.user_id ASC LIMIT 1) c5 ON true
   WHERE o.owner_user_id IS NULL
   ORDER BY o.id
   FOR UPDATE OF o`;

async function audit(q, row, action, before, after, reason) {
  await q(
    `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
     VALUES (gen_random_uuid(), :g, :c, NULL, :action, 'Opportunity', :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`,
    { g: row.group_id, c: row.company_id, id: row.id, action, b: JSON.stringify(before), a: JSON.stringify(after), r: reason }
  );
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await withoutForcedRls(sequelize, transaction, async () => {
        const [rows] = await q(CANDIDATES);
        for (const row of rows) {
          if (!row.owner) {
            await audit(q, row, 'opportunity.owner_backfill_without_candidate', { ownerUserId: null }, { ownerUserId: null },
              `Migration ${MIGRATION} (DI-M3CA-1): oportunidade sem responsável e a empresa não tem nenhum membro ativo para recebê-la.`);
            continue;
          }
          await q('UPDATE crm.opportunities SET owner_user_id = :owner, updated_at = now() WHERE id = :id', { owner: row.owner, id: row.id });
          await audit(q, row, 'opportunity.owner_backfilled', { ownerUserId: null }, { ownerUserId: row.owner, rule: row.rule },
            `Migration ${MIGRATION} (DI-M3CA-1): oportunidade sem responsável recebeu responsável pela regra ${row.rule}.`);
        }
      });
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await withoutForcedRls(sequelize, transaction, async () => {
        await sequelize.query(
          `UPDATE crm.opportunities o SET owner_user_id = NULL, updated_at = now()
             FROM audit.audit_log a
            WHERE a.action = 'opportunity.owner_backfilled' AND a.entity_id = o.id AND a.reason LIKE :marca
              AND o.owner_user_id::text = a.after_json->>'ownerUserId'`,
          { transaction, replacements: { marca: `Migration ${MIGRATION}%` } }
        );
      });
    });
  },
};
