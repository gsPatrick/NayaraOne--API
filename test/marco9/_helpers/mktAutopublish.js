'use strict';

// Apoio dos testes de aprovação e autopublicação (M9-D408): classes autorizadas, conteúdo SOLD_RENTED da NAY e leitura do evento. Não é teste.
const tipos = require('./mktTipos');
const base = require('./mktAgenda');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const nay = require('../../../src/features/marketing/content/pipeline.nayPort');

const KEY = 'marketing.autopublish.classes';
const SOLD_CLASS = Object.freeze({ tipo: 'SOLD_RENTED', canal: 'SITE' });
const { fx, service } = base;

/** Grava a lista de classes autorizadas (parâmetro da empresa) como a tela de Parâmetros faria. */
const setClasses = (t, tenant, classes) => upsertSetting(KEY, JSON.stringify(classes), tenant, tenant.userId, t);

/** Registra a NAY sandbox com texto aprovado pelo validador factual e devolve a lista de chamadas. */
function registerNay(text = 'Imóvel vendido no Jardim Europa.') {
  const calls = [];
  nay.registerNayDraftProvider(async (request) => { calls.push(request); return { text, nayRunId: fx.uid(), modelName: 'sandbox-m9d408' }; });
  return calls;
}

/**
 * Cria um SOLD_RENTED (imóvel vendido) e percorre o pipeline. `human: true` escreve o texto à mão (sem NAY); `channels` são os canais pretendidos.
 * Devolve { itemId, versionId, status } depois de runPipeline (PENDING_APPROVAL, ou APPROVED/SCHEDULED quando a classe autoriza).
 */
async function soldContent(t, env, { channels = ['SITE'], human = false, withTemplate = true, now, variables } = {}) {
  const prop = await tipos.activeProperty(t, env.tenant);
  await tipos.setAvailability(t, prop.propertyId, 'SOLD');
  const tpl = withTemplate ? await fx.publishedTemplate(t, env.tenant, { channel: 'SITE', body: 'Vendido em {{bairro}}: {{texto}}', variables: [{ name: 'bairro', type: 'text' }, { name: 'texto', type: 'text' }] }) : null;
  const input = { type: 'SOLD_RENTED', sourceEntityType: 'property', sourceEntityId: prop.propertyId, channels, ...(tpl ? { templateId: tpl.id } : {}), ...(human ? { texto: 'Imóvel vendido no Jardim Europa.' } : {}), ...(variables ? { variables } : {}) };
  const out = await service.createAndRun({ tenant: env.tenant, actor: env.tenant.userId, input, now }, fx.sameTx(t));
  return { itemId: out.content.id, status: out.content.status, templateId: tpl && tpl.id, propertyId: prop.propertyId, content: out.content };
}

/** NEW_PROPERTY da NAY (imóvel publicado, que o portão das redes sociais aceita) com template padrão de teste. */
async function newPropertyContent(t, env, { channels = ['LINKEDIN'] } = {}) {
  const prop = await fx.seedProperty(t, env.tenant);
  const tpl = await fx.publishedTemplate(t, env.tenant);
  fx.registerSandboxNay();
  const out = await service.createAndRun({ tenant: env.tenant, actor: env.tenant.userId, input: { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id, channels } }, fx.sameTx(t));
  return { itemId: out.content.id, status: out.content.status };
}

const eventsOf = (t, itemId, type = 'marketing.content.approved') => fx.q(t, 'SELECT payload_json FROM integration.outbox_events WHERE aggregate_id = :i AND event_type = :ty ORDER BY occurred_at', { i: itemId, ty: type });
const jobsOf = (t, itemId) => fx.q(t, 'SELECT j.* FROM marketing.publication_jobs j JOIN marketing.content_versions v ON v.id = j.content_version_id WHERE v.content_item_id = :i ORDER BY j.channel', { i: itemId });
const itemOf = async (t, itemId) => (await fx.q(t, 'SELECT i.status, i.autopublish_class, v.approved_by, v.approved_hash, v.model_name FROM marketing.content_items i JOIN marketing.content_versions v ON v.id = i.current_version_id WHERE i.id = :i', { i: itemId }))[0];

module.exports = { ...base, KEY, SOLD_CLASS, setClasses, registerNay, soldContent, newPropertyContent, eventsOf, jobsOf, itemOf, tipos };
