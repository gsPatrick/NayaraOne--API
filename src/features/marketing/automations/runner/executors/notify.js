'use strict';

const { Notification } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const receipt = require('./receipt');

/** NOTIFY_USER -> notificação interna ao usuário da ação (padrão: o dono da automação). Sem canal externo e sem consentimento. */
async function notifyUser(ctx) {
  const { def, tenant, transaction } = ctx;
  const title = typeof def.title === 'string' ? def.title.trim() : '';
  const userId = def.userId || ctx.flow.ownerUserId;
  if (!title || !userId) throw AppError.badRequest('Informe o título e o usuário da notificação.', 'MKT_ACTION_INVALID');
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  const row = await Notification.create({
    groupId: tenant.groupId, companyId: tenant.companyId, userId, channel: 'IN_APP', title: title.slice(0, 255), body: def.body ? String(def.body) : null,
    createdBy: ctx.flow.ownerUserId || null, updatedBy: ctx.flow.ownerUserId || null,
  }, { transaction });
  await receipt.setDestination(ctx, row.id);
  return { status: 'OK', providerRef: row.id };
}

module.exports = { notifyUser };
