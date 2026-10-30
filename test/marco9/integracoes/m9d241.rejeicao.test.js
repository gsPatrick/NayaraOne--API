'use strict';

// Marco 9, M9-D241 — recusa da prefeitura (motivo em português, correção em NOVO RPS, nunca edita a nota anterior) e cancelamento (motivo obrigatório, DANGEROUS, confirmado só pelo
// status CANCELED do emissor, com MFA na rota). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d241Env');
const { SANDBOX_REJECT_MARKER, SANDBOX_REJECT_NOW_MARKER } = require('../../../src/features/correspondent/adapters/NfseAdapter');
const { cancelAtIssuer } = require('../../../src/features/correspondent/fiscal/nfse/nfse.ops');
const fiscalController = require('../../../src/features/correspondent/fiscal/fiscal.controller');
const correspondentRouter = require('../../../src/features/correspondent/correspondent.routes');
const { withTimeout } = env.nfseService;

before(async () => { await env.carregar(); env.resetSandbox(); });
after(async () => { await env.sequelize.close(); });

const rollback = (fn) => env.withRollbackTenantTransaction(env.tenant, fn);
const codigo = (c) => (e) => { assert.equal(e.code, c); return true; };

test('nfse_rejeicao_novo_rps', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const sourceId = require('node:crypto').randomUUID();
    const recusada = await env.pedir(t, { sourceId, description: `Serviço ${SANDBOX_REJECT_MARKER} ${env.uniqueSuffix()}` });
    await env.esperarEmissor();
    const consultada = await env.consultar(t, recusada.id);
    assert.equal(consultada.status, 'REJECTED');
    assert.match(consultada.rejectionReason, /recusada pelo emissor/i, 'o motivo da prefeitura fica na nota');
    const [envioRecusado] = await env.envios(t, recusada.id, 'issueNfse');
    assert.equal(envioRecusado.status, 'FAILED', 'a recusa encerra o envio da emissão');
    assert.equal(envioRecusado.last_error_code, 'EXTERNAL_REJECTED');
    // A correção é OUTRA nota: outro RPS, outro envio, e a recusada fica exatamente como estava.
    const corrigida = await env.pedir(t, { sourceId, description: `Serviço corrigido ${env.uniqueSuffix()}` });
    assert.notEqual(corrigida.id, recusada.id);
    assert.ok(Number(corrigida.rpsNumber) > Number(recusada.rpsNumber), 'novo RPS');
    assert.notEqual(corrigida.issuerKey, recusada.issuerKey);
    assert.equal(corrigida.attemptNumber, recusada.attemptNumber + 1);
    const [envioNovo] = await env.envios(t, corrigida.id, 'issueNfse');
    assert.notEqual(envioNovo.id, envioRecusado.id);
    const intacta = await env.nota(t, recusada.id);
    assert.deepEqual([intacta.status, Number(intacta.rpsNumber), intacta.description, intacta.rejectionReason], ['REJECTED', Number(recusada.rpsNumber), recusada.description, consultada.rejectionReason]);
  });
});

test('nfse_rejeicao_sincrona_grava_a_nota_e_responde_422', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const nota = await env.pedir(t, { description: `Tomador inválido ${SANDBOX_REJECT_NOW_MARKER} ${env.uniqueSuffix()}` });
    assert.equal(nota.status, 'REJECTED', 'a prefeitura recusou no pedido: a nota fica gravada, com o motivo');
    assert.match(nota.rejectionReason, /CNPJ\/CPF do tomador inválido/);
    assert.equal(nota.externalId, null);
    const [envio] = await env.envios(t, nota.id, 'issueNfse');
    assert.equal(envio.status, 'FAILED');
    // A resposta da rota é 422 com o código do livro, depois da transação confirmada.
    let erro = null;
    const req = { body: { sourceType: 'SERVICE_ORDER', sourceId: require('node:crypto').randomUUID(), amount: 100, description: `Rota ${SANDBOX_REJECT_NOW_MARKER}` }, auth: { userId: env.tenant.userId, groupId: env.tenant.groupId, companyId: env.tenant.companyId, permissions: ['correspondent:fiscal'] }, withTenantTransaction: (fn) => fn(t) };
    await new Promise((resolve) => { fiscalController.requestInvoice(req, { status() { return this; }, json() { resolve(); } }, (e) => { erro = e; resolve(); }); });
    assert.equal(erro.statusCode, 422);
    assert.equal(erro.code, 'INTEGRATION_FISCAL_NFSE_REJECTED');
    assert.equal(erro.message, 'A prefeitura recusou a nota: veja o motivo e emita novamente.');
    assert.match(erro.details.reason, /tomador/);
    assert.ok(erro.details.rpsNumber);
  });
});

