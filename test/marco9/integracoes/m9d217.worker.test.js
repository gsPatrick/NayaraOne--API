'use strict';

// Marco 9, M9-D217 — o circuito no worker de envios: abre pelas falhas reais, não essencial não chama em OPEN, fallback na abertura e 503 para quem não tem fila.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  sequelize, comTenant, carregarTenants, ctxDe, conexaoAtiva, limparPendentes, enfileirar, tentativas, instalar, restaurar, forcar, ler, dispatch,
} = require('../_helpers/m9d214Env');
const { mensagemProgramavel, erroHttp } = require('../_helpers/m9d214Scripted');
const { linha, forcarCircuito, errosCircuito, limparCircuito, desativarConexoesDeTeste, admitir, breaker, comConexao } = require('../_helpers/m9d217Env');
const { registerContingencyHandler, clearContingencyHandlers } = require('../../../src/features/integrations/providers/contingency.registry');

let tenant;
let msg;
let Msg;
const agg = () => crypto.randomUUID();
const texto = (extra = {}) => enfileirar(tenant, { connectionId: msg.id, operation: 'sendText', aggregateType: 'Message', aggregateId: agg(), payload: { to: `+5541${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, text: 'Olá' }, ...extra });
const rodar = (now = new Date()) => dispatch.runDispatchCycle(ctxDe(tenant), { now, limit: 50 });

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  Msg = mensagemProgramavel({ idempotente: true });
  instalar(Msg);
  clearContingencyHandlers();
  await limparPendentes(tenant);
  await limparCircuito(tenant);
  msg = await conexaoAtiva(tenant, 'MESSAGING');
});
after(async () => { clearContingencyHandlers(); await limparCircuito(tenant); await desativarConexoesDeTeste(tenant); restaurar(); await sequelize.close(); });

test('circuito_aciona_fallback_na_abertura', async () => {
  const chamadas = [];
  registerContingencyHandler('MESSAGING', async (info) => { chamadas.push(info); });
  Msg.S.fila('sendText', [{ erro: erroHttp(503) }]);
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await texto()).dispatchId);
  await rodar();
  const l = await linha(tenant, msg.id);
  assert.equal(l.circuit_state, 'OPEN', 'cinco 503 seguidos abrem o circuito pelo worker');
  assert.equal(l.consecutive_failures, 5);
  assert.equal(chamadas.length, 1, 'a contingência da família é acionada uma vez, na abertura');
  assert.deepEqual([chamadas[0].domain, chamadas[0].providerCode], ['MESSAGING', 'messaging-sandbox']);
  assert.equal(chamadas[0].companyId, tenant.companyId);
  const erros = await errosCircuito(tenant, msg.id);
  assert.equal(erros.length, 1);
  assert.equal(erros[0].severity, 'HIGH');
  assert.equal(erros[0].error_class, 'TRANSIENT');
  // defeito na contingência nunca derruba o circuito nem o worker
  const outro = await conexaoAtiva(tenant, 'MESSAGING');
  registerContingencyHandler('MESSAGING', async () => { throw new Error('contingência quebrada'); });
  await forcarCircuito(tenant, outro.id, { consecutiveFailures: 4 });
  await comConexao(tenant, outro.id, (c, t) => breaker.recordCallResult(c, ctxDe(tenant), t, { ok: false, errorClass: 'TRANSIENT' }));
  assert.equal((await linha(tenant, outro.id)).circuit_state, 'OPEN');
});

test('circuito_nao_essencial_nao_chama_em_open', async () => {
  await forcarCircuito(tenant, msg.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 120 });
  const massa = await texto();
  const essencial = await texto({ essential: true });
  const resumo = await rodar();
  assert.equal(resumo.deferred, 1, 'o não essencial espera');
  const espera = await ler(tenant, massa.dispatchId);
  assert.equal(espera.status, 'RETRY_WAIT');
  assert.equal(espera.attempts, 0, 'sem gastar tentativa');
  const ate = new Date(espera.next_attempt_at).getTime() - Date.now();
  assert.ok(ate > 110000 && ate <= 121000, `volta no fim do cooldown (${ate} ms)`);
  assert.equal((await tentativas(tenant, massa.dispatchId)).length, 0, 'nenhuma chamada ao fornecedor');
  assert.equal(Msg.S.chamadas.length, 1, 'só a essencial chamou');
  assert.equal((await ler(tenant, essencial.dispatchId)).status, 'SUBMITTED');
  assert.equal((await linha(tenant, msg.id)).circuit_state, 'OPEN', 'sucesso em OPEN antes do cooldown não fecha nem pula o HALF_OPEN');
  // operação essencial por definição do port (consulta de pagamento) também atravessa
  const { OPERATION_POLICY } = require('../../../src/features/integrations/providers/ports/operationPolicy');
  assert.equal(OPERATION_POLICY.BANK.getPaymentStatus.essential, true);
  assert.equal(OPERATION_POLICY.SIGNATURE.getEnvelope.essential, true);
  assert.equal(OPERATION_POLICY.MESSAGING.sendText.essential, false);
  // vencido o cooldown, o envio vai como teste e, com sucesso, fecha o circuito
  await forcarCircuito(tenant, msg.id, { circuitOpenedAt: new Date(Date.now() - 130000) });
  await forcar(tenant, massa.dispatchId, 'next_attempt_at = now()');
  await rodar();
  assert.equal((await ler(tenant, massa.dispatchId)).status, 'SUBMITTED');
  const l = await linha(tenant, msg.id);
  assert.deepEqual([l.circuit_state, l.half_open_inflight, l.consecutive_failures], ['CLOSED', 0, 0]);
});

test('circuito_half_open_no_worker_reabre_e_reagenda_o_excesso', async () => {
  await forcarCircuito(tenant, msg.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(Date.now() - 130000), circuitCooldownS: 120 });
  Msg.S.fila('sendText', [{ erro: erroHttp(503) }]);
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await texto()).dispatchId);
  const resumo = await rodar();
  assert.equal(Msg.S.chamadas.length >= 1 && Msg.S.chamadas.length <= 3, true, `no máximo 3 testes (${Msg.S.chamadas.length})`);
  assert.equal(resumo.deferred >= 3, true, 'o excesso volta a esperar sem gastar tentativa');
  assert.equal((await linha(tenant, msg.id)).circuit_state, 'OPEN', 'a falha do teste reabre');
  const esperando = (await Promise.all(ids.map((id) => ler(tenant, id)))).filter((d) => d.attempts === 0);
  assert.ok(esperando.length >= 3 && esperando.every((d) => d.status === 'RETRY_WAIT'));
});

test('circuito_chamada_sem_fila_recebe_503', async () => {
  await forcarCircuito(tenant, msg.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 120 });
  await assert.rejects(
    comConexao(tenant, msg.id, (c, t) => breaker.assertCallAllowed(c, ctxDe(tenant), t, { essential: false })),
    (e) => e.statusCode === 503 && e.code === 'INTEGRATION_CIRCUIT_OPEN' && /reagendada/.test(e.message),
  );
  const essencial = await comConexao(tenant, msg.id, (c, t) => breaker.assertCallAllowed(c, ctxDe(tenant), t, { essential: true }));
  assert.equal(essencial.allowed, true);
  const livre = await conexaoAtiva(tenant, 'MESSAGING');
  assert.equal((await admitir(tenant, livre.id)).allowed, true);
});

test('circuito_falha_ao_gravar_nao_bloqueia', async () => {
  // Connection que não existe mais para a empresa: o breaker não derruba quem chama.
  const fantasma = { id: crypto.randomUUID(), groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'messaging-sandbox', policyJson: {} };
  const r = await comTenant(tenant, (t) => breaker.admitCall(fantasma, ctxDe(tenant), t, { essential: false }));
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'CIRCUIT_STATE_UNAVAILABLE');
  await comTenant(tenant, (t) => breaker.recordCallResult(fantasma, ctxDe(tenant), t, { ok: false, errorClass: 'TRANSIENT' }));
});
