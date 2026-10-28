'use strict';

const { Permission, Role, RolePermission } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getSetting } = require('../../features/settings/settings.service');
const {
  PROFILES_ASSISTANT_KEY, PROFILES_MANAGER_KEY, PROFILES_DIRECTOR_KEY, MARKETING_SETTING_DEFAULTS, parseNameList,
} = require('./marketing.settings');

/**
 * Catálogo fechado de 12 permissões do Marketing (M9-D402 §3) e a concessão padrão por papel. A migration 20260101000760 grava o
 * mesmo catálogo (cópia literal; o teste m9d402 confere que os dois coincidem). Concessão sempre por papel, nunca por usuário.
 * Quem tem `write` não tem `approve` por padrão (segregação de funções). O administrador redistribui qualquer código pela tela
 * de perfis e escolhe os nomes dos perfis nos parâmetros marketing.permissoes.perfis_*.
 */
const MARKETING_PERMISSIONS = Object.freeze([
  { code: 'marketing:content:read', risk: 'LOW', description: 'Consultar conteúdos, publicações e templates de Marketing.' },
  { code: 'marketing:content:write', risk: 'MEDIUM', description: 'Criar e editar rascunhos de conteúdo de Marketing (não aprova nem publica).' },
  { code: 'marketing:content:approve', risk: 'HIGH', description: 'Aprovar ou rejeitar a versão corrente de um conteúdo de Marketing.' },
  { code: 'marketing:content:publish', risk: 'HIGH', description: 'Agendar, publicar e cancelar publicações de conteúdo aprovado.' },
  { code: 'marketing:template:manage', risk: 'MEDIUM', description: 'Gerir templates versionados e a lista de campos publicáveis.' },
  { code: 'marketing:campaign:manage', risk: 'HIGH', description: 'Criar, completar e agendar campanhas de Marketing.' },
  { code: 'marketing:automation:manage', risk: 'HIGH', description: 'Criar, pausar e configurar automações e parâmetros do motor de regras de Marketing.' },
  { code: 'marketing:automation:publish', risk: 'HIGH', description: 'Publicar ou retomar a versão de uma automação de Marketing.' },
  { code: 'marketing:suppression:manage', risk: 'HIGH', description: 'Gerir a lista de supressão (opt-out) de Marketing.' },
  { code: 'marketing:send:mass', risk: 'CRITICAL', description: 'Disparar mensagem em massa acima do limite sem aprovação.' },
  { code: 'marketing:attribution:read', risk: 'LOW', description: 'Consultar a atribuição de campanhas (first e last touch).' },
  { code: 'marketing:killswitch:manage', risk: 'CRITICAL', description: 'Ligar e desligar o kill switch de Marketing; a reativação exige MFA e libera canal para produção.' },
]);

const ALL_CODES = MARKETING_PERMISSIONS.map((p) => p.code);

const ASSISTENTE = Object.freeze(['marketing:content:read', 'marketing:content:write']);
const GERENTE = Object.freeze([
  ...ASSISTENTE, 'marketing:content:approve', 'marketing:content:publish', 'marketing:campaign:manage',
  'marketing:automation:manage', 'marketing:automation:publish',
]);
const DIRETORIA = Object.freeze([...GERENTE, 'marketing:killswitch:manage']);

/** Tabela de concessão padrão. ADMIN recebe as 12; as demais (template, supressão, massa, atribuição) só o ADMIN por padrão. */
const DEFAULT_GRANTS = Object.freeze({
  ADMIN: Object.freeze([...ALL_CODES]),
  DIRETORIA,
  GERENTE,
  ASSISTENTE,
});

/** Nome com que o papel é criado quando a empresa ainda não tem nenhum com os nomes configurados. */
const DEFAULT_ROLE_NAMES = Object.freeze({
  ASSISTENTE: 'Assistente de Marketing',
  GERENTE: 'Gerente de Marketing',
  DIRETORIA: 'Diretoria',
});

