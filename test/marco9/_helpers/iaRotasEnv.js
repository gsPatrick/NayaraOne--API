'use strict';

// Ambiente HTTP comum dos testes das rotas da NAY da M9-D031: sobe o app, concede permissões aos perfis do seed de dois tenants,
// liga a NAY nas duas empresas e devolve os ids das pessoas. Só roda no cluster descartável; nunca chama MFA nem forja token.

const assert = require('node:assert/strict');
const { admin, grant, startHttpEnv } = require('./aiHttpEnv');
const { emailFor } = require('../../../scripts/seed-ci-two-tenants');

async function usuario(tenantKey, perfil) {
  const r = await admin(
    `SELECT u.id, m.group_id, m.company_id FROM core.users u JOIN core.user_memberships m ON m.user_id = u.id AND m.status = 'ACTIVE' WHERE u.email = $1 LIMIT 1`, [emailFor(tenantKey, perfil)]
  );
  return { id: r.rows[0].id, groupId: r.rows[0].group_id, companyId: r.rows[0].company_id };
}

/** Limpa as permissões `ai:*` dos perfis antes de conceder as deste arquivo (outros testes do mesmo cluster acumulam concessões). */
const revogarAi = (perfis) => admin(
  `DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = ANY($1::text[]) AND p.code LIKE 'ai:%'`,
  [perfis]
);

/** Perfis: gestor (admin, approve, evaluate, budget, audit), checker (ai:read, ai:approve, ai:evaluate), maker (só ai:read), somente (só ai:use). */
async function subir(porta) {
  await revogarAi(['CI GESTOR', 'CI CHECKER', 'CI MAKER', 'CI LEITURA']);
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'ai:audit', 'ai:approve', 'ai:evaluate', 'ai:budget', 'settings:read', 'settings:update']);
  await grant('CI CHECKER', ['ai:read', 'ai:approve', 'ai:evaluate']);
  await grant('CI MAKER', ['ai:read']);
  await grant('CI LEITURA', ['ai:use']);
  const env = await startHttpEnv(porta, [['A', 'gestor'], ['A', 'checker'], ['A', 'maker'], ['A', 'leitura'], ['B', 'gestor']]);
  const gestor = await usuario('A', 'gestor');
  const pessoas = { gestor: gestor.id, checker: (await usuario('A', 'checker')).id, maker: (await usuario('A', 'maker')).id };
  const tenant = { groupId: gestor.groupId, companyId: gestor.companyId, userId: gestor.id };
  const desligada = await env.call('GET', '/ai/budgets', env.tokens['A:gestor']);
  assert.equal(desligada.body.error.code, 'AI_FEATURE_DISABLED');
  for (const t of ['A:gestor', 'B:gestor']) assert.equal((await env.call('PUT', '/settings/ia.habilitada', env.tokens[t], { value: true })).status, 200);
  return { env, pessoas, tenant };
}

async function encerrar(env, extras = []) {
  if (!env) return;
  for (const chave of extras) await env.call('PUT', `/settings/${chave}`, env.tokens['A:gestor'], { value: false });
  for (const t of ['A:gestor', 'B:gestor']) await env.call('PUT', '/settings/ia.habilitada', env.tokens[t], { value: false });
  setTimeout(() => process.exit(0), 300);
}

module.exports = { subir, encerrar, usuario };
