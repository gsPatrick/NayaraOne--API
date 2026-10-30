'use strict';

// Marco 9, M9-D238 + M9-D220 — a apólice e o sinistro reagem só a evento interno do envio (idempotente e auditado): a recusa da seguradora avisa a pessoa sem mudar o estado, a ordem sem
// resposta conclusiva vai à revisão humana, a apólice vigente confirmada passa a ACTIVE, o pedido nasce na transação de Compras e proposta não tem compensação automática. Banco descartável.
process.env.PORT = process.env.M9D238_REACAO_PORT || '24239';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d238Env');
const reacao = require('../_helpers/reacaoD220');
const auxiliar = () => ({ tenant, comTenant: env.comTenant, ler: (consulta, r) => env.sql(tenant, consulta, { c: tenant.companyId, ...r }) });
const { IntegrationDispatch } = require('../../../src/models');
const { publishDispatchEvent, EVENTS } = require('../../../src/features/integrations/dispatch/dispatch.events');
const { compensateDispatch } = require('../../../src/features/integrations/domain');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  env.resetSandbox();
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const avisos = () => env.sql(tenant, "SELECT title, body FROM core.notifications WHERE company_id = :c AND user_id = :u AND title IN ('A seguradora não executou o pedido', 'Conferir com a seguradora') ORDER BY created_at", { c: tenant.companyId, u: tenant.userId });
const emitirComFalha = async (fault) => {
  await env.escolher(tenant, 'sandbox');
  const canal = await env.conectar(tenant, 'insurance-sandbox');
  const apolice = await env.criarApolice(tenant);
  await env.cotar(tenant, apolice.id);
  await env.sql(tenant, 'UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { id: canal.conn.id, cfg: JSON.stringify({ sandbox_fault: fault }) }); // a falha vale só para a proposta
  const resultado = await env.emitir(tenant, apolice.id).catch((e) => e);
  const [envio] = await env.envios(tenant, apolice.id, 'propose');
  return { apolice, envio, resultado };
};

test('seguro_d220_proposta_recusada_depois_avisa_sem_mudar_a_apolice_e_uma_vez', async () => {
  // A proposta ficou incerta (202, sem erro ao usuário); a reconciliação descobre depois que a seguradora a RECUSOU: o motor dá o envio por falho e publica o evento.
  const { apolice, envio, resultado } = await emitirComFalha('TIMEOUT_AFTER_SEND');
  assert.ok(resultado && !(resultado instanceof Error));
  assert.equal(envio.status, 'UNKNOWN');
  const linha = await env.comTenant(tenant, (t) => IntegrationDispatch.findByPk(envio.id, { transaction: t }));
  await env.comTenant(tenant, (t) => publishDispatchEvent(env.ctxDe(tenant), linha, EVENTS.FAILED, { errorClass: 'VALIDATION', errorCode: 'EXTERNAL_DENIED', status: 'FAILED' }, t));
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'QUOTED', 'a apólice não é emitida por uma proposta recusada');
  const antes = (await avisos()).length;
  await reacao.consumirDuasVezes(auxiliar(), 'integration.dispatch.failed', envio.id);
  const depois = await avisos();
  assert.equal(depois.length, antes + 1, 'duas entregas do evento, um aviso');
  assert.match(depois[depois.length - 1].body, /Nada foi emitido nem protocolado/);
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'QUOTED');
  assert.equal(await reacao.reacoesAuditadas(auxiliar(), 'procurement.insurance.dispatch_failed', apolice.id), 1);
});

test('seguro_d220_recusa_sincrona_nao_deixa_envio_nem_muda_a_apolice', async () => {
  // Credencial recusada (401) com o usuário esperando: o erro volta ao usuário e nada fica gravado (o pedido refeito usa outra tentativa).
  const { apolice, envio, resultado } = await emitirComFalha('HTTP_401');
  assert.ok(resultado instanceof Error && resultado.code === 'PROCUREMENT_INSURANCE_PROVIDER_ERROR');
  assert.equal(envio, undefined, 'a transação do domínio voltou junto com o pedido');
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'QUOTED');
});

