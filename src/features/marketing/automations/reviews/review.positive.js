'use strict';

const ports = require('../runner/runner.ports');
const { publishMarketingEvent } = require('../../marketing.events.publish');
const repo = require('./review.repository');
const reviewPorts = require('./review.ports');
const { auditReview } = require('./review.audit');
const { reviewBlockedOpenCase } = require('./review.errors');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { classifyMessageOutcome, classifySendException } = require('../../sendRetry.outcome');

const DEFAULT_TEXT = 'Olá! Sua opinião é muito importante para nós. Conte como foi a sua experiência: {link}';
const DEFAULT_SUBJECT = 'Conte como foi a sua experiência';
const LINK_MARKER = '{link}';
const KILL_SWITCH = 'KILL_SWITCH';

async function move(row, fields, input, reason) {
  const after = await repo.update(row.id, fields, input.ownerUserId, input.transaction);
  await auditReview(input.tenant, input.ownerUserId, `marketing.review_request.${String(after.status).toLowerCase()}`, row, after, reason, input.transaction);
  return after;
}

const fail = async (row, code, input, reason) => {
  await move(row, { status: 'FAILED', errorCode: code }, input, reason);
  return { reviewRequestId: row.id, failed: code };
};

async function shortCodeOf(linkId, transaction) {
  const [row] = await sequelize.query('SELECT short_code FROM marketing.tracking_links WHERE id = :id', { replacements: { id: linkId }, transaction, type: QueryTypes.SELECT });
  return row ? row.short_code : null;
}

/** Link rastreável do pedido (um por pedido: a retomada reaproveita o já criado). Devolve o endereço público completo. */
async function trackedUrl(row, input, params) {
  if (row.tracking_link_id) return `${params.linkBase}/t/${await shortCodeOf(row.tracking_link_id, input.transaction)}`;
  const link = await reviewPorts.createLink({ tenant: input.tenant, actor: input.ownerUserId, input: { targetUrl: params.reviewUrl, channel: row.channel, utmCampaign: 'avaliacao' } }, input.transaction);
  await repo.update(row.id, { trackingLinkId: link.id }, input.ownerUserId, input.transaction);
  row.tracking_link_id = link.id;
  return `${params.linkBase}${link.path}`;
}

/**
 * Entrega do pedido PENDING: sem URL da avaliação o pedido fica FAILED e nada sai (a automação não inventa destino); o link é rastreável; o envio passa pelo canSend
 * (AVALIACAO exige OPT_IN), kill switch e limite, dentro de sendMarketingMessage (também no reenvio). Horário de silêncio adia (a ação espera); bloqueio vira SUPPRESSED;
 * recusa definitiva do canal vira FAILED (não conta como pedido feito); falha transitória e resultado incerto deixam o pedido PENDING com a ação aberta (nova tentativa ou
 * reconciliação pela chave, DI-M9F-2); só o envio aceito vira SENT e emite review.requested.
 */
