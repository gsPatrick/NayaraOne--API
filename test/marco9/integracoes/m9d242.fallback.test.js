'use strict';

// Marco 9, M9-D242 — contingência da identidade (INT-015, família IDENTITY em PRESERVE_AND_ALTERNATE_FLOW): com o provedor externo fora (circuito aberto ou sem connection ativa)
// a contingência é ativada e o login local segue só para quem a política libera. Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env242 = require('../_helpers/m9d242Env');
const env = require('../_helpers/m9d226Env');
const authService = require('../../../src/features/auth/auth.service');
const identity = require('../../../src/features/integrations/identity');
const keys = require('../../../src/features/integrations/providers/identity/sandbox/identity.sandbox.keys');
const { signAccessToken } = require('../../../src/utils/jwt');

const { sequelize, comTenant, ctxDe, registry } = env;
let ciA;

const KEYS = ['integration.identity.local_fallback_enabled', 'integration.identity.local_fallback_admin_enabled', 'integration.identity.local_fallback_admin_roles', 'integration.identity.clock_tolerance_s'];
const login = () => authService.login({ email: ciA.email, password: ciA.password, companyId: ciA.companyId });
const negado = (e) => e.statusCode === 403 && e.code === 'INTEGRATION_IDENTITY_FALLBACK_DENIED';
const auditorias = (acao) => comTenant(ciA, async (t) => (await sequelize.query(
  'SELECT * FROM audit.audit_log WHERE company_id = :c AND action = :a', { replacements: { c: ciA.companyId, a: acao }, transaction: t },
))[0]);
const erros = (codigo) => comTenant(ciA, async (t) => (await sequelize.query(
  "SELECT * FROM integration.integration_errors WHERE company_id = :c AND error_code = :k AND status = 'OPEN'", { replacements: { c: ciA.companyId, k: codigo }, transaction: t },
))[0]);

before(async () => {
  assert.ok(process.env.CI_TENANT_USERS_PASSWORD, 'o teste precisa do seed de dois tenants (CI_TENANT_USERS_PASSWORD)');
  ciA = await env242.tenantCiA();
  identity.ensureIdentityRegistered();
  env.contingency.installContingency();
});
beforeEach(async () => { await env.limparContingencias(ciA); await env.limparConfig(ciA, KEYS); await env.semConexoes(ciA, 'IDENTITY'); await env.limparCircuito(ciA); });
after(async () => { await env.limparContingencias(ciA); await env.limparConfig(ciA, KEYS); await env.semConexoes(ciA, 'IDENTITY'); await sequelize.close(); });

test('identity_fallback_local_admin', async () => {
  // Sem provedor externo: o login local é o de sempre e o token vale pelo adapter identity-local.
  const sem = await login();
  const v = await comTenant(ciA, (t) => identity.verifyToken(ciA, sem.accessToken, t));
  assert.equal(v.provider, 'identity-local');
  assert.equal(v.subject, ciA.userId);
  assert.equal((await env.ativas(ciA)).filter((a) => a.domain === 'IDENTITY').length, 0, 'sem provedor externo não há contingência');

  // Provedor externo de pé: o login local segue igual, sem contingência.
  const idp = await env.conexaoDe(ciA, 'identity-sandbox');
  await login();
  assert.equal((await env.ativas(ciA)).filter((a) => a.domain === 'IDENTITY').length, 0);

  // Circuito aberto: a contingência da família é ativada no modo do livro e o login local passa a depender da política.
  await env.falhar(ciA, idp.id, 5);
  const ativas = (await env.ativas(ciA)).filter((a) => a.connectionId === idp.id);
  assert.equal(ativas.length, 1, 'o circuito aberto ativa a contingência da connection de identidade');
  assert.equal(ativas[0].mode, 'PRESERVE_AND_ALTERNATE_FLOW');
  assert.equal(ativas[0].domain, 'IDENTITY');
  assert.deepEqual(ativas[0].reasons, ['CIRCUIT_OPEN']);
  const linha = (await erros('CONTINGENCY_ACTIVE')).filter((e) => e.connection_id === idp.id);
  assert.equal(linha.length, 1, 'linha real em integration_errors (CONTINGENCY_ACTIVE)');
  assert.equal(linha[0].source, 'HEALTH');

  // Usuário comum: o provedor está fora e a política só libera administradores.
  await assert.rejects(login(), negado);
  // Administrador (papel na lista da política): o login local segue e fica registrado.
  await env.config(ciA, 'integration.identity.local_fallback_admin_roles', 'CI MAKER');
  const antes = (await auditorias('integration.identity.local_fallback_used')).length;
  const admin = await login();
  assert.ok(admin.accessToken, 'o administrador entra pelo identity-local mesmo com o provedor fora');
  assert.equal((await auditorias('integration.identity.local_fallback_used')).length - antes, 1, 'o uso do acesso local na contingência é auditado');
  assert.equal((await comTenant(ciA, (t) => identity.verifyToken(ciA, admin.accessToken, t))).provider, 'identity-local', 'o token local segue valendo');
  // A política desligada (geral ou só para administradores) volta a negar.
  await env.config(ciA, 'integration.identity.local_fallback_admin_enabled', false);
  await assert.rejects(login(), negado);
  await env.config(ciA, 'integration.identity.local_fallback_admin_enabled', true);
  await env.config(ciA, 'integration.identity.local_fallback_enabled', false);
  await assert.rejects(login(), negado);
  await env.config(ciA, 'integration.identity.local_fallback_enabled', true);
  await login();
  // O provedor volta: o login local deixa de depender da política.
  await env.fecharCircuito(ciA, idp.id);
  await env.config(ciA, 'integration.identity.local_fallback_admin_roles', 'OUTRO PAPEL');
  await login();
});

