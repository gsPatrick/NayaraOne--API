'use strict';

// Marco 9, M9-D228 — promotora fora: o pedido espera na fila e é consultado pela chave no retorno, o alternativo só vale se elegível (ativo, liberado, com a capability, sem exclusividade do
// caso), a troca preserva o provider original no histórico com auditoria e, passado o prazo da fila, o caso segue pelo fluxo manual com o status registrado com evidência. Rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d240Env');
const contingency = require('../../../src/features/integrations/contingency');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { updateCircuitState } = require('../../../src/features/integrations/health');
const { ensureFinancingConnection } = require('../../../src/features/correspondent/dispatch/financingConnection');
const { SandboxFinancingProviderAdapter } = require('../../../src/features/correspondent/adapters/FinancingProviderAdapter');
const { contractedProviderCode } = require('../../../src/features/correspondent/dispatch/providerSwitch');
const caseWorkflow = require('../../../src/features/correspondent/cases/caseWorkflow.service');
const { File, FinancingCase } = require('../../../src/models');

const { sequelize, withRollbackTenantTransaction } = env;
let tenant;
before(async () => { tenant = await env.carregar(); contingency.installContingency(); });
after(async () => { await sequelize.close(); });

function espiarSubmit(comportamento) {
  const original = SandboxFinancingProviderAdapter.prototype.submitCase;
  const chamadas = [];
  SandboxFinancingProviderAdapter.prototype.submitCase = async function espiado(req) { chamadas.push(req); return comportamento ? comportamento.call(this, req, original) : original.call(this, req); };
  return { chamadas, restaurar: () => { SandboxFinancingProviderAdapter.prototype.submitCase = original; } };
}
const abrir = (t, id) => updateCircuitState(id, { circuitState: 'OPEN', circuitOpenedAt: new Date(), circuitCooldownS: 3600 }, t);
const fechar = (t, id) => updateCircuitState(id, { circuitState: 'CLOSED', circuitOpenedAt: null, circuitCooldownS: null, consecutiveFailures: 0 }, t);
const ciclo = (t) => contingency.runContingencyCycle(env.ctxDe(), { now: new Date() }, t);
const recarregar = (t, caso) => FinancingCase.findByPk(caso.id, { transaction: t });
const auditoria = async (t, entityId, action) => (await sequelize.query('SELECT * FROM audit.audit_log WHERE entity_id = :id AND action = :a', { replacements: { id: entityId, a: action }, transaction: t }))[0];

async function conexoes(t, { politica = true } = {}) {
  const ctx = env.ctxDe();
  const manual = await registry.createConnection({ providerCode: 'financing-manual', environment: registry.getServerEnvironment(), label: `Manual D228 ${env.uniqueSuffix()}` }, ctx, t);
  await transitionConnection(manual.id, 'ACTIVE', ctx, t);
  const principal = await ensureFinancingConnection(ctx, 'sandbox', t);
  if (politica) await registry.updateConnection(principal.id, { policyJson: { contingency: { alternate_connection_id: manual.id } } }, ctx, t);
  return { manual, principal };
}

