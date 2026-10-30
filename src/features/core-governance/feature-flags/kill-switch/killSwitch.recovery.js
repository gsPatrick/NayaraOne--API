'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const flagsService = require('../feature-flags.service');
const { readFlagsParams } = require('../flags.params');
const repo = require('../flags.repository');
const { getProbe } = require('./probes/registry');
const { VERIFICATION, RESULTS, AUDIT } = require('./killSwitch.constants');
const kRepo = require('./killSwitch.repository');
const { alertFailed } = require('./killSwitch.alerts');

/**
 * Se o job caiu no meio de um teste (linha RUNNING mais antiga que `governanca.flags.kill_teste_tolerancia_min`), restaura o switch ao `previous_state` gravado antes do efeito,
 * fecha o teste como FAIL (interrompido), marca UNVERIFIED e avisa o responsável. Roda ANTES de qualquer outro trabalho do ciclo (M9-D872 §3.2). Devolve as chaves restauradas.
 */
async function recoverInterrupted(tenant, { now, transaction }) {
  const params = await readFlagsParams(tenant, transaction);
  const before = new Date(now.getTime() - params.killToleranceMin * 60000);
  const recovered = [];
  for (const drill of await kRepo.listInterrupted(tenant, before, transaction)) {
    const row = await repo.findById(tenant, 'FLAG', drill.flag_id, transaction, { lock: true });
    if (row && row.value !== drill.previous_state) {
      await flagsService.updateEntry(tenant, { id: row.id, value: drill.previous_state, reason: 'Teste do kill switch interrompido: estado anterior restaurado.' }, null, transaction, { now });
    }
    await kRepo.finishDrill(tenant, drill.id, RESULTS.FAIL, { interrupted: true, restoredTo: drill.previous_state, environment: drill.environment, probeVersion: drill.probe_version }, now, transaction);
    if (row) {
      await kRepo.setVerification(tenant, row.id, VERIFICATION.UNVERIFIED, transaction);
      const probe = getProbe(row.probe) || { name: row.probe, version: drill.probe_version };
      await alertFailed(tenant, row, { environment: drill.environment, probe, why: 'o teste foi interrompido antes de terminar', params, now }, transaction);
    }
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: AUDIT.drill, entityType: AUDIT.entity, entityId: drill.flag_id,
      beforeJson: { drillId: drill.id, result: RESULTS.RUNNING }, afterJson: { result: RESULTS.FAIL, interrupted: true, restoredTo: drill.previous_state },
      reason: `Teste interrompido do kill switch ${drill.flag_key}: estado anterior restaurado.`,
    }, transaction);
    recovered.push(drill.flag_key);
  }
  return recovered;
}

module.exports = { recoverInterrupted };
