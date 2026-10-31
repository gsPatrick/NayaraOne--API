'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CHANNEL_META } = require('../channels');
const { assertChannelAdapter } = require('../ChannelAdapter');
const { SCENARIOS } = require('../sandbox/sandbox.scenarios');

// Canários montados em tempo de execução: o valor completo nunca fica escrito no repositório (varredura de segredo, M9-D246).
const SECRET_VALUE = ['sk', 'live', '51HsegredoMuitoLongo9876543210abcdef'].join('_');
const BEARER_VALUE = `Bearer ${['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiJ4In0', 'assinaturaSecreta123'].join('.')}`;
const WEBHOOK_SECRET = 'segredo-do-contrato-de-canal';
const SAMPLE = Object.freeze({ to: '+5511999990000', texto: 'Olá, conheça o imóvel' });

/** Mesma entrada em qualquer verificação: o contrato é sobre comportamento, não sobre o conteúdo. */
const sample = (over = {}) => ({ ...SAMPLE, ...over });
const sign = (secret, body, t = Math.floor(Date.now() / 1000)) => ({ 'x-signature': `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}` });
const opOf = (adapter) => CHANNEL_META[adapter.channel].operation;
const send = (adapter, key, options = {}, over) => adapter[opOf(adapter)](sample(over), { idempotencyKey: key, ...options });

/**
 * As verificações do contrato (M9-D430 3.4): a mesma lista roda contra cada adapter (sandbox em CI; o real em LAB, quando houver conta). Cada uma recebe
 * `make(opts)` (adapter novo, em escopo próprio) e o canal; falhar é lançar. As marcadas `sandboxOnly` usam cenários e só valem no simulador.
 */
