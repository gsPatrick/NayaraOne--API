'use strict';

const { Message } = require('../../../../../models');
const { canSend, classifyPurpose, readOfficialTemplateChannels } = require('../../../suppression');
const { sendToChannel, resolveChannelAdapter, isQueueExpired } = require('../../adapters');
const { readPreviewConfig } = require('../preview/preview.settings');
const { previewSafe, previewSensitive } = require('../preview/preview.safe');
const { signUnsubscribeToken } = require('../unsubscribe/unsubscribe.token');
const { parseSendInput } = require('./message.input');
const { loadApprovedTemplate, fillTemplate } = require('./message.template');
const { templateNotApproved, unsubscribeRequired } = require('./message.errors');
const { buildWhatsappMessage, previewFields: whatsappPreview } = require('./whatsapp.adapter');
const { buildEmailMessage, previewFields: emailPreview } = require('./email.adapter');
const { recipientAddress } = require('./message.recipient');
const { recordOutbound, moveOutbound, audit, STATUS_TEXT } = require('./message.persist');
const { isOutboundBlocked } = require('../../../killswitch.state');

const QUIET = 'QUIET_HOURS';
const KILL = { reason: 'KILL_SWITCH', code: 'MKT_KILL_SWITCH_ACTIVE', message: 'O kill switch do Marketing está ativo: nenhuma mensagem sai até a reativação.' };

/** Kill switch (M9-D425) lido na hora do envio: global, canal, campanha e automação do contexto; ilegível = bloqueado. Bloquear não é exceção: a mensagem não sai e a razão fica registrada. */
const killBlock = (ctx, channel) => isOutboundBlocked(ctx.tenant, { channel, campaignId: ctx.campaignId, automationId: ctx.automationId }, ctx.transaction);

/** Mensagem do CRM já gravada com esta action_key (a replay devolve a mesma, sem enviar outra vez). */
const findByActionKey = (actionKey, tenant, transaction) => Message.findOne({ where: { companyId: tenant.companyId, actionKey }, transaction, lock: transaction.LOCK.UPDATE });

/** Texto/assunto/pré-cabeçalho finais: texto seguro quando sensível; senão cada trecho do preview é verificado (redige o que dá, recusa o resto). */
function applyPreviewRules(input, message, previewConfig) {
  if (input.sensitive) {
    const safe = `${previewConfig.safeText}${input.portalUrl ? ` ${input.portalUrl}` : ''}`;
    return { ...message, text: safe, ...(message.subject ? { subject: previewConfig.safeText } : {}), preheader: undefined };
  }
  const next = { ...message };
  const fields = input.channel === 'WHATSAPP' ? whatsappPreview(message, previewConfig) : emailPreview(message);
  for (const { field, value, maxChars } of fields) {
    const check = previewSafe(value, previewConfig, { maxChars });
    if (check.safe) continue;
    if (check.refused) throw previewSensitive({ channel: input.channel, field, patterns: check.patterns, alternativa: 'use sensitive: true para enviar só o aviso com link seguro' });
    next[field] = check.text;
  }
  return next;
}

/** Link de descadastro do e-mail de marketing: o informado, ou o do parâmetro com o token assinado. */
async function unsubscribeLinkFor(input, previewConfig, tenant, transaction) {
  const { requiresOptIn } = await classifyPurpose(input.purpose, tenant, transaction);
  if (input.channel !== 'EMAIL') return { required: false, url: null };
  let url = input.unsubscribeUrl;
  if (!url && previewConfig.unsubscribeUrl) url = previewConfig.unsubscribeUrl.replace('{token}', encodeURIComponent(await signUnsubscribeToken({ companyId: tenant.companyId, personId: input.personId, channel: input.channel })));
  if (requiresOptIn && !url) throw unsubscribeRequired({ channel: input.channel, purpose: input.purpose });
  return { required: requiresOptIn, url: url || null };
}

