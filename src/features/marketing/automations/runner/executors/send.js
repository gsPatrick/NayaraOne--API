'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const ports = require('../runner.ports');
const { fillMarkers, variablesFor } = require('./fill');

const LINK_MARKER = '{link}';

/** Com template oficial só vão as variáveis que ele declara (o resto seria recusado); sem template, todas. */
async function declaredOnly(templateId, vars, ctx) {
  if (!templateId) return vars;
  const [row] = await sequelize.query('SELECT variables_json FROM marketing.templates WHERE id = :id AND company_id = :c', { replacements: { id: templateId, c: ctx.tenant.companyId }, transaction: ctx.transaction, type: QueryTypes.SELECT });
  const declared = new Set(((row && row.variables_json) || []).map((v) => v.name));
  return Object.fromEntries(Object.entries(vars).filter(([name]) => declared.has(name)));
}

/** SEND_MESSAGE -> adapter de canal (M9-D429) pelo sendMarketingMessage, com a action_key como chave de idempotência (coluna action_key da mensagem). O canSend já foi decidido pelo runner. */
async function sendMessage(ctx) {
  const { def, entry, subject } = ctx;
  if (!subject || subject.type !== 'PERSON') return { status: 'SKIPPED', errorCode: 'NO_ADDRESS' };
  let text = def.text;
  let subjectLine = def.subject;
  let variables = def.variables;
  if (def.variablesProvider) { // variáveis do provedor nomeado (ex.: primeiro nome), preenchidas na hora; marcador sem valor = a mensagem não sai
    const vars = await variablesFor(ctx);
    const filledText = fillMarkers(text, vars);
    const filledSubject = subjectLine ? fillMarkers(subjectLine, vars) : { text: subjectLine, missing: [] };
    if (filledText.missing.length || filledSubject.missing.length) return { status: 'SKIPPED', errorCode: 'MKT_VARIABLE_NOT_AVAILABLE' };
    text = filledText.text;
    subjectLine = filledSubject.text;
    variables = { ...def.variables, ...(await declaredOnly(def.templateId, vars, ctx)) };
  }
  if (def.linkProvider) { // o link é obtido de quem o possui, na hora do envio; sem link a mensagem não sai (nunca com o marcador cru)
    const link = await ports.linkOf(def.linkProvider, { tenant: ctx.tenant, transaction: ctx.transaction, personId: subject.id, event: ctx.event, channel: entry.channel, actorUserId: ctx.flow.ownerUserId || null });
    if (!link) return { status: 'SKIPPED', errorCode: 'MKT_LINK_NOT_AVAILABLE' };
    text = String(text).split(LINK_MARKER).join(link);
    variables = { ...variables, link };
  }
  const res = await ports.sendMessage({
    tenant: ctx.tenant, transaction: ctx.transaction, now: ctx.now, mode: ctx.mode, scenario: ctx.scenario, automationId: ctx.flow.id, campaignId: ctx.campaignId, preAuthorized: true,
  }, {
    channel: entry.channel, personId: subject.id, purpose: entry.purpose, actionKey: entry.action_key, text, templateId: def.templateId, subject: subjectLine,
    preheader: def.preheader, variables, sensitive: def.sensitive === true, portalUrl: def.portalUrl,
  });
  if (res.sent || res.status === 'SENT') return { status: 'OK', providerRef: res.providerRef || null };
  if (res.status === 'UNKNOWN') return { status: 'UNKNOWN', providerRef: res.providerRef || null, errorCode: 'MKT_ACTION_UNKNOWN' };
  if (res.status === 'QUEUED') return { status: 'OK', providerRef: res.providerRef || null, detail: 'QUEUED' };
  if (['BLOCKED', 'DEFERRED'].includes(res.status)) return { status: 'SKIPPED', errorCode: res.reason || 'NO_ADDRESS' };
  return { status: 'FAILED', errorCode: 'MKT_ACTION_FAILED', detail: res.status };
}

module.exports = { sendMessage };
