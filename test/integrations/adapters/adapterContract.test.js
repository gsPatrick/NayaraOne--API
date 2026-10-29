'use strict';

// Marco 9, M9-D209 — contrato IntegrationAdapter: validação no boot, capabilities, health, status, versão, resolução, redação.
// Roda em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 <arquivo>
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { sequelize, getSeedTenant, uniqueSuffix } = require('../../testHelpers');
const { IntegrationConnection, IntegrationError } = require('../../../src/models');
const registryService = require('../../../src/features/integrations/registry/registry.service');
const settingsService = require('../../../src/features/settings/settings.service');
const { IntegrationAdapter } = require('../../../src/features/integrations/registry/IntegrationAdapter');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { runHealthCheck } = require('../../../src/features/integrations/registry/adapterHealth');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const { classifyHttpError } = require('../../../src/features/integrations/registry/classifyHttpError');
const { registerBuiltInAdapters, BUILT_IN_ADAPTERS } = require('../../../src/features/integrations/adapters');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { DOMAIN_CAPABILITIES, DOMAINS } = require('../../../src/features/integrations/providers/catalog.domains');
const { MessagingAdapter } = require('../../../src/features/integrations/providers/messaging/messaging.port');
const { BankAdapter } = require('../../../src/features/integrations/providers/bank/bank.port');

