'use strict';

// Marco 9, M9-D215 — recuperador de órfãos em SENDING e webhook simultâneo com a reconciliação.
// Testes 8, 9 e 11 da demanda. Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparTudo, enfileirar, pagamento, eventos, erros, instalar, restaurar, forcar, ler, dispatch,
  auditoria, tentativaAberta, pausa, bancoReconciliavel, mensagemProgramavel,
} = require('../_helpers/m9d215Env');
const { runIntegrationDispatchOrphanJob, resetOrphanSchedule } = require('../../../src/engines/jobs/integrationDispatchOrphanJob');
const { clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let banco;
let msg;
let Banco;
let Msg;
const agg = () => crypto.randomUUID();
const ctx = () => ctxDe(tenant);

before(async () => {
  ({ tenant } = await carregarTenants());
  banco = await conexaoAtiva(tenant, 'BANK');
  msg = await conexaoAtiva(tenant, 'MESSAGING');
});
beforeEach(async () => {
  Banco = bancoReconciliavel();
  Msg = mensagemProgramavel({ idempotente: true });
  instalar(Banco);
  instalar(Msg);
  clearCircuitCache();
  resetOrphanSchedule();
  await limparTudo(tenant);
});
after(async () => { restaurar(); await sequelize.close(); });

const pagar = () => enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: agg(), payload: pagamento() });
const texto = () => enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: '+5541999990000', text: 'Olá' } });
/** Deixa o envio preso em SENDING há 10 minutos, com a tentativa aberta, como depois de uma queda do processo. */
async function preso(r) {
  await forcar(tenant, r.dispatchId, "status = 'SENDING', attempts = 1, updated_at = now() - interval '10 minutes'");
  await tentativaAberta(tenant, await ler(tenant, r.dispatchId));
}
const tentativas = (id) => comTenant(tenant, async (t) => (await sequelize.query('SELECT * FROM integration.dispatch_attempts WHERE dispatch_id = :id', { replacements: { id }, transaction: t }))[0]);

test('unknown_orfao_sending_recuperado', async () => {
  const r = await pagar();
  await preso(r);
  const recente = await pagar();
  await forcar(tenant, recente.dispatchId, "status = 'SENDING', attempts = 1");
  const resumo = await runIntegrationDispatchOrphanJob({ now: new Date() });
  assert.ok(resumo.recovered >= 1);
  const l = await ler(tenant, r.dispatchId);
  assert.equal(l.status, 'UNKNOWN', 'processo morto com operação perigosa: UNKNOWN, nunca reenvio direto');
  assert.ok(l.unknown_since);
  assert.equal(l.last_error_code, 'SENDING_STALE');
  const e = await erros(tenant, banco.id, 'SENDING_STALE');
  assert.equal(e[e.length - 1].severity, 'CRITICAL');
  assert.ok((await tentativas(r.dispatchId)).every((t) => t.finished_at && t.outcome === 'ERROR'), 'a tentativa aberta foi fechada');
  assert.equal((await ler(tenant, recente.dispatchId)).status, 'SENDING', 'o envio recente não é tocado');
  assert.equal(Banco.S.chamadas.length, 0, 'o recuperador não chama o fornecedor');
  // O job respeita o intervalo da empresa (60 s): a 2ª rodada logo em seguida não faz nada.
  assert.equal((await runIntegrationDispatchOrphanJob({ now: new Date() })).companies, 0);
  // A consulta seguinte (reconciliação) decide com o fornecedor: ele recebeu a ordem, é achada pela chave e vira SUBMITTED.
  Banco.S.registrar((await ler(tenant, r.dispatchId)).idempotency_key);
  assert.equal((await dispatch.reconcileDispatch(ctx(), r.dispatchId, { now: new Date(Date.now() + 40000) })).status, 'SUBMITTED');
  assert.equal(Banco.S.todos.length, 1);
});

