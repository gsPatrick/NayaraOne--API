'use strict';

// Apoio dos testes da NAY Comercial (M9-D034): o agente NAY_COMERCIAL da empresa copiado do padrão do sistema (migration 728) e ativado
// pelo serviço da D004, orçamento do mês do relógio do teste, oportunidade com mensagens, propostas e radar, e o pedido pelo serviço de
// execução da D030 com o provider sandbox. nayara_runtime (RLS real), transação com rollback. O relógio do run anda `dias` à frente do
// registro (que nasce com a hora real do banco), assim "9 dias sem contato" é exato sem mexer em created_at.

const { upsertSetting } = require('../../../src/features/settings/settings.service');
const agents = require('../../../src/features/ai/agents');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { executeRequest } = require('../../../src/features/ai/runApi');
const messagesService = require('../../../src/features/crm/messages.service');
const proposalsService = require('../../../src/features/crm/proposals.service');
const { Property } = require('../../../src/models');
const propertiesService = require('../../../src/features/properties/properties.service');
const offersService = require('../../../src/features/properties/propertyOffers.service');
const radarService = require('../../../src/features/radar/radar.service');
const { carregarPessoas, ctxDe, q, uid } = require('../../helpers/aiAgents');
const { criarOportunidade } = require('./aiToolsEnv');
const { criarOrcamento } = require('./iaOrcamento');

const CODE = 'NAY_COMERCIAL';
const DIA = 86400000;
const PERMS_CORRETOR = ['ai:use', 'ai:read', 'crm:opportunities:read', 'people:read', 'radar:read', 'properties:read'];
const SUBJECT = (id) => ({ entityType: 'crmOpportunity', entityId: id });

/** Agente da empresa (cópia do padrão do sistema), ativo, com orçamento; oportunidade criada. `dias`: quanto o relógio do run anda. */
async function cenario(tenant, tx, { perms = PERMS_CORRETOR, dias = 0, deps = {}, limite = '500.00' } = {}) {
  registerAiAdapters();
  await carregarPessoas();
  const registry = await buildDefaultRegistry();
  const dono = ctxDe(tenant);
  await upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, dono, dono.userId, tx);
  const versao = await agents.createVersion(dono, CODE, { limits: { max_tool_calls_por_run: 4, max_runs_por_minuto_usuario: 200 } }, tx);
  await agents.homologate(ctxDe(tenant), CODE, versao.version, {}, tx);
  await agents.activate(dono, CODE, versao.version, tx);
  const clock = () => Date.now() + dias * DIA;
  await criarOrcamento({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, tx, { agentCode: CODE, limit: limite, at: new Date(clock()) });
  const { opp, pessoa } = await criarOportunidade(tenant, tx);
  const auth = { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms, roles: ['TESTE'] };
  const c = { tenant, tx, registry, versao, opp, pessoa, auth, ctx: dono, clock, deps: { toolRegistry: registry, clock, ...deps } };
  c.pedir = (taskType, input, over = {}) => executeRequest({
    kind: 'RUN', body: { agentCode: CODE, purpose: 'Apoio comercial', input, taskType, context: SUBJECT(over.oppId || opp.id), ...(over.body || {}) },
  }, over.auth || auth, tx, { ...c.deps, ...(over.deps || {}) });
  return c;
}

const mensagem = (c, direction = 'OUTBOUND') => messagesService.createMessage({
  groupId: c.tenant.groupId, companyId: c.tenant.companyId, personId: c.pessoa.id, opportunityId: c.opp.id, direction, authorType: direction === 'INBOUND' ? 'CLIENT' : 'EMPLOYEE',
  channel: 'WHATSAPP', body: 'Mensagem de teste.', ...(direction === 'OUTBOUND' ? { purpose: 'TRANSACTIONAL' } : {}), // M3-18: saída declara a finalidade
}, c.tenant.userId, c.tx);

/** Proposta enviada (SENT, com sentAt de agora). */
async function propostaEnviada(c, value = 450000) {
  // M3-13: proposta é sempre de um imóvel (o de interesse da oportunidade ou um imóvel de teste).
  const propertyId = c.opp.propertyId || (await Property.create({ groupId: c.tenant.groupId, companyId: c.tenant.companyId, title: `Imóvel proposta ${Date.now()}`, internalCode: `IA-PROP-${Date.now()}${Math.floor(Math.random() * 1e5)}`, propertyType: 'RESIDENTIAL', createdBy: c.tenant.userId, updatedBy: c.tenant.userId }, { transaction: c.tx })).id;
  const base = { groupId: c.tenant.groupId, companyId: c.tenant.companyId, opportunityId: c.opp.id, propertyId, value };
  const p = await proposalsService.createProposal(base, c.tenant.userId, c.tx);
  await proposalsService.updateProposalStatus(p.id, { status: 'SENT' }, c.tenant.userId, c.tx);
  return p;
}

/** `n` imóveis à venda na cidade e um radar da oportunidade que combina com todos. */
async function radarComImoveis(c, n, cidade = `Cidade ${uid().slice(0, 6)}`) {
  const t = c.tenant;
  for (let i = 0; i < n; i += 1) {
    const p = await propertiesService.createProperty({ groupId: t.groupId, companyId: t.companyId, title: `Imóvel radar ${i + 1}`, internalCode: `RAD-${uid().slice(0, 8)}`, propertyType: 'RESIDENTIAL', city: cidade, areaTotalM2: 90 }, t.userId, c.tx);
    await offersService.createOffer(p.id, { offerType: 'SALE', askingPrice: 400000 + i }, t.userId, c.tx);
  }
  const { radar } = await radarService.createRadar({ groupId: t.groupId, companyId: t.companyId, personId: c.pessoa.id, opportunityId: c.opp.id, criteriaJson: { city: cidade, propertyType: 'RESIDENTIAL', offerType: 'SALE' } }, t.userId, c.tx);
  return radar;
}

const contar = async (sql, params, tx) => (await q(sql, params, tx))[0].n;
const tarefasDe = (c) => contar("SELECT count(*)::int AS n FROM core.tasks WHERE related_entity_id = :id", { id: c.opp.id }, c.tx);
const mensagensDe = (c) => contar('SELECT count(*)::int AS n FROM crm.messages WHERE opportunity_id = :id', { id: c.opp.id }, c.tx);
const chamadasDe = (runId, tx) => q('SELECT tool_name, status FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);

module.exports = { CODE, DIA, PERMS_CORRETOR, SUBJECT, cenario, mensagem, propostaEnviada, radarComImoveis, tarefasDe, mensagensDe, chamadasDe, contar };