test('identity_contingencia_sem_connection_ativa_mantem_autenticacao_local', async () => {
  const idp = await env.conexaoDe(ciA, 'identity-sandbox');
  await comTenant(ciA, (t) => registry.transitionConnection(idp.id, 'PAUSED', ctxDe(ciA), t));
  assert.equal((await comTenant(ciA, (t) => identity.externalIdentityState(ciA, t))).reason, 'NO_ACTIVE_CONNECTION');
  // Usuário comum: a política nega; a contingência da família foi ativada (e sobrevive ao pedido recusado).
  await assert.rejects(login(), negado);
  const familia = (await env.ativas(ciA)).filter((a) => a.scope === 'FAMILY' && a.domain === 'IDENTITY');
  assert.equal(familia.length, 1);
  assert.equal(familia[0].mode, 'PRESERVE_AND_ALTERNATE_FLOW');
  assert.deepEqual(familia[0].reasons, ['NO_ACTIVE_CONNECTION']);
  assert.ok((await erros('CONTINGENCY_ACTIVE')).length >= 1, 'a contingência da família fica registrada em integration_errors');
  // Administrador: a autenticação local segue.
  await env.config(ciA, 'integration.identity.local_fallback_admin_roles', 'CI MAKER');
  assert.ok((await login()).accessToken);
  // Token local continua válido com o provedor fora; token de outro emissor é recusado (401), nunca aceito.
  const local = signAccessToken({ sub: ciA.userId, group_id: ciA.groupId, company_id: ciA.companyId, roles: [], permissions: [] });
  assert.equal((await comTenant(ciA, (t) => identity.verifyToken(ciA, local, t))).provider, 'identity-local');
  await assert.rejects(comTenant(ciA, (t) => identity.verifyToken(ciA, keys.issueToken({}), t)), (e) => e.statusCode === 401 && e.code === 'INTEGRATION_IDENTITY_TOKEN_INVALID');
});

test('identity_token_externo_valido_pelo_provedor_ativo', async () => {
  const idp = await env.conexaoDe(ciA, 'identity-sandbox');
  const r = await comTenant(ciA, (t) => identity.verifyToken(ciA, keys.issueToken({ sub: 'pessoa-externa' }), t));
  assert.equal(r.provider, 'identity-sandbox');
  assert.equal(r.subject, 'pessoa-externa');
  // Emissor errado: 401 INTEGRATION_IDENTITY_TOKEN_INVALID. A tolerância de relógio vem da configuração da empresa.
  await assert.rejects(comTenant(ciA, (t) => identity.verifyToken(ciA, keys.issueToken({}, { issuer: 'outro' }), t)), (e) => e.code === 'INTEGRATION_IDENTITY_TOKEN_INVALID');
  const vencido = keys.issueToken({}, { expiresInS: -30 });
  assert.equal((await comTenant(ciA, (t) => identity.verifyToken(ciA, vencido, t))).provider, 'identity-sandbox', 'padrão: 60 s de tolerância');
  await env.config(ciA, 'integration.identity.clock_tolerance_s', 0);
  await assert.rejects(comTenant(ciA, (t) => identity.verifyToken(ciA, vencido, t)), (e) => e.code === 'INTEGRATION_IDENTITY_TOKEN_INVALID');
  assert.ok(idp.id);
});

test('identity_parametros_validados_e_lidos', async () => {
  const p = await comTenant(ciA, (t) => identity.readIdentityParams(ciA, t));
  assert.deepEqual({ ...p }, { localFallbackEnabled: true, localFallbackAdminEnabled: true, clockToleranceS: 60, jwksCacheTtlS: 300, algorithms: ['RS256'], adminRoles: ['ADMIN'] });
  const rejeita = (k, v) => assert.rejects(env.config(ciA, k, v), (e) => e.code === 'SETTING_INVALID_VALUE', `${k}=${v}`);
  await rejeita('integration.identity.allowed_algorithms', 'none');
  await rejeita('integration.identity.allowed_algorithms', 'RS256,none');
  await rejeita('integration.identity.clock_tolerance_s', 301);
  await rejeita('integration.identity.jwks_cache_ttl_s', 5);
  await env.config(ciA, 'integration.identity.allowed_algorithms', 'RS256, ES256');
  assert.deepEqual((await comTenant(ciA, (t) => identity.readIdentityParams(ciA, t))).algorithms, ['RS256', 'ES256']);
  await env.limparConfig(ciA, ['integration.identity.allowed_algorithms']);
});