test('contingencia_financiamento_fila_e_consulta', async () => {
  const perdida = espiarSubmit(async function aceitaMasPerde(req, original) { await original.call(this, req); throw new Error('Conexão perdida depois de o provider aceitar o caso.'); });
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { principal } = await conexoes(t, { politica: false });
      const caso = await env.casoPronto(t);
      const pendente = await env.pedir(caso, t);
      await abrir(t, principal.id);
      const adiada = await env.processar(pendente, caso, t);
      assert.equal(adiada.status, 'PENDING', 'a promotora fora: o pedido espera na fila');
      assert.equal(perdida.chamadas.length, 0, 'nada sai');
      assert.ok((await ciclo(t)).activated >= 1);
      assert.equal((await contingency.listActiveContingencies(env.ctxDe(), t)).find((a) => a.connectionId === principal.id).mode, 'QUEUE_QUERY_OR_ALTERNATE_PROVIDER');
      assert.equal((await env.envios(t, pendente.id)).filter((d) => ['PENDING', 'RETRY_WAIT'].includes(d.status)).length, 1, 'um envio na fila, sem duplicar');
      // A promotora volta, mas a resposta do envio se perde: o caso fica incerto e é CONSULTADO pela chave, nunca reenviado às cegas.
      await fechar(t, principal.id);
      const incerta = await env.processar(adiada, caso, t);
      assert.equal(incerta.status, 'UNKNOWN');
      assert.equal(perdida.chamadas.length, 1);
      const r = await env.submissionsService.acknowledgeUnknownSubmission(pendente.id, {}, ...env.a(), t);
      assert.equal(r.recovered, true, 'a consulta por chave recuperou o caso');
      assert.equal(perdida.chamadas.length, 1, 'consultou, não enviou de novo');
      assert.equal((await env.envios(t, pendente.id)).length, 1);
    });
  } finally { perdida.restaurar(); }
});

test('contingencia_financiamento_alternativo_elegivel', async () => {
  const espiao = espiarSubmit();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { manual, principal } = await conexoes(t);
      await abrir(t, principal.id);

      // Caso comum: o alternativo elegível (ativo, liberado, com submitCase e circuito fechado) leva o envio; o provider original fica no histórico e a troca é auditada.
      const caso = await env.casoPronto(t);
      const pendente = await env.pedir(caso, t);
      const enviada = await env.processar(pendente, caso, t);
      assert.equal(enviada.status, 'SUBMITTED');
      assert.match(enviada.externalCaseId, /^manual-/, 'o fluxo manual levou o caso');
      assert.equal(espiao.chamadas.length, 0);
      const depois = await recarregar(t, caso);
      assert.equal(depois.providerCode, 'manual');
      assert.equal(depois.providerHistory.length, 1);
      assert.deepEqual([depois.providerHistory[0].from, depois.providerHistory[0].to, depois.providerHistory[0].reason], ['sandbox', 'manual', 'CONTINGENCY_ALTERNATE_PROVIDER']);
      assert.equal(contractedProviderCode(depois), 'sandbox', 'a comissão segue o provider contratado');
      assert.equal(enviada.providerCode, 'sandbox', 'a submissão guarda o provider com que nasceu');
      const aud = await auditoria(t, caso.id, 'correspondent.case.provider_switched');
      assert.equal(aud.length, 1);
      assert.equal(aud[0].before_json.providerCode, 'sandbox');
      assert.equal(aud[0].after_json.providerCode, 'manual');
      const linhas = await env.envios(t, pendente.id);
      assert.deepEqual(linhas.map((l) => [l.provider_code, l.status]).sort(), [['financing-manual', 'SUBMITTED'], ['financing-sandbox', 'CANCELLED']]);

      // Caso com exclusividade contratual: nenhum provider automático alternativo, mesmo elegível. Espera na fila.
      const exclusivo = await env.casoPronto(t);
      await FinancingCase.update({ providerExclusive: true }, { where: { id: exclusivo.id }, transaction: t });
      const pedidoEx = await env.pedir(exclusivo, t);
      const adiado = await env.processar(pedidoEx, exclusivo, t);
      assert.equal(adiado.status, 'PENDING');
      assert.equal((await recarregar(t, exclusivo)).providerCode, 'sandbox');
      assert.deepEqual((await env.envios(t, pedidoEx.id)).map((l) => l.provider_code), ['financing-sandbox']);

      // Alternativo não elegível (pausado): também espera.
      await transitionConnection(manual.id, 'PAUSED', env.ctxDe(), t);
      const outro = await env.casoPronto(t);
      const pedidoOutro = await env.pedir(outro, t);
      assert.equal((await env.processar(pedidoOutro, outro, t)).status, 'PENDING');
      assert.equal((await recarregar(t, outro)).providerHistory.length, 0);
    });
  } finally { espiao.restaurar(); }
});

