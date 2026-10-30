'use strict';

// Marco 9, M9-D228 — banco fora: nada é presumido pago, ao voltar o banco cada ordem é consultada pela chave antes de qualquer reenvio, a pendência acima de 72 h vira tarefa ao
// financeiro e o pagamento só vira PAID com a evidência de qualquer pagamento. Banco descartável (os testes COMMITAM, exceto os de intenção, que usam rollback). Nomes da seção 8.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const e215 = require('../_helpers/m9d215Env');
const e226 = require('../_helpers/m9d226Env');
const e237 = require('../_helpers/m9d237Env');
const contingency = require('../../../src/features/integrations/contingency');
const dispatchApi = require('../../../src/features/integrations/dispatch');
const { clearCircuitCache } = require('../../../src/features/integrations/health');
const health = require('../../../src/features/integrations/health');
const { IntegrationConnection } = require('../../../src/models');
const bankPayments = require('../../../src/features/finance/bankPayments.service');
const paymentIntents = require('../../../src/features/finance/paymentIntents.service');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { OutboxEvent } = require('../../../src/models');

const { sequelize, ctxDe } = e215;
let tenant;
let Banco;
let banco;
const ctx = () => ctxDe(tenant);
const rodar = () => dispatchApi.runDispatchCycle(ctx(), { now: new Date() });
const envios = () => Banco.S.chamadas.filter((c) => c.op === 'submitPayment');
const pagar = (extra = {}) => e215.enfileirar(tenant, { connectionId: banco.id, operation: 'submitPayment', aggregateType: 'PaymentIntent', aggregateId: crypto.randomUUID(), payload: e215.pagamento(), ...extra });
const linhaDe = (id) => e215.ler(tenant, id);

before(async () => {
  ({ tenant } = await e215.carregarTenants());
  contingency.installContingency();
  require('../../../src/features/finance/bank');
});
beforeEach(async () => {
  Banco = e215.bancoReconciliavel();
  e215.instalar(Banco);
  clearCircuitCache();
  await e215.limparTudo(tenant);
  await e226.limparContingencias(tenant);
  banco = await e226.conexaoDe(tenant, 'bank-sandbox');
});
after(async () => { e215.restaurar(); await e226.limparContingencias(tenant); await e215.limparTudo(tenant); await e226.desativarConexoesDeTeste(tenant); await sequelize.close(); });

test('contingencia_banco_nao_presume_pago', async () => {
  await e237.carregar();
  await e237.withRollbackTenantTransaction(e237.tenant, async (t) => {
    const connection = await IntegrationConnection.findOne({ where: { companyId: e237.tenant.companyId, providerCode: 'bank-sandbox', status: 'ACTIVE' }, transaction: t });
    await health.updateCircuitState(connection.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 3600 }, t);
    const { entry, intent } = await e237.intencaoEnviada(t, { amount: 1800.5 });
    // O banco está fora: a ordem espera na fila, a intenção segue SUBMITTING e a tela diz "Aguardando confirmação do banco"; nada é EXECUTED nem liquidado.
    assert.equal(intent.status, 'SUBMITTING');
    assert.equal(intent.externalStatus, 'QUEUED');
    assert.equal(intent.statusMessage, 'Aguardando confirmação do banco');
    assert.equal(intent.toJSON().statusMessage, 'Aguardando confirmação do banco');
    assert.equal((await entry.reload({ transaction: t })).status, 'PENDING');
    const [d] = await e237.envios(t, intent.id);
    assert.ok(['PENDING', 'RETRY_WAIT'].includes(d.status), 'a ordem fica na fila do banco');
    assert.equal(d.external_resource_id, null);
    const r = await contingency.runContingencyCycle(e237.ctxDe(), { now: new Date() }, t);
    assert.ok(r.activated >= 1);
    const ativas = await contingency.listActiveContingencies(e237.ctxDe(), t);
    assert.equal(ativas.find((a) => a.connectionId === connection.id).mode, 'NO_ASSUME_AND_QUERY');
    assert.equal(r.switched, 0, 'o banco não troca sozinho de fornecedor: outro banco só com aprovação humana e MFA');
    await intent.reload({ transaction: t });
    assert.equal(intent.status, 'SUBMITTING', 'depois da rodada continua aguardando: nenhum pagamento é presumido');
    assert.equal((await entry.reload({ transaction: t })).status, 'PENDING');
  });
});

