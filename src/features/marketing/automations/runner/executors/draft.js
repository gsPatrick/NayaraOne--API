'use strict';

const AppError = require('../../../../../utils/AppError');
const ports = require('../runner.ports');
const receipt = require('./receipt');

/** CREATE_CONTENT_DRAFT -> createContent (M9-D406) em RASCUNHO; a action_key é o triggerEventId do conteúdo e o recibo impede o segundo rascunho. */
async function createContentDraft(ctx) {
  const { def, tenant, transaction } = ctx;
  if (!def.type) throw AppError.badRequest('Informe o tipo do conteúdo do rascunho.', 'MKT_ACTION_INVALID');
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  const out = await ports.createDraft({
    tenant, actor: ctx.flow.ownerUserId || null,
    input: { type: def.type, title: def.title, texto: def.texto, sourceEntityType: def.sourceEntityType, sourceEntityId: def.sourceEntityId, channels: def.channels, triggerEventId: ctx.entry.action_key },
  }, transaction);
  await receipt.setDestination(ctx, out.itemId);
  return { status: 'OK', providerRef: out.itemId };
}

module.exports = { createContentDraft };
