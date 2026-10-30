'use strict';

const send = require('./drill.cases.send');
const fail = require('./drill.cases.fail');
const { http5xx } = require('./drill.cases.circuit');
const message = require('./drill.cases.message');
const webhook = require('./drill.cases.webhook');
const { scheduledJobs, jobRow } = require('./drill.fixture');
const { prepare, cycle, posts } = require('./drill.cycle');

/**
 * Os cenários rodam pelo caminho que cada canal tem de verdade. SITE, PORTAL e as cinco redes publicam por JOB (worker de publicação, M9-D411); WhatsApp e e-mail são mensagem
 * DIRETA (sendMarketingMessage, M9-D429), que não passa pelo worker. O recebimento (webhook) e a falha de entrega são iguais para os nove.
 */
const PRIVATE_CHANNELS = Object.freeze(['WHATSAPP', 'EMAIL']);

/** Caso de base de todo ensaio de publicação (cenário OK do sandbox): uma publicação sai uma vez e fecha como publicada. Sem ele os outros cenários não provam nada. */
async function publicationBaseline(t, env) {
  await prepare(t, env);
  const s = await scheduledJobs(t, env, env.channel, 1);
  await cycle(t, env, { now: s.now });
  const job = await jobRow(t, s.jobs[0]);
  return { ok: job.status === 'PUBLISHED' && job.attempts === 1 && posts(env) === 1, obtained: `${job.status} em ${job.attempts} tentativa, ${posts(env)} post` };
}

const SHARED = { WEBHOOK_ASSINATURA_INVALIDA: webhook.invalidSignature, WEBHOOK_DUPLICADO: webhook.duplicateEvent, FALHA_DE_ENTREGA: webhook.deliveryFailure };

const PUBLICATION_CASES = Object.freeze({
  TIMEOUT: send.timeout,
  UNKNOWN_BUT_PUBLISHED: send.unknownButPublished,
  UNKNOWN_NOT_PUBLISHED: send.unknownNotPublished,
  HTTP_429: fail.http429,
  HTTP_5XX: http5xx,
  AUTH_REVOKED: fail.authRevoked,
  REJECTED: fail.rejected,
  DUPLICATE_KEY: send.duplicateKey,
  SLOW: send.slow,
  ...SHARED,
});

const MESSAGE_CASES = Object.freeze({
  TIMEOUT: message.timeout,
  UNKNOWN_BUT_PUBLISHED: message.unknownButPublished,
  UNKNOWN_NOT_PUBLISHED: message.unknownNotPublished,
  HTTP_429: message.http429,
  HTTP_5XX: message.http5xx,
  AUTH_REVOKED: message.authRevoked,
  REJECTED: message.rejected,
  DUPLICATE_KEY: message.duplicateKey,
  SLOW: message.slow,
  ...SHARED,
});

/** { baseline, cases } do canal: cenário -> função (t, env) -> { ok, obtained }. A tabela de cenários e dos resultados esperados é drill.constants. */
function casesFor(channel) {
  return PRIVATE_CHANNELS.includes(channel) ? { baseline: message.baseline, cases: MESSAGE_CASES } : { baseline: publicationBaseline, cases: PUBLICATION_CASES };
}

module.exports = { casesFor, PRIVATE_CHANNELS };