/** Resposta de canSend negado: DEFERRED quando é só o horário de silêncio (a mensagem não se perde, volta em nextEligibleAt); BLOCKED nos demais. */
async function blockedResult(decision, input, tenant, transaction) {
  const status = decision.reason === QUIET ? 'DEFERRED' : 'BLOCKED';
  await audit(tenant, `marketing.message.${status.toLowerCase()}`, 'Person', input.personId, { channel: input.channel, purpose: input.purpose, actionKey: input.actionKey, reason: decision.reason, code: decision.code },
    `Mensagem de ${input.channel} ${status === 'DEFERRED' ? 'adiada' : 'bloqueada'} pelo canSend: ${decision.reason}.`, transaction);
  return { status, reason: decision.reason, code: decision.code, message: decision.message, nextEligibleAt: decision.nextEligibleAt || null, replayed: false, sent: false };
}

/** Estado gravado no CRM e retorno para cada resultado do canal (decideOnResult decide fila, nova tentativa por classe e cancelamento). */
function outcomeOf(result) {
  if (['SENT', 'PUBLISHED'].includes(result.status)) return { status: 'SENT', reason: null };
  if (result.unknown || result.status === 'UNKNOWN') return { status: 'UNKNOWN', reason: STATUS_TEXT.UNKNOWN };
  const plan = result.contingency || {};
  if (plan.state === 'QUEUED' || (plan.retry && plan.retry !== 'NONE')) return { status: 'QUEUED', reason: STATUS_TEXT.QUEUED }; // fila (WhatsApp) ou nova tentativa por classe (e-mail)
  return { status: 'FAILED', reason: result.error && result.error.message ? `${STATUS_TEXT.FAILED} ${result.error.message}` : STATUS_TEXT.FAILED };
}

function view(row, extra = {}) {
  return { status: row.deliveryStatus || row.status, messageId: row.id, channel: row.channel, purpose: row.purpose, providerRef: row.externalMessageId || null, replayed: false, sent: false, ...extra };
}

/** Reenvio de mensagem QUEUED (nova tentativa) ou conferência de UNKNOWN pela chave de idempotência, antes de repetir (M9-D415). */
async function resumeExisting(ctx, row, rebuild) {
  const { tenant, transaction } = ctx;
  const state = row.deliveryStatus || row.status;
  if (state === 'UNKNOWN') {
    const adapter = await resolveChannelAdapter(row.channel, { tenant, transaction, mode: ctx.mode });
    const found = await adapter.findByIdempotencyKey(row.actionKey);
    if (found && found.found) return view(await moveOutbound(row, { status: 'SENT', providerRef: found.providerRef }, transaction), { replayed: true, sent: true, reconciled: true });
  }
  if (!['UNKNOWN', 'QUEUED'].includes(state)) return view(row, { replayed: true });
  if (state === 'QUEUED' && row.channel === 'WHATSAPP' && await isQueueExpired({ queuedAt: row.get('created_at') }, tenant, transaction)) {
    return view(await moveOutbound(row, { status: 'CANCELLED', reason: STATUS_TEXT.EXPIRED }, transaction), { replayed: true, cancelled: true });
  }
  if ((await killBlock(ctx, row.channel)).blocked) return view(row, { replayed: true, blocked: true, reason: KILL.reason, code: KILL.code }); // fica como estava (QUEUED/UNKNOWN) e sai depois da reativação
  const message = await rebuild();
  const result = await sendToChannel(row.channel, message, { tenant, transaction, idempotencyKey: row.actionKey, now: ctx.now, mode: ctx.mode, scenario: ctx.scenario, campaignId: ctx.campaignId, automationId: ctx.automationId });
  const out = outcomeOf(result);
  return view(await moveOutbound(row, { ...out, providerRef: result.providerRef }, transaction), { replayed: true, sent: out.status === 'SENT', contingency: result.contingency, sandbox: result.sandbox });
}

