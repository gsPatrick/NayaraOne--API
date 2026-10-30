'use strict';

const { Notification } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const ports = require('../runner.ports');
const receipt = require('./receipt');
const { fillMarkers, variablesFor } = require('./fill');

/** NOTIFY_USER -> notificação interna ao usuário da ação (padrão: o dono da automação). Sem canal externo e sem consentimento. */
async function notifyUser(ctx) {
  const { def, tenant, transaction } = ctx;
  const rawTitle = typeof def.title === 'string' ? def.title.trim() : '';
  // `assignee` (resolvedor nomeado, ex.: o corretor do radar) e `variablesProvider` (nome e imóvel no texto): marcador sem valor sai em branco (M9-D421)
  const userId = def.userId || (def.assignee ? await ports.assigneeOf(def.assignee, { tenant, transaction, subject: ctx.subject, event: ctx.event }) : null) || ctx.flow.ownerUserId;
  if (!rawTitle || !userId) throw AppError.badRequest('Informe o título e o usuário da notificação.', 'MKT_ACTION_INVALID');
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  const vars = await variablesFor(ctx);
  const clean = (text) => fillMarkers(text, vars).text.replace(/\{[a-z_][a-z0-9_]*\}/gi, '').replace(/\s+/g, ' ').trim();
  const title = clean(rawTitle);
  const row = await Notification.create({
    groupId: tenant.groupId, companyId: tenant.companyId, userId, channel: 'IN_APP', title: title.slice(0, 255), body: def.body ? clean(String(def.body)) : null,
    createdBy: ctx.flow.ownerUserId || null, updatedBy: ctx.flow.ownerUserId || null,
  }, { transaction });
  await receipt.setDestination(ctx, row.id);
  return { status: 'OK', providerRef: row.id };
}

module.exports = { notifyUser };