test('seguro_d220_sem_resposta_nao_altera_a_apolice_e_a_revisao_humana_so_avisa', async () => {
  const { apolice, envio, resultado } = await emitirComFalha('TIMEOUT_AFTER_SEND');
  assert.ok(resultado && !(resultado instanceof Error), 'o usuário recebe o aceite (202), não erro');
  assert.equal(envio.status, 'UNKNOWN');
  assert.equal(await reacao.eventoDoEnvio(auxiliar(), 'integration.dispatch.failed', envio.id), null, 'sem resposta da seguradora não há evento de falha');
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'QUOTED');
  // A reconciliação esgota as consultas sem resposta conclusiva: revisão humana, sem mudar a apólice.
  const linha = await env.comTenant(tenant, (t) => IntegrationDispatch.findByPk(envio.id, { transaction: t }));
  await env.comTenant(tenant, (t) => publishDispatchEvent(env.ctxDe(tenant), linha, EVENTS.NEEDS_MANUAL_REVIEW, { reason: 'UNRESOLVED' }, t));
  const antes = (await avisos()).length;
  await reacao.consumirDuasVezes(auxiliar(), 'integration.dispatch.needs_manual_review', envio.id);
  const depois = await avisos();
  assert.equal(depois.length, antes + 1);
  assert.match(depois[depois.length - 1].body, /confira com ela antes de repetir/);
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'QUOTED');
  assert.equal(await reacao.reacoesAuditadas(auxiliar(), 'procurement.insurance.dispatch_needs_review', apolice.id), 1);
});

test('seguro_d220_apolice_vigente_confirmada_vai_a_active_so_pelo_evento', async () => {
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const apolice = await env.criarApolice(tenant);
  await env.cotar(tenant, apolice.id);
  await env.emitir(tenant, apolice.id);
  const [envio] = await env.envios(tenant, apolice.id, 'propose');
  assert.equal(envio.status, 'CONFIRMED', 'o sandbox informa a apólice vigente na consulta de status');
  assert.equal(String(envio.external_status).toUpperCase(), 'ACTIVE');
  // A seguradora respondeu a emissão como ISSUED (como a Porto Seguro) e só a consulta de status informou ACTIVE: a apólice espera o evento.
  await env.sql(tenant, "UPDATE procurement.insurance_policies SET status = 'ISSUED' WHERE id = :id", { id: apolice.id });
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'ISSUED', 'confirmar o envio não muda a apólice antes do evento ser consumido');
  await reacao.consumirDuasVezes(auxiliar(), 'integration.dispatch.confirmed', envio.id);
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'ACTIVE');
  assert.equal(await reacao.reacoesAuditadas(auxiliar(), 'procurement.insurance.dispatch_confirmed', apolice.id), 1);
});

test('seguro_d220_pedido_nasce_na_transacao_do_dominio', async () => {
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const apolice = await env.criarApolice(tenant);
  await assert.rejects(env.comTenant(tenant, async (t) => {
    await env.insuranceService.quotePolicy(apolice.id, { estimatedValue: 9000 }, env.actorDe(tenant), t);
    throw new Error('QA-M9 rollback de Compras');
  }), /rollback de Compras/);
  assert.equal((await env.envios(tenant, apolice.id, 'quote')).length, 0, 'sem commit do domínio não há pedido à seguradora');
  assert.equal((await env.apolice(tenant, apolice.id)).status, 'DRAFT');
});

test('seguro_d220_proposta_e_sinistro_nao_tem_compensacao_automatica', async () => {
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const apolice = await env.criarApolice(tenant);
  await env.cotar(tenant, apolice.id);
  await env.emitir(tenant, apolice.id);
  const [original] = await env.envios(tenant, apolice.id, 'propose');
  await assert.rejects(env.comTenant(tenant, (t) => compensateDispatch(env.ctxDe(tenant), original.id, { userId: tenant.userId, transaction: t })), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_COMPENSATION_UNSUPPORTED');
  const todos = await env.envios(tenant, apolice.id);
  assert.deepEqual(todos.map((e) => e.operation), ['quote', 'propose'], 'nenhum envio compensatório: apólice emitida se desfaz por cancelamento com a seguradora, decisão de uma pessoa');
  assert.equal(todos[1].status, original.status);
});

test('seguro_d220_modulo_nao_chama_a_seguradora_direto', () => {
  const dir = path.join(__dirname, '../../../src/features/procurement/insurance');
  const fontes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')]);
  for (const [f, texto] of fontes) assert.equal(/\.issuePolicy\(|\.submitClaim\(|procurement\/adapters\/InsuranceAdapter/.test(texto), false, `${f} chama a seguradora por fora do Dispatch Service`);
  assert.ok(fontes.some(([, t]) => /registerDomainReaction/.test(t)));
});
