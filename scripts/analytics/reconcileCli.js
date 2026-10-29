'use strict';

/**
 * M9-D708 (3.3) — comando operacional `node scripts/analytics/reconcile.js --metric=<código|all> --company=<id> [--data=AAAA-MM-DD]`.
 * Calcula o valor do BI (snapshot da versão atual) e o do relatório de referência de cada KPI e grava a linha PENDING com a diferença em
 * analytics.metric_acceptance. Sem rota HTTP (o livro não pede). Código de saída: 0 ok, 1 falha, 2 uso incorreto.
 */
const { reconcileMetric, reconcileAll } = require('../../src/features/analytics/metrics/acceptance.reconcile');
const { REFERENCE_REPORTS } = require('./reconcile/reports');
const { UUID, findCompany, inTenant } = require('./reconcile/tenant');

const USAGE = 'Uso: node scripts/analytics/reconcile.js --metric=<código|all> --company=<id da empresa> [--data=AAAA-MM-DD]';
const CODE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const br = (v) => (v === null || v === undefined ? 'n/d' : String(v).replace('.', ','));

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return { metric: out.metric, company: out.company, data: out.data };
}

const describe = (r) => `OK ${r.metricCode} v${r.version}: BI ${br(r.biValue)}; relatório ${br(r.referenceValue)}; diferença ${br(r.difference)}; tolerância ${br(r.tolerance)}; PENDING`
  + `${r.comment ? ` (${r.comment})` : ''}\n    relatório de referência: ${r.referenceReport}`;

/** `options`: { out, err, asOfDate, now } (os dois últimos só para o teste fixar a data e o instante). Devolve o código de saída. */
async function runReconcile(argv, { out = console.log, err = console.error, asOfDate, now } = {}) {
  const args = parseArgs(argv);
  const metricOk = args.metric === 'all' || CODE.test(args.metric || '');
  if (!metricOk || !UUID.test(args.company || '') || (args.data !== undefined && !DATE.test(args.data))) {
    err(USAGE);
    return 2;
  }
  const target = await findCompany(args.company);
  if (!target) {
    err('Empresa não encontrada.');
    return 1;
  }
  const ctx = { ...target, actorUserId: null, permissions: [] };
  const options = { asOfDate: args.data || asOfDate, now, referenceReports: REFERENCE_REPORTS };
  try {
    const rows = await inTenant(target, null, (tx) => (args.metric === 'all' ? reconcileAll(ctx, options, tx) : reconcileMetric(ctx, args.metric, options, tx).then((r) => [r])));
    rows.forEach((r) => out(describe(r)));
    out(`${rows.length} indicador(es) reconciliado(s).`);
    return 0;
  } catch (e) {
    err(`ERRO ${e.code || 'ANALYTICS_RECONCILE_FAILED'}: ${e.message}`);
    return 1;
  }
}

module.exports = { runReconcile, parseArgs, USAGE };