test('nfse_cancelamento_exige_motivo_e_confirma_por_status', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const nota = await env.pedir(t, { amount: 3200 });
    await env.esperarEmissor();
    const autorizada = await env.consultar(t, nota.id);
    assert.equal(autorizada.status, 'AUTHORIZED');
    // Sem motivo: a integração recusa com 422 (mensagem do livro) e nada sai para o emissor.
    for (const vazio of [undefined, null, '', '   ']) {
       
      await assert.rejects(cancelAtIssuer(env.ctxDe(), autorizada, vazio, { transaction: t, timeoutMs: 8000, withTimeout }), (e) => { assert.equal(e.statusCode, 422); assert.equal(e.code, 'INTEGRATION_FISCAL_CANCEL_REASON_REQUIRED'); assert.equal(e.message, 'Informe o motivo do cancelamento da nota.'); return true; });
    }
    assert.equal((await env.envios(t, nota.id, 'cancelNfse')).length, 0, 'sem motivo não há envio');
    // A rota do Fiscal mantém o contrato do Marco 8 (400 NFSE_CANCEL_REASON_REQUIRED) e a nota segue autorizada.
    await assert.rejects(env.cancelar(t, nota.id, ''), codigo('NFSE_CANCEL_REASON_REQUIRED'));
    assert.equal((await env.nota(t, nota.id)).status, 'AUTHORIZED');
    // Com motivo: o cancelamento sai como DANGEROUS com a chave do RPS e só é confirmado pelo status CANCELED do emissor.
    const cancelada = await env.cancelar(t, nota.id, 'Valor lançado errado pelo operador');
    assert.equal(cancelada.status, 'CANCELED');
    const [cancelamento] = await env.envios(t, nota.id, 'cancelNfse');
    assert.equal(cancelamento.idempotency_key, `nfse-cancel:A-${nota.rpsNumber}`);
    assert.equal(cancelamento.criticality_op, 'DANGEROUS');
    assert.equal(cancelamento.confirmation_mode, 'ON_STATUS');
    assert.equal(cancelamento.purpose, 'FISCAL_CANCELLATION');
    assert.equal(cancelamento.payload_snapshot.reason, 'Valor lançado errado pelo operador');
    assert.equal(cancelamento.status, 'CONFIRMED', 'confirmado pela consulta de status CANCELED, não pela resposta do pedido');
    assert.equal(cancelamento.external_status, 'CANCELED');
    const eventos = await env.nfseService.getInvoiceEvents(nota.id, env.tenant.groupId, env.tenant.companyId, t);
    assert.ok(eventos.some((e) => e.normalizedStatus === 'CANCELED' && /Valor lançado errado/.test(e.note || '')), 'o motivo fica no histórico');
    // O documento fiscal emitido continua preservado (a nota cancelada nunca o apaga).
    assert.ok(await env.documento(t, nota.id), 'o documento fiscal segue guardado, com o número oficial');
  });
});

test('nfse_cancelamento_exige_mfa_recente_na_rota', async () => {
  const camada = correspondentRouter.stack.find((l) => l.route && l.route.path === '/fiscal/invoices/:id/cancel' && l.route.methods.post);
  assert.ok(camada, 'a rota de cancelamento existe');
  const nomes = camada.route.stack.map((l) => l.handle.name);
  assert.ok(nomes.includes('requireRecentMfa'), 'cancelar nota fiscal exige MFA recente');
  assert.ok(camada.route.stack.some((l) => l.handle.requiredPermission === 'correspondent:fiscal'), 'e a permissão fiscal de sempre');
});
