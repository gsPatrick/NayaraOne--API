'use strict';

// Marco 9, M9-D238 — seguradoras: cotação, proposta, apólice e status pelo adapter (Dispatch Service) e pelo fluxo manual, com o mesmo modelo e os mesmos eventos; proposta que
// não repete depois de um timeout; webhook de status pela caixa de entrada. Banco descartável.
process.env.PORT = process.env.M9D238_FLUXO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d238Env');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const { reconcileDispatch } = require('../../../src/features/integrations/dispatch/reconcile');
const { IntegrationConnection } = require('../../../src/models');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const conexaoAtiva = async (providerCode) => env.comTenant(tenant, (t) => IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode, status: 'ACTIVE' }, order: [['created_at', 'DESC']], transaction: t }));

test('seguro_adapter_quote_propose_getpolicy_getstatus', async () => {
  await env.escolher(tenant, 'sandbox');
  const canal = await env.conectar(tenant, 'insurance-sandbox');
  const apolice = await env.criarApolice(tenant);
  const cotada = await env.cotar(tenant, apolice.id, { estimatedValue: 12000, insuredName: 'Fulano', insuredDocument: '52998224725' });
  assert.equal(cotada.status, 'QUOTED');
  assert.equal(Number(cotada.premiumAmount), 120, 'prêmio do sandbox: 1% do valor segurado');
  const [cotacao] = await env.envios(tenant, apolice.id, 'quote');
  assert.equal(cotacao.connection_id, canal.conn.id);
  assert.equal(cotacao.purpose, 'INSURANCE_QUOTE', 'a finalidade do mapper fica gravada no envio');
  assert.equal(cotacao.aggregate_type, 'InsurancePolicy');
  assert.match(cotacao.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(cotacao.payload_snapshot.policyRef, apolice.id);
  assert.equal(cotacao.payload_snapshot.insuredAmount, '12000', 'valor como texto decimal no conteúdo do envio');
  assert.equal(cotacao.status, 'CONFIRMED', 'consulta SAFE: a resposta confirma');
  const emitida = await env.emitir(tenant, apolice.id);
  assert.equal(emitida.status, 'ACTIVE');
  assert.equal(emitida.provider, 'sandbox');
  const [proposta] = await env.envios(tenant, apolice.id, 'propose');
  assert.equal(proposta.purpose, 'INSURANCE_PROPOSAL');
  assert.equal(proposta.idempotency_key, `insurance-policy:${apolice.id}`, 'a chave de idempotência do livro (uma emissão por apólice)');
  assert.equal(proposta.criticality_op, 'DANGEROUS');
  assert.equal(proposta.confirmation_mode, 'ON_STATUS');
  assert.equal(proposta.status, 'CONFIRMED', 'o status da apólice consultado pelo adapter confirma a proposta (a resposta de envio sozinha nunca confirma)');
  const adapter = adapterRegistry.instantiate('insurance-sandbox');
  const ctx = { tenant: env.ctxDe(tenant) };
  const conn = await conexaoAtiva('insurance-sandbox');
  const resolvido = await env.comTenant(tenant, (t) => adapterRegistry.resolve(conn, env.ctxDe(tenant), t));
  const porta = await env.comTenant(tenant, (t) => invoke(resolvido, 'getPolicy', { externalResourceId: proposta.external_resource_id }, { ...ctx, transaction: t }));
  assert.equal(porta.status, 'ACTIVE');
  const status = await env.comTenant(tenant, (t) => invoke(resolvido, 'getStatus', { externalResourceId: proposta.external_resource_id }, { ...ctx, transaction: t }));
  assert.equal(status.status, 'ACTIVE');
  assert.deepEqual([...adapter.capabilities()].sort(), ['getPolicy', 'getStatus', 'propose', 'quote', 'submitClaim', 'verifyWebhook']);
  const [submissao] = await env.sql(tenant, "SELECT * FROM procurement.insurance_provider_submissions WHERE policy_id = :id AND submission_type = 'ISSUE'", { id: apolice.id });
  assert.equal(submissao.source, 'API');
  assert.equal((await env.apolice(tenant, apolice.id)).issue_source, 'API');
});

test('seguro_workflow_manual_mesmo_modelo_e_eventos', async () => {
  // Caminho 1: API (sandbox).
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const viaApi = await env.criarApolice(tenant);
  await env.cotar(tenant, viaApi.id);
  await env.emitir(tenant, viaApi.id);
  // Caminho 2: fluxo manual (sem API).
  await env.escolher(tenant, 'manual');
  const manual = await env.criarApolice(tenant);
  const pendente = await env.cotar(tenant, manual.id, { estimatedValue: 12000 });
  assert.equal(pendente.status, 'DRAFT', 'sem API a cotação espera a pessoa');
  assert.equal(pendente.get('pendingTask').kind, 'QUOTE_DOCUMENT');
  const [tarefaCotacao] = await env.tarefas(tenant, manual.id);
  assert.equal(tarefaCotacao.status, 'OPEN');
  assert.ok(tarefaCotacao.due_at && tarefaCotacao.assigned_to_user_id, 'tarefa com responsável e prazo');
  await assert.rejects(env.comTenant(tenant, (t) => require('../../../src/features/procurement/insurance/insurance.tasks').completeTask(tarefaCotacao.id, {}, env.actorDe(tenant), t)), (e) => e.code === 'INTEGRATION_INSURANCE_TASK_INVALID');
  const tasks = require('../../../src/features/procurement/insurance/insurance.tasks');
  await env.comTenant(tenant, (t) => tasks.completeTask(tarefaCotacao.id, { premiumAmount: 120 }, env.actorDe(tenant), t));
  const cotada = await env.apolice(tenant, manual.id);
  assert.equal(cotada.status, 'QUOTED');
  assert.equal(Number(cotada.premium_amount), 120);
  await assert.rejects(env.comTenant(tenant, (t) => tasks.completeTask(tarefaCotacao.id, { premiumAmount: 120 }, env.actorDe(tenant), t)), (e) => e.code === 'INTEGRATION_INSURANCE_TASK_NOT_OPEN');
  // Emissão: número da proposta e depois a apólice anexada.
  const aguardando = await env.emitir(tenant, manual.id);
  assert.equal(aguardando.status, 'QUOTED');
  assert.equal(aguardando.get('pendingTask').kind, 'PROPOSAL_NUMBER');
  const [, tarefaProposta] = await env.tarefas(tenant, manual.id);
  const proposta = await env.comTenant(tenant, (t) => tasks.completeTask(tarefaProposta.id, { proposalNumber: 'PROP-2026-1' }, env.actorDe(tenant), t));
  assert.equal(proposta.status, 'DONE');
  const [, , tarefaApolice] = await env.tarefas(tenant, manual.id);
  assert.equal(tarefaApolice.kind, 'POLICY_DOCUMENT');
  await assert.rejects(env.comTenant(tenant, (t) => tasks.completeTask(tarefaApolice.id, { policyNumber: 'APL-MANUAL-1' }, env.actorDe(tenant), t)), (e) => e.code === 'INTEGRATION_INSURANCE_POLICY_DOCUMENT_REQUIRED');
  const arquivo = await env.criarArquivo(tenant);
  await env.comTenant(tenant, (t) => tasks.completeTask(tarefaApolice.id, { policyNumber: 'APL-MANUAL-1', fileId: arquivo.id }, env.actorDe(tenant), t));
  const emitida = await env.apolice(tenant, manual.id);
  assert.equal(emitida.status, 'ACTIVE');
  assert.equal(emitida.provider, 'manual');
  assert.equal(emitida.external_policy_number, 'APL-MANUAL-1');
  assert.equal(emitida.issue_source, 'MANUAL');
  const [v1] = await env.versoes(tenant, manual.id);
  assert.deepEqual([v1.version, v1.kind, v1.source, v1.file_id, v1.sha256], [1, 'INITIAL', 'MANUAL', arquivo.id, arquivo.checksumSha256]);
  // Mesmo modelo: parcelas, tarefa de renovação e os mesmos eventos internos, só a origem muda.
  assert.equal((await env.parcelas(tenant, manual.id)).length, (await env.parcelas(tenant, viaApi.id)).length, 'mesmas parcelas');
  assert.equal((await env.tarefaRenovacao(tenant, manual.id)).length, (await env.tarefaRenovacao(tenant, viaApi.id)).length, 'mesma tarefa de renovação');
  const tipos = async (id) => (await env.eventos(tenant, id)).map((e) => e.event_type).filter((t) => t.startsWith('insurance.')).sort();
  const tiposApi = await tipos(viaApi.id);
  const tiposManual = (await tipos(manual.id)).filter((t) => t !== 'insurance.policy.version_added');
  assert.deepEqual(tiposManual, tiposApi, 'os mesmos eventos internos que a API produziria');
  assert.deepEqual(tiposManual, ['insurance.policy.issued', 'insurance.quote.received']);
  assert.deepEqual((await tipos(manual.id)).filter((t) => t === 'insurance.policy.version_added'), ['insurance.policy.version_added'], 'o documento da apólice anexado também gera o evento da versão');
  assert.equal((await env.eventos(tenant, viaApi.id, 'insurance.policy.issued'))[0].payload_json.source, 'API');
  assert.equal((await env.eventos(tenant, manual.id, 'insurance.policy.issued'))[0].payload_json.source, 'MANUAL');
  assert.equal((await env.eventos(tenant, manual.id, 'insurance.quote.received'))[0].payload_json.source, 'MANUAL');
  const [envioProposta] = await env.envios(tenant, manual.id, 'propose');
  assert.equal(envioProposta.status, 'CONFIRMED', 'a apólice anexada é a evidência de status que confirma a proposta do envio');
  const [submissao] = await env.sql(tenant, "SELECT * FROM procurement.insurance_provider_submissions WHERE policy_id = :id AND submission_type = 'ISSUE'", { id: manual.id });
  assert.equal(submissao.source, 'MANUAL');
  await env.escolher(tenant, 'sandbox');
});

test('seguro_propose_nao_repete_apos_timeout', async () => {
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox', { config: { sandbox_fault: 'TIMEOUT_AFTER_SEND' } });
  env.resetSandbox();
  const apolice = await env.criarApolice(tenant);
  await env.cotar(tenant, apolice.id);
  const primeira = await env.emitir(tenant, apolice.id);
  assert.equal(primeira.get('providerResult').state, 'UNCERTAIN', 'resposta incerta: o pedido fica gravado, sem erro e sem emitir de novo');
  assert.equal(primeira.status, 'QUOTED', 'a apólice não vira emitida sem evidência');
  assert.equal(env.calls.propose, 1, 'a seguradora recebeu a proposta uma vez');
  const [incerto] = await env.envios(tenant, apolice.id, 'propose');
  assert.equal(incerto.status, 'UNKNOWN');
  // Repetir o pedido (mesma chave) devolve o mesmo envio: nenhuma chamada nova à seguradora.
  const repetida = await env.emitir(tenant, apolice.id);
  assert.equal(repetida.get('providerResult').dispatchId, incerto.id);
  assert.equal(env.calls.propose, 1, 'sem retry cego em propose');
  assert.equal((await env.envios(tenant, apolice.id, 'propose')).length, 1);
  // A reconciliação pela chave descobre que a seguradora tem a proposta: o envio é confirmado, sem reenviar.
  const r = await reconcileDispatch(env.ctxDe(tenant), incerto.id, { now: new Date(Date.now() + 3600000) });
  assert.equal(r.status, 'CONFIRMED');
  assert.equal(env.calls.propose, 1);
  const concluida = await env.emitir(tenant, apolice.id);
  assert.equal(concluida.status, 'ACTIVE', 'depois de reconciliada, a emissão aplica o resultado');
  assert.equal(concluida.externalPolicyNumber, null, 'sem a resposta original o número vem da consulta ao fornecedor');
  assert.equal(env.calls.propose, 1, 'a proposta nunca foi repetida');
});

test('seguro_webhook_pelo_framework', async () => {
  await env.escolher(tenant, 'sandbox');
  env.resetSandbox();
  const canal = await env.conectar(tenant, 'insurance-sandbox');
  const apolice = await env.criarApolice(tenant);
  await env.cotar(tenant, apolice.id);
  const emitida = await env.emitir(tenant, apolice.id);
  const [envio] = await env.envios(tenant, apolice.id, 'propose');
  const externo = envio.external_resource_id;
  // Evento sem assinatura válida: 401, nada muda.
  const ev = env.eventoStatus(externo, 'ACTIVE');
  const falso = await env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, Buffer.from(JSON.stringify(ev)), { 'x-webhook-signature': '0'.repeat(64) });
  assert.equal(falso.status, 401);
  // A apólice emitida mas ainda não vigente (ISSUED) vira ACTIVE pelo evento assinado.
  await env.sql(tenant, "UPDATE procurement.insurance_policies SET status = 'ISSUED' WHERE id = :id", { id: apolice.id });
  const ok = await env.enviarStatus(canal, ev);
  assert.equal(ok.json.status, 'accepted');
  await env.rodar(tenant);
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'ACTIVE');
  // Status mais antigo que o aplicado não regride a apólice.
  await env.enviarStatus(canal, env.eventoStatus(externo, 'ISSUED'));
  await env.rodar(tenant);
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'ACTIVE');
  // Apólice desconhecida: erro de integração, sem efeito.
  await env.enviarStatus(canal, env.eventoStatus('sbx-desconhecida', 'ACTIVE'));
  await env.rodar(tenant);
  assert.ok((await env.erros(tenant, canal.provider, 'INTEGRATION_INSURANCE_POLICY_UNKNOWN')).length >= 1);
  assert.equal(emitida.status, 'ACTIVE');
});
