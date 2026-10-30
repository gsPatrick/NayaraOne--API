'use strict';

// Marco 9, M9-D229 — os dois adapters de mensageria de laboratório, sem banco: envio de texto, template e mídia, consulta de status, atraso da entrega, falhas injetadas
// (429, 500, timeout, número inválido), telefone E.164 e a regra de status que não regride.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MessagingSandboxAdapter } = require('../../../src/features/integrations/providers/messaging/sandbox/messaging-sandbox.adapter');
const { MessagingAltSandboxAdapter } = require('../../../src/features/integrations/providers/messaging/sandbox/messaging-alt-sandbox.adapter');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const { classifyDispatchError } = require('../../../src/features/integrations/dispatch/retry/retry.classify');
const { shouldApply } = require('../../../src/features/integrations/providers/messaging/messaging.status');
const store = require('../../../src/features/integrations/providers/messaging/sandbox/messaging.sandbox.store');
const { assertE164 } = require('../../../src/features/crm/messaging/messaging.phone');

const contexto = (id, config = {}, timeouts = { readMs: 60, writeMs: 60 }) => ({ connection: { id, providerCode: 'x', environment: 'SANDBOX', apiVersion: null, config }, policy: {}, timeouts });
const TO = '+5511999990000';

test('messaging_send_text_template_media_getstatus', async () => {
  store.reset();
  for (const [Classe, id] of [[MessagingSandboxAdapter, 'c-a'], [MessagingAltSandboxAdapter, 'c-b']]) {
    const a = new Classe(contexto(id));
    const texto = await invoke(a, 'sendText', { to: TO, text: 'Olá' }, { meta: { idempotencyKey: 'k1' } });
    assert.equal(texto.status, 'SENT', 'o aceite do envio é SENT, nunca entregue');
    assert.match(texto.externalResourceId, /^(sbx|alt)-msg-[0-9a-f]{16}$/);
    const modelo = await invoke(a, 'sendTemplate', { to: TO, templateName: 'boas_vindas' }, { meta: { idempotencyKey: 'k2' } });
    assert.equal(modelo.status, 'SENT');
    assert.notEqual(modelo.externalResourceId, texto.externalResourceId, 'cada envio é uma mensagem');
    const consulta = await invoke(a, 'getStatus', { externalResourceId: texto.externalResourceId });
    assert.equal(consulta.status, 'DELIVERED', 'sem atraso configurado a consulta já vê a entrega');
    assert.equal(a.mapStatus('status-que-ninguem-conhece'), null);
  }
  const a = new MessagingSandboxAdapter(contexto('c-a'));
  assert.equal((await invoke(a, 'sendMedia', { to: TO, mediaRef: 'file:abc' }, { meta: { idempotencyKey: 'k3' } })).status, 'SENT');
  const alt = new MessagingAltSandboxAdapter(contexto('c-b'));
  assert.equal(alt.supports('sendMedia'), false, 'o fornecedor alternativo não envia mídia');
  assert.equal(alt.supports('sendText'), true);
  await assert.rejects(invoke(alt, 'sendMedia', { to: TO, mediaRef: 'file:abc' }), (e) => e.code === 'INTEGRATION_OPERATION_UNSUPPORTED');
  // Atraso configurável da entrega: até lá a consulta diz SENT.
  const lento = new MessagingSandboxAdapter(contexto('c-lento', { sandbox_delivery_delay_ms: 60000 }));
  const m = await invoke(lento, 'sendText', { to: TO, text: 'x' }, { meta: { idempotencyKey: 'k9' } });
  assert.equal((await invoke(lento, 'getStatus', { externalResourceId: m.externalResourceId })).status, 'SENT');
  // Mesma chave de idempotência: um único recurso externo.
  const de = new MessagingSandboxAdapter(contexto('c-dup'));
  const um = await invoke(de, 'sendText', { to: TO, text: 'igual' }, { meta: { idempotencyKey: 'mesma' } });
  const dois = await invoke(de, 'sendText', { to: TO, text: 'igual' }, { meta: { idempotencyKey: 'mesma' } });
  assert.equal(um.externalResourceId, dois.externalResourceId);
});

