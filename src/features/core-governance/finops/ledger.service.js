'use strict';

const { getSetting } = require('../../settings/settings.service');
const { DOMAINS_KEY, DEFAULT_DOMAINS, parseDomains } = require('../data-quality/data-quality.settings');
const { PLATFORM_DOMAIN } = require('./finops.constants');
const { readFinopsParams } = require('./finops.params');
const { normalizeLine } = require('./ledger.validate');
const repo = require('./ledger.repository');
const readModel = require('./costReadModel');
const { evaluateForPeriods } = require('./budgets/budget.evaluate');
const E = require('./finops.errors');

/** Domínios aceitos: os do cadastro de dados mestres (D804, configurável) mais PLATFORM. */
async function allowedDomains(tenant, transaction) {
  return [PLATFORM_DOMAIN, ...parseDomains(await getSetting(DOMAINS_KEY, tenant, transaction, DEFAULT_DOMAINS))];
}

/**
 * Grava um lote de linhas do ledger numa só transação (a do chamador): valida tudo antes de gravar; idempotente (replay não duplica); a fatura BILLED
 * (CHARGE) substitui o ESTIMATED contido no período; recalcula o CostReadModel dos dias tocados. Devolve { inserted, replayed, superseded, ids }.
 */
async function recordLines(tenant, lines, transaction) {
  const params = await readFinopsParams(tenant, transaction);
  const domains = await allowedDomains(tenant, transaction);
  const normalized = lines.map((raw) => {
    const line = normalizeLine({ environment: params.environment, domain: PLATFORM_DOMAIN, ...raw }, params.currency);
    if (!domains.includes(line.domain)) throw E.lineInvalid(`Domínio de custo desconhecido: ${line.domain}.`, { domain: line.domain, allowed: domains });
    return line;
  });
  const out = { inserted: 0, replayed: 0, superseded: 0, ids: [] };
  const touched = [];
  for (const line of normalized) {
    const { id, inserted } = await repo.upsertLine(tenant, line, transaction);
    out.ids.push(id);
    out[inserted ? 'inserted' : 'replayed'] += 1;
    touched.push(line.periodStart);
    if (line.costKind === 'BILLED' && line.lineType === 'CHARGE') {
      const replaced = await repo.supersedeContained(tenant, id, transaction);
      out.superseded += replaced.length;
      replaced.forEach((r) => touched.push(r.period_start));
    } else if (line.costKind === 'ESTIMATED') {
      await repo.supersedeByExistingBill(id, transaction);
    }
  }
  await readModel.refreshForPeriods(tenant, touched, transaction);
  // M9-D861: a cada gravação do ledger (coleta ou fatura) os orçamentos dos meses tocados são reavaliados, na mesma transação.
  await evaluateForPeriods(tenant, touched, transaction);
  return out;
}

module.exports = { recordLines, allowedDomains };