const TIER_SETTING = Object.freeze({
  ASSISTENTE: PROFILES_ASSISTANT_KEY,
  GERENTE: PROFILES_MANAGER_KEY,
  DIRETORIA: PROFILES_DIRECTOR_KEY,
});

async function readProfileLists(tenant, transaction) {
  const lists = {};
  for (const [tier, key] of Object.entries(TIER_SETTING)) {
    // eslint-disable-next-line no-await-in-loop
    const value = await getSetting(key, tenant, transaction, MARKETING_SETTING_DEFAULTS[key]);
    lists[tier] = parseNameList(value, MARKETING_SETTING_DEFAULTS[key]);
  }
  return lists;
}

/** Faixa de um papel pelo nome (sem diferenciar maiúsculas); ADMIN vence; sem faixa => null (nada de Marketing). */
function tierForRoleName(name, lists) {
  const upper = String(name || '').trim().toUpperCase();
  if (upper === 'ADMIN') return 'ADMIN';
  for (const tier of ['DIRETORIA', 'GERENTE', 'ASSISTENTE']) {
    if ((lists[tier] || []).includes(upper)) return tier;
  }
  return null;
}

/**
 * Garante os 3 papéis (cria o que não existe com o nome padrão) e concede o pacote de Marketing de cada faixa. Idempotente: só
 * concede o que falta, nunca retira. Auditoria com antes e depois por papel que mudou.
 */
async function aplicarConcessaoPadrao(tenant, actorUserId, transaction) {
  const lists = await readProfileLists(tenant, transaction);
  const permissions = await Permission.findAll({ where: { code: ALL_CODES }, transaction });
  const idByCode = new Map(permissions.map((p) => [p.code, p.id]));
  let roles = await Role.findAll({ where: { companyId: tenant.companyId }, transaction });
  const criados = [];
  for (const tier of ['ASSISTENTE', 'GERENTE', 'DIRETORIA']) {
    if (roles.some((role) => tierForRoleName(role.name, lists) === tier)) continue;
    // eslint-disable-next-line no-await-in-loop
    const created = await Role.create({
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      name: DEFAULT_ROLE_NAMES[tier],
      description: `Papel padrão de Marketing (${DEFAULT_ROLE_NAMES[tier]}).`,
      isSystem: false,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    }, { transaction });
    criados.push(created.name);
    roles = [...roles, created];
  }
  let concedidas = 0;
  const detalhes = [];
  for (const role of roles) {
    const tier = tierForRoleName(role.name, lists);
    if (!tier) continue;
    const wanted = DEFAULT_GRANTS[tier].filter((code) => idByCode.has(code));
    // eslint-disable-next-line no-await-in-loop
    const current = await RolePermission.findAll({ where: { roleId: role.id }, transaction });
    const have = new Set(current.map((rp) => rp.permissionId));
    const added = [];
    for (const code of wanted) {
      if (have.has(idByCode.get(code))) continue;
      // eslint-disable-next-line no-await-in-loop
      await RolePermission.create({ roleId: role.id, permissionId: idByCode.get(code), createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
      added.push(code);
    }
    const created = criados.includes(role.name);
    if (added.length || created) {
      concedidas += added.length;
      detalhes.push({ papel: role.name, faixa: tier, criado: created, concedidas: added });
      // eslint-disable-next-line no-await-in-loop
      await registrarAuditoria({
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        actorUserId,
        action: 'marketing.permissions.default_grants',
        entityType: 'Role',
        entityId: role.id,
        beforeJson: { marketingCodes: wanted.filter((code) => have.has(idByCode.get(code))), papelCriado: created },
        afterJson: { marketingCodes: wanted },
        reason: `Concessão padrão de Marketing (faixa ${tier}) ao papel "${role.name}".`,
      }, transaction);
    }
  }
  return { papeis: roles.length, criados, concedidas, detalhes };
}

module.exports = {
  MARKETING_PERMISSIONS, ALL_CODES, DEFAULT_GRANTS, DEFAULT_ROLE_NAMES, tierForRoleName, readProfileLists, aplicarConcessaoPadrao,
};
