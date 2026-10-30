'use strict';

// Marco 9, M9-D241 + M9-D220 — a nota muda de estado só por evento interno do envio (idempotente e auditado), o pedido nasce na transação do Fiscal, a emissão tardia vira cancelamento
// compensatório por NOVO envio e a falha ou a ausência de resposta do emissor não altera a nota. Banco descartável; cada teste roda numa transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d241Env');
const reacao = require('../_helpers/reacaoD220');
const { IntegrationDispatch } = require('../../../src/models');
const { transitionDispatch } = require('../../../src/features/integrations/dispatch/dispatch.transition');
const { publishDispatchEvent, EVENTS } = require('../../../src/features/integrations/dispatch/dispatch.events');
const dispatchService = require('../../../src/features/integrations/dispatch/enqueue/dispatch.service');
const { withTenantTransaction } = require('../../testHelpers');
const { ensureFiscalConnection } = require('../../../src/features/correspondent/fiscal/nfse/nfse.connection');
const { confirmDispatch } = require('../../../src/features/integrations/dispatch/worker/worker.confirm');

before(async () => { await env.carregar(); env.resetSandbox(); });
after(async () => { await env.sequelize.close(); });

const rollback = (fn) => env.withRollbackTenantTransaction(env.tenant, fn);
const { sequelize } = env;

/** O motor de envios dá o envio por falho e publica o evento (o que retry.apply faz na recusa 4xx). */
async function falharEnvio(t, dispatchId, errorClass) {
  await transitionDispatch(env.ctxDe(), dispatchId, 'FAILED', { lastErrorClass: errorClass, lastErrorCode: `EXTERNAL_${errorClass}` }, { motivo: 'QA-M9 recusa' }, t);
  const row = await IntegrationDispatch.findByPk(dispatchId, { transaction: t });
  await publishDispatchEvent(env.ctxDe(), row, EVENTS.FAILED, { errorClass, errorCode: `EXTERNAL_${errorClass}`, status: 'FAILED' }, t);
}
const confirmar = (t, dispatchId, externalResourceId) => confirmDispatch(env.ctxDe(), dispatchId, { source: 'STATUS_QUERY', status: 'AUTHORIZED', externalResourceId }, t);
const eventosDaNota = (t, notaId) => env.sql(t, 'SELECT raw_status FROM correspondent.invoice_events WHERE invoice_request_id = :id ORDER BY occurred_at, id', { id: notaId });

test('nfse_d220_recusa_definitiva_vai_a_rejected_so_pelo_evento_e_uma_vez', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    await env.falha(t, 'TIMEOUT_AFTER_SEND');
    const nota = await env.pedir(t, { amount: 1800 });
    assert.equal(nota.status, 'UNKNOWN');
    await falharEnvio(t, nota.dispatchId, 'VALIDATION');
    assert.equal((await env.nota(t, nota.id)).status, 'UNKNOWN', 'o envio falho sozinho não muda a nota: só o evento consumido');
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.failed', nota.dispatchId);
    const depois = await env.nota(t, nota.id);
    assert.equal(depois.status, 'REJECTED');
    assert.match(depois.rejectionReason, /O emissor recusou os dados do pedido/);
    assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'correspondent.nfse.dispatch_failed', nota.id), 1, 'duas entregas, uma reação auditada');
    assert.equal((await eventosDaNota(t, nota.id)).filter((e) => e.raw_status === 'REJECTED').length, 1);
  });
});

test('nfse_d220_falha_que_nao_e_recusa_e_ausencia_de_resposta_mantem_a_nota', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    await env.falha(t, 'TIMEOUT_AFTER_SEND');
    const nota = await env.pedir(t, { amount: 900 });
    assert.equal(nota.status, 'UNKNOWN', 'o emissor não respondeu: a nota não é dada como emitida nem como inexistente');
    const falhos = await env.sql(t, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'integration.dispatch.failed' AND payload_json->>'dispatchId' = :d", { d: nota.dispatchId });
    assert.equal(falhos[0].n, 0, 'sem resposta do emissor não há evento de falha: nada para a nota reagir');
    await falharEnvio(t, nota.dispatchId, 'AUTH');
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.failed', nota.dispatchId);
    const depois = await env.nota(t, nota.id);
    assert.equal(depois.status, 'UNKNOWN', 'falha de credencial não decide o destino da nota');
    assert.equal(depois.rejectionReason, null);
    assert.ok((await eventosDaNota(t, nota.id)).some((e) => e.raw_status === 'ISSUE_FAILED'), 'o histórico registra a falha');
  });
});

