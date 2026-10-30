'use strict';

// Marco 9, M9-D240 + M9-D220 — a submissão do Correspondente muda de estado por evento interno do envio (idempotente e auditado), o envio nasce na transação do domínio, o caso confirmado
// tarde vira cancelamento por NOVO envio e a falha ou a ausência de resposta do provider não altera a submissão. Banco descartável; cada teste roda numa transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d240Env');
const reacao = require('../_helpers/reacaoD220');
const { SandboxFinancingProviderAdapter } = require('../../../src/features/correspondent/adapters/FinancingProviderAdapter');
const { IntegrationDispatch } = require('../../../src/models');
const { publishDispatchEvent, EVENTS } = require('../../../src/features/integrations/dispatch/dispatch.events');
const { confirmDispatch } = require('../../../src/features/integrations/dispatch/worker/worker.confirm');

const { sequelize, withRollbackTenantTransaction } = env;
let tenant;
before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

const sql = async (t, consulta, replacements) => (await sequelize.query(consulta, { replacements, transaction: t }))[0];
const submissao = async (t, id) => (await sql(t, 'SELECT status, failure_reason, external_case_id FROM correspondent.provider_submissions WHERE id = :id', { id }))[0];

/** O provider recusa o envio com o status HTTP dado (o sandbox é trocado só durante o teste). */
async function comRecusa(status, fn) {
  const original = SandboxFinancingProviderAdapter.prototype.submitCase;
  SandboxFinancingProviderAdapter.prototype.submitCase = async () => { throw Object.assign(new Error('recusa de laboratório'), { status }); };
  try { return await fn(); } finally { SandboxFinancingProviderAdapter.prototype.submitCase = original; }
}

/** Envio do caso feito pelo fluxo real; devolve { caso, pendente, enviada, envio }. */
async function enviar(t) {
  const caso = await env.casoPronto(t);
  const pendente = await env.pedir(caso, t);
  const enviada = await env.processar(pendente, caso, t);
  const [envio] = await env.envios(t, pendente.id);
  return { caso, pendente, enviada, envio };
}

const publicarFalha = async (t, envio, errorClass) => {
  const row = await IntegrationDispatch.findByPk(envio.id, { transaction: t });
  await publishDispatchEvent(env.ctxDe(), row, EVENTS.FAILED, { errorClass, errorCode: `EXTERNAL_${errorClass}`, status: 'FAILED' }, t);
};

test('financiamento_d220_recusa_definitiva_vai_a_failed_so_pelo_evento_e_uma_vez', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { pendente, envio } = await comRecusa(422, () => enviar(t));
    // A submissão volta ao ponto anterior à decisão: só o evento do envio pode levá-la a FAILED.
    await sql(t, "UPDATE correspondent.provider_submissions SET status = 'PENDING', failure_reason = NULL WHERE id = :id", { id: pendente.id });
    await publicarFalha(t, envio, 'VALIDATION');
    assert.equal((await submissao(t, pendente.id)).status, 'PENDING', 'o envio falho sozinho não muda a submissão: só o evento consumido');
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.failed', envio.id);
    const depois = await submissao(t, pendente.id);
    assert.equal(depois.status, 'FAILED');
    assert.match(depois.failure_reason, /O provider recusou os dados do caso/);
    assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'correspondent.financing.dispatch_failed', pendente.id), 1, 'duas entregas, uma reação auditada');
    const eventos = await sql(t, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'integration.correspondent.failed' AND idempotency_key = :k", { k: `integration.correspondent.failed:${pendente.id}` });
    assert.equal(eventos[0].n, 1, 'o aviso de falha do Correspondente sai uma só vez');
  });
});

test('financiamento_d220_falha_que_nao_e_recusa_mantem_a_submissao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { pendente, envio } = await enviar(t);
    await sql(t, "UPDATE correspondent.provider_submissions SET status = 'UNKNOWN', external_case_id = NULL WHERE id = :id", { id: pendente.id });
    await publicarFalha(t, envio, 'AUTH');
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.failed', envio.id);
    const depois = await submissao(t, pendente.id);
    assert.equal(depois.status, 'UNKNOWN', 'falha de credencial ou de disponibilidade não decide o destino da submissão');
    assert.equal(depois.failure_reason, null);
    assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'correspondent.financing.dispatch_failed', pendente.id), 1, 'a manutenção fica auditada, sem mudar o estado');
  });
});

test('financiamento_d220_ausencia_de_resposta_nao_gera_evento_nem_muda_a_submissao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const original = SandboxFinancingProviderAdapter.prototype.submitCase;
    SandboxFinancingProviderAdapter.prototype.submitCase = async () => { throw Object.assign(new Error('Tempo esgotado esperando o fornecedor.'), { code: 'ETIMEDOUT', name: 'TimeoutError' }); };
    try {
      const { pendente, enviada, envio } = await enviar(t);
      assert.equal(enviada.status, 'UNKNOWN', 'o provider não respondeu: o caso não é dado como aceito nem como inexistente');
      const falhos = await sql(t, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'integration.dispatch.failed' AND payload_json->>'dispatchId' = :d", { d: envio.id });
      assert.equal(falhos[0].n, 0, 'sem resposta do provider não há evento de falha: nada para a submissão reagir');
      assert.equal((await submissao(t, pendente.id)).status, 'UNKNOWN');
    } finally { SandboxFinancingProviderAdapter.prototype.submitCase = original; }
  });
});

