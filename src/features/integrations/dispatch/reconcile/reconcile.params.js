'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { parseIntervals } = require('./reconcile.settings');

/** Padrões do livro (M9-D215 3.2: 5 consultas, 30 s, 2 min, 10 min, 1 h e 6 h; recuperador a cada 60 s) e da decisão DI-D215-3 (job a cada 10 s). */
const PADROES = Object.freeze({ maxAttempts: 5, intervalsS: Object.freeze([30, 120, 600, 3600, 21600]), jobIntervalS: 10, orphanIntervalS: 60 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readReconcileParams(ctx, transaction) {
  const [max, esperas, job, orfao] = await Promise.all([
    getSetting('integration.unknown.max_reconcile_attempts', ctx, transaction, PADROES.maxAttempts),
    getSetting('integration.unknown.reconcile_intervals_s', ctx, transaction, PADROES.intervalsS.join(',')),
    getSetting('integration.unknown.reconcile_job_interval_s', ctx, transaction, PADROES.jobIntervalS),
    getSetting('integration.dispatch.orphan_interval_s', ctx, transaction, PADROES.orphanIntervalS),
  ]);
  return {
    maxAttempts: inteiro(max, PADROES.maxAttempts, 1),
    intervalsS: parseIntervals(esperas) || [...PADROES.intervalsS],
    jobIntervalS: inteiro(job, PADROES.jobIntervalS, 1),
    orphanIntervalS: inteiro(orfao, PADROES.orphanIntervalS, 5),
  };
}

/** Segundos de espera antes da consulta de número `done + 1` (done = consultas já feitas); passou do fim da lista, repete a última. */
const waitBeforeAttemptS = (params, done) => params.intervalsS[Math.min(Math.max(0, done), params.intervalsS.length - 1)];

module.exports = { PADROES, readReconcileParams, waitBeforeAttemptS };
