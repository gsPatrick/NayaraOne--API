'use strict';

const eligibility = require('./retention.eligibility');
const runRepository = require('./retention.run.repository');
const holdGuard = require('./retention.holdGuard');
const integration = require('./retention.integration');
const targets = require('./retention.targets');
const { DISPOSITIONS } = require('./retention.constants');

const PAGE = 2000;
const emptyCounts = () => ({ eligibleCount: 0, blockedByHold: 0, blockedByException: 0, wouldDelete: 0, wouldAnonymize: 0, wouldArchive: 0, forReview: 0 });

/** Distribui o que "seria feito" na coluna da disposição da política. */
function applyOutcome(counts, policy, { eligible, blockedByException, blockedByHold }) {
  const actionable = Math.max(0, eligible - blockedByException - blockedByHold);
  const out = { ...counts };
  out.eligibleCount += eligible; out.blockedByException += blockedByException; out.blockedByHold += blockedByHold;
  if (policy.disposition === DISPOSITIONS.DELETE) out.wouldDelete += actionable;
  else if (policy.disposition === DISPOSITIONS.ANONYMIZE) out.wouldAnonymize += actionable;
  else if (policy.disposition === DISPOSITIONS.ARCHIVE) out.wouldArchive += actionable;
  else out.forReview += Math.max(0, eligible - blockedByException);
  return out;
}

/** Alvo de tabela: conta, confere o hold dos candidatos (disposição destrutiva) e grava o conjunto exato como itens PENDING. */
async function analyzeTable(ctx, policy, target) {
  const { tenant, today, batchSize, sampleSize, runId, transaction } = ctx;
  const counted = await eligibility.counts(tenant, policy, target, today, transaction);
  const sample = await eligibility.sample(tenant, policy, target, today, sampleSize, transaction);
  let blockedByHold = 0;
  if (policy.disposition !== DISPOSITIONS.REVIEW) {
    await eligibility.insertCandidates(tenant, policy, target, today, { runId, batchSize }, transaction);
    // O hold é conferido no conjunto já gravado, em páginas; o que está sob hold sai do conjunto e fica só na contagem.
    let after = '';
    for (;;) {
      const ids = await runRepository.pendingIds(runId, target.code, { after, limit: PAGE }, transaction);
      if (!ids.length) break;
      const held = await holdGuard.heldIds(target.holdEntityType, ids, { tenant, transaction });
      await runRepository.deleteItems(runId, target.code, held, transaction);
      blockedByHold += held.length; after = ids[ids.length - 1];
    }
  }
  return { target: target.code, ...applyOutcome(emptyCounts(), policy, { eligible: counted.eligible, blockedByException: counted.blockedByException, blockedByHold }), sample };
}

/** Alvo FUNCTION (integração): conta o que integration.purge_expired() tocaria; sob hold nada entra; senão um item executa a função no apply. */
async function analyzeFunction(ctx, policy, target) {
  const { tenant, runId, transaction, batchSize } = ctx;
  const dry = await integration.dryCounts(tenant, transaction);
  const held = (await holdGuard.heldIds(target.holdEntityType, [tenant.companyId], { tenant, transaction })).length > 0;
  if (!held) await runRepository.insertItems(tenant, runId, policy, target, [tenant.companyId], 0, batchSize, transaction);
  const outcome = applyOutcome(emptyCounts(), policy, { eligible: dry.total, blockedByException: 0, blockedByHold: held ? dry.total : 0 });
  return { target: target.code, ...outcome, sample: [], detail: dry.counts, effectiveDays: dry.effectiveDays };
}

async function analyzePolicy(ctx, policy) {
  const parts = [];
  for (const code of policy.dataTypes) {
    const target = targets.get(code);
    parts.push(await (targets.isFunction(target) ? analyzeFunction(ctx, policy, target) : analyzeTable(ctx, policy, target)));
  }
  const total = parts.reduce((sum, part) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + part[key]])), emptyCounts());
  return {
    code: policy.code, version: policy.version, disposition: policy.disposition, trigger: policy.trigger, retentionMonths: policy.retentionMonths, ...total,
    sample: parts.flatMap((part) => part.sample).slice(0, ctx.sampleSize), targets: parts,
  };
}

module.exports = { analyzePolicy, emptyCounts };
