'use strict';

// M9-D428 — os cinco adapters de rede (Instagram, Facebook, LinkedIn, YouTube, TikTok): contrato do sandbox, capabilities próprias, post idempotente com marca,
// redação de token e token só no cofre. Sem banco: o sandbox é puro e o cliente HTTP do adapter real é falso.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adapters = require('../../../src/features/marketing/publications/adapters');
const social = require('../../../src/features/marketing/publications/adapters/social');

const { SOCIAL_NETWORKS } = social;
const TOKEN = 'EAABsbCS1iHgBAPlmnopQRSTuvwxYZ0123456789tokenDaRede';
const CLASSES = { INSTAGRAM: 'InstagramAdapter', FACEBOOK: 'FacebookAdapter', LINKEDIN: 'LinkedInAdapter', YOUTUBE: 'YouTubeAdapter', TIKTOK: 'TikTokAdapter' };

const resposta = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, text: async () => JSON.stringify(body), json: async () => body });
function real(network, handler, opts = {}) {
  const calls = [];
  const ctx = {
    connection: { id: 'conn-social', providerCode: 'social-x', environment: 'PRODUCTION', apiVersion: null, config: { baseUrl: 'https://rede.exemplo.com.br/v1/' } },
    policy: {}, timeouts: { readMs: 1000, writeMs: 1000 }, healthCheckTimeoutMs: 1000,
    http: { request: async (req) => { calls.push(req); return handler(req); } },
    secret: async () => ({ value: { reveal: () => TOKEN } }),
  };
  const Real = social.REAL_ADAPTERS[network];
  return { calls, adapter: new Real(network, ctx, { proof: adapters.mintReleaseProof(), ...opts }) };
}
const sandbox = (network, extra = {}) => adapters.channelRegistry.get(network, 'SANDBOX').create({ scope: 'qa-m9', slowMs: 5, retryAfterS: 7, ...extra });

test('cada_rede_tem_o_seu_adapter_registrado_em_sandbox_e_em_producao', () => {
  for (const network of SOCIAL_NETWORKS) {
    const Sandbox = social[CLASSES[network]];
    assert.equal(typeof Sandbox, 'function', network);
    assert.ok(sandbox(network) instanceof Sandbox, `${network}: o sandbox é a classe própria da rede`);
    assert.ok(sandbox(network) instanceof adapters.SandboxChannelAdapter);
    assert.ok(social.REAL_ADAPTERS[network].prototype instanceof adapters.RealChannelAdapter);
    assert.deepEqual(adapters.channelRegistry.list().filter((e) => e.channel === network).map((e) => e.mode).sort(), ['PRODUCTION', 'SANDBOX']);
  }
});

test('contract_test_do_adapter_sandbox: a suíte única passa nos cinco e cada rede declara as suas capabilities', async () => {
  for (const network of SOCIAL_NETWORKS) {
    const report = await adapters.runChannelContract(network, { make: (scope, extra) => sandbox(network, { scope, ...extra }) });
    assert.deepEqual(report.results.filter((r) => !r.ok), [], network);
    const adapter = sandbox(network);
    const caps = adapter.networkCapabilities();
    assert.deepEqual(caps, social.DEFAULT_CAPABILITIES[network], `${network}: capabilities da rede`);
    assert.ok(adapter.capabilities().includes('publish') && adapter.capabilities().includes('findByIdempotencyKey') && adapter.capabilities().includes('getMetrics'));
    assert.equal((await adapter.healthCheck()).ok, true);
  }
  assert.equal(sandbox('INSTAGRAM').networkCapabilities().legendaMax, 2200);
  assert.deepEqual(sandbox('INSTAGRAM').networkCapabilities().proporcoes.REEL, ['9:16']);
});

test('post_idempotente_por_rede: a mesma chave publica uma vez e o texto leva a marca da chave', async () => {
  for (const network of SOCIAL_NETWORKS) {
    const adapter = sandbox(network);
    const post = { titulo: 'Novo imóvel', texto: 'Apartamento de 3 quartos.' };
    const a = await adapter.publish(post, { idempotencyKey: 'pub:v1:rede:2026-10-30T12:00:00.000Z' });
    const b = await adapter.publish(post, { idempotencyKey: 'pub:v1:rede:2026-10-30T12:00:00.000Z' });
    assert.equal(b.providerRef, a.providerRef, network);
    assert.equal(b.replayed, true);
    assert.equal(adapters.sandboxRecordCount('qa-m9', network), 1, `${network}: um único post`);
    assert.match(a.watermark, /^[0-9a-f]{8}$/, 'a marca da chave volta no resultado');
    const found = await adapter.findByIdempotencyKey('pub:v1:rede:2026-10-30T12:00:00.000Z');
    assert.deepEqual([found.found, found.providerRef], [true, a.providerRef]);
    const other = await adapter.publish(post, { idempotencyKey: 'pub:v1:rede:2026-10-30T13:00:00.000Z' });
    assert.notEqual(other.providerRef, a.providerRef);
    assert.notEqual(other.watermark, a.watermark);
  }
  adapters.resetSandbox();
});