test('financiamento_d220_caso_confirmado_tarde_gera_cancelamento_por_novo_envio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { pendente, envio } = await enviar(t);
    assert.ok(envio.external_resource_id);
    // O Correspondente deu a submissão por encerrada (recusa registrada) e o provider depois confirma que o caso existe: o envio do caso é confirmado.
    await sql(t, "UPDATE correspondent.provider_submissions SET status = 'FAILED' WHERE id = :id", { id: pendente.id });
    await confirmDispatch(env.ctxDe(), envio.id, { source: 'STATUS_QUERY', status: 'UNDER_ANALYSIS', externalResourceId: envio.external_resource_id }, t);
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.confirmed', envio.id);
    const envios = await env.envios(t, pendente.id);
    assert.deepEqual(envios.map((e) => e.operation).sort(), ['cancelCase', 'submitCase'], 'a compensação é um NOVO envio');
    const comp = envios.find((e) => e.operation === 'cancelCase');
    const original = envios.find((e) => e.operation === 'submitCase');
    assert.equal(comp.idempotency_key, `compensate:${envio.id}`);
    assert.equal(comp.external_resource_id ?? comp.payload_snapshot.externalResourceId, envio.external_resource_id);
    assert.equal(original.id, envio.id);
    assert.equal(original.status, 'CONFIRMED', 'o envio original é preservado');
    assert.equal((await submissao(t, pendente.id)).status, 'FAILED', 'a submissão não muda: só ganha o pedido de cancelamento');
    assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'correspondent.financing.dispatch_confirmed', pendente.id), 1);
  });
});

test('financiamento_d220_sem_integracao_ativa_o_cancelamento_nao_trava_o_evento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { pendente, envio } = await enviar(t);
    await sql(t, "UPDATE correspondent.provider_submissions SET status = 'CANCELED' WHERE id = :id", { id: pendente.id });
    await confirmDispatch(env.ctxDe(), envio.id, { source: 'STATUS_QUERY', status: 'UNDER_ANALYSIS', externalResourceId: envio.external_resource_id }, t);
    await sql(t, "UPDATE integration.connections SET status = 'PAUSED' WHERE id = :id", { id: envio.connection_id });
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.confirmed', envio.id);
    assert.deepEqual((await env.envios(t, pendente.id)).map((e) => e.operation), ['submitCase'], 'sem integração ativa o cancelamento não nasce');
    assert.equal((await submissao(t, pendente.id)).status, 'CANCELED');
    assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'correspondent.financing.dispatch_confirmed', pendente.id), 1, 'a situação fica auditada para uma pessoa decidir');
  });
});

test('financiamento_d220_caso_em_andamento_confirmado_nao_gera_compensacao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { pendente, envio } = await enviar(t);
    await confirmDispatch(env.ctxDe(), envio.id, { source: 'STATUS_QUERY', status: 'UNDER_ANALYSIS', externalResourceId: envio.external_resource_id }, t);
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.confirmed', envio.id);
    assert.deepEqual((await env.envios(t, pendente.id)).map((e) => e.operation), ['submitCase']);
    assert.equal((await submissao(t, pendente.id)).status, 'SUBMITTED');
  });
});

test('financiamento_d220_envio_nasce_na_transacao_do_dominio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await env.casoPronto(t);
    const pendente = await env.pedir(caso, t);
    const contar = async () => (await sql(t, "SELECT count(*)::int AS n FROM integration.dispatches WHERE aggregate_type = 'ProviderSubmission' AND aggregate_id = :id", { id: pendente.id }))[0].n;
    assert.equal(await contar(), 0);
    // Savepoint do próprio teste (nome único: os savepoints aninhados do Sequelize repetem nomes e desfariam só o último).
    await sequelize.query('SAVEPOINT qa_m9_d240_dominio', { transaction: t });
    await env.processar(pendente, caso, t);
    assert.equal(await contar(), 1, 'o envio nasce junto com a decisão do domínio');
    await sequelize.query('ROLLBACK TO SAVEPOINT qa_m9_d240_dominio', { transaction: t });
    assert.equal(await contar(), 0, 'sem commit do domínio não há envio ao provider');
  });
});

test('financiamento_d220_modulo_nao_chama_o_provider_direto', () => {
  const dir = path.join(__dirname, '../../../src/features/correspondent/dispatch');
  const fontes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')]);
  for (const [f, texto] of fontes) assert.equal(/\.submitCase\(|\.requestAppraisal\(|\.uploadDocument\(|\.cancelCase\(|\.simulate\(/.test(texto), false, `${f} chama o provider por fora do Dispatch Service`);
  assert.ok(fontes.some(([, t]) => /registerDomainReaction/.test(t)) && fontes.some(([, t]) => /compensateDispatch/.test(t)));
});
