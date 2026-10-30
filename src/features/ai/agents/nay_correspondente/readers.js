'use strict';

const { getSetting } = require('../../../settings/settings.service');
const clock = require('../../clock');
const nay = require('../../../correspondent/correspondentNay.service');
const { getFinancingCase } = require('../../../correspondent/cases/financingCases.service');
const { getPendingRequirements } = require('../../../correspondent/correspondentNayReaders.service');
const { CORRESPONDENTE_KEYS: K, CORRESPONDENTE_SETTING_DEFAULTS: D } = require('./correspondente.settings');

const iso = (date) => (date ? new Date(date).toISOString() : null);
const plain = (value) => JSON.parse(JSON.stringify(value));

async function limitOf(key, scope, transaction) {
  const value = await getSetting(key, scope, transaction, D[key]);
  return Number.isInteger(value) && value > 0 ? value : D[key];
}

/**
 * Leituras da NAY Correspondente para as ferramentas e para o caminho de regra (M9-D039). Todas SOMENTE LEITURA e sobre o que já está
 * registrado: nenhuma cria simulação, chama o provider ou muda o status do caso. O tamanho das listas vem dos parâmetros da empresa.
 */
function correspondentReaders(transaction, { groupId, companyId }) {
  const scope = { groupId, companyId };
  return {
    /** Situação do caso: a etapa atual com a data da última mudança e a fonte. */
    async getStatus(caseId) {
      const c = plain(await getFinancingCase(caseId, groupId, companyId, transaction));
      return {
        ...c, applicantsCount: Array.isArray(c.applicants) ? c.applicants.length : 0, source: 'correspondent.financing_cases', updatedAt: c.updatedAt ?? c.updated_at ?? null, asOf: iso(clock.now()),
      };
    },

    /** Casos sem atividade há `stalledCaseDays` ou mais (parâmetro do Correspondente), do mais parado ao menos, com o motivo de cada um. */
    async getStalledCases() {
      const max = await limitOf(K.maxStalledCases, scope, transaction);
      const result = await nay.checkStalledCases(groupId, companyId, {}, transaction);
      const ordered = [...result.cases].sort((a, b) => b.idleDays - a.idleDays);
      return {
        source: 'correspondent.financing_cases', asOf: iso(clock.now()), thresholdDays: result.thresholdDays, total: ordered.length, truncated: ordered.length > max,
        items: ordered.slice(0, max).map((c) => ({ financingCaseId: c.financingCaseId, status: c.status, idleDays: c.idleDays, reason: c.reason, pendingRequirementTypes: c.pendingRequirementTypes })),
      };
    },

    getPendingRequirements: (caseId) => getPendingRequirements(caseId, groupId, companyId, transaction),

    /** Simulações já registradas do caso, lado a lado, só do mesmo valor financiado; nada é estimado e nada é recomendado. */
    async compareSimulations(caseId) {
      const max = await limitOf(K.maxSimulations, scope, transaction);
      const result = plain(await nay.compareSimulations(caseId, groupId, companyId, transaction));
      const sims = result.simulations;
      return {
        financingCaseId: caseId, source: 'correspondent.simulations', asOf: iso(clock.now()), referenceAmount: sims.length ? sims[0].amount : null,
        total: sims.length, truncated: sims.length > max, termsDiffer: result.termsDiffer,
        simulations: sims.slice(0, max).map((s) => ({
          id: s.id, providerCode: s.providerCode, amount: s.amount, termMonths: s.termMonths, monthlyPayment: s.monthlyPayment, rate: s.rate, rateInformed: s.rateInformed,
          totalCost: s.totalCost, createdAt: s.createdAt, lowestPayment: s.lowestPayment, lowestTotalCost: s.lowestTotalCost,
        })),
      };
    },
  };
}

module.exports = { correspondentReaders };
