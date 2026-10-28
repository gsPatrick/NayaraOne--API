'use strict';

const stepsRepo = require('./steps.repository');
const { STEP_CONTENT_STATUSES } = require('./campaigns.constants');
const { stepInvalid, validation } = require('./campaigns.errors');

const unique = (list) => [...new Set(list)];

/** Rascunho: o template e o conteúdo de cada step existem nesta empresa e o canal do step está entre os canais da campanha. */
async function assertStepsReferences(steps, channels, tenant, transaction) {
  if (steps.length === 0) return;
  const outside = steps.filter((s) => !channels.includes(s.channel));
  if (outside.length > 0) {
    throw validation(`O canal do step ${outside[0].stepNo} não está entre os canais da campanha.`, { field: 'steps', stepNo: outside[0].stepNo });
  }
  const templates = await stepsRepo.templatesByIds(unique(steps.map((s) => s.templateId)), tenant, transaction);
  for (const s of steps) {
    if (!templates.some((t) => t.id === s.templateId)) throw stepInvalid(`O template do step ${s.stepNo} não foi encontrado.`, { stepNo: s.stepNo });
  }
  const itemIds = unique(steps.map((s) => s.contentItemId).filter(Boolean));
  if (itemIds.length > 0) {
    const items = await stepsRepo.contentItemsByIds(itemIds, tenant, transaction);
    for (const s of steps.filter((x) => x.contentItemId)) {
      if (!items.some((i) => i.id === s.contentItemId)) throw stepInvalid(`O conteúdo do step ${s.stepNo} não foi encontrado.`, { stepNo: s.stepNo });
    }
  }
}

/** Ao agendar: cada step usa template PUBLISHED (do canal do step) e, se tiver conteúdo, conteúdo aprovado. */
async function assertStepsApproved(steps, tenant, transaction) {
  const templates = await stepsRepo.templatesByIds(unique(steps.map((s) => s.template_id)), tenant, transaction);
  const itemIds = unique(steps.map((s) => s.content_item_id).filter(Boolean));
  const items = itemIds.length > 0 ? await stepsRepo.contentItemsByIds(itemIds, tenant, transaction) : [];
  for (const s of steps) {
    const template = templates.find((t) => t.id === s.template_id);
    if (!template || template.status !== 'PUBLISHED') {
      throw stepInvalid(`O template do step ${s.step_no} precisa estar publicado.`, { stepNo: s.step_no, reason: 'TEMPLATE_NOT_PUBLISHED' });
    }
    if (template.channel && template.channel !== s.channel) {
      throw stepInvalid(`O template do step ${s.step_no} é de outro canal.`, { stepNo: s.step_no, reason: 'TEMPLATE_CHANNEL_MISMATCH' });
    }
    if (s.content_item_id) {
      const item = items.find((i) => i.id === s.content_item_id);
      if (!item || !STEP_CONTENT_STATUSES.includes(item.status)) {
        throw stepInvalid(`O conteúdo do step ${s.step_no} precisa estar aprovado.`, { stepNo: s.step_no, reason: 'CONTENT_NOT_APPROVED' });
      }
    }
  }
}

module.exports = { assertStepsReferences, assertStepsApproved };