test('contingencia_banco_consulta_antes_de_reenviar', async () => {
  // 12 ordens esperam o banco fora (R$ 500,00 a R$ 8.000,00); ao voltar, ANTES de reenviar, o banco é consultado pela chave: 9 já processadas, 2 inexistentes, 1 inconclusiva.
  await e226.forcarCircuito(tenant, banco.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 3600 });
  const ordens = [];
  for (let i = 0; i < 12; i += 1) ordens.push(await pagar({ payload: e215.pagamento({ amount: String(500 + i * 681.82) }) }));
  assert.ok((await e226.ciclo(tenant)).activated >= 1);
  await rodar();
  assert.equal(envios().length, 0, 'com o banco fora nenhuma ordem sai');
  for (const o of ordens) assert.ok(['PENDING', 'RETRY_WAIT'].includes((await linhaDe(o.dispatchId)).status));

  const chaveDe = async (o) => (await linhaDe(o.dispatchId)).idempotency_key;
  for (const o of ordens.slice(0, 9)) Banco.S.registrar(await chaveDe(o), 'CONFIRMED'); // o banco já tinha processado estas
  const inconclusiva = await chaveDe(ordens[11]);
  const original = Banco.prototype.findByIdempotencyKey;
  Banco.prototype.findByIdempotencyKey = function consulta(_c, request) {
    if (request.idempotencyKey === inconclusiva) return Promise.reject(Object.assign(new Error('banco indisponível'), { status: 503 }));
    return original.call(this, _c, request);
  };

  // O banco volta: a fila é solta em ordem, mas a rodada do worker só CONSULTA (UNKNOWN), não reenvia.
  await e226.fecharCircuito(tenant, banco.id);
  await e226.checks(tenant, banco.id, 3, true);
  const volta = await e226.ciclo(tenant);
  assert.ok(volta.deactivated >= 1);
  await rodar();
  assert.equal(envios().length, 0, 'antes de qualquer reenvio o banco é consultado: nenhuma ordem foi reenviada');
  for (const o of ordens) assert.equal((await linhaDe(o.dispatchId)).status, 'UNKNOWN', 'cada ordem solta pela fila vai a UNKNOWN para a consulta pela chave');
  for (const o of ordens) await dispatchApi.reconcileDispatch(ctx(), o.dispatchId, { now: new Date(Date.now() + 3600000) });
  const estados = {};
  for (const o of ordens) { const s = (await linhaDe(o.dispatchId)).status; estados[s] = (estados[s] || 0) + 1; }
  assert.deepEqual(estados, { CONFIRMED: 9, RETRY_WAIT: 2, UNKNOWN: 1 }, '9 confirmadas, 2 inexistentes para reenviar e 1 inconclusiva para conferência manual');
  assert.equal(Banco.S.consultas.some((c) => c.metodo === 'key'), true);

  // Só as 2 inexistentes saem, com a MESMA chave de idempotência.
  const chavesReenviadas = new Set();
  for (const o of ordens.slice(9, 11)) chavesReenviadas.add(await chaveDe(o));
  await e215.forcar(tenant, ordens[9].dispatchId, 'next_attempt_at = now() - interval \'1 second\'');
  await e215.forcar(tenant, ordens[10].dispatchId, 'next_attempt_at = now() - interval \'1 second\'');
  await rodar();
  assert.equal(envios().length, 2);
  assert.deepEqual(new Set(envios().map((c) => c.meta.idempotencyKey)), chavesReenviadas);
  assert.equal((await linhaDe(ordens[11].dispatchId)).status, 'UNKNOWN', 'a inconclusiva não é reenviada nem dada como paga: conferência manual');
  Banco.prototype.findByIdempotencyKey = original;
});

test('contingencia_banco_pendencia_72h_tarefa_manual', async () => {
  await e226.forcarCircuito(tenant, banco.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 3600 });
  const fila = await pagar();
  const incerta = await pagar();
  const aceita = await pagar();
  const recente = await pagar();
  await e215.forcar(tenant, incerta.dispatchId, "status = 'UNKNOWN', unknown_since = now() - interval '80 hours'");
  await e215.forcar(tenant, aceita.dispatchId, "status = 'SUBMITTED', external_resource_id = 'ext-aceita', submitted_at = now() - interval '80 hours'");
  for (const o of [fila, incerta, aceita]) await e226.envelhecer(tenant, o.dispatchId, 73);
  await e226.envelhecer(tenant, recente.dispatchId, 25);
  const r = await e226.ciclo(tenant);
  assert.equal(r.manualTasks, 3, 'fila, incerta e aceita sem status final, todas acima de 72 h');
  await e226.consumir(tenant, 'integration.contingency.manual_task');
  for (const o of [fila, incerta, aceita]) {
    const tarefas = await e226.tarefasDoEnvio(tenant, o.dispatchId);
    assert.equal(tarefas.length, 1);
    assert.equal(tarefas[0].title, 'Conferir no internet banking o pagamento pendente');
    assert.match(tarefas[0].description, /internet banking/);
    assert.match(tarefas[0].description, /status final do banco ou a entrada do extrato conciliada/);
  }
  assert.equal((await e226.tarefasDoEnvio(tenant, recente.dispatchId)).length, 0, 'com 25 h ainda não vira tarefa');
  const estados = [];
  for (const o of [fila, incerta, aceita]) estados.push((await linhaDe(o.dispatchId)).status);
  assert.deepEqual(estados, ['PENDING', 'UNKNOWN', 'SUBMITTED'], 'a tarefa não muda o estado de nenhum pagamento');
  assert.equal((await e226.ciclo(tenant)).manualTasks, 0, 'uma tarefa por ordem');
  const [ev] = (await e226.eventos(tenant, 'integration.contingency.manual_task')).filter((e) => e.payload_json.dispatchId === incerta.dispatchId);
  assert.equal(ev.payload_json.mode, 'NO_ASSUME_AND_QUERY');
});