test('a_marca_e_invisivel_ou_hashtag_tecnica_pelo_parametro_e_nao_muda_o_texto_visivel', () => {
  const invisible = social.watermarkFor('chave-1', { mode: 'INVISIVEL', hashtagPrefix: 'nyr' });
  const tag = social.watermarkFor('chave-1', { mode: 'HASHTAG', hashtagPrefix: 'nyr' });
  assert.match(invisible.code, /^[0-9a-f]{8}$/);
  assert.equal(invisible.code, tag.code, 'o código é o mesmo nos dois modos');
  assert.match(invisible.suffix, /^[\u200b\u200c]+$/, 'invisível: só caracteres de largura zero');
  assert.equal(tag.suffix, ` #nyr${tag.code}`);
  const marked = social.applyWatermark({ texto: 'Olá', titulo: 'T' }, invisible);
  assert.equal(marked.texto.replace(/[\u200b\u200c]/g, ''), 'Olá', 'o texto visível não muda');
  assert.equal(marked.titulo, 'T');
  assert.equal(social.extractWatermarkCode(marked.texto), invisible.code, 'a marca é lida de volta (reconciliação)');
  assert.equal(social.extractWatermarkCode(social.applyWatermark({ texto: 'Olá' }, tag).texto), tag.code);
  assert.equal(social.watermarkFor('chave-2', { mode: 'INVISIVEL' }).code === invisible.code, false);
});

test('real_busca_o_post_pela_marca_quando_a_rede_nao_tem_idempotencia_nativa', async () => {
  const { adapter, calls } = real('LINKEDIN', (req) => (req.method === 'POST' ? resposta(201, { id: 'urn-1', status: 'PROCESSING' }) : resposta(200, { items: [{ id: 'urn-1', status: 'LIVE' }] })));
  const sent = await adapter.publish({ texto: 'Novo imóvel' }, { idempotencyKey: 'pub:chave-real-1' });
  assert.equal(sent.status, 'PROCESSING');
  assert.equal(calls[0].headers['idempotency-key'], 'pub:chave-real-1');
  const body = JSON.parse(calls[0].body);
  assert.ok(body.texto.startsWith('Novo imóvel') && body.texto.length > 'Novo imóvel'.length, 'a marca vai no texto enviado');
  const found = await adapter.findByIdempotencyKey('pub:chave-real-1');
  assert.deepEqual([found.found, found.providerRef, found.status], [true, 'urn-1', 'LIVE']);
  assert.ok(decodeURIComponent(calls[1].url).includes(sent.watermark), 'a consulta usa o código da marca, não o texto');
});

test('conta_social_token_vazado_secret_redaction: token no corpo da rede e no payload nunca aparece em resultado nem em log', async () => {
  for (const network of SOCIAL_NETWORKS) {
    const { adapter } = real(network, () => resposta(400, { error: { message: `Invalid OAuth access token ${TOKEN}`, fbtrace_id: 'x' } }));
    const r = await adapter.publish({ texto: 'oi', accessToken: TOKEN, headers: { authorization: `Bearer ${TOKEN}` } }, { idempotencyKey: `pub:red-${network}` });
    const dump = JSON.stringify(r) + JSON.stringify(adapter.logEntries());
    assert.ok(!dump.includes(TOKEN), `${network}: o token vazou`);
    assert.equal(r.status, 'REJECTED');
    const ok = real(network, () => resposta(201, { id: 'p-1', status: 'LIVE', note: TOKEN }));
    const sent = await ok.adapter.publish({ texto: 'oi', accessToken: TOKEN }, { idempotencyKey: `pub:red2-${network}` });
    assert.ok(!(JSON.stringify(sent) + JSON.stringify(ok.adapter.logEntries())).includes(TOKEN), `${network}: vazou na resposta aceita`);
    assert.ok(JSON.stringify(ok.adapter.logEntries()).includes('[REDIGIDO]'), 'o marcador único de redação aparece no log');
  }
});

test('token_so_no_cofre: o adapter lê o segredo pela referência e ele só vai no cabeçalho de autorização', async () => {
  const { adapter, calls } = real('INSTAGRAM', () => resposta(201, { id: 'ig-1', status: 'LIVE' }));
  await adapter.publish({ texto: 'Olá' }, { idempotencyKey: 'pub:cofre-1' });
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!calls[0].body.includes(TOKEN) && !calls[0].url.includes(TOKEN), 'nem no corpo nem na URL');
  assert.ok(!JSON.stringify(adapter).includes(TOKEN), 'o adapter não guarda o token em propriedade nenhuma');
});

