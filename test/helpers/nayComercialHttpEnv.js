'use strict';

// Ambiente HTTP da NAY Comercial (livro do Marco 3 §12, §16, §18 e §19; rodada M3CB): app real no cluster descartável, NAY_COMERCIAL ATIVA
// (versão da empresa criada por SQL pelo superusuário do cluster, como em m9d034.http), provider sandbox (modelo simulado), dois corretores
// com carteira própria (`crm:opportunities:read:own`): A = perfil CI CHECKER, B = perfil CI MAKER; o gestor (CI GESTOR) vê tudo.
// Dados de negócio COMMITADOS pela transação da empresa (RLS real). Nunca chama MFA nem forja token.

const H = require('../marco9/_helpers/iaRunApiEnv');
const { grant } = require('../marco9/_helpers/aiHttpEnv');
const { withTenantTransaction, uniqueSuffix } = require('../testHelpers');
const peopleService = require('../../src/features/people/people.service');
const opportunityService = require('../../src/features/crm/opportunity.service');
const propertiesService = require('../../src/features/properties/properties.service');
const offersService = require('../../src/features/properties/propertyOffers.service');
const messagesService = require('../../src/features/crm/messages.service');

const CODE = 'NAY_COMERCIAL';
const TOOLS = ['crm.getOpportunity', 'crm.getCustomerSummary', 'radar.listMatchesForOpportunity'];
const CORRETOR = ['crm:opportunities:read', 'crm:opportunities:read:own', 'people:read', 'radar:read', 'properties:read', 'ai:use', 'ai:read'];
const ESCOPO = ['crm:opportunities:read:own', 'crm:opportunities:read:all'];

/**
 * Sobe o app, os perfis e a NAY_COMERCIAL ativa. Devolve { env, tenant, pessoas }. As permissões entram no token no login: por isso o escopo
 * de carteira e `properties:read` são concedidos ANTES de subir (o H.subir só mexe em ai:* e nas leituras do CRM, que ele mesmo concede).
 */
async function subir(porta) {
  await H.admin(
    `DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = ANY($1::text[]) AND p.code = ANY($2::text[])`,
    [['CI CHECKER', 'CI MAKER', 'CI GESTOR'], ESCOPO]
  );
  await grant('CI CHECKER', ['crm:opportunities:read:own', 'properties:read']);
  await grant('CI MAKER', ['crm:opportunities:read:own', 'properties:read']);
  await grant('CI GESTOR', ['properties:read', 'crm:opportunities:read:all']);
  const base = await H.subir(porta, { extras: { 'CI MAKER': CORRETOR } });
  await H.agenteAtivo(base.env, base.tenant, { code: CODE, tools: TOOLS });
  return base;
}

/** Devolve os perfis ao estado anterior (o cluster pode ser compartilhado com outros arquivos) e encerra. */
async function encerrar(env, chaves = []) {
  await H.admin(
    `DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = ANY($1::text[]) AND p.code = ANY($2::text[])`,
    [['CI CHECKER', 'CI MAKER', 'CI GESTOR'], [...ESCOPO, 'properties:read']]
  );
  await H.encerrar(env, chaves);
}

/** Oportunidade commitada do responsável `ownerUserId`, aberta `dias` dias atrás (sem interação). */
async function oportunidade(tenant, ownerUserId, { dias = 0, nome } = {}) {
  const { pessoa, opp } = await withTenantTransaction(tenant, async (tx) => {
    const p = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: nome || `QA-M3CB Cliente ${uniqueSuffix()}` }, tenant.userId, tx);
    const o = await opportunityService.createOpportunity({
      groupId: tenant.groupId, companyId: tenant.companyId, personId: p.id, nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 86400000).toISOString(),
    }, tenant.userId, tx);
    return { pessoa: p, opp: o };
  });
  await H.admin(`UPDATE crm.opportunities SET owner_user_id = $2, created_at = now() - ($3 || ' days')::interval WHERE id = $1`, [opp.id, ownerUserId, String(dias)]);
  return { pessoa, opp };
}

/** Imóvel commitado com oferta ativa (área, cidade e preço; o resto vazio, a não ser o que `extra` trouxer). */
const imovel = (tenant, extra = {}, preco = 750000) => withTenantTransaction(tenant, async (tx) => {
  const p = await propertiesService.createProperty({
    groupId: tenant.groupId, companyId: tenant.companyId, title: `Casa M3CB ${uniqueSuffix()}`, internalCode: `M3CB-${uniqueSuffix()}`, propertyType: 'RESIDENTIAL', city: 'Curitiba', areaTotalM2: 120, ...extra,
  }, tenant.userId, tx);
  await offersService.createOffer(p.id, { offerType: 'SALE', askingPrice: preco }, tenant.userId, tx);
  return p;
});

/** Mensagem RECEBIDA do cliente, commitada. */
const mensagemRecebida = (tenant, { pessoa, opp }, body) => withTenantTransaction(tenant, (tx) => messagesService.createMessage({
  groupId: tenant.groupId, companyId: tenant.companyId, personId: pessoa.id, opportunityId: opp.id, direction: 'INBOUND', authorType: 'CLIENT', channel: 'WHATSAPP', body,
}, tenant.userId, tx));

/** POST /ai/runs da NAY Comercial. */
const pedir = (env, quem, taskType, input, context) => env.call('POST', '/ai/runs', env.tokens[quem], {
  agentCode: CODE, purpose: 'Apoio comercial', input, taskType, ...(context ? { context } : {}),
});

const oppCtx = (opp) => ({ entityType: 'crmOpportunity', entityId: opp.id });
const setParam = (env, chave, valor) => env.call('PUT', `/settings/${chave}`, env.tokens['A:gestor'], { value: valor });
const num = async (sql, params) => Number((await H.admin(sql, params)).rows[0].n);

/**
 * Evidência opcional: com M3CB_IA_EVIDENCIAS_DIR definido, grava o pedido e a resposta HTTP (sem token nem segredo) em <dir>/<nome>.json.
 * Sem a variável, não faz nada.
 */
function evidencia(nome, pedido, res) {
  const dir = process.env.M3CB_IA_EVIDENCIAS_DIR;
  if (!dir) return;
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${nome}.json`), `${JSON.stringify({ capturadoEm: new Date().toISOString(), pedido, resposta: { status: res.status, body: res.body } }, null, 2)}\n`);
}

module.exports = { CODE, TOOLS, evidencia, subir, encerrar, oportunidade, imovel, mensagemRecebida, pedir, oppCtx, setParam, num, admin: H.admin, withTenantTransaction };
