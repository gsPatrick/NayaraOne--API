'use strict';

// Marco 9, M9-D237 + M9-D220 — a intenção de pagamento muda de estado só por evento interno do envio (a recusa do banco), a ordem sem resposta conclusiva vai à revisão humana sem mudar a
// intenção, o pedido nasce na transação do Financeiro, pagamento não tem compensação automática e a falha ou a ausência de resposta do banco nunca decide o pagamento. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d237Env');
const reacao = require('../_helpers/reacaoD220');
const { erroHttp } = require('../_helpers/m9d214Scripted');
const { IntegrationDispatch } = require('../../../src/models');
const { SandboxBankAdapter } = require('../../../src/features/finance/adapters/BankAdapter');
const { publishDispatchEvent, EVENTS } = require('../../../src/features/integrations/dispatch/dispatch.events');
const { compensateDispatch } = require('../../../src/features/integrations/domain');

const { sequelize, withRollbackTenantTransaction } = env;
let tenant;
before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

/** Troca o submitPayment do sandbox por um que lança `erro`. */
function bancoFalha(erro) {
  const original = SandboxBankAdapter.prototype.submitPayment;
  SandboxBankAdapter.prototype.submitPayment = async function recusa() { throw erro; };
  return () => { SandboxBankAdapter.prototype.submitPayment = original; };
}
const timeout = () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
const recarregar = (t, intent) => intent.reload({ transaction: t });
const casos = (t, intentId) => env.linhas(t, "SELECT * FROM finance.anomaly_cases WHERE related_entity_id = :id AND case_type = 'BANK_PAYMENT_UNRESOLVED'", { id: intentId });

test('banco_d220_recusa_do_banco_vai_a_failed_so_pelo_evento_e_uma_vez', async () => {
  const restaurar = bancoFalha(erroHttp(422));
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { entry, intent } = await env.intencaoEnviada(t);
      assert.equal(intent.status, 'SUBMITTING', 'a recusa chegou ao envio, mas a intenção só muda pelo evento');
      const [envio] = await env.envios(t, intent.id);
      assert.equal(envio.status, 'FAILED');
      assert.equal(envio.last_error_class, 'VALIDATION');
      await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.failed', envio.id);
      const depois = await recarregar(t, intent);
      assert.equal(depois.status, 'FAILED');
      assert.match(depois.failureReason, /O banco recusou a ordem de pagamento/);
      assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'finance.bank.dispatch_failed', intent.id), 1, 'duas entregas, uma reação auditada');
      assert.equal((await entry.reload({ transaction: t })).status, 'PENDING', 'o lançamento não é liquidado nem estornado pela recusa');
    });
  } finally { restaurar(); }
});

test('banco_d220_falha_sem_recusa_e_sem_resposta_nao_decidem_o_pagamento', async () => {
  const restaurar = bancoFalha(timeout());
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { intent } = await env.intencaoEnviada(t);
      const [envio] = await env.envios(t, intent.id);
      assert.equal(envio.status, 'UNKNOWN', 'timeout depois de enviar: incerto, nunca falho');
      const falhos = await env.linhas(t, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'integration.dispatch.failed' AND payload_json->>'dispatchId' = :d", { d: envio.id });
      assert.equal(falhos[0].n, 0, 'sem resposta do banco não há evento de falha');
      assert.equal((await recarregar(t, intent)).status, 'SUBMITTING');
      // Mesmo uma falha de credencial (classe AUTH) não decide o pagamento: a intenção segue em envio incerto, com o rastro auditado.
      await publishDispatchEvent(env.ctxDe(), await IntegrationDispatch.findByPk(envio.id, { transaction: t }), EVENTS.FAILED, { errorClass: 'AUTH', errorCode: 'HTTP_401', status: 'FAILED' }, t);
      await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.failed', envio.id);
      assert.equal((await recarregar(t, intent)).status, 'SUBMITTING');
      assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'finance.bank.dispatch_failed', intent.id), 1);
    });
  } finally { restaurar(); }
});

test('banco_d220_sem_resposta_conclusiva_abre_revisao_humana_sem_mudar_a_intencao', async () => {
  const restaurar = bancoFalha(timeout());
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { intent } = await env.intencaoEnviada(t);
      const envio = await IntegrationDispatch.findOne({ where: { aggregateType: 'PaymentIntent', aggregateId: intent.id }, transaction: t });
      await publishDispatchEvent(env.ctxDe(), envio, EVENTS.NEEDS_MANUAL_REVIEW, { reason: 'UNRESOLVED' }, t);
      await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.needs_manual_review', envio.id);
      assert.equal((await recarregar(t, intent)).status, 'SUBMITTING', 'o pagamento pode ter saído: a intenção não muda');
      const abertos = await casos(t, intent.id);
      assert.equal(abertos.length, 1, 'duas entregas do evento, um caso de revisão');
      assert.equal(abertos[0].risk_level, 'HIGH');
      assert.match(abertos[0].reason, /confira no extrato/);
    });
  } finally { restaurar(); }
});

test('banco_d220_pedido_nasce_na_transacao_do_dominio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const contar = async () => (await env.linhas(t, "SELECT count(*)::int AS n FROM integration.dispatches WHERE operation = 'submitPayment'"))[0].n;
    const antes = await contar();
    // Savepoint do próprio teste (nome único: os savepoints aninhados do Sequelize repetem nomes e desfariam só o último).
    await sequelize.query('SAVEPOINT qa_m9_d237_dominio', { transaction: t });
    await env.intencaoEnviada(t);
    assert.equal(await contar(), antes + 1, 'o envio nasce junto com a intenção');
    await sequelize.query('ROLLBACK TO SAVEPOINT qa_m9_d237_dominio', { transaction: t });
    assert.equal(await contar(), antes, 'sem commit do domínio não há ordem ao banco');
  });
});

test('banco_d220_pagamento_nao_tem_compensacao_automatica_e_o_envio_original_fica', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { intent } = await env.intencaoEnviada(t);
    const [original] = await env.envios(t, intent.id);
    assert.ok(['SUBMITTED', 'CONFIRMED'].includes(original.status) && original.external_resource_id);
    await assert.rejects(compensateDispatch(env.ctxDe(), original.id, { userId: tenant.userId, transaction: t }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_COMPENSATION_UNSUPPORTED');
    const depois = await env.envios(t, intent.id);
    assert.equal(depois.length, 1, 'nenhum envio compensatório: dinheiro que saiu volta pelo caminho de devolução (RETURNED) com revisão humana');
    assert.equal(depois[0].status, original.status);
    assert.equal(depois[0].external_resource_id, original.external_resource_id);
  });
});

test('banco_d220_modulo_nao_chama_o_banco_direto_para_ordenar_pagamento', () => {
  const dir = path.join(__dirname, '../../../src/features/finance/bank');
  const fontes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')]);
  for (const [f, texto] of fontes) assert.equal(/\.submitPayment\(|new (Sandbox|Santander)BankAdapter/.test(texto), false, `${f} ordena pagamento por fora do Dispatch Service`);
  assert.ok(fontes.some(([, t]) => /registerDomainReaction/.test(t)));
});
