'use strict';

// Marco 9, M9-D240 — o pedido do caso ao provider passa pelo Dispatch Service: chave de idempotência, conteúdo minimizado, incerteza e provider fora.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d240Env');
const { hashPayload } = require('../../../src/features/integrations/dispatch');
const { SandboxFinancingProviderAdapter } = require('../../../src/features/correspondent/adapters/FinancingProviderAdapter');
const { IntegrationConnection } = require('../../../src/models');
const { updateCircuitState } = require('../../../src/features/integrations/health');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');

const { sequelize, withRollbackTenantTransaction, submissionsService } = env;
let tenant;

before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

/** Troca o submitCase do sandbox por um que anota o pedido recebido e segue para o original (ou para `comportamento`). */
function espiarSubmit(comportamento) {
  const original = SandboxFinancingProviderAdapter.prototype.submitCase;
  const chamadas = [];
  SandboxFinancingProviderAdapter.prototype.submitCase = async function espiado(req) {
    chamadas.push(req);
    return comportamento ? comportamento.call(this, req, original) : original.call(this, req);
  };
  return { chamadas, restaurar: () => { SandboxFinancingProviderAdapter.prototype.submitCase = original; } };
}

test('financiamento_submit_case_via_dispatch_idempotente', async () => {
  const espiao = espiarSubmit();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const caso = await env.casoPronto(t);
      const pendente = await env.pedir(caso, t);
      assert.equal((await env.envios(t, pendente.id)).length, 0, 'pedir o envio ainda não chama o provider nem grava o envio');
      const enviada = await env.processar(pendente, caso, t);
      assert.equal(enviada.status, 'SUBMITTED');
      const linhas = await env.envios(t, pendente.id);
      assert.equal(linhas.length, 1, 'o pedido ao provider nasce em integration.dispatches');
      const d = linhas[0];
      assert.deepEqual([d.operation, d.criticality_op, d.provider_code, d.status], ['submitCase', 'DANGEROUS', 'financing-sandbox', 'SUBMITTED']);
      assert.equal(d.confirmation_mode, 'ON_STATUS', 'a resposta da submissão não confirma: só o status final do provider');
      assert.equal(d.idempotency_key, pendente.idempotencyKey, 'a chave do envio é a chave de submissão já existente');
      assert.equal(d.external_resource_id, enviada.externalCaseId);
      assert.equal(d.purpose, 'FINANCING_PROPOSAL', 'a finalidade fica gravada');
      // conteúdo MINIMIZADO: só o que o mapper financing.submitCase aceita; consentimento, proponentes e documentos do snapshot da submissão não saem
      const snapshot = d.payload_snapshot;
      assert.deepEqual(Object.keys(snapshot).sort(), ['amount', 'caseRef', 'proponentDocument', 'proponentName']);
      ['consent', 'applicants', 'documents', 'simulation', 'idempotencyKey'].forEach((k) => assert.equal(k in snapshot, false, `${k} não sai para o fornecedor`));
      assert.equal(snapshot.caseRef, caso.id);
      assert.equal(d.payload_hash, hashPayload(snapshot), 'o hash é do conteúdo minimizado');
      // o provider recebeu o pedido na interface original e com a chave
      assert.equal(espiao.chamadas.length, 1);
      assert.deepEqual([espiao.chamadas[0].financingCaseId, espiao.chamadas[0].idempotencyKey, espiao.chamadas[0].consent], [caso.id, pendente.idempotencyKey, true]);
      // pedir de novo devolve o mesmo envio: sem segundo dispatch nem segunda chamada
      const outra = await env.pedir(caso, t);
      assert.equal(outra.id, pendente.id);
      await env.processar(outra, caso, t);
      assert.equal((await env.envios(t, pendente.id)).length, 1);
      assert.equal(espiao.chamadas.length, 1);
    });
  } finally { espiao.restaurar(); }
});

test('m9_d240_dispatch_minimizado_linha_real', async () => {
  const espiao = espiarSubmit();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const caso = await env.casoPronto(t);
      const pendente = await env.pedir(caso, t);
      await env.processar(pendente, caso, t);
      const [d] = await env.envios(t, pendente.id);
      assert.ok(d, 'linha real de integration.dispatches deste fluxo');
      assert.equal(d.purpose, 'FINANCING_PROPOSAL');
      assert.equal(d.fields_dropped, 0);
      assert.equal(d.payload_hash, hashPayload(d.payload_snapshot));
      assert.equal(JSON.stringify(d.payload_snapshot).includes(pendente.idempotencyKey), false);
      // nenhum segredo e nenhum dado fora do mapper no conteúdo gravado
      assert.equal(/consent|evidence|checksum|storage/i.test(JSON.stringify(d.payload_snapshot)), false);
    });
  } finally { espiao.restaurar(); }
});

