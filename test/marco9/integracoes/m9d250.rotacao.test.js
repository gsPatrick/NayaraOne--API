'use strict';

// Marco 9, M9-D250 — POST /admin/integrations/:provider/rotate-secret (HTTP real, MFA real do usuário de teste): rotação com janela de graça da M9-D202.
// Roda em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D250_ROTACAO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d250Env');
const secrets = require('../../../src/features/integrations/secrets');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { programavel } = require('../_helpers/m9d214Scripted');
const { MessagingAdapter } = require('../../../src/features/integrations/providers/messaging/messaging.port');

const { carregarTenants, comTenant, ctxDe, sequelize } = env;
let tenant;
let chamar;
let tokenGerencia;
let loja;
const ATUAL = 'valor-atual-QA-M9-D250-abc123';
const NOVO = 'valor-novo-QA-M9-D250-xyz789';
const uniq = () => Math.random().toString(16).slice(2, 10);
const refDe = (nome) => `company/${tenant.companyId}/qa-m9-d250/${uniq()}/${nome}`;

before(async () => {
  ({ tenant } = await carregarTenants());
  loja = secrets.createHttpVaultStore({ mode: 'sandbox' });
  secrets.setSecretStoreForTests(loja);
  tokenGerencia = env.tokenDe(tenant, ['integration:read', 'integration:manage', 'integration:test']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
afterEach(() => { env.restaurarAdaptadores(); });
after(async () => { secrets.setSecretStoreForTests(null); await env.admin().close(); await sequelize.close(); process.exit(0); });

const girar = (body, token = tokenGerencia, provider = 'messaging-sandbox') => chamar(token, 'POST', `/admin/integrations/${provider}/rotate-secret`, body);
const codigo = (r) => (r.corpo.error ? r.corpo.error.code : null);

/** Connection de mensageria (sandbox) com a credencial atual gravada no cofre. */
async function conexaoComSegredo(providerCode = 'messaging-sandbox') {
  const ref = refDe('api-key');
  await loja.put(ref, ATUAL, {});
  const c = await comTenant(tenant, (t) => registry.createConnection({ providerCode, environment: 'SANDBOX', label: `QA-M9 ${uniq()}`, secretRef: ref }, ctxDe(tenant), t));
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND environment = 'SANDBOX' AND status IN ('ACTIVE', 'AUTH_FAILED', 'PAUSED', 'DRAFT') AND id <> :id", { c: tenant.companyId, p: providerCode, id: c.id });
  return { c, ref };
}

test('rotate_secret_gera_novo_valor_com_mfa_e_janela_de_graca', async () => {
  const { c, ref } = await conexaoComSegredo();
  await env.ativarMfa(tenant);
  await env.vencerMfa(tenant);
  const sem = await girar({ environment: 'SANDBOX', connectionId: c.id, generate: true });
  assert.equal(sem.status, 403);
  assert.equal(codigo(sem), 'MFA_STEP_UP_REQUIRED');
  assert.equal((await loja.describe(ref)).version, 1, 'nada mudou');

  await env.ativarMfa(tenant);
  const r = await girar({ environment: 'SANDBOX', connectionId: c.id, generate: true });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.data.connectionId, c.id);
  assert.deepEqual([r.corpo.data.previousVersion, r.corpo.data.version], [1, 2]);
  assert.ok(r.corpo.data.graceUntil, 'a anterior fica em graça');
  assert.deepEqual(Object.keys(r.corpo.data).sort(), ['connectionId', 'graceUntil', 'previousVersion', 'version']);
  const atual = (await loja.get(ref)).value.reveal();
  assert.notEqual(atual, ATUAL, 'o cofre gerou outro valor');
  assert.ok(!JSON.stringify(r.corpo).includes(atual) && !JSON.stringify(r.corpo).includes(ATUAL), 'a resposta nunca traz o valor');
  assert.equal((await loja.getAcceptedVersions(ref)).length, 2, 'webhook em voo ainda confere com a versão anterior durante a graça');
  const [aud] = await env.trilha(tenant, c.id, 'integration.secret.rotated');
  assert.ok(aud);
  assert.ok(!JSON.stringify(aud).includes(atual) && !JSON.stringify(aud).includes(ATUAL), 'a auditoria só leva versões');
});

test('rotate_secret_com_referencia_do_novo_valor_no_cofre', async () => {
  const { c, ref } = await conexaoComSegredo();
  const novaRef = refDe('nova');
  await loja.put(novaRef, NOVO, {});
  await env.ativarMfa(tenant);
  const r = await girar({ environment: 'SANDBOX', connectionId: c.id, newSecretRef: novaRef });
  assert.equal(r.status, 200);
  assert.equal((await loja.get(ref)).value.reveal(), NOVO, 'o valor da referência nova passou a ser o da credencial');
  assert.ok(!JSON.stringify(r.corpo).includes(NOVO));
  const linha = (await env.sql(tenant, 'SELECT last_secret_rotation_at FROM integration.connections WHERE id = :id', { id: c.id }))[0];
  assert.ok(linha.last_secret_rotation_at, 'a data da última rotação foi gravada');
});

test('rotate_secret_corpo_e_referencias_invalidos', async () => {
  const { c, ref } = await conexaoComSegredo();
  await env.ativarMfa(tenant);
  const base = { environment: 'SANDBOX', connectionId: c.id };
  assert.equal((await girar(base)).status, 422, 'sem referência nem generate');
  assert.equal((await girar({ ...base, generate: true, newSecretRef: refDe('x') })).status, 422, 'os dois ao mesmo tempo');
  assert.equal((await girar({ ...base, generate: 'sim' })).status, 422);
  assert.equal((await girar({ ...base, generate: true, expiresAt: '2020-01-01' })).status, 422, 'vencimento no passado');
  assert.equal((await girar({ generate: true })).status, 422, 'sem ambiente');
  assert.equal(codigo(await girar({ ...base, newSecretRef: ref })), 'INTEGRATION_SECRET_REF_INVALID', 'a mesma referência em uso');
  assert.equal(codigo(await girar({ ...base, newSecretRef: `company/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/qa/valor` })), 'INTEGRATION_SECRET_REF_FOREIGN_COMPANY', 'referência de outra empresa');
  assert.equal(codigo(await girar({ ...base, newSecretRef: refDe('inexistente') })), 'INTEGRATION_SECRET_NOT_FOUND');
  assert.equal((await loja.describe(ref)).version, 1, 'nenhuma das recusas mexeu na credencial');
  assert.equal((await girar({ ...base, generate: true }, env.tokenDe(tenant, ['integration:read', 'integration:test']))).status, 403, 'sem integration:manage');
  assert.equal((await girar({ environment: 'SANDBOX', generate: true }, tokenGerencia, 'fornecedor-que-nao-existe')).status, 404);
});

test('rotate_secret_teste_reprovado_mantem_a_credencial_anterior', async () => {
  const Msg = programavel(MessagingAdapter, 'messaging-sandbox', ['sendText', 'sendTemplate', 'sendMedia', 'getStatus']);
  Msg.prototype.healthCheck = async () => ({ ok: false, latencyMs: 1, detail: 'chave nova recusada' });
  env.instalarTemporario(Msg);
  const { c, ref } = await conexaoComSegredo('messaging-sandbox');
  await env.ativarMfa(tenant);
  const r = await girar({ environment: 'SANDBOX', connectionId: c.id, generate: true }, tokenGerencia, 'messaging-sandbox');
  assert.equal(r.status, 422);
  assert.equal(codigo(r), 'INTEGRATION_SECRET_ROTATION_FAILED');
  assert.equal((await loja.describe(ref)).version, 1, 'a candidata foi descartada e a anterior segue');
  assert.equal((await loja.get(ref)).value.reveal(), ATUAL);
});

test('rotate_secret_parametro_do_administrador_desliga_o_mfa_fora_de_producao', async () => {
  const { c } = await conexaoComSegredo();
  await env.ativarMfa(tenant);
  await env.vencerMfa(tenant);
  await env.config(tenant, 'integration.admin.mfa_on_secret_rotation', false);
  try {
    assert.equal((await girar({ environment: 'SANDBOX', connectionId: c.id, generate: true })).status, 200, 'regra desligada pelo administrador');
  } finally { await env.config(tenant, 'integration.admin.mfa_on_secret_rotation', true); }
});
