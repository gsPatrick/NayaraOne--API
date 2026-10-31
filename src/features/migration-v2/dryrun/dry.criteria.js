'use strict';

/** Nomes dos seis critérios de aprovação do DRY3 (M9-D908 §3.3.4), na ordem do livro. */
const CRITERIA = Object.freeze(['blockers_zero', 'counts_match', 'batches_verified', 'parallel_clean', 'clock_tz_validated', 'rollback_simulated']);

const phaseOf = (phases, name) => phases.find((phase) => phase.name === name) || null;
const done = (phase) => Boolean(phase) && phase.status === 'DONE';

/**
 * Calcula os critérios e a conclusão a partir do que as fases mediram (sem aprovação manual). `facts`: { blockers[], volumes[], batches{ total, verified, other }, compare{ blockers, failed },
 * clock{ status }, tz{ divergences, checked }, rollback{ complete } }. Qualquer critério sem medição (fase que falhou) fica reprovado. APROVADO só com os seis verdes.
 */
function evaluate(phases, facts) {
  const criteria = {
    blockers_zero: { ok: done(phaseOf(phases, 'TOWER')) && facts.blockers.length === 0, count: facts.blockers.length, codes: [...new Set(facts.blockers.map((blocker) => blocker.code))] },
    counts_match: { ok: done(phaseOf(phases, 'VOLUME')) && facts.volumes.length > 0 && facts.volumes.every((item) => item.equal), code: 'GOV_MIG_VOLUME_MISMATCH', entities: facts.volumes.length, mismatched: facts.volumes.filter((item) => !item.equal).length },
    batches_verified: { ok: done(phaseOf(phases, 'VERIFY')) && facts.batches.total > 0 && facts.batches.verified === facts.batches.total, total: facts.batches.total, verified: facts.batches.verified, pct: facts.batches.total ? Math.round((facts.batches.verified / facts.batches.total) * 10000) / 100 : 0 },
    parallel_clean: { ok: done(phaseOf(phases, 'COMPARE')) && facts.compare.blockers === 0 && facts.compare.failed === 0, blockers: facts.compare.blockers, failedRuns: facts.compare.failed },
    clock_tz_validated: { ok: done(phaseOf(phases, 'CLOCK')) && facts.clock.status === 'OK' && done(phaseOf(phases, 'TZ_SAMPLE')) && facts.tz.divergences === 0, clock: facts.clock.status, tzDivergences: facts.tz.divergences, tzChecked: facts.tz.checked },
    rollback_simulated: { ok: done(phaseOf(phases, 'ROLLBACK')) && facts.rollback.complete === true, activated: facts.rollback.activated, rolledBack: facts.rollback.rolledBack, pendingItems: facts.rollback.pendingItems },
  };
  const approved = CRITERIA.every((name) => criteria[name].ok);
  return { criteria, conclusion: approved ? 'APROVADO' : 'REPROVADO' };
}

module.exports = { evaluate, CRITERIA };
