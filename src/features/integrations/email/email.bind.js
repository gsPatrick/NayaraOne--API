'use strict';

const { sequelize, EmailMessage } = require('../../../models');
const { registerCallObserver, registerDispatchCycleStep } = require('../dispatch/worker/worker.hooks');
const { syncFailedMessages } = require('./email.sync');

/**
 * Liga a resposta do provedor à mensagem (M9-D234 3.2 item 1): quando `sendEmail` é aceito, o worker de envios entrega a resposta e este observador grava o identificador da
 * mensagem no provedor (único por connection) e leva a mensagem de QUEUED a SENT, mas nunca a DELIVERED: a entrega só vale com o evento do provedor. Roda num SAVEPOINT: falhar
 * aqui não derruba o envio.
 */
async function bindMessageResult({ dispatch, connection, response, transaction }) {
  const message = await EmailMessage.findOne({ where: { dispatchId: dispatch.id, companyId: dispatch.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  const externalId = response.externalResourceId || null;
  if (!message || !externalId) return;
  const patch = { externalMessageId: String(externalId).slice(0, 160), connectionId: connection.id };
  if (message.status === 'QUEUED') Object.assign(patch, { status: 'SENT', sentAt: new Date() });
  await message.update(patch, { transaction });
}

let installed = false;
/** Registra o observador do envio e o passo da rodada do worker (mensagem cujo envio foi recusado de vez vira FAILED) uma vez por processo. */
function installEmailBinder() {
  if (installed) return;
  installed = true;
  registerCallObserver(async (args) => {
    const { dispatch, response, error } = args;
    if (error || !response || dispatch.operation !== 'sendEmail' || dispatch.aggregateType !== 'EmailMessage') return;
    try {
      await sequelize.transaction({ transaction: args.transaction }, (savepoint) => bindMessageResult({ ...args, transaction: savepoint }));
    } catch { /* o savepoint desfez só a ligação; o evento do provedor encontra a mensagem pelo envio */ }
  });
  registerDispatchCycleStep((ctx, _meta, transaction) => syncFailedMessages(ctx, transaction));
}

module.exports = { installEmailBinder, bindMessageResult };