test('nfse_d220_emissao_tardia_gera_cancelamento_compensatorio_por_novo_envio', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const nota = await env.pedir(t, { amount: 1200 });
    const [original] = await env.envios(t, nota.id, 'issueNfse');
    assert.ok(original.external_resource_id);
    // O pedido foi encerrado aqui (o emissor "não tinha recebido") e a reconciliação acha a nota no emissor: o envio da emissão é confirmado.
    await env.sql(t, "UPDATE correspondent.invoice_requests SET status = 'CANCELED' WHERE id = :id", { id: nota.id });
    await confirmar(t, original.id, original.external_resource_id);
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.confirmed', original.id);
    const envios = await env.envios(t, nota.id);
    assert.deepEqual(envios.map((e) => e.operation).sort(), ['cancelNfse', 'issueNfse'], 'a compensação é um NOVO envio');
    const comp = envios.find((e) => e.operation === 'cancelNfse');
    const emissao = envios.find((e) => e.operation === 'issueNfse');
    assert.equal(comp.idempotency_key, `compensate:${original.id}`);
    assert.equal(emissao.id, original.id);
    assert.equal(emissao.status, 'CONFIRMED', 'o envio original é preservado');
    assert.equal(emissao.external_resource_id, original.external_resource_id);
    assert.equal((await env.nota(t, nota.id)).status, 'CANCELED');
    assert.equal(await reacao.reacoesNaTransacao(sequelize, t, 'correspondent.nfse.dispatch_confirmed', nota.id), 1);
  });
});

test('nfse_d220_nota_em_andamento_confirmada_nao_gera_compensacao', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const nota = await env.pedir(t, { amount: 700 });
    const [original] = await env.envios(t, nota.id, 'issueNfse');
    await confirmar(t, original.id, original.external_resource_id);
    await reacao.consumirNaTransacao(sequelize, t, 'integration.dispatch.confirmed', original.id);
    assert.deepEqual((await env.envios(t, nota.id)).map((e) => e.operation), ['issueNfse']);
    assert.equal((await env.nota(t, nota.id)).status, 'SUBMITTED');
  });
});

test('nfse_d220_pedido_nasce_na_transacao_do_dominio', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const contar = async () => (await env.sql(t, "SELECT count(*)::int AS n FROM integration.dispatches WHERE operation = 'issueNfse'"))[0].n;
    const antes = await contar();
    // Savepoint do próprio teste (nome único: os savepoints aninhados do Sequelize repetem nomes e desfariam só o último).
    await sequelize.query('SAVEPOINT qa_m9_d241_dominio', { transaction: t });
    await env.pedir(t, { amount: 500 });
    assert.equal(await contar(), antes + 1, 'o envio nasce junto com o pedido da nota');
    await sequelize.query('ROLLBACK TO SAVEPOINT qa_m9_d241_dominio', { transaction: t });
    assert.equal(await contar(), antes, 'sem commit do domínio não há envio ao emissor');
  });
});

test('nfse_d220_producao_nota_e_envio_nascem_na_mesma_transacao', async () => {
  // Caminho de produção (transação própria da nota): se o envio ao emissor não puder nascer, a nota também não existe (nunca há nota REQUESTED sem o envio que a leva ao emissor).
  await withTenantTransaction(env.tenant, (t) => ensureFiscalConnection(env.ctxDe(), t)); // a connection de NFS-e já existe (confirmada) em produção
  process.env.NFSE_FORCE_OWN_TX = '1';
  const original = dispatchService.enqueue;
  const sourceId = require('node:crypto').randomUUID();
  const doBanco = (consulta) => withTenantTransaction(env.tenant, async (t) => (await sequelize.query(consulta, { replacements: { s: sourceId }, transaction: t }))[0]);
  try {
    dispatchService.enqueue = async () => { throw new Error('QA-M9 fila indisponível'); };
    await assert.rejects(rollback((t) => env.pedir(t, { sourceId, amount: 400 })), /fila indisponível/);
    assert.equal((await doBanco('SELECT 1 FROM correspondent.invoice_requests WHERE source_id = :s')).length, 0, 'sem o envio, a nota não ficou gravada');
    dispatchService.enqueue = original;
    const nota = await rollback((t) => env.pedir(t, { sourceId, amount: 400 }));
    assert.ok(nota.dispatchId && nota.externalId, 'com a fila de pé, a nota e o envio nascem e o emissor responde');
    const gravados = await doBanco("SELECT i.status, d.operation, d.status AS envio FROM correspondent.invoice_requests i JOIN integration.dispatches d ON d.aggregate_id = i.id AND d.aggregate_type = 'InvoiceRequest' WHERE i.source_id = :s");
    assert.equal(gravados.length, 1, 'a nota e o envio ficaram gravados juntos');
    assert.equal(gravados[0].operation, 'issueNfse');
  } finally { dispatchService.enqueue = original; delete process.env.NFSE_FORCE_OWN_TX; }
});

test('nfse_d220_modulo_nao_chama_o_emissor_direto', () => {
  const dir = path.join(__dirname, '../../../src/features/correspondent/fiscal/nfse');
  const fontes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, texto] of fontes) assert.equal(/\.requestInvoice\(|\.cancelInvoice\(|\.getInvoiceStatus\(|NfseAdapter'\)/.test(texto.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false, `${f} chama o emissor por fora do Dispatch Service`);
  assert.ok(fontes.some(([, t]) => /registerDomainReaction/.test(t)) && fontes.some(([, t]) => /compensateDispatch/.test(t)));
});
