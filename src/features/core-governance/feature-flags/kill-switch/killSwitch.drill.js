'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const flagsService = require('../feature-flags.service');
const E = require('../flags.errors');
const { readFlagsParams } = require('../flags.params');
const { ENVIRONMENT_KEY } = require('../flags.environment');
const repo = require('../flags.repository');
const { viewOf } = require('../flags.view');
const { getProbe } = require('./probes/registry');
const { DRILL_ENVIRONMENTS, VERIFICATION, RESULTS, AUDIT } = require('./killSwitch.constants');
const K = require('./killSwitch.errors');
const kRepo = require('./killSwitch.repository');
const { inTenantTransaction } = require('./killSwitch.tx');
const { alertFailed } = require('./killSwitch.alerts');

const EVIDENCE_MAX = 4000;

/** Evidência gravada: probe, versão, ambiente e o que o probe devolveu (cortada para não guardar texto sem fim; o probe não deve devolver dado pessoal ou segredo). */
function evidenceOf(probe, environment, outcome) {
  const base = { probe: probe.name, probeVersion: probe.version, environment, detail: outcome.evidence === undefined ? null : outcome.evidence };
  if (outcome.error) base.error = outcome.error;
  return JSON.stringify(base).length > EVIDENCE_MAX ? { probe: probe.name, probeVersion: probe.version, environment, detail: 'evidência longa demais, cortada', error: base.error } : base;
}

/** Roda o probe numa transação própria (o erro dele nunca impede a restauração): devolve { pass, evidence, error }. */
async function runProbe(tenant, probe, flag, { environment, now, transaction }) {
  try {
    const out = await inTenantTransaction(tenant, transaction, (tx) => probe.run({ tenant, flag, environment, transaction: tx, now }));
    return { pass: Boolean(out) && out.pass === true, evidence: out ? out.evidence : undefined };
  } catch (err) {
    return { pass: false, error: String(err && err.message ? err.message : err).slice(0, 500) };
  }
}

/** Fase 1: grava o estado anterior ANTES do efeito (linha RUNNING) e aciona o switch; confirmada antes de o probe rodar. */
function start(tenant, flagId, { environment, now, transaction }) {
  return inTenantTransaction(tenant, transaction, async (tx) => {
    const row = await repo.findById(tenant, 'FLAG', flagId, tx, { lock: true });
    if (!row) throw E.notFound();
    if (!row.is_kill_switch) throw E.inputInvalid('Esta chave não é um kill switch.', { field: 'id' });
    const probe = getProbe(row.probe);
    if (!probe) throw K.probeRequired({ probe: row.probe || null });
    const drill = await kRepo.insertDrill(tenant, { flagId: row.id, key: row.key, at: now, environment, previous: row.value === true, probeVersion: probe.version }, tx);
    if (row.value !== true) await flagsService.updateEntry(tenant, { id: row.id, value: true, reason: 'Teste periódico do kill switch: acionado para o drill.' }, null, tx, { now });
    return { drill, probe, flag: viewOf({ ...row, value: true }) };
  });
}

/** Fase 3: restaura SEMPRE o estado anterior, fecha o registro do teste, marca VERIFIED/UNVERIFIED, audita e, no FAIL, alerta o responsável. */
function finish(tenant, started, outcome, { environment, now, transaction }) {
  return inTenantTransaction(tenant, transaction, async (tx) => {
    const { drill, probe } = started;
    const row = await repo.findById(tenant, 'FLAG', drill.flag_id, tx, { lock: true });
    if (row && row.value !== drill.previous_state) {
      await flagsService.updateEntry(tenant, { id: row.id, value: drill.previous_state, reason: 'Teste periódico do kill switch: estado anterior restaurado.' }, null, tx, { now });
    }
    const result = outcome.pass ? RESULTS.PASS : RESULTS.FAIL;
    const evidence = evidenceOf(probe, environment, outcome);
    await kRepo.finishDrill(tenant, drill.id, result, evidence, now, tx);
    await kRepo.setVerification(tenant, drill.flag_id, outcome.pass ? VERIFICATION.VERIFIED : VERIFICATION.UNVERIFIED, tx);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: AUDIT.drill, entityType: AUDIT.entity, entityId: drill.flag_id,
      beforeJson: { previousState: drill.previous_state }, afterJson: { result, environment, probeVersion: probe.version, drillId: drill.id },
      reason: `Teste periódico do kill switch ${drill.flag_key}: ${result} (${environment}).`,
    }, tx);
    if (!outcome.pass && row) {
      const params = await readFlagsParams(tenant, tx);
      await alertFailed(tenant, row, { environment, probe, why: outcome.error || 'a função continuou ativa com o switch acionado', params, now }, tx);
    }
    return { result, drillId: drill.id, evidence, restoredTo: drill.previous_state };
  });
}

/**
 * Teste (drill) de UM kill switch (M9-D872 §3.2): aciona, executa o probe e restaura o estado anterior SEMPRE, inclusive quando o probe falha ou lança erro. Nunca roda em PROD
 * (403 GOV_KILL_DRILL_PROD_FORBIDDEN, sem tocar no switch). Cada fase é confirmada em separado: se o processo cair entre elas, o registro RUNNING guarda o estado a restaurar.
 * Opções: `environment` (padrão o da instalação), `now`, `transaction` (usa a do chamador em vez de abrir as próprias).
 */
async function runDrill(tenant, flagId, { now = new Date(), environment, transaction } = {}) {
  const env = String(environment || await inTenantTransaction(tenant, transaction, (tx) => ENVIRONMENT_KEY.read(tenant, tx))).toUpperCase();
  if (!DRILL_ENVIRONMENTS.includes(env)) throw K.drillProdForbidden();
  const started = await start(tenant, flagId, { environment: env, now, transaction });
  const outcome = await runProbe(tenant, started.probe, started.flag, { environment: env, now, transaction });
  return finish(tenant, started, outcome, { environment: env, now, transaction });
}

module.exports = { runDrill, finish, evidenceOf };