test('contingencia_financiamento_manual_com_evidencia', async () => {
  const espiao = espiarSubmit();
  try {
    await withRollbackTenantTransaction(tenant, async (t) => {
      const { principal } = await conexoes(t, { politica: false });
      const exclusivo = await env.casoPronto(t);
      await FinancingCase.update({ providerExclusive: true }, { where: { id: exclusivo.id }, transaction: t });
      const recente = await env.casoPronto(t);
      const pedidoEx = await env.pedir(exclusivo, t);
      const pedidoRecente = await env.pedir(recente, t);
      await abrir(t, principal.id);
      await env.processar(pedidoEx, exclusivo, t);
      await env.processar(pedidoRecente, recente, t);
      await ciclo(t);
      // Só o envio que passou de 24 h na fila segue pelo fluxo manual (a exclusividade não impede: é a mesma promotora, contatada por pessoas).
      const [dEx] = await env.envios(t, pedidoEx.id);
      await sequelize.query("UPDATE integration.dispatches SET created_at = now() - interval '25 hours' WHERE id = :id", { replacements: { id: dEx.id }, transaction: t });
      const r = await ciclo(t);
      assert.equal(r.switched, 1);
      const caso = await recarregar(t, exclusivo);
      assert.equal(caso.providerCode, 'manual');
      assert.equal(caso.providerHistory[0].reason, 'CONTINGENCY_QUEUE_EXPIRED');
      assert.equal((await env.envios(t, pedidoEx.id))[0].status, 'CANCELLED', 'o envio da fila da promotora que caiu foi cancelado');
      assert.equal((await recarregar(t, recente)).providerCode, 'sandbox', 'o que não passou de 24 h segue esperando');
      assert.equal((await auditoria(t, exclusivo.id, 'correspondent.case.provider_switched')).length, 1);

      // O worker entrega a submissão ao fluxo manual (a promotora é contatada por pessoas).
      const manual = await env.processar(await pedidoEx.reload({ transaction: t }), caso, t);
      assert.equal(manual.status, 'SUBMITTED');
      assert.match(manual.externalCaseId, /^manual-/);
      assert.equal(espiao.chamadas.length, 0);

      // O analista registra o status que a promotora informou: SEM evidência é recusado; COM o arquivo da evidência entra, e a evidência fica na linha do histórico.
      const reg = (payload) => caseWorkflow.registerManualStatus(caso.id, payload, tenant.userId, tenant.groupId, tenant.companyId, t);
      await assert.rejects(reg({ status: 'UNDER_ANALYSIS' }), (e) => e.statusCode === 400 && e.code === 'MANUAL_STATUS_EVIDENCE_REQUIRED');
      await assert.rejects(reg({ status: 'UNDER_ANALYSIS', evidenceFileId: '00000000-0000-4000-8000-000000000000' }), (e) => e.code === 'MANUAL_STATUS_EVIDENCE_REQUIRED');
      const arquivo = await File.create({ groupId: tenant.groupId, companyId: tenant.companyId, fileName: `email-promotora-${env.uniqueSuffix()}.pdf`, mimeType: 'application/pdf', sizeBytes: 1024, storageKey: `test/${env.uniqueSuffix()}.pdf`, uploadedByUserId: tenant.userId }, { transaction: t });
      const ok = await reg({ status: 'UNDER_ANALYSIS', note: 'Promotora retornou por e-mail.', evidenceFileId: arquivo.id });
      assert.equal(ok.financingCase.status, 'UNDER_ANALYSIS');
      const [hist] = (await sequelize.query("SELECT * FROM correspondent.provider_status_history WHERE financing_case_id = :id AND source = 'manual' ORDER BY occurred_at DESC", { replacements: { id: caso.id }, transaction: t }))[0];
      assert.match(hist.note, new RegExp(arquivo.id), 'a evidência fica no histórico do status');
    });
  } finally { espiao.restaurar(); }
});
