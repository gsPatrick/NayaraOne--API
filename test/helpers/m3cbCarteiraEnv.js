'use strict';

// Apoio dos testes da carteira do corretor (livro do Marco 3 §18, CRM-TS-012) e da exportação pelo caminho vivo (M3-21, CRM-TS-013).
// Sobe o app real e faz LOGIN de verdade com os perfis do seed de dois tenants (nunca chama MFA nem forja token): na empresa A,
// "maker" é o corretor A (escopo próprio), "checker" é o corretor B (escopo próprio) e "gestor" vê tudo. Só no cluster descartável.
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, admin, grant, startHttpEnv } = require('../marco9/_helpers/aiHttpEnv');
const { emailFor } = require('../../scripts/seed-ci-two-tenants');

const CORRETOR = [
  'people:read', 'people:create', 'crm:opportunities:read', 'crm:opportunities:read:own', 'crm:opportunities:update', 'crm:opportunities:create',
  'crm:visits:read', 'crm:visits:create', 'crm:visits:update', 'crm:messages:read', 'crm:messages:create', 'crm:messages:update',
  'crm:proposals:read', 'crm:proposals:create', 'crm:proposals:update', 'crm:feedback:read', 'crm:feedback:create', 'crm:feedback:update',
  'crm:tasks:read', 'crm:tasks:create', 'crm:dashboard:read', 'radar:read', 'radar:create', 'properties:read',
];
const GESTOR = [...CORRETOR.filter((p) => p !== 'crm:opportunities:read:own'), 'crm:opportunities:read:all', 'crm:opportunities:reassign', 'properties:create', 'properties:update', 'users:read', 'settings:read', 'settings:update'];
const ROLES = { maker: 'CI MAKER', checker: 'CI CHECKER', gestor: 'CI GESTOR' };

const granted = [];
/** Concede só o que o perfil ainda não tinha e guarda para devolver no fim (a semente de CI fica como estava para os testes seguintes). */
async function grantMissing(roleName, codes) {
  const { rows } = await admin(
    `SELECT p.code FROM core.permissions p WHERE p.code = ANY($2::text[]) AND NOT EXISTS (
       SELECT 1 FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id WHERE r.name = $1 AND rp.permission_id = p.id)`,
    [roleName, codes]
  );
  const missing = rows.map((r) => r.code);
  if (missing.length) { await grant(roleName, missing); granted.push([roleName, missing]); }
}

async function revokeGranted() {
  for (const [roleName, codes] of granted.splice(0)) {
    await admin('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2::text[])', [roleName, codes]);
  }
}

/** Devolve as permissões emprestadas e encerra o processo do arquivo (o app real fica escutando a porta). */
async function encerrar() {
  await revokeGranted();
  if (process.env.M3CB_EVIDENCIA_DIR && trilha.length) {
    const fs = require('node:fs');
    const path = require('node:path');
    const nome = path.basename(process.argv[1] || 'teste').replace(/\.test\.js$/, '');
    fs.mkdirSync(process.env.M3CB_EVIDENCIA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.M3CB_EVIDENCIA_DIR, `${nome}.json`), `${JSON.stringify({ arquivo: `test/${nome}.test.js`, chamadas: trilha }, null, 1)}\n`);
  }
  setTimeout(() => process.exit(0), 300);
}

const userIdOf = async (profile) => (await admin('SELECT id FROM core.users WHERE email = $1', [emailFor('A', profile)])).rows[0].id;