test('unknown_webhook_e_reconcile_simultaneos', async () => {
  for (let rodada = 0; rodada < 3; rodada += 1) {
    const r = await pagar();
    await forcar(tenant, r.dispatchId, "status = 'UNKNOWN', attempts = 1, unknown_since = now() - interval '1 minute'");
    const l = await ler(tenant, r.dispatchId);
    Banco.S.registrar(l.idempotency_key, 'PAID');
    Banco.S.aoConsultar = () => pausa(150);
    const evento = { providerCode: 'bank-sandbox', idempotencyKey: l.idempotency_key, status: 'PAID', source: 'WEBHOOK_SIGNED' };
    const [consulta, webhook] = await Promise.all([
      dispatch.reconcileDispatch(ctx(), r.dispatchId, { now: new Date() }),
      pausa(rodada * 60).then(() => dispatch.resolveDispatchByEvent(ctx(), evento, {})),
    ]);
    const f = await ler(tenant, r.dispatchId);
    assert.equal(f.status, 'CONFIRMED');
    assert.equal((await eventos(tenant, dispatch.EVENTS.CONFIRMED, r.dispatchId)).length, 1, 'uma única confirmação publicada');
    const aud = await comTenant(tenant, async (t) => (await sequelize.query(
      "SELECT * FROM audit.audit_log WHERE entity_id = :id AND action = 'integration.dispatch.status_changed' AND after_json->>'status' = 'CONFIRMED'", { replacements: { id: r.dispatchId }, transaction: t },
    ))[0]);
    assert.equal(aud.length, 1, 'uma única transição para CONFIRMED na auditoria');
    const mudaram = [consulta.status === 'CONFIRMED' && !consulta.skipped, webhook.changed === true].filter(Boolean).length;
    assert.equal(mudaram, 1, 'só quem chegou primeiro confirma; o outro vê o estado final e não faz nada');
    assert.ok((await auditoria(tenant, r.dispatchId, 'integration.dispatch.reconciled')).length >= 1);
  }
});

test('unknown_orfao_em_sending_safe_vai_a_retry_wait_e_dangerous_a_unknown', async () => {
  const perigoso = await pagar();
  const seguro = await texto();
  await preso(perigoso);
  await preso(seguro);
  const agora = new Date();
  await runIntegrationDispatchOrphanJob({ now: agora });
  const p = await ler(tenant, perigoso.dispatchId);
  const s = await ler(tenant, seguro.dispatchId);
  assert.equal(p.status, 'UNKNOWN');
  assert.equal(s.status, 'RETRY_WAIT', 'operação segura: nova tentativa com backoff');
  assert.equal(s.last_error_class, 'TRANSIENT');
  assert.equal(s.last_error_code, 'SENDING_STALE');
  assert.equal(s.attempts, 1, 'a tentativa perdida continua contada');
  const [min, max] = dispatch.backoffRangeMs(1, { base_delay_ms: 5000, factor: 2, cap_delay_ms: 1800000, jitter_pct: 25 });
  const espera = new Date(s.next_attempt_at).getTime() - agora.getTime();
  assert.ok(espera >= min && espera <= max, `backoff (${espera} ms)`);
  // A rodada do worker depois do vencimento envia a mensagem; o pagamento segue sem ser repetido.
  await forcar(tenant, seguro.dispatchId, "next_attempt_at = now() - interval '1 second'");
  Msg.S.fila('sendText', [{ resposta: { status: 'DELIVERED', externalResourceId: 'm-1' } }]);
  await dispatch.runDispatchCycle(ctx(), { now: new Date() });
  assert.equal((await ler(tenant, seguro.dispatchId)).status, 'CONFIRMED');
  assert.equal(Banco.S.chamadas.length, 0);
  // Esgotadas as tentativas, o órfão seguro vai à fila morta com o motivo.
  const ultimo = await texto();
  await preso(ultimo);
  await forcar(tenant, ultimo.dispatchId, 'attempts = max_attempts');
  await runIntegrationDispatchOrphanJob({ now: new Date(Date.now() + 120000) });
  const d = await ler(tenant, ultimo.dispatchId);
  assert.deepEqual([d.status, d.dead_letter_reason], ['DEAD_LETTER', 'ATTEMPTS_EXHAUSTED']);
});
