'use strict';

const { sequelize, IntegrationConnection } = require('../../../models');
const { ctxOk } = require('./registry.helpers');
const { CORRESPONDENT_TO_CATALOG } = require('../providers/catalog.legacy');
const { serializeConnection, auditar } = require('./registry.auditoria');

/**
 * Copia correspondent.provider_accounts da empresa atual para connections (domínio FINANCING),
 * de forma idempotente (o id da conta é o id da connection). A conta ativa mais antiga de cada
 * fornecedor fica ACTIVE; as demais ativas ficam PAUSED; inativas ficam DISABLED. O livro não
 * traz ambiente para a conta legada: SANDBOX (DI-007).
 */
// Código da conta legada -> código do catálogo (sandbox e manual viram financing-sandbox e financing-manual).
const CATALOG_CODE_SQL = `CASE lower(a.provider_code)${Object.entries(CORRESPONDENT_TO_CATALOG).map(([k, v]) => ` WHEN '${k}' THEN '${v}'`).join('')} ELSE lower(a.provider_code) END`;

const COPIA_LEGADO_SQL = `
INSERT INTO "integration"."connections"
  (id, group_id, company_id, provider_code, environment, label, status, secret_ref, config_json, policy_json, created_by, updated_by, created_at, updated_at)
SELECT s.id, s.group_id, s.company_id, s.catalog_code, 'SANDBOX',
       CASE WHEN s.rn = 1 THEN s.label ELSE left(s.label, 74) || ' (' || s.rn || ')' END,
       CASE WHEN NOT s.active THEN 'DISABLED'
            WHEN s.ordem_ativa = 1 AND NOT EXISTS (
              SELECT 1 FROM "integration"."connections" x
               WHERE x.company_id = s.company_id AND x.provider_code = s.catalog_code
                 AND x.environment = 'SANDBOX' AND x.status = 'ACTIVE') THEN 'ACTIVE'
            ELSE 'PAUSED' END,
       s.secret_ref, '{}'::jsonb, '{}'::jsonb, s.created_by, s.created_by, s.created_at, s.updated_at
FROM (
  SELECT a.*, c.catalog_code,
         row_number() OVER (PARTITION BY a.company_id, c.catalog_code, lower(a.label) ORDER BY a.active DESC, a.created_at, a.id) AS rn,
         CASE WHEN a.active THEN row_number() OVER (PARTITION BY a.company_id, c.catalog_code, a.active ORDER BY a.created_at, a.id) END AS ordem_ativa
  FROM "correspondent"."provider_accounts" a
  CROSS JOIN LATERAL (SELECT ${CATALOG_CODE_SQL} AS catalog_code) c
  WHERE a.company_id = :companyId AND lower(a.provider_code) ~ '^[a-z0-9_-]{1,48}$'
    AND EXISTS (SELECT 1 FROM "integration"."providers" p WHERE p.code = c.catalog_code)
) s
ON CONFLICT DO NOTHING
RETURNING id;
`;

async function migrateLegacyProviderAccounts(ctx, transaction) {
  ctxOk(ctx);
  const [rows] = await sequelize.query(COPIA_LEGADO_SQL, { replacements: { companyId: ctx.companyId }, transaction });
  for (const { id } of rows) {
    const c = await IntegrationConnection.findByPk(id, { transaction });
    await auditar(ctx, c, null, serializeConnection(c), `Conta de provider legada migrada para a integração "${c.label}".`, transaction);
  }
  return { inserted: rows.length };
}

module.exports = { migrateLegacyProviderAccounts };
