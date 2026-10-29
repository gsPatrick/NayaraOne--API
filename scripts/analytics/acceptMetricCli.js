'use strict';

/**
 * M9-D708 (3.4) — comando operacional `node scripts/analytics/acceptMetric.js --metric=<código> --company=<id> --user=<id|email> --decisao=ACEITAR|REJEITAR
 * --evidencia=<id do arquivo> [--versao=N] [--comentario=<texto>]`. O owner (papel da métrica, com analytics:accept) registra a decisão depois de ver a
 * diferença gravada por reconcile.js. Sem rota nem tela (o livro não pede). A regra está em acceptance.service.decide. Saída: 0 ok, 1 recusa, 2 uso incorreto.
 */
const { sequelize } = require('../../src/models');
const { decide } = require('../../src/features/analytics/metrics/acceptance.service');
const { UUID, findCompany, findUser, permissionsOf, inTenant } = require('./reconcile/tenant');

const USAGE = 'Uso: node scripts/analytics/acceptMetric.js --metric=<código> --company=<id> --user=<id|email> --decisao=ACEITAR|REJEITAR --evidencia=<id do arquivo> [--versao=N] [--comentario=<texto>]';
const CODE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return { metric: out.metric, company: out.company, user: out.user, decision: out.decisao, evidence: out.evidencia, version: out.versao ? Number(out.versao) : undefined, comment: (out.comentario || '').trim() || undefined };
}

/** Versão vigente da métrica na empresa (quando o comando não informa --versao). */
async function currentVersion(target, userId, metric) {
  return inTenant(target, userId, async (transaction) => {
    const [rows] = await sequelize.query(
      `SELECT v.version FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.metric_code = :metric
        ORDER BY (d.company_id IS NULL), (d.group_id IS NULL) LIMIT 1`, { replacements: { metric }, transaction });
    return rows[0] ? rows[0].version : undefined;
  });
}

async function runAccept(argv, { out = console.log, err = console.error } = {}) {
  const a = parseArgs(argv);
  if (!CODE.test(a.metric || '') || !UUID.test(a.company || '') || !a.user || !a.decision || !a.evidence || (a.version !== undefined && !Number.isInteger(a.version))) {
    err(USAGE);
    return 2;
  }
  const target = await findCompany(a.company);
  const user = target ? await findUser(a.user) : null;
  if (!target || !user) {
    err(target ? 'Usuário não encontrado.' : 'Empresa não encontrada.');
    return 1;
  }
  try {
    const permissions = await permissionsOf(user.id, target);
    const version = a.version !== undefined ? a.version : await currentVersion(target, user.id, a.metric);
    const ctx = { ...target, actorUserId: user.id, permissions };
    const r = await inTenant(target, user.id, (transaction) => decide(a.metric, version, user.id, a.decision, a.evidence, { ctx, transaction, comment: a.comment }));
    out(`OK ${r.metricCode} v${r.version}: ${r.status}; diferença ${String(r.difference).replace('.', ',')}; evidência ${r.evidenceFileId}; decidido por ${r.acceptedBy}; ambiente ${r.ambiente}`);
    return 0;
  } catch (e) {
    err(`ERRO ${e.code || 'ANALYTICS_ACCEPT_FAILED'}: ${e.message}`);
    return 1;
  }
}

module.exports = { runAccept, parseArgs, USAGE };
