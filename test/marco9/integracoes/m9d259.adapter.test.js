'use strict';

// Marco 9, M9-D259 — SiteAdapter e site-sandbox sem banco e sem rede: status normalizado, idempotência da publicação, remoção idempotente, falhas por cabeçalho e a suíte de contrato da M9-D222.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const contract = require('../../../src/features/integrations/contract');
const { SiteSandboxAdapter } = require('../../../src/features/integrations/providers/site/sandbox/site-sandbox.adapter');
const { SiteAdapter } = require('../../../src/features/integrations/providers/site/site.port');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const store = require('../../../src/features/integrations/providers/site/sandbox/site.sandbox.store');
const { DOMAIN_CAPABILITIES } = require('../../../src/features/integrations/providers/catalog.domains');

const ctxDe = (id = 'site-t1', config = {}) => Object.freeze({
  connection: Object.freeze({ id, providerCode: 'site-sandbox', environment: 'SANDBOX', apiVersion: 'v1', config }), policy: {}, timeouts: { readMs: 150, writeMs: 150 }, http: null, secret: null,
});
const PAGINA = { pageKey: 'property:ap-1:pt-BR', slug: 'ap-1', locale: 'pt-BR', contentRef: 'property:ap-1@aaaaaaaaaaaa', contentHash: 'a'.repeat(64) };
const usar = (ctx) => { const a = new SiteSandboxAdapter(ctx); return a; };

before(() => { registerBuiltInAdapters(); });
beforeEach(() => store.reset());

test('site_adapter_passa_a_suite_de_contrato_de_d222', async () => {
  assert.ok(contract.listTargets().some((t) => t.providerCode === 'site-sandbox'), 'o site-sandbox tem fixtures e entra na suíte');
  assert.ok(!contract.coverage().pending.some((p) => p.providerCode === 'site-sandbox'), 'não está mais pendente');
  const alvo = contract.listTargets().find((t) => t.providerCode === 'site-sandbox');
  const rel = await contract.runSuite(alvo);
  assert.equal(rel.status, 'PASSED', JSON.stringify(rel.scenarios.filter((s) => s.failures.length).map((s) => [s.id, s.failures.slice(0, 2)])));
  assert.equal(rel.scenarios.length, 10);
  rel.scenarios.forEach((c) => { assert.ok(c.executions > 0, `cenário ${c.id} executou`); assert.deepEqual(c.failures, [], `cenário ${c.id} (${c.name})`); });
  assert.deepEqual([...rel.capabilities].sort(), [...DOMAIN_CAPABILITIES.SITE].sort(), 'as três capabilities de D201');
  assert.deepEqual(rel.supportedVersions || rel.apiVersions || rel.versionsTested, ['v1']);
});

test('site_port_tem_as_tres_capabilities_do_catalogo_e_status_da_ordem', () => {
  assert.deepEqual(Object.keys(SiteAdapter.operations).sort(), [...DOMAIN_CAPABILITIES.SITE].sort());
  assert.deepEqual([SiteAdapter.operations.publishPage.opClass, SiteAdapter.operations.publishPage.confirmation], ['DANGEROUS', 'ON_STATUS']);
  assert.deepEqual([SiteAdapter.operations.unpublishPage.opClass, SiteAdapter.operations.unpublishPage.confirmation], ['SAFE', 'ON_STATUS']);
  const a = usar(null);
  assert.deepEqual(a.statusRank(), { PENDING: 0, PUBLISHED: 1, UNPUBLISHED: 1 }, 'FAILED fica fora da ordem (terminal, tratado à parte)');
  assert.deepEqual(a.supportedVersions(), ['v1']);
  assert.equal(a.supportsIdempotency('publishPage'), true);
});

test('site_get_page_status_normaliza_status_e_status_desconhecido_vira_null', async () => {
  const a = usar(null);
  assert.deepEqual(['pending', 'live', 'removed', 'error'].map((s) => a.mapStatus(s)), ['PENDING', 'PUBLISHED', 'UNPUBLISHED', 'FAILED']);
  assert.equal(a.mapStatus('em_revisao'), null);
  assert.equal(a.mapStatus(undefined), null);
  assert.throws(() => a.normalizeStatus('em_revisao'), (e) => e.statusCode === 502 && e.code === 'INTEGRATION_STATUS_UNMAPPED');
  // getPageStatus pelo contrato do port: pending enquanto o site não publicou, live depois do atraso; status inédito do site é recusado, nunca presumido.
  const ctx = ctxDe('site-s1', { sandbox_publish_delay_ms: 60000 });
  const adapter = usar(ctx);
  await invoke(adapter, 'publishPage', PAGINA, { meta: { idempotencyKey: 'k-1' } });
  assert.equal((await invoke(adapter, 'getPageStatus', { pageKey: PAGINA.pageKey })).status, 'PENDING');
  const imediata = usar(ctxDe('site-s2', { sandbox_publish_delay_ms: 0 }));
  await invoke(imediata, 'publishPage', PAGINA, { meta: { idempotencyKey: 'k-2' } });
  assert.equal((await invoke(imediata, 'getPageStatus', { pageKey: PAGINA.pageKey })).status, 'PUBLISHED');
  await assert.rejects(invoke(usar(ctxDe('site-s1', {})), 'getPageStatus', { pageKey: PAGINA.pageKey, headers: { 'x-sandbox-fail': 'unknown_status' } }), (e) => e.code === 'INTEGRATION_STATUS_UNMAPPED');
  await assert.rejects(invoke(usar(ctxDe('site-s1', {})), 'getPageStatus', { pageKey: 'property:nao-existe:pt-BR' }), (e) => e.status === 404);
});

