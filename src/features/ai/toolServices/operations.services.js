'use strict';

const { getProjectHealth } = require('../../construction/projectHealth.service');
const contractsService = require('../../../modules/legal/contracts/application/contract.service');
const { toPlain } = require('./plain');
const { correspondentReaders } = require('../agents/nay_correspondente/readers');

function constructionProjects(transaction) {
  return {
    async getProgress(projectId) {
      const h = await getProjectHealth(projectId, transaction);
      const k = h.kpis || {};
      return {
        projectId, physicalProgressPct: k.physicalProgressPct, plannedProgressPct: k.plannedProgressPct, scheduleProgressPct: k.scheduleProgressPct ?? null,
        scheduleDelayDays: k.scheduleDelayDays, isOverdue: k.isOverdue, baselineBudget: h.baselineBudget, projectedTotalCost: h.projectedTotalCost,
        projectedMargin: h.projectedMargin, marginPct: h.marginPct ?? null, belowMinMargin: h.belowMinMargin ?? null, updatedAt: h.updatedAt,
      };
    },
  };
}

function legalContracts(transaction) {
  return {
    async getSummary(contractId) {
      const c = toPlain(await contractsService.getContract(contractId, transaction));
      return { ...c, versionsCount: Array.isArray(c.versions) ? c.versions.length : 0 };
    },
  };
}

/** Escrita (proposta aprovada): cria o rascunho do contrato na empresa do contexto. */
function legalDrafts(transaction, { userId, groupId, companyId }) {
  return {
    async createDraft(input) {
      const c = toPlain(await contractsService.createContract({ ...input, groupId, companyId }, userId, transaction));
      return { id: c.id, contractNumber: c.contractNumber ?? null, status: c.status };
    },
  };
}

function correspondentCases(transaction, scope) {
  // M9-D039: situação, casos parados, exigências abertas e simulações comparadas; as leituras do Correspondente moram com o agente.
  return correspondentReaders(transaction, scope);
}

module.exports = { constructionProjects, legalContracts, legalDrafts, correspondentCases };