/**
 * sendMarketingMessage — WhatsApp e e-mail do Marketing (M9-D429). Ordem: pedido e replay por action_key; template aprovado (inexistente ou reprovado = 422);
 * texto montado e verificado contra o preview sensível (422, ou texto seguro); descadastro obrigatório no e-mail de marketing (422); canSend NA HORA do envio
 * (bloqueio = BLOCKED, horário de silêncio = DEFERRED, nada sai e a razão é gravada na auditoria); envio pelo ChannelAdapter com a action_key como chave de
 * idempotência; e a mensagem no CRM com a finalidade e o status que o canal confirmou (SENT; DELIVERED/READ só pelo status de entrega). Resultado incerto
 * (timeout) fica UNKNOWN. ctx: { tenant, transaction, now?, mode?, scenario? }.
 */
async function sendMarketingMessage(ctx, rawInput) {
  const { tenant, transaction } = ctx;
  const now = ctx.now || new Date();
  const input = parseSendInput(rawInput);
  const previewConfig = await readPreviewConfig(tenant, transaction);

  let template = null;
  let officialTemplate = false;
  if (input.templateId) {
    template = await loadApprovedTemplate(input.templateId, input.channel, tenant, transaction);
    officialTemplate = Boolean(template.official_template_ref);
    if (!officialTemplate && (await readOfficialTemplateChannels(tenant, transaction)).includes(input.channel)) throw templateNotApproved({ templateId: input.templateId, channel: input.channel, motivo: 'sem referência oficial' });
  }
  const text = template ? fillTemplate(template, input.variables, previewConfig) : input.text;
  const link = await unsubscribeLinkFor(input, previewConfig, tenant, transaction);
  const rebuild = async () => {
    const to = await recipientAddress(input.personId, input.channel, tenant, transaction);
    const base = applyPreviewRules(input, { to, text, subject: input.subject, preheader: input.preheader }, previewConfig);
    return input.channel === 'WHATSAPP' ? buildWhatsappMessage({ ...base, template, variables: input.variables }) : buildEmailMessage({ ...base, unsubscribeUrl: link.url });
  };

  const existing = await findByActionKey(input.actionKey, tenant, transaction);
  if (existing) return resumeExisting(ctx, existing, rebuild);

  const message = await rebuild(); // verificações de template, preview e descadastro vêm antes do canSend
  if (!ctx.preAuthorized) { // o runner de automações (M9-D414) já decidiu kill switch e canSend, com a trava e a reserva, antes de chamar: decidir de novo contaria a própria reserva no cap
    if ((await killBlock(ctx, input.channel)).blocked) return blockedResult(KILL, input, tenant, transaction); // kill switch antes do canSend (runner, passo 3)
    const decision = await canSend(input.personId, input.channel, input.purpose, now, { tenant, transaction, officialTemplate });
    if (!decision.allowed) return blockedResult(decision, input, tenant, transaction);
  }
  if (!message.to) return blockedResult({ reason: 'NO_ADDRESS', code: 'MKT_NO_ADDRESS', message: 'A pessoa não tem endereço de contato utilizável neste canal.' }, input, tenant, transaction);

  const result = await sendToChannel(input.channel, message, { tenant, transaction, idempotencyKey: input.actionKey, now, mode: ctx.mode, scenario: ctx.scenario, campaignId: ctx.campaignId, automationId: ctx.automationId });
  const out = outcomeOf(result);
  const row = await recordOutbound({ tenant, input, message: { subject: message.subject, text: message.text }, ...out, providerRef: result.providerRef }, transaction);
  await audit(tenant, 'marketing.message.sent', 'Message', row.id, { channel: input.channel, purpose: input.purpose, status: out.status, sandbox: result.sandbox, decision: result.contingency && result.contingency.action },
    `Mensagem de ${input.channel} ${out.status === 'SENT' ? 'aceita pelo canal' : `não confirmada (${out.status})`}.`, transaction);
  return view(row, { sent: out.status === 'SENT', contingency: result.contingency, sandbox: result.sandbox, previewRedacted: message.text !== text });
}

module.exports = { sendMarketingMessage };
