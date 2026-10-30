'use strict';

const ports = require('../runner.ports');

/** SEND_MESSAGE -> adapter de canal (M9-D429) pelo sendMarketingMessage, com a action_key como chave de idempotência (coluna action_key da mensagem). O canSend já foi decidido pelo runner. */
async function sendMessage(ctx) {
  const { def, entry, subject } = ctx;
  if (!subject || subject.type !== 'PERSON') return { status: 'SKIPPED', errorCode: 'NO_ADDRESS' };
  const res = await ports.sendMessage({
    tenant: ctx.tenant, transaction: ctx.transaction, now: ctx.now, mode: ctx.mode, scenario: ctx.scenario, automationId: ctx.flow.id, campaignId: ctx.campaignId, preAuthorized: true,
  }, {
    channel: entry.channel, personId: subject.id, purpose: entry.purpose, actionKey: entry.action_key, text: def.text, templateId: def.templateId, subject: def.subject,
    preheader: def.preheader, variables: def.variables, sensitive: def.sensitive === true, portalUrl: def.portalUrl,
  });
  if (res.sent || res.status === 'SENT') return { status: 'OK', providerRef: res.providerRef || null };
  if (res.status === 'UNKNOWN') return { status: 'UNKNOWN', providerRef: res.providerRef || null, errorCode: 'MKT_ACTION_UNKNOWN' };
  if (res.status === 'QUEUED') return { status: 'OK', providerRef: res.providerRef || null, detail: 'QUEUED' };
  if (['BLOCKED', 'DEFERRED'].includes(res.status)) return { status: 'SKIPPED', errorCode: res.reason || 'NO_ADDRESS' };
  return { status: 'FAILED', errorCode: 'MKT_ACTION_FAILED', detail: res.status };
}

module.exports = { sendMessage };
