'use strict';

const { forceRestaurado } = require('../src/shared/db/forceRestaurado');
const { randomUUID } = require('crypto');

/**
 * Verificação independente do Marco 6 (M6-29 e M6-107). Caderno Obras §8 "Perda/quebra exige loss_record, motivo e
 * aprovação conforme valor" e §9 "Desconto/ressarcimento passa por regra/aprovação e Financeiro".
 *  - Permissão própria para alterar a alçada (construction.approval_thresholds): `construction:approval_threshold:manage`
 *    (antes bastava construction:update, e quem edita a obra subia a alçada e se autoaprovava). Semeada e concedida ao
 *    papel ADMIN na mesma migration (PADRAO_COMPONENTES_E_REGRAS §2.5). A rota também pede MFA recente.
 *  - construction.maintenance_cases.resolution_proposed_by_user_id: quem propôs o desconto/ressarcimento, para a
 *    aprovação acima da alçada recusar a mesma pessoa (quem propõe não aprova). As propostas que já existem recebem
 *    o autor do registro de auditoria da proposta (construction.maintenance_case.resolution_proposed).
 *  - O padrão de R$ 1.000,00 sai do código (DI-M6V-6): cada empresa que já existe ganha as duas alçadas
 *    (MATERIAL_LOSS e WARRANTY_RESOLUTION) gravadas com o valor que valia até aqui, com auditoria; a coluna deixa de ter
 *    valor padrão. Empresa sem alçada configurada não autoaprova nada (o mais conservador) até o administrador definir.
 * Reversível (o down devolve o padrão da coluna; as alçadas semeadas ficam, são configuração da empresa).
 */
const CODE = 'construction:approval_threshold:manage';

const CONTEXTOS = ['MATERIAL_LOSS', 'WARRANTY_RESOLUTION'];
const VALOR_VIGENTE_ATE_AQUI = '1000.00'; // o que o código usava quando a empresa não tinha alçada (lossRecords.service.js antigo)

async function semearAlcadas(q) {
  const tabelas = ['construction.approval_thresholds', 'core.companies', 'audit.audit_log'];
  for (const t of tabelas) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
  await forceRestaurado(async () => {
    for (const contexto of CONTEXTOS) {
      const [linhas] = await q(
        `INSERT INTO construction.approval_thresholds (id, group_id, company_id, context, max_auto_approve_amount, created_at, updated_at)
         SELECT gen_random_uuid(), c.group_id, c.id, :contexto, :valor, now(), now() FROM core.companies c
          WHERE NOT EXISTS (SELECT 1 FROM construction.approval_thresholds a WHERE a.company_id = c.id AND a.context = :contexto)
         RETURNING id, group_id, company_id`,
        { replacements: { contexto, valor: VALOR_VIGENTE_ATE_AQUI } }
      );
      for (const l of linhas) {
        await q(
          `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
           VALUES (gen_random_uuid(), :g, :c, NULL, 'construction.approval_threshold.seeded', 'ApprovalThreshold', :id, NULL, :a::jsonb, :r, now(), now(), now())`,
          { replacements: { g: l.group_id, c: l.company_id, id: l.id, a: JSON.stringify({ context: contexto, maxAutoApproveAmount: VALOR_VIGENTE_ATE_AQUI }), r: 'Migration 20260101006605 (DI-M6V-6): alçada gravada com o valor que valia por padrão no código, agora configuração da empresa.' } }
        );
      }
    }
  }, async () => {
    for (const t of tabelas) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  });
  await q('ALTER TABLE construction.approval_thresholds ALTER COLUMN max_auto_approve_amount DROP DEFAULT');
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => sequelize.query(sql, { transaction, ...opts });
      await queryInterface.bulkInsert(
        { tableName: 'permissions', schema: 'core' },
        [{ id: randomUUID(), code: CODE, description: 'Alterar a alçada de aprovação de Obras (perda de material e desconto/ressarcimento de garantia).', risk_level: 'HIGH', created_at: new Date(), updated_at: new Date() }],
        { ignoreDuplicates: true, transaction }
      );
      await q('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
      await q(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p
         WHERE r.name = 'ADMIN' AND p.code = :code
           AND NOT EXISTS (SELECT 1 FROM core.role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id)`, { replacements: { code: CODE } });
      await q('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');

      await q(`ALTER TABLE construction.maintenance_cases
        ADD COLUMN IF NOT EXISTS resolution_proposed_by_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT`);
      await q('ALTER TABLE construction.maintenance_cases NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE audit.audit_log NO FORCE ROW LEVEL SECURITY');
      await forceRestaurado(async () => {
        await q(`UPDATE construction.maintenance_cases mc SET resolution_proposed_by_user_id = a.user_id
                   FROM (SELECT DISTINCT ON (entity_id) entity_id, user_id FROM audit.audit_log
                          WHERE action = 'construction.maintenance_case.resolution_proposed' AND user_id IS NOT NULL
                          ORDER BY entity_id, occurred_at DESC) a
                  WHERE a.entity_id = mc.id AND mc.resolution_proposed_by_user_id IS NULL AND mc.resolution_status IS NOT NULL`);
      }, async () => {
        await q('ALTER TABLE construction.maintenance_cases FORCE ROW LEVEL SECURITY');
        await q('ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY');
      });
      await semearAlcadas(q);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => sequelize.query(sql, { transaction, ...opts });
      await q("ALTER TABLE construction.approval_thresholds ALTER COLUMN max_auto_approve_amount SET DEFAULT 1000.00");
      await q('ALTER TABLE construction.maintenance_cases DROP COLUMN IF EXISTS resolution_proposed_by_user_id');
      await q('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = :code)', { replacements: { code: CODE } });
      await q('DELETE FROM core.permissions WHERE code = :code', { replacements: { code: CODE } });
    });
  },
};