let tenant;
let ctx;
const RAIZ = path.join(__dirname, '..', '..', '..');
const comTenant = async (fn) => {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (e) { await t.rollback(); throw e; }
};
const config = (k, v) => comTenant((t) => settingsService.upsertSetting(k, v, tenant, tenant.userId, t));
const conexao = (providerCode) => comTenant(async (t) => {
  await sequelize.query("UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND environment = 'SANDBOX' AND status = 'ACTIVE'", { replacements: { c: tenant.companyId, p: providerCode }, transaction: t });
  return registryService.createConnection({ providerCode, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}` }, ctx, t);
});

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  registerBuiltInAdapters();
});
afterEach(() => { adapterRegistry.unregister('qa-m9-d209-x'); registerBuiltInAdapters(); });
after(async () => { await config('integration.health.check_timeout_ms', 5000); await sequelize.close(); });

/** Adapter mínimo e válido de um domínio, para os cenários. */
function adapterValido(Port, code, caps, extra = {}) {
  const Cls = class extends Port {
    providerCode() { return code; }
    capabilities() { return caps; }
    supportedVersions() { return ['v1', 'v2']; }
    async healthCheck() { return { ok: true, latencyMs: 1, detail: 'ok' }; }
    classifyError(e) { return classifyHttpError(e); }
    mapStatus(s) { return s === 'OK' ? 'DONE' : null; }
  };
  Object.assign(Cls.prototype, extra);
  return Cls;
}

test('adapter_contract_valida_metodos_obrigatorios', () => {
  assert.equal(adapterRegistry.register(adapterValido(BankAdapter, 'qa-m9-d209-x', ['submitPayment'], { submitPayment: async () => ({ status: 'OK' }) })).code, 'qa-m9-d209-x');
  adapterRegistry.unregister('qa-m9-d209-x');
  const semHealth = class extends BankAdapter {
    providerCode() { return 'qa-m9-d209-x'; }
    capabilities() { return ['submitPayment']; }
    supportedVersions() { return ['v1']; }
    classifyError() { return {}; }
    mapStatus() { return null; }
    async submitPayment() { return {}; }
  };
  assert.throws(() => adapterRegistry.register(semHealth), (e) => e.statusCode === 500 && e.code === 'INTEGRATION_ADAPTER_CONTRACT_INVALID' && e.details.problemas.some((p) => p.includes('healthCheck')));
  assert.throws(() => adapterRegistry.register(class {}), (e) => e.code === 'INTEGRATION_ADAPTER_CONTRACT_INVALID');
  assert.throws(() => adapterRegistry.register(class extends IntegrationAdapter {}), (e) => e.code === 'INTEGRATION_ADAPTER_CONTRACT_INVALID' && e.details.problemas.length >= 6);
  // O boot cai: um processo que registra o adapter inválido sai com erro e a mensagem do contrato.
  const codigo = `
    const { BankAdapter } = require('./src/features/integrations/providers/bank/bank.port');
    const reg = require('./src/features/integrations/registry/adapterRegistry');
    class Ruim extends BankAdapter { providerCode() { return 'qa-m9-d209-x'; } capabilities() { return ['submitPayment']; } supportedVersions() { return ['v1']; } async submitPayment() { return {}; } }
    reg.register(Ruim);
    console.log('SUBIU');`;
  let saida = '';
  let saiu = 0;
  try { saida = execFileSync(process.execPath, ['-e', codigo], { cwd: RAIZ, env: process.env, stdio: 'pipe' }).toString(); } catch (e) { saiu = e.status; saida = String(e.stderr); }
  assert.notEqual(saiu, 0, 'o processo não pode subir');
  assert.ok(!saida.includes('SUBIU'));
  assert.match(saida, /INTEGRATION_ADAPTER_CONTRACT_INVALID/);
});

test('adapter_capabilities_subconjunto_do_dominio', () => {
  const estranha = adapterValido(MessagingAdapter, 'qa-m9-d209-x', ['sendText', 'submitPayment'], { sendText: async () => ({}), submitPayment: async () => ({}) });
  assert.throws(() => adapterRegistry.register(estranha), (e) => e.code === 'INTEGRATION_ADAPTER_CONTRACT_INVALID' && e.details.problemas.some((p) => p.includes('submitPayment') && p.includes('MESSAGING')));
  const semOperacao = adapterValido(MessagingAdapter, 'qa-m9-d209-x', ['sendText']);
  assert.throws(() => adapterRegistry.register(semOperacao), (e) => e.details.problemas.some((p) => p.includes('sendText')));
  adapterRegistry.register(adapterValido(MessagingAdapter, 'qa-m9-d209-x', ['sendText'], { sendText: async () => ({ status: 'OK' }) }));
  // Catálogo: um adapter com o código de um fornecedor do catálogo precisa declarar as mesmas capabilities gravadas.
  const divergente = adapterValido(MessagingAdapter, 'messaging-sandbox', ['sendText'], { sendText: async () => ({}) });
  assert.throws(() => adapterRegistry.register(divergente), (e) => e.details.problemas.some((p) => p.includes('catálogo')));
  // Os 14 ports existem, são versionados e cobrem exatamente as capabilities do domínio.
  assert.deepEqual(Object.keys(PORTS).sort(), [...DOMAINS].sort());
  DOMAINS.forEach((d) => {
    assert.equal(PORTS[d].domain, d);
    assert.equal(PORTS[d].portVersion, '1');
    assert.deepEqual(Object.keys(PORTS[d].operations).sort(), [...DOMAIN_CAPABILITIES[d]].sort(), `port ${d}`);
  });
});

test('adapter_health_check_nunca_lanca', async () => {
  await config('integration.health.check_timeout_ms', 500);
  const modos = {
    lanca: { healthCheck: async () => { throw new Error('boom com token=abc123'); } },
    travado: { healthCheck: () => new Promise(() => {}) },
    formatoErrado: { healthCheck: async () => ({ ok: 'sim' }) },
    sincrono: { healthCheck: () => { throw new Error('síncrono'); } },
  };
  for (const [nome, impl] of Object.entries(modos)) {
    const A = adapterValido(BankAdapter, 'qa-m9-d209-x', ['submitPayment'], { submitPayment: async () => ({}), ...impl });
    const t0 = Date.now();
    const r = await runHealthCheck(new A({ healthCheckTimeoutMs: 500 }), ctx, null);
    assert.equal(r.ok, false, nome);
    assert.equal(typeof r.detail, 'string');
    assert.ok(Date.now() - t0 < 2000, `${nome}: respeita o tempo máximo`);
    assert.ok(!JSON.stringify(r).includes('abc123'), 'o segredo não vaza');
  }
  const bom = await runHealthCheck(new (adapterValido(BankAdapter, 'qa-m9-d209-x', ['submitPayment'], { submitPayment: async () => ({}) }))({}), ctx, null);
  assert.deepEqual(bom, { ok: true, latencyMs: 1, detail: 'ok' });
  for (const A of BUILT_IN_ADAPTERS) assert.equal((await runHealthCheck(new A({ healthCheckTimeoutMs: 500, secret: async () => { throw new Error('sem cofre'); } }), ctx, null)).ok === true || A.name.includes('Clicksign'), true, A.name);
});

test('adapter_map_status_desconhecido_retorna_null', async () => {
  for (const A of BUILT_IN_ADAPTERS) {
    const a = new A(null);
    assert.equal(a.mapStatus('STATUS_QUE_NAO_EXISTE'), null, A.name);
    assert.equal(a.mapStatus(undefined), null);
    assert.throws(() => a.normalizeStatus('STATUS_QUE_NAO_EXISTE'), (e) => e.statusCode === 502 && e.code === 'INTEGRATION_STATUS_UNMAPPED');
  }
  const a = new (BUILT_IN_ADAPTERS.find((x) => new x(null).providerCode() === 'bank-sandbox'))({ connection: { id: null } });
  assert.equal(a.mapStatus('confirmed'), 'PAID');
  // invoke: status que o adapter não mapeia vira erro de integração da empresa, não presunção.
  const Ruim = adapterValido(BankAdapter, 'qa-m9-d209-x', ['getPaymentStatus'], { async getPaymentStatus() { return { status: this.normalizeStatus('???') }; } });
  const c = await conexao('bank-sandbox');
  // O erro é gravado na transação do chamador; quem captura a recusa e comita (como o DispatchService) mantém a linha.
  const recusa = await comTenant(async (t) => invoke(new Ruim({ connection: { id: c.id } }), 'getPaymentStatus', { externalResourceId: 'x' }, { tenant: ctx, transaction: t }).then(() => null, (e) => e));
  assert.equal(recusa.statusCode, 502);
  assert.equal(recusa.code, 'INTEGRATION_STATUS_UNMAPPED');
  const erros = await comTenant((t) => IntegrationError.count({ where: { errorCode: 'INTEGRATION_STATUS_UNMAPPED', connectionId: c.id }, transaction: t }));
  assert.equal(erros, 1);
});

test('adapter_versao_nao_suportada', async () => {
  const c = await conexao('financing-sandbox');
  const conn = await comTenant((t) => IntegrationConnection.findByPk(c.id, { transaction: t }));
  conn.apiVersion = 'v3';
  await assert.rejects(comTenant((t) => adapterRegistry.resolve(conn, ctx, t)), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_VERSION_UNSUPPORTED' && e.details.suportadas.includes('v1'));
  conn.apiVersion = 'v1';
  const ok = await comTenant((t) => adapterRegistry.resolve(conn, ctx, t));
  assert.equal(ok.providerCode(), 'financing-sandbox');
});

test('adapter_resolve_por_connection', async () => {
  const [cb, cf] = [await conexao('bank-sandbox'), await conexao('financing-sandbox')];
  await config('integration.dispatch.timeout_ms.read', 3000);
  await config('integration.dispatch.timeout_ms.write', 4000);
  const [b, f] = await comTenant(async (t) => [
    await adapterRegistry.resolve(await IntegrationConnection.findByPk(cb.id, { transaction: t }), ctx, t),
    await adapterRegistry.resolve(await IntegrationConnection.findByPk(cf.id, { transaction: t }), ctx, t),
  ]);
  assert.notEqual(b.constructor, f.constructor, 'a troca de connection troca a instância');
  assert.equal(b.ctx.connection.id, cb.id);
  assert.equal(f.ctx.connection.id, cf.id);
  assert.deepEqual(b.ctx.timeouts, { readMs: 3000, writeMs: 4000 }, 'tempos vêm dos parâmetros da empresa');
  assert.equal(typeof b.ctx.secret, 'function');
  assert.ok(Object.isFrozen(b.ctx));
  for (const proibido of ['companyId', 'groupId', 'userId', 'tenant', 'transaction', 'sequelize']) {
    assert.ok(!(proibido in b.ctx) && !(proibido in b.ctx.connection), `o adapter não conhece ${proibido}`);
  }
  // O chamador usa só o Port: a mesma chamada, instâncias diferentes.
  assert.equal((await invoke(b, 'submitPayment', { amount: '10.00', payee: 'X', idempotencyKey: 'k1' })).status, 'PENDING');
  const r = await invoke(f, 'simulate', { amount: 1000, termMonths: 12 });
  assert.deepEqual(Object.keys(r).sort(), ['externalRequestId', 'externalResourceId', 'status'], 'raw não sai do módulo');
  await assert.rejects(invoke(b, 'submitPayment', { amount: '10.00' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_REQUEST_INVALID');
  await assert.rejects(invoke(b, 'simulate', {}), (e) => e.code === 'INTEGRATION_OPERATION_UNSUPPORTED');
  // Fornecedor do catálogo sem adapter instalado: 501.
  adapterRegistry.unregister('messaging-sandbox');
  const cm = await conexao('messaging-sandbox');
  await assert.rejects(comTenant(async (t) => adapterRegistry.resolve(await IntegrationConnection.findByPk(cm.id, { transaction: t }), ctx, t)), (e) => e.statusCode === 501 && e.code === 'INTEGRATION_ADAPTER_NOT_IMPLEMENTED');
  await config('integration.dispatch.timeout_ms.read', 10000);
  await config('integration.dispatch.timeout_ms.write', 20000);
});
