'use strict';

/**
 * M9-D700 (3.3) — ABAC do BI por cima do RLS.
 *  - Domínio da métrica -> permissão de leitura do módulo de origem (`analytics.abac.mapa_dominio_permissao`).
 *  - Recorte por carteira/equipe: mesma convenção do CRM (migration 330): quem tem `crm:opportunities:read:own` sem
 *    `crm:opportunities:read:all` e sem `analytics:read:group` vê só a própria carteira; a equipe do gerente vem do parâmetro
 *    `analytics.abac.equipes` ("gerente=pessoa,pessoa; ..." por id de usuário). Não existe entidade de equipe no projeto (DI-D700-2).
 */
const { has, assertPermission } = require('./permissionGuard');
const { readParam, KEYS } = require('./securityParams');
const { SECURITY_SETTING_DEFAULTS, NONE } = require('./security.settings');
const { P } = require('./permissionCatalog');

const DOMAIN_LABELS = Object.freeze({
  FINANCE: ['financeiro'], CRM: ['comercial'], PROPERTIES: ['imoveis'], MARKETING: ['marketing'], SUPPORT: ['atendimento'],
  RENTAL: ['locacao'], LEGAL: ['juridico'], CONSTRUCTION: ['obras'], INVENTORY: ['estoque'], CORRESPONDENT: ['correspondente'],
  TECH_AI: ['tecnologia'],
});
const PERMISSION_RE = /^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const OWN = 'crm:opportunities:read:own';
const ALL = 'crm:opportunities:read:all';

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** "Financeiro=finance:read; Locação e Jurídico=legal:read" -> Map(domínio -> permissão). Entradas malformadas são ignoradas. */
function parseDomainMap(text) {
  const byLabel = new Map();
  for (const entry of String(text || '').split(';')) {
    const [labels, permission] = entry.split('=').map((s) => (s || '').trim());
    if (!labels || !PERMISSION_RE.test(permission || '')) continue;
    for (const label of norm(labels).split(/\/|\s+e\s+/)) if (label) byLabel.set(label.trim(), permission);
  }
  const map = new Map();
  for (const [domain, labels] of Object.entries(DOMAIN_LABELS)) {
    const hit = labels.map((l) => byLabel.get(l)).find(Boolean);
    if (hit) map.set(domain, hit);
  }
  return map;
}

const DEFAULT_MAP = parseDomainMap(SECURITY_SETTING_DEFAULTS[KEYS.DOMAIN_MAP]);

/** Mapa efetivo: o padrão do livro com as entradas válidas do administrador por cima (domínio sem entrada cai no padrão). */
function mergeDomainMap(text) {
  return new Map([...DEFAULT_MAP, ...parseDomainMap(text)]);
}

/** Permissão que dá acesso ao domínio. Domínio geral (painéis de saúde e comando) usa `analytics:read`. */
function domainPermissionOf(map, domain) {
  if (domain === 'GENERAL') return P.READ;
  return map.get(domain) || DEFAULT_MAP.get(domain) || P.MANAGE;
}

async function loadDomainMap(ctx, transaction) {
  return mergeDomainMap(await readParam(KEYS.DOMAIN_MAP, ctx, transaction));
}

/** 403 PERMISSION_DENIED com a permissão do domínio quando o usuário não a tem. */
async function assertDomainAccess(ctx, domain, transaction) {
  assertPermission(ctx, domainPermissionOf(await loadDomainMap(ctx, transaction), domain));
}

function parseTeams(text) {
  const teams = new Map();
  if (!text || norm(text) === NONE || norm(text) === 'nenhuma') return teams;
  for (const entry of String(text).split(';')) {
    const [manager, members] = entry.split('=').map((s) => (s || '').trim());
    if (!UUID_RE.test(manager || '')) continue;
    teams.set(manager.toLowerCase(), String(members || '').split(',').map((m) => m.trim().toLowerCase()).filter((m) => UUID_RE.test(m)));
  }
  return teams;
}

/** { mode: 'ALL' } ou { mode: 'SELF', userIds: [próprio, ...equipe] }. */
async function resolveRowScope(ctx, transaction) {
  if (has(ctx, ALL) || has(ctx, P.READ_GROUP) || !has(ctx, OWN)) return { mode: 'ALL', userIds: [] };
  const teams = parseTeams(await readParam(KEYS.TEAMS, ctx, transaction));
  const self = String(ctx.actorUserId).toLowerCase();
  return { mode: 'SELF', userIds: [...new Set([self, ...(teams.get(self) || [])])] };
}

/** Fragmento SQL do recorte: `clause` e `replacements` (nome do parâmetro `analyticsScopeUserIds`). */
function ownerFilter(scope, column = 'owner_user_id') {
  if (!COLUMN_RE.test(column)) throw new Error('Coluna inválida para o recorte por carteira.');
  if (scope.mode === 'ALL') return { clause: 'TRUE', replacements: {} };
  return { clause: `${column} = ANY(CAST(ARRAY[:analyticsScopeUserIds] AS uuid[]))`, replacements: { analyticsScopeUserIds: scope.userIds } };
}

module.exports = { parseDomainMap, mergeDomainMap, domainPermissionOf, loadDomainMap, assertDomainAccess, parseTeams, resolveRowScope, ownerFilter };