const CONTRACT_CHECKS = Object.freeze([
  {
    id: 'capabilities_coerentes',
    title: 'declara as operações do contrato e só responde às que declarou',
    async run({ make, channel }) {
      const adapter = make();
      assert.deepEqual(assertChannelAdapter(adapter), { ok: true, problems: [] });
      const outra = opOf(adapter) === 'send' ? 'publish' : 'send';
      await assert.rejects(() => adapter[outra](sample(), { idempotencyKey: 'contrato-cap-0001' }), (e) => e.code === 'MKT_CHANNEL_OPERATION_UNSUPPORTED');
      assert.equal(adapter.capabilities().includes('getMetrics'), CHANNEL_META[channel].metrics.length > 0);
    },
  },
  {
    id: 'idempotencia',
    title: 'a mesma chave devolve a mesma resposta e um único registro',
    async run({ make }) {
      const adapter = make();
      const a = await send(adapter, 'contrato-idem-0001');
      const b = await send(adapter, 'contrato-idem-0001');
      assert.equal(b.providerRef, a.providerRef);
      assert.equal(b.status, a.status);
      const achado = await adapter.findByIdempotencyKey('contrato-idem-0001');
      assert.deepEqual([achado.found, achado.providerRef], [true, a.providerRef]);
    },
  },
  {
    id: 'sandbox_deterministico',
    title: 'mesma entrada, mesma saída (instâncias e escopos diferentes)',
    sandboxOnly: true,
    async run({ make }) {
      const a = await send(make(), 'contrato-det-00001');
      const b = await send(make(), 'contrato-det-00001');
      assert.deepEqual(a, b);
      assert.notEqual((await send(make(), 'contrato-det-00001', {}, { texto: 'outro' })).providerRef, a.providerRef);
    },
  },
  {
    id: 'timeout_vira_unknown',
    title: 'timeout vira UNKNOWN (nunca falha definitiva)',
    sandboxOnly: true,
    async run({ make }) {
      const r = await send(make(), 'contrato-timeout-01', { scenario: 'TIMEOUT' });
      assert.deepEqual([r.status, r.unknown, r.error.code], ['UNKNOWN', true, 'TIMEOUT']);
    },
  },
  {
    id: 'find_by_idempotency_key',
    title: 'findByIdempotencyKey acha o que foi publicado e não acha o que não foi',
    sandboxOnly: true,
    async run({ make }) {
      const adapter = make();
      assert.equal((await send(adapter, 'contrato-find-pub-1', { scenario: 'UNKNOWN_BUT_PUBLISHED' })).status, 'UNKNOWN');
      assert.equal((await adapter.findByIdempotencyKey('contrato-find-pub-1')).found, true);
      assert.equal((await send(adapter, 'contrato-find-no-01', { scenario: 'UNKNOWN_NOT_PUBLISHED' })).status, 'UNKNOWN');
      assert.equal((await adapter.findByIdempotencyKey('contrato-find-no-01')).found, false);
    },
  },
  {
    id: 'erro_429_respeita_backoff',
    title: 'o erro 429 vira RATE_LIMIT com o tempo de espera do canal',
    sandboxOnly: true,
    async run({ make }) {
      const r = await send(make(), 'contrato-429-000001', { scenario: 'HTTP_429' });
      assert.deepEqual([r.status, r.error.class, r.error.httpStatus], ['FAILED', 'RATE_LIMIT', 429]);
      assert.ok(r.error.retryAfterMs > 0, 'informa quanto esperar');
    },
  },
  {
    id: 'cenarios_do_sandbox',
    title: 'os 10 cenários respondem como o livro manda',
    sandboxOnly: true,
    async run({ make }) {
      const esperado = { OK: ['SENT', 'PUBLISHED'], SLOW: ['SENT', 'PUBLISHED'], TIMEOUT: ['UNKNOWN'], UNKNOWN_BUT_PUBLISHED: ['UNKNOWN'], UNKNOWN_NOT_PUBLISHED: ['UNKNOWN'], HTTP_429: ['FAILED'], HTTP_5XX: ['FAILED'], REJECTED: ['REJECTED'], DUPLICATE_KEY: ['SENT', 'PUBLISHED'] };
      for (const scenario of SCENARIOS.filter((s) => s !== 'AUTH_REVOKED')) {
        const r = await send(make(), `contrato-cen-${scenario}`, { scenario });
        assert.ok(esperado[scenario].includes(r.status), `${scenario} deu ${r.status}`);
      }
      const adapter = make();
      const auth = await send(adapter, 'contrato-cen-AUTH', { scenario: 'AUTH_REVOKED' });
      assert.deepEqual([auth.status, auth.error.class], ['FAILED', 'AUTH']);
      assert.equal((await adapter.healthCheck()).ok, false);
    },
  },
  {
    id: 'redaction_de_segredo',
    title: 'segredo nunca aparece em resultado nem em log',
    sandboxOnly: true,
    async run({ make }) {
      const adapter = make();
      for (const scenario of [undefined, 'REJECTED', 'HTTP_5XX', 'UNKNOWN_BUT_PUBLISHED']) {
        const r = await send(adapter, `contrato-red-${scenario || 'OK'}`, { scenario }, { apiKey: SECRET_VALUE, headers: { authorization: BEARER_VALUE } });
        const dump = JSON.stringify(r) + JSON.stringify(adapter.logEntries());
        assert.ok(!dump.includes(SECRET_VALUE) && !dump.includes('assinaturaSecreta123'), `vazou em ${scenario || 'OK'}`);
      }
    },
  },
  {
    id: 'webhook_assinatura',
    title: 'webhook com assinatura inválida é recusado (401) e o assinado é aceito',
    async run({ make }) {
      const adapter = make({ webhookSecrets: [WEBHOOK_SECRET] });
      const body = Buffer.from(JSON.stringify({ id: 'evt-contrato-1', type: 'message.delivered', status: 'delivered' }));
      assert.equal(adapter.parseWebhook(sign(WEBHOOK_SECRET, body), body).eventId, 'evt-contrato-1');
      for (const headers of [sign('outro-segredo', body), {}, { 'x-signature': 'lixo' }]) {
        assert.throws(() => adapter.parseWebhook(headers, body), (e) => e.statusCode === 401 && e.code === 'MKT_WEBHOOK_SIGNATURE_INVALID');
      }
    },
  },
  {
    id: 'saude_e_revogacao',
    title: 'healthCheck nunca lança e a revogação derruba a credencial',
    sandboxOnly: true,
    async run({ make }) {
      const adapter = make();
      assert.equal((await adapter.healthCheck()).ok, true);
      await adapter.revoke({ id: 'conexao-de-contrato' });
      assert.equal((await adapter.healthCheck()).ok, false);
    },
  },
]);

module.exports = { CONTRACT_CHECKS };
