'use strict';

const logger = require('../../../../utils/logger');
const consumersRepo = require('./consumers.repository');
const { routeKeyOfRoutedRequest } = require('./target');
const { inTenantTx } = require('./tenantTx');

/**
 * Rastro de uso (M9-D841 §3.1): ao fim de uma resposta bem-sucedida de consumidor identificado, grava `MAJOR:<n>` e `ROUTE:<MÉTODO> <caminho com parâmetros>` em
 * governance.api_consumer_usage, no máximo uma vez por intervalo (`governanca.api.consumidor.uso_intervalo_minutos`) por consumidor e alvo. A trava local poupa o banco; a do UPSERT vale
 * entre processos. A gravação não atrasa nem derruba a resposta: erro vai para o log.
 */
const lastWrite = new Map();
const pending = new Set();

function track(req, res, caller, split) {
  const { consumer, ctx } = caller;
  if (!consumer || consumer.status !== 'ACTIVE') return;
  // `split` é o caminho versionado lido antes do roteamento (no fim da resposta `req.path` já é relativo ao roteador). A gravação entra em `pending` já na chegada da requisição (e sai ao terminar a resposta), para o flush não perder uma resposta que o cliente leu antes do evento `finish`.
  let release;
  const job = new Promise((resolve) => { release = resolve; });
  pending.add(job);
  const done = () => { pending.delete(job); release(); };
  res.once('close', () => { if (!res.writableFinished) done(); });
  res.once('finish', () => {
    if (res.statusCode >= 400) return done();
    const keys = [split ? `MAJOR:${split.major}` : null, routeKeyOfRoutedRequest(req)].filter(Boolean);
    const now = Date.now();
    const due = keys.filter((key) => now - (lastWrite.get(`${consumer.id}|${key}`) || 0) >= ctx.usageIntervalMinutes * 60000);
    if (!due.length) return done();
    for (const key of due) lastWrite.set(`${consumer.id}|${key}`, now);
    return inTenantTx(ctx.tenant, async (transaction) => {
      for (const targetKey of due) await consumersRepo.touchUsage({ consumer, targetKey, intervalMinutes: ctx.usageIntervalMinutes }, transaction);
    }).catch((err) => { for (const key of due) lastWrite.delete(`${consumer.id}|${key}`); logger.warn({ err: err.message }, 'apiConsumer.usage.failed'); }).finally(done);
  });
}

/** Espera as gravações de uso em andamento (testes e desligamento). */
const flushUsage = () => Promise.all([...pending]);
const resetUsageThrottle = () => lastWrite.clear();

module.exports = { track, flushUsage, resetUsageThrottle };
