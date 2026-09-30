'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, MaintenanceCase } = require('../../models');
const { computeEscalationLevel } = require('../../features/construction/maintenanceCases.service');

/**
 * warrantyEscalationJob (M6-63/M6-88) — recalcula periodicamente o `escalation_level` de todo
 * chamado de garantia (WarrantyCase / `construction.maintenance_cases`) que ainda não está
 * CLOSED e tem `sla_due_at` definido, escalando NONE -> WARNING -> CRITICAL -> OVERDUE conforme
 * o prazo se aproxima ou vence. Mesmo padrão (varredura por grupo/empresa com SET LOCAL, uma
 * transação por empresa) de `feedbackCaseAlertJob.js`/`legalDeadlineAlertJob.js`.
 *
 * O cálculo do nível NÃO é reimplementado aqui: reusa `computeEscalationLevel`, a MESMA função
 * pura usada por `maintenanceCases.service.js` ao criar/atualizar um caso manualmente — garante
 * que o nível mostrado nunca diverge entre "acabei de editar o caso" e "o job rodou por cima".
 *
 * Idempotência: só ESCREVE no banco quando o nível calculado é diferente do já salvo — rodar o
 * job várias vezes seguidas sem nada mudar não gera nenhuma escrita nem auditoria repetida.
 */

const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

/**
 * escalateOverdueWarrantyCases — o miolo do job, isolado numa função que recebe a transação de
 * fora, para: (1) `processCompany` usá-la dentro da própria transação por empresa; (2) os
 * testes exercitarem o comportamento REAL do job dentro de `withRollbackTenantTransaction`, sem
 * persistir nada no banco compartilhado.
 */
async function escalateOverdueWarrantyCases(transaction, now = new Date()) {
  const candidates = await MaintenanceCase.findAll({
    where: {
      status: { [Op.in]: OPEN_STATUSES },
      slaDueAt: { [Op.ne]: null },
    },
    transaction,
  });

  let escalated = 0;
  for (const warrantyCase of candidates) {
    const newLevel = computeEscalationLevel(warrantyCase.slaDueAt, now);
    if (newLevel !== warrantyCase.escalationLevel) {
      warrantyCase.escalationLevel = newLevel;
      await warrantyCase.save({ transaction });
      escalated += 1;
    }
  }

  return { casesChecked: candidates.length, escalated };
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return escalateOverdueWarrantyCases(transaction);
  });
}

async function runWarrantyEscalationJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, casesChecked: 0, escalated: 0, errors: 0 };

  for (const group of groups) {
    summary.groupsChecked += 1;
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });

    for (const company of companies) {
      summary.companiesChecked += 1;
      try {
        const result = await processCompany(group, company);
        summary.casesChecked += result.casesChecked;
        summary.escalated += result.escalated;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[WarrantyEscalationJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`
        );
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[WarrantyEscalationJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.casesChecked} caso(s) verificado(s), ${summary.escalated} escalonado(s), ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function startWarrantyEscalationJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runWarrantyEscalationJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[WarrantyEscalationJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runWarrantyEscalationJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[WarrantyEscalationJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runWarrantyEscalationJob,
  startWarrantyEscalationJob,
  escalateOverdueWarrantyCases,
  processWarrantyEscalationForCompany: processCompany,
};
