'use strict';

const { Permission, Role, RolePermission } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getSetting } = require('../../features/settings/settings.service');
const {
  PROFILES_MANAGEMENT_KEY, PROFILES_FINANCE_KEY, GOVERNANCE_SETTING_DEFAULTS, parseNameList,
} = require('./governance.settings');

/**
 * Catálogo fechado de 21 permissões de governança (M9-D800 §3.3) e tabela de concessão padrão. A migration 20260101000800
 * grava o mesmo catálogo (cópia literal; o teste m9d800 confere que os dois coincidem). O administrador do grupo pode
 * redistribuir qualquer código pela tela de perfis; as listas de nomes de perfil de Gestão e Financeiro são parâmetros
 * (governanca.permissoes.perfis_gestao e perfis_financeiro).
 */
const GOVERNANCE_PERMISSIONS = Object.freeze([
  { code: 'governance:calendar:read', risk: 'LOW', description: 'Consultar o calendário unificado de governança.' },
  { code: 'governance:data-quality:read', risk: 'LOW', description: 'Consultar donos, curadores e problemas de qualidade de dados.' },
  { code: 'governance:data-quality:manage', risk: 'MEDIUM', description: 'Gerir donos/curadores de dados e tratar problemas de qualidade.' },
  { code: 'governance:data-quality:bulk', risk: 'CRITICAL', description: 'Executar alteração em massa de dados mestres (exige permissão, MFA e auditoria).' },
  { code: 'governance:lineage:manage', risk: 'HIGH', description: 'Gerir o registro de linhagem de dados e KPIs críticos.' },
  { code: 'governance:dlp:export', risk: 'MEDIUM', description: 'Solicitar exportação de dados sujeita às regras de DLP.' },
  { code: 'governance:dlp:admin', risk: 'CRITICAL', description: 'Administrar políticas de DLP e liberar exportações bloqueadas.' },
  { code: 'governance:dlp:view-restricted', risk: 'CRITICAL', description: 'Ver em claro campos classificados como RESTRICTED (única permissão dedicada).' },
  { code: 'governance:bcp:record', risk: 'MEDIUM', description: 'Registrar operação manual de contingência (BCP).' },
  { code: 'governance:bcp:import', risk: 'HIGH', description: 'Importar operações manuais de contingência para o sistema.' },
  { code: 'governance:bcp:approve', risk: 'CRITICAL', description: 'Aprovar operações manuais de contingência importadas.' },
  { code: 'governance:api:read', risk: 'LOW', description: 'Consultar consumidores, contratos e versões de API.' },
  { code: 'governance:api:manage', risk: 'HIGH', description: 'Gerir consumidores, depreciações e contratos de API.' },
  { code: 'governance:finops:read', risk: 'LOW', description: 'Consultar custos, orçamentos e saúde de FinOps.' },
  { code: 'governance:finops:manage', risk: 'HIGH', description: 'Gerir orçamentos, alertas e coletores de FinOps.' },
  { code: 'governance:flags:manage', risk: 'CRITICAL', description: 'Gerir feature flags, configurações e kill switches.' },
  { code: 'governance:migration:run', risk: 'CRITICAL', description: 'Executar etapas da migração de dados do sistema legado.' },
  { code: 'governance:migration:admin', risk: 'CRITICAL', description: 'Administrar a migração de dados (corte, reversão, exceções).' },
  { code: 'governance:classification:manage', risk: 'HIGH', description: 'Gerir a classificação de dados (PUBLIC a RESTRICTED).' },
  { code: 'governance:retention:manage', risk: 'HIGH', description: 'Gerir políticas de retenção e descarte de dados.' },
  { code: 'governance:legal-hold:manage', risk: 'CRITICAL', description: 'Criar e liberar bloqueio legal (legal hold) de dados.' },
]);

const ALL_CODES = GOVERNANCE_PERMISSIONS.map((p) => p.code);

/** As 13 permissões que só o administrador recebe por padrão. */
const SENSITIVE_PERMISSIONS = Object.freeze([
  'governance:data-quality:bulk', 'governance:dlp:admin', 'governance:dlp:view-restricted', 'governance:bcp:approve',
  'governance:lineage:manage', 'governance:api:manage', 'governance:finops:manage', 'governance:flags:manage',
  'governance:migration:run', 'governance:migration:admin', 'governance:classification:manage', 'governance:retention:manage',
  'governance:legal-hold:manage',
]);

