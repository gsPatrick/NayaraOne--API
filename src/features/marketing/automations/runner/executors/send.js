'use strict';

const ports = require('../runner.ports');

const LINK_MARKER = '{link}';

/** SEND_MESSAGE -> adapter de canal (M9-D429) pelo sendMarketingMessage, com a action_key como chave de idempotência (coluna action_key da mensagem). O canSend já foi decidido pelo runner. */
async function sendMessage(ctx) {
  const { def, entry, subject } = ctx;
  if (!subject || subject.type !== 'PERSON') return { status: 'SKIPPED', errorCode: 'NO_ADDRESS' };
  let text = def.text;
  let variables = def.variables;
  if (def.linkProvider) { // o link é obtido de quem o possui, na hora do envio; sem link a mensagem não sai (nunca com o marcador cru)
    const link = await ports.linkOf(def.linkProvider, { tenant: ctx.tenant, transaction: ctx.transaction, personId: subject.id });
    if (!link) return { status: 'SKIPPED', errorCode: 'MKT_LINK_NOT_AVAILABLE' };
    text = String(def.text).split(LINK_MARKER).join(link);
    variables = { ...def.variables, link };
  }
  const res = await ports.sendMessage({
    tenant: ctx.tenant, transaction: ctx.transaction, now: ctx.now, mode: ctx.mode, scenario: ctx.scenario, automationId: ctx.flow.id, campaignId: ctx.campaignId, preAuthorized: true,
  }, {
    channel: entry.channel, personId: subject.id, purpose: entry.purpose, actionKey: entry.action_key, text, templateId: def.templateId, subject: def.subject,
    preheader: def.preheader, variables, sensitive: def.sensitive === true, portalUrl: def.portalUrl,
  });
  if (res.sent || res.status === 'SENT') return { status: 'OK', providerRef: res.providerRef || null };
  if (res.status === 'UNKNOWN') return { status: 'UNKNOWN', providerRef: res.providerRef || null, errorCode: 'MKT_ACTION_UNKNOWN' };
  if (res.status === 'QUEUED') return { status: 'OK', providerRef: res.providerRef || null, detail: 'QUEUED' };
  if (['BLOCKED', 'DEFERRED'].includes(res.status)) return { status: 'SKIPPED', errorCode: res.reason || 'NO_ADDRESS' };
  return { status: 'FAILED', errorCode: 'MKT_ACTION_FAILED', detail: res.status };
}

module.exports = { sendMessage };