test('financiamento_timeout_submit_unknown_reconcilia', async () => {
  const perdida = espiarSubmit(async function aceitaMasPerde(req, original) {
    await original.call(this, req); // o provider aceita e guarda pela chave, mas a resposta se perde
    throw new Error('Conexão perdida depois de o provider aceitar o caso.');
  });
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const caso = await env.casoPronto(t);
      const pendente = await env.pedir(caso, t);
      const incerta = await env.processar(pendente, caso, t);
      assert.equal(incerta.status, 'UNKNOWN', 'resposta perdida: incerta, nunca reenviada às cegas');
      assert.match(incerta.failureReason, /Conexão perdida/);
      const [d] = await env.envios(t, pendente.id);
      assert.notEqual(d.status, 'RETRY_WAIT', 'o worker de envios não pode repetir sozinho um envio incerto do Correspondente');
      assert.equal(perdida.chamadas.length, 1);
      // a consulta pela chave (findSubmissionByKey) recupera o caso sem novo envio
      const r = await submissionsService.acknowledgeUnknownSubmission(pendente.id, {}, ...env.a(), t);
      assert.equal(r.recovered, true);
      assert.equal(perdida.chamadas.length, 1, 'a reconciliação consulta, não envia de novo');
      assert.equal((await env.envios(t, pendente.id)).length, 1, 'continua um único envio');
      // o adapter do contrato expõe a mesma consulta para a reconciliação do motor (M9-D215)
      const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
      const contrato = adapterRegistry.instantiate('financing-sandbox');
      const achou = await contrato.findByIdempotencyKey(null, { idempotencyKey: pendente.idempotencyKey });
      assert.equal(achou.found, true);
      assert.equal((await contrato.findByIdempotencyKey(null, { idempotencyKey: 'chave-que-nao-existe' })).found, false);
    });
  } finally { perdida.restaurar(); }
});

test('financiamento_provider_fora_usa_manual', async () => {
  const espiao = espiarSubmit();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const ctx = env.ctxDe();
      const manual = await registry.createConnection({ providerCode: 'financing-manual', environment: registry.getServerEnvironment(), label: `Manual D240 ${env.uniqueSuffix()}` }, ctx, t);
      await transitionConnection(manual.id, 'ACTIVE', ctx, t);
      const caso = await env.casoPronto(t);
      const pendente = await env.pedir(caso, t);
      // sem alternativo na política, o provider fora (circuito aberto) só adia: nada sai e a submissão segue PENDING
      const sandbox = await require('../../../src/features/correspondent/dispatch/financingConnection').ensureFinancingConnection(ctx, 'sandbox', t);
      await updateCircuitState(sandbox.id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 600 }, t);
      const adiada = await env.processar(pendente, caso, t);
      assert.equal(adiada.status, 'PENDING');
      assert.equal(espiao.chamadas.length, 0, 'o provider fora não é chamado');
      // com o alternativo configurado (fluxo manual), o mesmo pedido segue pelo financing-manual
      await registry.updateConnection(sandbox.id, { policyJson: { contingency: { alternate_connection_id: manual.id } } }, ctx, t);
      const manualmente = await env.processar(adiada, caso, t);
      assert.equal(manualmente.status, 'SUBMITTED');
      assert.match(manualmente.externalCaseId, /^manual-/, 'o fluxo manual assumiu');
      assert.equal(espiao.chamadas.length, 0);
      const linhas = await env.envios(t, pendente.id);
      assert.deepEqual(linhas.map((l) => [l.provider_code, l.status]).sort(), [['financing-manual', 'SUBMITTED'], ['financing-sandbox', 'CANCELLED']]);
      assert.ok(linhas.every((l) => l.idempotency_key === pendente.idempotencyKey), 'a mesma chave nos dois envios');
      assert.equal((await IntegrationConnection.findByPk(manual.id, { transaction: t })).status, 'ACTIVE');
    });
  } finally { espiao.restaurar(); }
});

test('financiamento_avaliacao_via_dispatch_com_valor_do_provider', async () => {
  const appraisals = require('../../../src/features/correspondent/cases/appraisals.service');
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = await env.casoPronto(t, 'sandbox', { comImovel: true });
    const avaliacao = await appraisals.createAppraisal(caso.id, { referenceValue: 500000 }, ...env.a(), t);
    assert.equal(avaliacao.status, 'COMPLETED');
    assert.ok(Number(avaliacao.requestedValue) > 0, 'o valor devolvido pelo provider chega à avaliação');
    const [linha] = (await sequelize.query("SELECT * FROM integration.dispatches WHERE aggregate_type = 'Appraisal' AND aggregate_id = :id", { replacements: { id: avaliacao.id }, transaction: t }))[0];
    assert.ok(linha, 'o pedido de avaliação nasce em integration.dispatches');
    assert.deepEqual([linha.operation, linha.provider_code, linha.status], ['requestAppraisal', 'financing-sandbox', 'CONFIRMED']);
    assert.equal(linha.idempotency_key, `appraisal:${avaliacao.id}`);
  });
});