/** Tabela de concessão padrão do 3.3. */
const DEFAULT_GRANTS = Object.freeze({
  ADMIN: Object.freeze([...ALL_CODES]),
  GESTAO: Object.freeze([
    'governance:calendar:read', 'governance:data-quality:read', 'governance:data-quality:manage',
    'governance:dlp:export', 'governance:api:read', 'governance:finops:read',
  ]),
  FINANCEIRO: Object.freeze([
    'governance:calendar:read', 'governance:finops:read', 'governance:dlp:export', 'governance:bcp:record', 'governance:bcp:import',
  ]),
  OPERACIONAL: Object.freeze(['governance:calendar:read']),
});

/** Decide a faixa de um perfil pelo nome (sem diferenciar maiúsculas); ADMIN sempre vence. */
function tierForRoleName(name, { gestao, financeiro }) {
  const upper = String(name || '').trim().toUpperCase();
  if (upper === 'ADMIN') return 'ADMIN';
  if ((gestao || []).includes(upper)) return 'GESTAO';
  if ((financeiro || []).includes(upper)) return 'FINANCEIRO';
  return 'OPERACIONAL';
}

async function readProfileLists(tenant, transaction) {
  const gestao = await getSetting(PROFILES_MANAGEMENT_KEY, tenant, transaction, GOVERNANCE_SETTING_DEFAULTS[PROFILES_MANAGEMENT_KEY]);
  const financeiro = await getSetting(PROFILES_FINANCE_KEY, tenant, transaction, GOVERNANCE_SETTING_DEFAULTS[PROFILES_FINANCE_KEY]);
  return {
    gestao: parseNameList(gestao, GOVERNANCE_SETTING_DEFAULTS[PROFILES_MANAGEMENT_KEY]),
    financeiro: parseNameList(financeiro, GOVERNANCE_SETTING_DEFAULTS[PROFILES_FINANCE_KEY]),
  };
}

/**
 * Aplica a tabela de concessão padrão aos perfis da empresa do tenant (idempotente: só concede o que falta, nunca retira).
 * Os perfis de Gestão e Financeiro são os nomes configurados pelo administrador; os demais recebem só a leitura do calendário.
 * Auditoria com antes e depois por perfil que mudou.
 */
async function aplicarConcessaoPadrao(tenant, actorUserId, transaction) {
  const lists = await readProfileLists(tenant, transaction);
  const permissions = await Permission.findAll({ where: { code: ALL_CODES }, transaction });
  const idByCode = new Map(permissions.map((p) => [p.code, p.id]));
  const roles = await Role.findAll({ where: { companyId: tenant.companyId }, transaction });
  let concedidas = 0;
  const detalhes = [];
  for (const role of roles) {
    const tier = tierForRoleName(role.name, lists);
    const wanted = DEFAULT_GRANTS[tier].filter((code) => idByCode.has(code));
    const current = await RolePermission.findAll({ where: { roleId: role.id }, transaction });
    const have = new Set(current.map((rp) => rp.permissionId));
    const added = [];
    for (const code of wanted) {
      if (have.has(idByCode.get(code))) continue;
      // eslint-disable-next-line no-await-in-loop
      await RolePermission.create({ roleId: role.id, permissionId: idByCode.get(code), createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
      added.push(code);
    }
    if (added.length) {
      concedidas += added.length;
      detalhes.push({ papel: role.name, faixa: tier, concedidas: added });
      // eslint-disable-next-line no-await-in-loop
      await registrarAuditoria({
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        actorUserId,
        action: 'governance.permissions.default_grants',
        entityType: 'Role',
        entityId: role.id,
        beforeJson: { governanceCodes: wanted.filter((code) => have.has(idByCode.get(code))) },
        afterJson: { governanceCodes: wanted },
        reason: `Concessão padrão de governança (faixa ${tier}) ao papel "${role.name}".`,
      }, transaction);
    }
  }
  return { papeis: roles.length, concedidas, detalhes };
}

module.exports = {
  GOVERNANCE_PERMISSIONS, SENSITIVE_PERMISSIONS, DEFAULT_GRANTS, ALL_CODES, tierForRoleName, readProfileLists, aplicarConcessaoPadrao,
};
