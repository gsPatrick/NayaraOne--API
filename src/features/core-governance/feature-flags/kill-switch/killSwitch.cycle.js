'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { dateKeyInZone } = require('../../calendar/sources/time');
const { claimFlagAlert } = require('../flags.alerts');
const { ENVIRONMENT_KEY } = require('../flags.environment');
const { DRILL_ENVIRONMENTS, VERIFICATION, AUDIT, ALERT_TYPES } = require('./killSwitch.constants');
const kRepo = require('./killSwitch.repository');
const { inTenantTransaction } = require('./killSwitch.tx');
const { runDrill } = require('./killSwitch.drill');
const { recoverInterrupted } = require('./killSwitch.recovery');
const { evaluate } = require('./killSwitch.status');
const { alertStale } = require('./killSwitch.alerts');
const { provisionSwitches } = require('./killSwitch.provision');

/** O switch precisa de teste agora? UNVERIFIED (reexecuta todo dia até PASS) ou vencido; nunca dois testes no mesmo dia nem enquanto outro está em andamento. */
async function needsDrill(tenant, row, status, { now, transaction }) {
  if (row.verification_state !== VERIFICATION.UNVERIFIED && !status.stale) return false;
  if (await kRepo.hasRunning(tenant, row.key, transaction)) return false;
  return !(await kRepo.drilledOnDay(tenant, row.key, dateKeyInZone(now), transaction));
}

/** Em PROD o teste automático é recusado: registra a recusa (auditoria), uma vez por switch e dia, sem tocar no switch. */
async function registerRefusal(tenant, row, { environment, now }, transaction) {
  const claimed = await claimFlagAlert(tenant, { key: `kill_switch.drill_refused:${row.id}:${dateKeyInZone(now)}`, type: ALERT_TYPES.refused, entryId: row.id, recipients: 0 }, transaction);
  if (!claimed) return false;
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: AUDIT.refused, entityType: AUDIT.entity, entityId: row.id,
    beforeJson: null, afterJson: { code: 'GOV_KILL_DRILL_PROD_FORBIDDEN', environment },
    reason: `O teste automático do kill switch ${row.key} não roda em produção.`,
  }, transaction);
  return true;
}

/**
 * Uma execução do killSwitchDrillJob para a empresa (M9-D872 §3.2 e §3.3), nesta ordem: (1) restaura o teste que ficou pela metade; (2) testa em HOMOLOG/DEV os kill switches
 * vencidos ou UNVERIFIED (em PROD só registra a recusa); (3) alerta CRÍTICO ao responsável do switch sem PASS válido dentro da periodicidade. Devolve { recovered, drills, refused, stale }.
 * `environment`: padrão o da instalação (governanca.finops.ambiente). `transaction`: usa a do chamador (testes) em vez de transações próprias.
 */
async function runCycle(tenant, { now = new Date(), environment, transaction } = {}) {
  const read = (fn) => inTenantTransaction(tenant, transaction, fn);
  const env = String(environment || await read((tx) => ENVIRONMENT_KEY.read(tenant, tx))).toUpperCase();
  const summary = { environment: env, recovered: [], drills: [], refused: [], stale: [] };
  summary.recovered = await read((tx) => recoverInterrupted(tenant, { now, transaction: tx }));
  await read((tx) => provisionSwitches(tenant, tx)); // os módulos donos cadastram as chaves que faltam na empresa (Marketing, M9-D425)
  const switches = await read((tx) => kRepo.listSwitches(tenant, tx));
  for (const row of switches) {
    const status = await read((tx) => evaluate(tenant, row, { now, transaction: tx }));
    if (!await read((tx) => needsDrill(tenant, row, status, { now, transaction: tx }))) continue;
    if (!DRILL_ENVIRONMENTS.includes(env)) {
      if (await read((tx) => registerRefusal(tenant, row, { environment: env, now }, tx))) summary.refused.push(row.key);
      continue;
    }
    const drill = await runDrill(tenant, row.id, { now, environment: env, transaction });
    summary.drills.push({ key: row.key, result: drill.result, drillId: drill.drillId });
  }
  const fresh = await read((tx) => kRepo.listSwitches(tenant, tx));
  for (const row of fresh) {
    const status = await read((tx) => evaluate(tenant, row, { now, transaction: tx }));
    if (!status.stale) continue;
    summary.stale.push(row.key);
    // O switch UNVERIFIED já tem o alerta de falha do dia; o de vencimento é para quem simplesmente ficou sem teste.
    if (row.verification_state !== VERIFICATION.UNVERIFIED) await read((tx) => alertStale(tenant, row, status, { now }, tx));
  }
  return summary;
}

module.exports = { runCycle, needsDrill };