test('messaging_sandbox_falhas_injetadas', async () => {
  store.reset();
  for (const Classe of [MessagingSandboxAdapter, MessagingAltSandboxAdapter]) {
    const a = new Classe(contexto('c-f'));
    const falha = async (fail, opts = {}) => {
      const t0 = Date.now();
      const e = await invoke(a, 'sendText', { to: TO, text: 'x', headers: { 'x-sandbox-fail': fail } }, {}).then(() => null, (erro) => erro);
      assert.ok(e, `a falha ${fail} precisa ser lançada`);
      return { classe: classifyDispatchError(e, a.classifyError(e), { opClass: 'SAFE', ...opts }), ms: Date.now() - t0, e };
    };
    const r429 = await falha('429');
    assert.equal(r429.classe.class, 'RATE_LIMIT');
    assert.equal(r429.classe.retryAfterMs, 7000);
    assert.equal((await falha('fail=500')).classe.class, 'TRANSIENT');
    const lenta = await falha('timeout');
    assert.equal(lenta.classe.class, 'TRANSIENT', 'timeout em operação segura repete');
    assert.ok(lenta.ms >= 50 && lenta.ms < 1000, `o adapter respeita o prazo da política (${lenta.ms} ms)`);
    const invalido = await falha('invalid_number');
    assert.equal(invalido.classe.class, 'VALIDATION');
    assert.equal((await falha('auth')).classe.class, 'AUTH');
    // A falha também vale quando vem da configuração da connection (fluxos de domínio).
    const viaConfig = new Classe(contexto('c-g', { sandbox_fault: '429' }));
    await assert.rejects(invoke(viaConfig, 'sendText', { to: TO, text: 'x' }), (e) => e.status === 429);
    // Pedido sem falha segue normalmente.
    assert.equal((await invoke(a, 'sendText', { to: TO, text: 'ok' })).status, 'SENT');
  }
});

test('messaging_telefone_e164', () => {
  assert.equal(assertE164('+5511999990000'), '+5511999990000');
  assert.equal(assertE164('+551133334444'), '+551133334444', 'fixo: 8 dígitos');
  for (const ruim of ['11999990000', '5511999990000', '+55 11 99999-0000', '+5511999', '+55119999900001234', '+1555123456', '', null, undefined, 123]) {
    assert.throws(() => assertE164(ruim), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_MESSAGING_PHONE_INVALID', String(ruim));
  }
  assert.equal(assertE164('+3519123456789', '351'), '+3519123456789', 'o código do país é parâmetro');
});

test('messaging_status_fora_de_ordem_nao_regride', () => {
  assert.equal(shouldApply('READ', 'DELIVERED'), false, 'READ(3) antes de DELIVERED(2) permanece READ');
  assert.equal(shouldApply('DELIVERED', 'SENT'), false);
  assert.equal(shouldApply('SENT', 'DELIVERED'), true);
  assert.equal(shouldApply('DELIVERED', 'READ'), true);
  assert.equal(shouldApply('QUEUED', 'SENT'), true);
  assert.equal(shouldApply('SENT', 'SENT'), false, 'repetir o mesmo status não muda nada');
  assert.equal(shouldApply('FAILED', 'DELIVERED'), false, 'FAILED é terminal');
  assert.equal(shouldApply('FAILED', 'READ'), false);
  assert.equal(shouldApply('SENT', 'FAILED'), true);
  assert.equal(shouldApply('DELIVERED', 'FAILED'), false, 'a mensagem já entregue não falha depois');
  assert.equal(shouldApply(null, 'QUEUED'), true);
  assert.equal(shouldApply('SENT', 'INEXISTENTE'), false);
});