test('site_publish_page_idempotente_mesma_chave_nao_duplica_no_adapter', async () => {
  const adapter = usar(ctxDe('site-i1'));
  const a = await invoke(adapter, 'publishPage', PAGINA, { meta: { idempotencyKey: 'chave-1' } });
  const b = await invoke(adapter, 'publishPage', PAGINA, { meta: { idempotencyKey: 'chave-1' } });
  assert.equal(a.externalResourceId, b.externalResourceId);
  assert.equal(store.pagesOf('site-i1').length, 1);
  assert.equal(store.pagesOf('site-i1')[0].publishCount, 1, 'a repetição com a mesma chave não publicou de novo');
  assert.equal(a.status, 'PENDING', 'a resposta do site é 202: ainda pendente');
  // Chave nova (conteúdo novo ou republicação) abre outra publicação da MESMA página.
  const c = await invoke(adapter, 'publishPage', { ...PAGINA, contentHash: 'b'.repeat(64) }, { meta: { idempotencyKey: 'chave-2' } });
  assert.notEqual(c.externalResourceId, a.externalResourceId);
  assert.equal(store.pagesOf('site-i1').length, 1);
  // A consulta pela chave (reconciliação) acha a publicação feita; chave desconhecida: não existe.
  assert.equal((await adapter.findByIdempotencyKey(adapter.ctx, { idempotencyKey: 'chave-1' })).found, true);
  assert.equal((await adapter.findByIdempotencyKey(adapter.ctx, { idempotencyKey: 'outra' })).found, false);
});

test('site_unpublish_page_e_idempotente_no_adapter', async () => {
  const adapter = usar(ctxDe('site-u1'));
  // Página que o site nunca viu: remoção responde removida, sem erro (e sem criar página).
  const vazia = await invoke(adapter, 'unpublishPage', { pageKey: 'property:fantasma:pt-BR' });
  assert.equal(vazia.status, 'UNPUBLISHED');
  assert.equal(store.pagesOf('site-u1').length, 0);
  await invoke(adapter, 'publishPage', PAGINA, { meta: { idempotencyKey: 'u-1' } });
  const r1 = await invoke(adapter, 'unpublishPage', { pageKey: PAGINA.pageKey });
  const r2 = await invoke(adapter, 'unpublishPage', { pageKey: PAGINA.pageKey });
  assert.equal(r1.status, 'UNPUBLISHED');
  assert.deepEqual(r2, r1, 'repetir a remoção devolve a mesma publicação e o mesmo estado');
  assert.equal((await invoke(adapter, 'getPageStatus', { pageKey: PAGINA.pageKey })).status, 'UNPUBLISHED');
});

test('site_sandbox_falhas_por_cabecalho_e_nunca_acessa_rede', async () => {
  const adapter = usar(ctxDe('site-f1'));
  const falha = async (modo) => { try { await adapter.publishPage(adapter.ctx, { ...PAGINA, headers: { 'x-sandbox-fail': modo } }, { idempotencyKey: `f-${modo}` }); return null; } catch (e) { return e; } };
  assert.equal((await falha('429')).status, 429);
  assert.equal((await falha('auth')).status, 401);
  assert.equal((await falha('500')).status, 500);
  const lento = await falha('timeout');
  assert.equal(lento.code, 'ETIMEDOUT');
  assert.equal(store.pagesOf('site-f1').length, 0, 'a falha antes do efeito não criou a página');
  assert.equal(adapter.classifyError(await falha('500')).class, 'TRANSIENT');
  assert.equal(adapter.classifyError(await falha('429')).class, 'RATE_LIMIT');
  await assert.rejects(invoke(adapter, 'publishPage', { ...PAGINA, headers: { 'x-sandbox-fail': 'malformed_json' } }), (e) => e.code === 'INTEGRATION_RESPONSE_INVALID');
  assert.equal((await adapter.healthCheck(adapter.ctx, { headers: { 'x-sandbox-fail': '500' } })).ok, false);
  // Nunca fala com a rede: não há cliente HTTP no contexto e o arquivo não importa nenhum transporte.
  const fonte = require('node:fs').readFileSync(require.resolve('../../../src/features/integrations/providers/site/sandbox/site-sandbox.adapter'), 'utf8');
  assert.ok(!/require\('(node:)?(https?|net|tls|dns)'\)|fetch\(|axios/.test(fonte));
});
