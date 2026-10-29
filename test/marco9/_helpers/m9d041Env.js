'use strict';

// Apoio dos testes da NAY Atendimento (M9-D041): a empresa com o agente cadastrado e ativo (sandbox), a identidade de serviço do canal,
// o orçamento, um contato do CRM e o responsável pelo encaminhamento. Banco descartável, role nayara_runtime, rollback.
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const agents = require('../../../src/features/ai/agents');
const identities = require('../../../src/features/ai/serviceIdentities');
const nay = require('../../../src/features/ai/agents/nay_atendimento');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { carregarPessoas, ctxDe, q, run, uid } = require('../../helpers/aiAgents');
const { criarOportunidade } = require('./aiToolsEnv');
const { criarOrcamento, AGORA } = require('./iaOrcamento');
const knowledge = require('../../../src/features/ai/knowledge');
const rag = require('../../../src/features/ai/retrieval');

const FIXO = () => AGORA.getTime();
const PERMISSOES_CANAL = ['ai:read', 'crm:opportunities:read', 'properties:read'];

/** Papel `atendimento` (nome do papel do parâmetro) com um membro ativo da empresa; devolve o id do responsável. */
async function criarResponsavel(tenant, tx, papel = 'atendimento') {
  const [membro] = await q("SELECT user_id, id FROM core.user_memberships WHERE company_id = :c AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY created_at LIMIT 1", { c: tenant.companyId }, tx);
  const roleId = uid();
  await run('INSERT INTO core.roles (id, group_id, company_id, name) VALUES (:id, :g, :c, :name)', { id: roleId, g: tenant.groupId, c: tenant.companyId, name: papel }, tx);
  await run('UPDATE core.user_memberships SET role_id = :r WHERE id = :m', { r: roleId, m: membro.id }, tx);
  return membro.user_id;
}

/**
 * Cenário padrão: agente provisionado, homologado e ativo (a avaliação verde obrigatória fica desligada, exceto nos testes que a provam),
 * identidade de serviço com `permissoes`, orçamento do agente e um contato do CRM. `deps` substitui dependências do orquestrador.
 */
async function cenario(tenant, tx, { permissoes = PERMISSOES_CANAL, ativar = true, identidade = true, orcamento = true, deps = {}, responsavel = true } = {}) {
  registerAiAdapters();
  await carregarPessoas();
  const registry = await buildDefaultRegistry();
  const ctx = ctxDe(tenant);
  await upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, ctx, ctx.userId, tx);
  const agente = await nay.provisionNayAtendimento(ctx, tx);
  if (ativar) {
    await agents.homologate(ctxDe(tenant), nay.AGENT_CODE, agente.version, {}, tx);
    await agents.activate(ctxDe(tenant), nay.AGENT_CODE, agente.version, tx);
  }
  const admin = { ...ctxDe(tenant), permissions: ['ai:admin'] };
  if (identidade) await identities.createServiceIdentity(admin, { agentCode: nay.AGENT_CODE, permissions: permissoes }, tx);
  if (orcamento) await criarOrcamento({ groupId: tenant.groupId, companyId: tenant.companyId, userId: ctx.userId }, tx, { agentCode: nay.AGENT_CODE, limit: '500.00' });
  const { pessoa } = await criarOportunidade(tenant, tx);
  const responsavelId = responsavel ? await criarResponsavel(tenant, tx) : null;
  return { tenant, tx, registry, agente, ctx, admin, contato: pessoa.id, responsavelId, deps: { toolRegistry: registry, clock: FIXO, ...deps } };
}

/** Política homologada (conhecimento do M9-D008) já indexada no RAG: é a fonte que o atendimento cita. `value.regra` é o texto. */
async function politicaHomologada(c, regra, { classification = 'INTERNAL', title = 'Política de atendimento' } = {}) {
  const autor = { ...ctxDe(c.tenant), permissions: ['ai:admin'] };
  const homologador = { ...ctxDe(c.tenant), permissions: ['ai:admin'] };
  const entrada = await knowledge.createEntry(autor, { factKey: `politica.${uid().slice(0, 8)}`, subjectType: 'politica', title, value: { regra }, classification }, c.tx);
  await knowledge.homologate(homologador, entrada.id, c.tx);
  await rag.processPending({ ...ctxDe(c.tenant), permissions: ['ai:use'] }, c.tx, { limit: 500 });
  return entrada;
}

/** Uma mensagem do cliente pelo canal (a fixture do sandbox, `[[RESPOSTA:...]]`, vai dentro do texto). */
const conversar = (c, message, over = {}) => nay.atendimentoChat({
  groupId: c.tenant.groupId, companyId: c.tenant.companyId, message, externalContactId: c.contato, ...over,
}, c.tx, c.deps);

const chamadas = (runId, tx) => q('SELECT * FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const lerRun = async (id, tx) => (await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const handoffs = (tx) => q("SELECT * FROM ai.ai_recommendations WHERE agent_code = 'NAY_ATENDIMENTO' AND recommendation_type = 'HANDOFF' ORDER BY created_at", {}, tx);

module.exports = { cenario, politicaHomologada, conversar, criarResponsavel, chamadas, lerRun, handoffs, PERMISSOES_CANAL, FIXO, q, run, uid };
