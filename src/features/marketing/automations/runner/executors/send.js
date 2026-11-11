'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const ports = require('../runner.ports');
const { fillMarkers, variablesFor } = require('./fill');
const { classifyMessageOutcome, classifySendException } = require('../../../sendRetry.outcome');
const { resultOfSend, timedOutSend } = require('../runner.sendRetry');

const LINK_MARKER = '{link}';

/** Com template oficial só vão as variáveis que ele declara (o resto seria recusado); sem template, todas. */
async function declaredOnly(templateId, vars, ctx) {
  if (!templateId) return vars;
  const [row] = await sequelize.query('SELECT variables_json FROM marketing.templates WHERE id = :id AND company_id = :c', { replacements: { id: templateId, c: ctx.tenant.companyId }, transaction: ctx.transaction, type: QueryTypes.SELECT });
  const declared = new Set(((row && row.variables_json) || []).map((v) => v.name));
  return Object.fromEntries(Object.entries(vars).filter(([name]) => declared.has(name)));
}

/**
 * SEND_MESSAGE -> adapter de canal (M9-D429) pelo sendMarketingMessage, com a action_key como chave de idempotência (coluna action_key da mensagem). O canSend já foi decidido
 * pelo runner (na criação da run ou, na nova tentativa, pelo executor das ações adiadas). O envio roda num savepoint: a exceção (cofre fora, banco) não aborta a run e é
 * classificada. A nova tentativa (RETRY) chama de novo com a MESMA chave: a mensagem já gravada é retomada (resumeExisting), nunca duplicada (DI-M9F-1).
 */
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
  const input = {
    channel: entry.channel, personId: subject.id, purpose: entry.purpose, actionKey: entry.action_key, text, templateId: def.templateId, subject: subjectLine,
    preheader: def.preheader, variables, sensitive: def.sensitive === true, portalUrl: def.portalUrl,
  };
  let res;
  try {
    res = await sequelize.transaction({ transaction: ctx.transaction }, (inner) => ports.sendMessage({
      tenant: ctx.tenant, transaction: inner, now: ctx.now, mode: ctx.mode, scenario: ctx.scenario, automationId: ctx.flow.id, campaignId: ctx.campaignId, preAuthorized: true,
    }, input));
  } catch (err) {
    return resultOfSend(ctx, entry, classifySendException(err));
  }
  if (res.blocked) { // retomada segurada pelo kill switch: a mensagem que estava na fila fecha CANCELLED, como a ação SCHEDULED pulada pelo kill switch
    const reason = res.reason || 'KILL_SWITCH';
    await ports.settleMessage({ tenant: ctx.tenant, transaction: ctx.transaction, channel: entry.channel, actionKey: entry.action_key }, { status: 'CANCELLED', code: reason });
    return { status: 'SKIPPED', errorCode: reason };
  }
  if (['BLOCKED', 'DEFERRED'].includes(res.status)) return { status: 'SKIPPED', errorCode: res.reason || 'NO_ADDRESS' };
  return resultOfSend(ctx, entry, classifyMessageOutcome(res));
}

/** Estouro de marketing.runner.acao_timeout_s no envio: UNKNOWN reconciliável pela chave (runner.exec). */
sendMessage.onTimeout = timedOutSend;

module.exports = { sendMessage };
