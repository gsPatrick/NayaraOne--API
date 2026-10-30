'use strict';

// Apoio dos testes de agendamento e aprovação do Marketing (M9-D408/M9-D410): tenant, revisor e item aprovado (não é teste). Banco descartável sempre.
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const fx = require('../../helpers/m9d406Fixtures');
const service = require('../../../src/features/marketing/content/content.service');
const nay = require('../../../src/features/marketing/content/pipeline.nayPort');
const factual = require('../../../src/features/marketing/content/pipeline.factualPort');

/** Tenant A e um segundo usuário real da empresa (quem aprova não é quem gerou). */
async function setup() {
  const { tenantA: tenant } = await prepararTenants();
  let reviewer = null;
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rows = await fx.q(t, 'SELECT id FROM core.users WHERE id <> :me AND deleted_at IS NULL ORDER BY id LIMIT 1', { me: tenant.userId });
    reviewer = rows[0] && rows[0].id;
  });
  if (!reviewer) throw new Error('o seed precisa ter um segundo usuário');
  return { tenant, reviewer };
}

const reset = () => { nay.clearNayDraftProvider(); factual.resetFactualValidator(); };

/** Conteúdo NEW_PROPERTY percorrido até PENDING_APPROVAL (NAY sandbox, com fotos e template). `channels`: canais pretendidos gravados no conteúdo. */
async function pendingItem(t, env, { channels, type = 'NEW_PROPERTY', textFor } = {}) {
  const prop = await fx.seedProperty(t, env.tenant);
  const tpl = await fx.publishedTemplate(t, env.tenant);
  fx.registerSandboxNay(textFor);
  const out = await service.createAndRun({ tenant: env.tenant, actor: env.tenant.userId, input: { type, sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id, ...(channels ? { channels } : {}) } }, fx.sameTx(t));
  return { itemId: out.content.id, status: out.content.status, propertyId: prop.id, templateId: tpl.id, versionId: out.content.currentVersion.id };
}

/** Institucional escrito à mão até PENDING_APPROVAL: sem imóvel nem template, para os testes que fazem COMMIT real e limpam depois. */
async function pendingInstitutional(t, env, title = 'QA-M9 institucional') {
  const out = await service.createAndRun({ tenant: env.tenant, actor: env.tenant.userId, input: { type: 'INSTITUTIONAL', title, texto: 'Somos uma imobiliária de Salvador.' } }, fx.sameTx(t));
  return { itemId: out.content.id, status: out.content.status, versionId: out.content.currentVersion.id };
}

/** Conteúdo aprovado por outra pessoa (status APPROVED). */
async function approvedItem(t, env, opts) {
  const item = await pendingItem(t, env, opts);
  const approved = await service.approve({ tenant: env.tenant, actor: env.reviewer, itemId: item.itemId, input: {} }, t);
  return { ...item, status: approved.status };
}

const schedule = (t, env, itemId, body, now) => service.schedule({ tenant: env.tenant, actor: env.reviewer, itemId, now, ...body }, t);
const inMinutes = (m, from = new Date()) => new Date(from.getTime() + m * 60000);
const rejectsCode = (promise, status, code) => require('node:assert/strict').rejects(promise, (e) => e.statusCode === status && e.code === code, `esperava ${status} ${code}`);

module.exports = { setup, reset, pendingItem, pendingInstitutional, approvedItem, schedule, inMinutes, rejectsCode, fx, service, withRollbackTenantTransaction };
