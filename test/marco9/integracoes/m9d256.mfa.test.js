'use strict';

// Marco 9, M9-D256 — aprovação humana da liberação: permissão, MFA recente de quem libera, concorrência e retorno a não liberada. Roda em banco descartável (COMMITA).
process.env.PORT = process.env.M9D256_MFA_PORT || '21757';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d256Env');

const { sequelize, carregarTenants } = env;
let tenant;
let chamar;
let token;
const MENSAGERIA = 'messaging-sandbox';

before(async () => {
  ({ tenant } = await carregarTenants());
  env.ligarPastas();
  env.secrets.setSecretStoreForTests(env.secrets.createHttpVaultStore({ mode: 'sandbox' }));
  token = env.tokenDe(tenant, ['integration:read', 'integration:manage']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await env.ativarMfa(tenant);
});
beforeEach(() => env.limparPastas());
after(async () => { env.secrets.setSecretStoreForTests(null); env.desligarPastas(); await env.admin().close(); await sequelize.close(); process.exit(0); });

const liberar = (id, t = token) => chamar(t, 'POST', `/admin/integrations/registry/connections/${id}/release`);

test('release_exige_mfa_de_quem_libera', async () => {
  await env.ativarMfa(tenant);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  await env.vencerMfa(tenant);
  const sem = await liberar(c.id);
  assert.equal(sem.status, 403);
  assert.equal(sem.corpo.error.code, 'MFA_STEP_UP_REQUIRED');
  assert.equal((await env.estadoDe(tenant, c.id)).production_released_at, null, 'sem MFA recente nada é liberado');
  // A exigência vale mesmo com o parâmetro de MFA em mudança de produção desligado: liberar é aprovação humana, não edição.
  await env.config(tenant, 'integration.admin.mfa_on_prod_connection_change', false);
  assert.equal((await liberar(c.id)).corpo.error.code, 'MFA_STEP_UP_REQUIRED');
  await env.limparConfig(tenant, ['integration.admin.mfa_on_prod_connection_change']);
  await env.ativarMfa(tenant);
  const ok = await liberar(c.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  assert.equal(ok.corpo.data.productionReleasedBy, tenant.userId);
});

test('release_exige_permissao_de_gerenciar_integracao', async () => {
  await env.ativarMfa(tenant);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  const leitura = env.tokenDe(tenant, ['integration:read']);
  assert.equal((await liberar(c.id, leitura)).status, 403);
  assert.equal((await liberar('00000000-0000-4000-8000-000000000256')).status, 404, 'connection inexistente');
  const sandbox = await env.comTenant(tenant, (t) => env.registry.createConnection({ providerCode: MENSAGERIA, environment: 'SANDBOX', label: `QA-M9 ${env.uniqueSuffix()}` }, env.ctxDe(tenant), t));
  const fora = await liberar(sandbox.id);
  assert.equal(fora.status, 409, 'só connection de PRODUÇÃO é liberada');
  assert.equal(fora.corpo.error.code, 'INTEGRATION_RELEASE_ENVIRONMENT_INVALID');
});

test('release_concorrente_libera_uma_vez_so', async () => {
  await env.ativarMfa(tenant);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  const rs = await Promise.all([liberar(c.id), liberar(c.id), liberar(c.id)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409], JSON.stringify(rs.map((r) => r.corpo.error)));
  assert.ok(rs.filter((r) => r.status === 409).every((r) => r.corpo.error.code === 'INTEGRATION_RELEASE_ALREADY_RELEASED'));
  assert.equal((await env.trilha(tenant, c.id, 'integration.connection.production_released')).length, 1, 'uma só liberação auditada');
});

test('release_pausar_ou_desativar_volta_a_nao_liberada', async () => {
  await env.ativarMfa(tenant);
  const c = await env.conexaoDeProducao(tenant, MENSAGERIA);
  await env.evidenciaCompleta(tenant, MENSAGERIA);
  assert.equal((await liberar(c.id)).status, 200);
  await env.sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE id = :id", { id: c.id });
  const estados = await chamar(token, 'GET', '/admin/integrations/registry/release-gate');
  assert.equal(estados.status, 200);
  assert.equal(estados.corpo.data.connections.find((x) => x.connectionId === c.id).releaseState, 'NOT_RELEASED', 'pausada volta a não liberada (D200)');
  const de = await liberar(c.id);
  assert.equal(de.status, 200, 'pausada, a liberação precisa de todas as evidências de novo e as tem');
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE id = :id", { id: c.id });
  assert.equal((await liberar(c.id)).corpo.error.code, 'INTEGRATION_CONNECTION_INVALID_TRANSITION', 'desativada é final');
});
