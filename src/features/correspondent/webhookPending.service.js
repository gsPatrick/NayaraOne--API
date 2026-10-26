'use strict';

const { Op } = require('sequelize');
const { WebhookPending } = require('../../models');
const logger = require('../../utils/logger');
const { sanitizeProviderMessage } = require('./sanitizeProviderMessage');

/**
 * Webhook que chega ANTES de o sistema conhecer o id do caso (o provider aceitou o envio e já
 * avisou, mas o roteamento ainda não foi gravado: envio incerto, processo reiniciado). A resposta ao
 * provider continua a mesma de uma assinatura inválida (nada revela quais ids existem), mas o evento
 * fica guardado com a assinatura original e é reprocessado quando o roteamento existir.
 * A assinatura NUNCA é confiada aqui: ela só é conferida no reprocessamento, com o segredo da empresa.
 */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PENDING_PER_PROVIDER = 2000;
const KEEP_HOURS = 72;
const MAX_PER_REPROCESS = 50;

async function storePendingWebhook(providerCode, rawBody, headers, body) {
  try {
    if (!rawBody || rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) return false;
    const signature = headers && typeof headers['x-webhook-signature'] === 'string' ? headers['x-webhook-signature'].slice(0, 512) : null;
    const cutoff = new Date(Date.now() - KEEP_HOURS * 3600 * 1000);
    await WebhookPending.destroy({ where: { receivedAt: { [Op.lt]: cutoff } } });
    const waiting = await WebhookPending.count({ where: { providerCode, processedAt: null } });
    if (waiting >= MAX_PENDING_PER_PROVIDER) return false;
    await WebhookPending.create({
      providerCode,
      externalCaseId: String(body.externalCaseId),
      externalEventId: String(body.externalEventId),
      rawBody: Buffer.from(rawBody).toString('utf8'),
      signature,
      receivedAt: new Date(),
    });
    return true;
  } catch (err) {
    // evento repetido (mesma chave) ou falha de gravação: o provider reenvia; nada disso muda a resposta
    if (err?.name !== 'SequelizeUniqueConstraintError') {
      logger.warn({ providerCode, err: sanitizeProviderMessage(err?.message) }, 'Não foi possível guardar o webhook de caso ainda desconhecido.');
    }
    return false;
  }
}

async function reprocessPendingWebhooks(providerCode, externalCaseId) {
  // Carregado aqui para evitar dependência circular entre os serviços.
  // eslint-disable-next-line global-require
  const { processFinancingWebhook } = require('./webhooks.service');
  const rows = await WebhookPending.findAll({
    where: { providerCode, externalCaseId, processedAt: null },
    order: [['received_at', 'ASC']],
    limit: MAX_PER_REPROCESS,
  });
  let processed = 0;
  for (const row of rows) {
    try {
      const body = JSON.parse(row.rawBody);
      // eslint-disable-next-line no-await-in-loop
      await processFinancingWebhook(providerCode, Buffer.from(row.rawBody, 'utf8'), { 'x-webhook-signature': row.signature || '' }, body, { fromPending: true });
      row.processedAt = new Date();
      row.attempts += 1;
      // eslint-disable-next-line no-await-in-loop
      await row.save();
      processed += 1;
    } catch (err) {
      row.attempts += 1;
      // Assinatura inválida ou corpo ilegível não melhora com o tempo: encerra. Falha técnica fica para a próxima tentativa.
      if (err?.code === 'CORRESPONDENT_WEBHOOK_HMAC_INVALID' || err instanceof SyntaxError || row.attempts >= 10) row.processedAt = new Date();
      // eslint-disable-next-line no-await-in-loop
      await row.save().catch(() => {});
    }
  }
  return processed;
}

/**
 * afterRootCommit — executa `fn` depois que a transação raiz foi confirmada no banco (se não há
 * transação, executa na hora). Savepoints (transações filhas) não disparam o commit: sobe até a raiz.
 */
function afterRootCommit(transaction, fn) {
  let root = transaction;
  while (root && root.parent) root = root.parent;
  if (root && typeof root.afterCommit === 'function') root.afterCommit(fn);
  else fn();
}

/**
 * scheduleWebhookReprocess — dispara o reprocessamento DEPOIS que o roteamento está confirmado no
 * banco. Nunca derruba quem chamou.
 */
function scheduleWebhookReprocess(transaction, providerCode, externalCaseId) {
  afterRootCommit(transaction, () => {
    reprocessPendingWebhooks(providerCode, externalCaseId).catch((err) => {
      logger.warn({ providerCode, err: sanitizeProviderMessage(err?.message) }, 'Falha ao reprocessar webhooks que aguardavam o roteamento.');
    });
  });
}

module.exports = { storePendingWebhook, reprocessPendingWebhooks, scheduleWebhookReprocess, afterRootCommit };