test('contingencia_pendencia_72h_nao_vira_pago_sem_evidencia', async () => {
  await e237.carregar();
  const SEGREDO = 'segredo-d228';
  await e237.withRollbackTenantTransaction(e237.tenant, async (t) => {
    await e237.definirSegredoWebhook(t, SEGREDO);
    const connection = await IntegrationConnection.findOne({ where: { companyId: e237.tenant.companyId, providerCode: 'bank-sandbox', status: 'ACTIVE' }, transaction: t });
    await health.updateCircuitState(connection.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 3600 }, t);
    const base = await e237.intencaoEnviada(t, { amount: 3000 });
    const { entry, intent } = base;
    const [d] = await e237.envios(t, intent.id);
    await sequelize.query("UPDATE integration.dispatches SET created_at = now() - interval '80 hours' WHERE id = :id", { replacements: { id: d.id }, transaction: t });
    const r = await contingency.runContingencyCycle(e237.ctxDe(), { now: new Date() }, t); // ativa a contingência e gera a tarefa do que passou de 72 h
    assert.equal(r.manualTasks, 1, 'passadas 72 h a pessoa é chamada');
    assert.equal((await contingency.runContingencyCycle(e237.ctxDe(), { now: new Date() }, t)).manualTasks, 0, 'uma tarefa só');
    for (const e of await OutboxEvent.findAll({ where: { companyId: e237.tenant.companyId, eventType: 'integration.contingency.manual_task' }, transaction: t })) await runEventConsumers(e, t);
    // Nada vira PAID por tempo: a intenção segue aguardando, a execução manual é recusada e sem evidência do banco não há por onde liquidar.
    await intent.reload({ transaction: t });
    assert.equal(intent.status, 'SUBMITTING');
    await assert.rejects(paymentIntents.executePaymentIntent(intent.id, e237.tenant.userId, t), (e) => e.statusCode === 409 && e.code === 'FINANCE_PAYMENT_INTENT_NOT_APPROVED');
    await assert.rejects(bankPayments.confirmBankPayment('ext-que-o-banco-nunca-informou', 'PAID', t), (e) => e.statusCode === 404 && e.code === 'FINANCE_BANK_PAYMENT_ROUTING_NOT_FOUND');
    assert.equal((await entry.reload({ transaction: t })).status, 'PENDING');
    // O banco volta: a ordem é consultada pela chave e reenviada com a mesma chave; ainda assim só o status FINAL, com o valor conferido, liquida.
    await health.updateCircuitState(connection.id, { circuitState: 'CLOSED', circuitOpenedAt: null, circuitCooldownS: null, consecutiveFailures: 0 }, t);
    await bankPayments.reconcilePaymentIntent(intent.id, { userId: e237.tenant.userId }, t);
    await intent.reload({ transaction: t });
    assert.equal(intent.status, 'SUBMITTED', 'o banco aceitou a ordem');
    assert.ok(intent.externalSubmissionId);
    await bankPayments.confirmBankPayment(intent.externalSubmissionId, 'PROCESSING', t);
    assert.equal((await entry.reload({ transaction: t })).status, 'PENDING', 'status não final nunca liquida');
    await bankPayments.confirmBankPayment(intent.externalSubmissionId, 'PAID', t, { amount: '3000.00', source: 'STATUS_QUERY' });
    assert.equal((await intent.reload({ transaction: t })).status, 'EXECUTED', 'a evidência (status final do banco com o valor) é o que paga');
    assert.equal((await entry.reload({ transaction: t })).status, 'SETTLED');
  });
});
