'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Leitura SOMENTE LEITURA do Financeiro para o custo real da campanha (M9-D432). Só SELECT; o Marketing nunca escreve em finance.*.
 *
 * Lançamento da campanha = despesa (DEBIT/PAYABLE) REALIZADA (status SETTLED), que não seja dinheiro de terceiro nem estorno, ligada
 * pela referência `campaign:{id}` (origin_ref) e, só quando não há referência de campanha, pelo centro de custo de código igual ao
 * `code` da campanha. A baixa parcial herda o vínculo do lançamento de origem; o lançamento de origem com baixas parciais liquidadas
 * não conta de novo (contam as baixas). Estorno total (REVERSED) e cancelado não entram; estorno parcial (ajuste CREDIT liquidado)
 * é subtraído. Valores em centavos inteiros (sem ponto flutuante).
 */
const SQL = `
WITH counted AS (
  SELECT e.id, e.amount
    FROM finance.financial_entries e
    LEFT JOIN finance.financial_entries root ON root.id = COALESCE(e.parent_entry_id, e.id) AND root.company_id = e.company_id
    LEFT JOIN finance.cost_centers cc ON cc.id = root.cost_center_id AND cc.company_id = root.company_id AND cc.deleted_at IS NULL
   WHERE e.company_id = :companyId AND e.entry_type = 'DEBIT' AND e.nature = 'PAYABLE' AND e.status = 'SETTLED'
     AND e.reversal_of_entry_id IS NULL AND e.is_third_party_funds = false
     AND NOT EXISTS (SELECT 1 FROM finance.financial_entries ch WHERE ch.parent_entry_id = e.id AND ch.company_id = e.company_id
                      AND ch.nature = 'PAYABLE' AND ch.status = 'SETTLED')
     AND (root.origin_ref = :ref OR (COALESCE(root.origin_ref, '') NOT LIKE 'campaign:%' AND cc.code = :code))
)
SELECT (COALESCE((SELECT sum(round(amount * 100)) FROM counted), 0)
      - COALESCE((SELECT sum(round(rv.amount * 100)) FROM finance.financial_entries rv
                   WHERE rv.company_id = :companyId AND rv.reversal_of_entry_id IN (SELECT id FROM counted)
                     AND rv.entry_type = 'CREDIT' AND rv.status = 'SETTLED'), 0))::bigint AS cents`;

/** Soma, em centavos, dos lançamentos realizados ligados à campanha (nunca negativo). */
async function readCampaignCostCents(campaign, tenant, transaction) {
  const [row] = await sequelize.query(SQL, {
    replacements: { companyId: tenant.companyId, ref: `campaign:${campaign.id}`, code: campaign.code }, transaction, type: QueryTypes.SELECT,
  });
  return Math.max(0, Number(row.cents));
}

module.exports = { readCampaignCostCents, COST_SQL: SQL };