/** Sobe o app com os três perfis da empresa A já com as permissões do CRM; `extra` = { perfil: [códigos] } a mais. */
async function subir(port, extra = {}) {
  await grantMissing(ROLES.maker, [...CORRETOR, ...(extra.maker || [])]);
  await grantMissing(ROLES.checker, [...CORRETOR, ...(extra.checker || [])]);
  await grantMissing(ROLES.gestor, [...GESTOR, ...(extra.gestor || [])]);
  const http = await startHttpEnv(port, [['A', 'maker'], ['A', 'checker'], ['A', 'gestor']]);
  const ids = { maker: await userIdOf('maker'), checker: await userIdOf('checker'), gestor: await userIdOf('gestor') };
  const perfilDe = Object.fromEntries(Object.entries(http.tokens).map(([perfil, token]) => [token, perfil]));
  // Evidência (M3CB_EVIDENCIA_DIR): método, caminho, perfil, status e código de cada chamada, sem token nem corpo.
  const call = async (method, path, token, body, headers) => {
    const r = await http.call(method, path, token, body, headers);
    trilha.push({ em: new Date().toISOString(), metodo: method, caminho: `/api/v1${path}`, perfil: perfilDe[token] || null, status: r.status, codigo: (r.body && r.body.error && r.body.error.code) || null });
    return r;
  };
  return { ...http, call, ids };
}
const trilha = [];

const FUTURE = () => new Date(Date.now() + 3 * 86400000).toISOString();
let seq = 0;
const unique = (label) => `${label} ${Date.now()}-${(seq += 1)}`;

/** Cria pela rota (como o gestor) uma pessoa e uma oportunidade com o responsável informado. */
async function oportunidadeDe(env, ownerUserId, label = 'Cliente') {
  const p = await env.call('POST', '/people', env.tokens['A:gestor'], { personType: 'PF', legalName: unique(label), allowDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const o = await env.call('POST', '/opportunities', env.tokens['A:gestor'], { personId: p.body.data.id, stage: 'NEW', ownerUserId, nextAction: 'Ligar para o cliente', nextActionDueAt: FUTURE() });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  return { personId: p.body.data.id, opportunityId: o.body.data.id };
}

async function imovel(env) {
  const s = `${Date.now()}${(seq += 1)}`;
  const r = await env.call('POST', '/properties', env.tokens['A:gestor'], { title: `Imóvel carteira ${s}`, internalCode: `CB-${s}`, propertyType: 'RESIDENTIAL', city: 'Campinas', state: 'SP', addressLine: `Rua ${s}`, zipCode: '13010-000' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

const MFA_SQL = `INSERT INTO core.mfa_step_ups (id, user_id, group_id, company_id, verified_at, expires_at, created_at, updated_at)
  SELECT gen_random_uuid(), u.id, c.group_id, c.id, now(), now() + interval '10 minutes', now(), now() FROM core.users u, core.companies c WHERE u.id = $1 AND c.id = $2`;
/** Verificação de MFA recente gravada no banco descartável (o teste não chama a rota de MFA nem forja token). */
async function mfaRecente(userId, companyId) {
  await admin('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [userId]);
  await admin(MFA_SQL, [userId, companyId]);
}
const semMfa = (userId) => admin('DELETE FROM core.mfa_step_ups WHERE user_id = $1', [userId]);
/** Zera o rastro de acesso do DLP (sinais, anomalias e suspensão, M9-D824) dos usuários: reexecutar o arquivo no mesmo banco não pode
 *  cair na suspensão por "exportações demais" das execuções anteriores. */
async function limparSinaisDlp(userIds) {
  for (const table of ['governance.user_dlp_state', 'governance.access_anomalies', 'governance.access_signals']) {
    await admin(`BEGIN; SET LOCAL session_replication_role = 'replica'; DELETE FROM ${table} WHERE user_id = ANY('{${userIds.join(',')}}'::uuid[]); COMMIT;`);
  }
}
const companyA = async () => (await admin("SELECT id, group_id FROM core.companies WHERE name = 'CI — Empresa Fictícia A'")).rows[0];

module.exports = { DISPOSABLE, SKIP, admin, subir, revokeGranted, encerrar, oportunidadeDe, imovel, mfaRecente, semMfa, companyA, limparSinaisDlp, unique, FUTURE, CORRETOR, GESTOR };