test('erro_da_rede_vira_codigo_do_marketing: token expirado e rede fora do ar', async () => {
  const auth = real('FACEBOOK', () => resposta(401, { error: 'expired' }));
  const a = await auth.adapter.publish({ texto: 'oi' }, { idempotencyKey: 'pub:erro-401' });
  assert.deepEqual([a.status, a.error.class, a.error.code, a.error.httpStatus], ['FAILED', 'AUTH', 'MKT_PROVIDER_AUTH_FAILED', 401]);
  const down = real('YOUTUBE', () => resposta(503, {}));
  const d = await down.adapter.publish({ texto: 'oi' }, { idempotencyKey: 'pub:erro-503' });
  assert.deepEqual([d.status, d.error.class, d.error.code], ['FAILED', 'TRANSIENT', 'MKT_PROVIDER_UNAVAILABLE']);
  const rate = await real('TIKTOK', () => resposta(429, {}, { 'retry-after': '9' })).adapter.publish({ texto: 'oi' }, { idempotencyKey: 'pub:erro-429' });
  assert.deepEqual([rate.error.class, rate.error.code, rate.error.retryAfterMs], ['RATE_LIMIT', 'MKT_PROVIDER_UNAVAILABLE', 9000]);
  const sbx = await sandbox('LINKEDIN').publish({ texto: 'oi' }, { idempotencyKey: 'pub:erro-sbx-1', scenario: 'HTTP_5XX' });
  assert.equal(sbx.error.code, 'MKT_PROVIDER_UNAVAILABLE');
  const revoked = await sandbox('LINKEDIN', { scope: 'qa-m9-rev' }).publish({ texto: 'oi' }, { idempotencyKey: 'pub:erro-sbx-2', scenario: 'AUTH_REVOKED' });
  assert.equal(revoked.error.code, 'MKT_PROVIDER_AUTH_FAILED');
  assert.throws(() => social.assertSocialResult(a), (e) => e.statusCode === 409 && e.code === 'MKT_PROVIDER_AUTH_FAILED' && /reautorizada/.test(e.message));
  assert.throws(() => social.assertSocialResult(d), (e) => e.statusCode === 503 && e.code === 'MKT_PROVIDER_UNAVAILABLE' && /tentada novamente/.test(e.message));
  assert.doesNotThrow(() => social.assertSocialResult({ status: 'PUBLISHED', error: null }));
});

test('falha_em_uma_rede_nao_bloqueia_outras: o erro de uma rede fica no resultado dela e a outra publica', async () => {
  const bad = await sandbox('LINKEDIN', { scope: 'iso' }).publish({ texto: 'oi' }, { idempotencyKey: 'pub:iso-1', scenario: 'HTTP_5XX' });
  const good = await sandbox('INSTAGRAM', { scope: 'iso' }).publish({ texto: 'oi' }, { idempotencyKey: 'pub:iso-1' });
  assert.equal(bad.status, 'FAILED');
  assert.equal(good.status, 'PUBLISHED');
  assert.equal(adapters.sandboxRecordCount('iso', 'LINKEDIN'), 0);
  assert.equal(adapters.sandboxRecordCount('iso', 'INSTAGRAM'), 1);
  adapters.resetSandbox();
});

test('o_adapter_recusa_conteudo_acima_do_limite_mesmo_chamado_direto', async () => {
  await assert.rejects(sandbox('INSTAGRAM').publish({ texto: 'x'.repeat(2300) }, { idempotencyKey: 'pub:limite-1' }), (e) => e.statusCode === 422 && e.code === 'MKT_CAPABILITY_VIOLATION' && e.details.limit === 'CAPTION_MAX');
  await assert.rejects(sandbox('INSTAGRAM').publish({ texto: 'oi' }, { idempotencyKey: 'pub:limite-2', media: { formato: 'IMAGE', proporcao: '3:1' } }), (e) => e.code === 'MKT_CAPABILITY_VIOLATION' && e.details.limit === 'ASPECT_RATIO');
  assert.equal(adapters.sandboxRecordCount('qa-m9', 'INSTAGRAM'), 0, 'nada foi publicado');
});

test('a_contingencia_das_redes_e_a_da_m9_d430_sem_modo_proprio', () => {
  for (const network of SOCIAL_NETWORKS) {
    const plan = adapters.planFor(network);
    assert.deepEqual([plan.owner, plan.mode, plan.queue, plan.alternate, plan.isolated, plan.retry], ['M9-D430', null, false, false, true, 'BY_ERROR_CLASS'], network);
    const decision = adapters.decideOnResult(network, { status: 'FAILED', error: { class: 'TRANSIENT', code: 'MKT_PROVIDER_UNAVAILABLE', httpStatus: 503 } });
    assert.deepEqual([decision.action, decision.blocksOthers], ['ISOLATE_AND_RETRY', false]);
    assert.equal(adapters.decideOnResult(network, { status: 'PROCESSING' }).action, 'NONE', 'post em processamento não é falha');
    assert.equal(adapters.decideOnResult(network, { status: 'LIVE' }).action, 'NONE');
  }
});