async function deliver(row, input, params) {
  if (await repo.hasOpenCase(row.person_id, input.transaction)) {
    await move(row, { status: 'SUPPRESSED', errorCode: reviewBlockedOpenCase().code }, input, 'Ocorrência aberta antes do envio: o pedido de avaliação foi bloqueado.');
    return { reviewRequestId: row.id, blocked: reviewBlockedOpenCase().code };
  }
  if (!params.reviewUrl) return fail(row, 'MKT_REVIEW_URL_NOT_CONFIGURED', input, 'Endereço da avaliação não configurado: nada foi enviado.');
  if (!params.linkBase) return fail(row, 'MKT_REVIEW_LINK_BASE_NOT_CONFIGURED', input, 'Endereço público dos links rastreáveis não configurado: nada foi enviado.');
  let url;
  try {
    url = await trackedUrl(row, input, params);
  } catch (err) {
    const passing = classifySendException(err); // cofre fora (a chave do link rastreável) é passageiro: nova tentativa, não pedido perdido (DI-M9F-2)
    if (passing.transient || passing.deferred) return { reviewRequestId: row.id, retry: passing, channel: row.channel };
    return fail(row, err.code || 'MKT_URL_NOT_ALLOWED', input, 'O endereço da avaliação foi recusado pela regra de URL externa: nada foi enviado.');
  }
  const message = (input.context && input.context.message) || {};
  let res;
  try { // savepoint: a exceção passageira (cofre fora, banco) não aborta a run e vira nova tentativa (DI-M9F-2)
    res = await sequelize.transaction({ transaction: input.transaction }, (inner) => ports.sendMessage(
      { tenant: input.tenant, transaction: inner, now: input.now, mode: input.mode, scenario: input.scenario, automationId: input.flowId },
      { channel: row.channel, personId: row.person_id, purpose: 'AVALIACAO', actionKey: input.idempotencyKey, text: String(message.text || DEFAULT_TEXT).split(LINK_MARKER).join(url), subject: message.subject || DEFAULT_SUBJECT, templateId: message.templateId, preheader: message.preheader },
    ));
  } catch (err) {
    const sent = classifySendException(err);
    if (!sent.transient && !sent.deferred) throw err; // recusa definitiva (template, preview, URL): como antes, a ação falha
    return { reviewRequestId: row.id, retry: sent, channel: row.channel };
  }
  if (res.status === 'DEFERRED') return { reviewRequestId: row.id, deferUntil: res.nextEligibleAt };
  if (res.sent || res.status === 'SENT') {
    await move(row, { status: 'SENT', sentAt: input.now || new Date(), messageId: res.messageId, errorCode: null }, input, 'Pedido de avaliação aceito pelo canal.');
    await publishMarketingEvent({ type: 'review.requested', tenant: input.tenant, payload: { reviewRequestId: row.id, personId: row.person_id, channel: row.channel }, correlationId: input.correlationId }, input.transaction);
    return { reviewRequestId: row.id, status: 'SENT', messageId: res.messageId };
  }
  if (res.blocked) { // retomada segurada pelo kill switch: a mensagem da fila não sai e o pedido falha, como no bloqueio do kill switch
    await ports.settleMessage({ tenant: input.tenant, transaction: input.transaction, channel: row.channel, actionKey: input.idempotencyKey }, { status: 'CANCELLED', code: KILL_SWITCH });
    return close(row, input, { status: 'FAILED', code: KILL_SWITCH });
  }
  // incerto (timeout) ou transitório (429/5xx): o pedido continua PENDING e a ação espera a reconciliação ou a nova tentativa (DI-M9F-2)
  if (res.status === 'UNKNOWN') return { reviewRequestId: row.id, unknown: true, channel: row.channel };
  if (res.status === 'QUEUED') return { reviewRequestId: row.id, retry: classifyMessageOutcome(res), channel: row.channel };
  if (res.status === 'BLOCKED') {
    const code = res.reason || 'BLOCKED';
    return close(row, input, { status: code === KILL_SWITCH ? 'FAILED' : 'SUPPRESSED', code, reason: `Pedido de avaliação bloqueado antes do envio: ${code}.` });
  }
  return fail(row, 'MKT_REVIEW_SEND_FAILED', input, 'O canal não aceitou o pedido de avaliação.');
}

/**
 * Fecha o pedido PENDING sem envio (DI-M9F-2): bloqueio (SUPPRESSED, ou FAILED no kill switch), tentativas ou consultas esgotadas (FAILED), automação pausada (SUPPRESSED).
 * Chamado aqui e pelo runner, quando a ação aberta do pedido fecha na retomada. Devolve o que o executor entende (`blocked`/`failed`).
 */
async function close(row, input, { status, code, reason }) {
  await move(row, { status, errorCode: code }, input, reason || `Pedido de avaliação fechado sem envio: ${code}.`);
  return status === 'FAILED' ? { reviewRequestId: row.id, failed: code } : { reviewRequestId: row.id, blocked: code };
}

/** Nota positiva: pedido PENDING (nunca para quem tem ocorrência aberta) e entrega. */
async function positive({ input, facts, params, channel }) {
  if (await repo.hasOpenCase(input.personId, input.transaction)) return { reviewRequestId: null, blocked: reviewBlockedOpenCase().code };
  if (!channel) return { reviewRequestId: null, blocked: 'NO_CONTACT_CHANNEL' };
  const row = await repo.insert(input.tenant, input.ownerUserId, { personId: input.personId, sourceType: facts.sourceType, sourceId: facts.sourceId, score: facts.score, platform: input.platform || params.platform, status: 'PENDING', channel, key: input.idempotencyKey }, input.transaction);
  if (!row) return { reviewRequestId: null, blocked: 'MKT_REVIEW_ALREADY_REGISTERED' };
  await auditReview(input.tenant, input.ownerUserId, 'marketing.review_request.create', null, row, `Nota ${facts.score} de satisfação: pedido de avaliação criado.`, input.transaction);
  return deliver(row, input, params);
}

module.exports = { positive, deliver, close };
