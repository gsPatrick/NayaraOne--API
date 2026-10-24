'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, Contract, RentAdjustment, BillingSchedule } = require('../../models');
const billingScheduleService = require('../../features/billing/billingSchedule.service');
const { LEASE_LIKE_TYPES } = require('../../features/legal/contracts.service');

/**
 * billingScheduleAutoGenerateJob — JUR-faltante (auditoria externa Nayara, 11/10/2026):
 * "Billing mensal automático de locação (aluguel + IPTU + condomínio + água/luz, reajuste
 * IGPM/IPCA) não foi encontrado — apenas lançamentos financeiros avulsos." O backend de
 * billing (billingSchedule.service.js, rentAdjustment.service.js, utilities.service.js) já
 * existia PRONTO e testado, mas só era acionável manualmente via API — não havia automação
 * mensal nenhuma, e nenhuma tela expunha isso (ver commit que adiciona o front).
 *
 * Este job roda diariamente e, para toda competência (YYYY-MM) ainda não gerada de um
 * contrato de LOCAÇÃO ativo, gera o cronograma de cobrança com o componente RENT no valor
 * vigente — usando o reajuste mais recente já APLICADO (RentAdjustment.status = 'APPLIED')
 * quando existir, senão o valor original do contrato (totalValue). IPTU/condomínio ficam como
 * componentes adicionais que o operador acrescenta manualmente na MESMA competência (o
 * Caderno não define um valor fixo recorrente pra esses itens no schema atual — eles variam
 * por boleto do condomínio/prefeitura, diferente do aluguel que é o único valor contratual
 * fixo). Água/luz continuam cobertas por UtilityObligation (obrigação de quem paga, não um
 * valor de cobrança mensal fixo).
 *
 * Idempotência: a MESMA trava que já protegia a chamada manual (UNIQUE (contract_id, period)
 * em billing_schedules, e checagem explícita em generateBillingSchedule antes do INSERT) vale
 * aqui — rodar o job 2x no mesmo dia, ou reprocessar o mesmo contrato, nunca duplica a
 * competência corrente.
 */

function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextDueDate() {
  // Vencimento padrão: dia 10 do mês corrente (mesmo critério já documentado em
  // rentAdjustment.service.js para a janela de reajuste — sem configuração de "dia de
  // vencimento" por contrato no schema atual).
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10));
}

async function resolveCurrentRentAmount(contract, transaction) {
  const latestApplied = await RentAdjustment.findOne({
    where: { contractId: contract.id, status: 'APPLIED' },
    order: [['period', 'DESC']],
    transaction,
  });
  if (latestApplied && latestApplied.newRentAmount !== null && latestApplied.newRentAmount !== undefined) {
    return Number(latestApplied.newRentAmount);
  }
  return Number(contract.totalValue);
}

// Função pura de domínio, sem abrir transação própria — usada tanto pelo job real (que a
// chama dentro de uma transação com SET LOCAL já aplicado) quanto pelos testes (que já rodam
// dentro de withRollbackTenantTransaction, com o tenant já setado).
async function generateBillingSchedulesInTransaction(transaction, { period = currentPeriod() } = {}) {
  const summary = { contractsChecked: 0, generated: 0, skipped: 0, errors: 0 };

  // FIX AUD-015 (11/10/2026): contractType 'LEASE' deixou de ser o único código de locação —
  // inclui também os subtipos LEASE_RESIDENTIAL/LEASE_COMMERCIAL/LEASE_SEASONAL/PROPERTY_ADMIN.
  const activeLeases = await Contract.findAll({
    where: { contractType: { [Op.in]: LEASE_LIKE_TYPES }, status: 'ACTIVE' },
    transaction,
  });

  for (const contract of activeLeases) {
    summary.contractsChecked += 1;
    const already = await BillingSchedule.findOne({ where: { contractId: contract.id, period }, transaction });
    if (already) {
      summary.skipped += 1;
      continue;
    }

    const rentAmount = await resolveCurrentRentAmount(contract, transaction);
    if (!Number.isFinite(rentAmount) || rentAmount <= 0) {
      summary.errors += 1;
      continue;
    }

    await billingScheduleService.generateBillingSchedule(
      {
        groupId: contract.groupId,
        companyId: contract.companyId,
        contractId: contract.id,
        period,
        dueDate: nextDueDate(),
        items: [{ componentType: 'RENT', description: `Aluguel — competência ${period}`, amount: rentAmount }],
      },
      null,
      transaction
    );
    summary.generated += 1;
  }

  return summary;
}

async function processCompany(group, company) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return generateBillingSchedulesInTransaction(transaction);
  });
}

async function runBillingScheduleAutoGenerateJob() {
  const groups = await Group.findAll();
  const summary = { groupsChecked: 0, companiesChecked: 0, contractsChecked: 0, generated: 0, skipped: 0, errors: 0 };

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
        summary.contractsChecked += result.contractsChecked;
        summary.generated += result.generated;
        summary.skipped += result.skipped;
        summary.errors += result.errors;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[BillingScheduleAutoGenerateJob] Falha ao processar empresa ${company.id} (grupo ${group.id}): ${err.message}`);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[BillingScheduleAutoGenerateJob] Execução concluída — ${summary.groupsChecked} grupo(s), ${summary.companiesChecked} empresa(s), ` +
      `${summary.contractsChecked} contrato(s) de locação ativo(s), ${summary.generated} cronograma(s) gerado(s), ` +
      `${summary.skipped} já existiam, ${summary.errors} erro(s).`
  );

  return summary;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x por dia — a competência é mensal, não precisa rodar com mais frequência.

function startBillingScheduleAutoGenerateJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  runBillingScheduleAutoGenerateJob().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[BillingScheduleAutoGenerateJob] Falha na execução inicial:', err.message);
  });

  return setInterval(() => {
    runBillingScheduleAutoGenerateJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[BillingScheduleAutoGenerateJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = {
  runBillingScheduleAutoGenerateJob,
  startBillingScheduleAutoGenerateJob,
  processBillingScheduleAutoGenerateForCompany: processCompany,
  generateBillingSchedulesInTransaction,
  currentPeriod,
};
