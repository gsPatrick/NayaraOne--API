'use strict';

/**
 * M9-D620 (3.3) — caixa livre e dinheiro de terceiros do read model financeiro. Tudo sai do ledger (finance.financial_entries) e das contas
 * bancárias da empresa, em consultas agregadas no banco, com os status de "liquidado" do mapa de status do administrador:
 *   caixa total        = lançamentos liquidados (receber menos pagar, próprios e de terceiros) + transferências entre empresas liquidadas + saldo de abertura (se ligado)
 *   dinheiro de terceiros = entradas liquidadas de terceiros - devoluções - compensações (RETURN e COMPENSATION de thirdPartyReleaseType)
 *   caixa livre        = caixa total - dinheiro de terceiros (o dinheiro de terceiros nunca é caixa livre)
 * Estornos (reversal_of_entry_id) e os status REVERSED e CANCELLED nunca entram. A transferência entre empresas é a perna ADJUSTMENT do
 * lançamento criado pela aprovação (chave de idempotência `intercompany-transfer:<id>:from|to`): sai de uma conta e entra em outra.
 * Valores monetários voltam como texto decimal exato; a abertura por conta e por centro de custo guarda as partes para o KPI aplicar o parâmetro.
 */
const { sequelize } = require('../../../models');
const money = require('../metrics/formulas/money');
const { iso } = require('./financeHealth.dates');

const NO_ACCOUNT = 'sem_conta';
const NO_CENTER = 'sem_centro';
const ORIGINS = Object.freeze(['CAUCAO', 'REPASSE', 'OUTRO']);
const INTERCOMPANY_KEY = "e.idempotency_key LIKE 'intercompany-transfer:%'";
const OWN_LEDGER = 'e.nature IN (\'RECEIVABLE\', \'PAYABLE\') AND NOT e.is_third_party_funds';
const SIGNED = "CASE WHEN e.nature = 'PAYABLE' THEN -e.amount ELSE e.amount END";
const LEG_SIGNED = "CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE -e.amount END";

const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const like = (terms) => terms.map((t) => `%${t}%`);
const total = (values) => money.money(money.sum(values));
const minus = (a, b) => money.money(money.toString(money.sub(a, b)));

const BASE = 'e.company_id = :companyId AND e.status IN (:realized) AND e.settled_at < :dayEnd AND e.reversal_of_entry_id IS NULL';

async function readThirdParty(r, transaction) {
  const found = await rows(
    `SELECT origin,
            COALESCE(SUM(amount) FILTER (WHERE nature = 'RECEIVABLE'), 0)::text AS inflow,
            COALESCE(SUM(amount) FILTER (WHERE nature = 'PAYABLE' AND release_type = 'COMPENSATION'), 0)::text AS compensated,
            COALESCE(SUM(amount) FILTER (WHERE nature = 'PAYABLE' AND release_type IS DISTINCT FROM 'COMPENSATION'), 0)::text AS returned
       FROM (SELECT e.nature, e.amount, e.third_party_release_type AS release_type,
                    CASE WHEN COALESCE(o.third_party_reference, e.third_party_reference, '') ILIKE ANY (ARRAY[:caucao]) THEN 'CAUCAO'
                         WHEN COALESCE(o.third_party_reference, e.third_party_reference, '') ILIKE ANY (ARRAY[:repasse]) THEN 'REPASSE' ELSE 'OUTRO' END AS origin
               FROM finance.financial_entries e LEFT JOIN finance.financial_entries o ON o.id = e.third_party_origin_entry_id
              WHERE ${BASE} AND e.is_third_party_funds AND e.nature IN ('RECEIVABLE', 'PAYABLE')) x
      GROUP BY origin`,
    { ...r, caucao: like(r.caucaoTerms), repasse: like(r.repasseTerms) }, transaction);
  const byOrigin = Object.fromEntries(ORIGINS.map((o) => [o, '0.00']));
  const parts = { inflow: [], returned: [], compensated: [] };
  for (const f of found) {
    byOrigin[f.origin] = minus(minus(f.inflow, f.returned), f.compensated);
    for (const k of Object.keys(parts)) parts[k].push(f[k]);
  }
  const inflow = total(parts.inflow);
  const returned = total(parts.returned);
  const compensated = total(parts.compensated);
  return { inflow, returned, compensated, balance: minus(minus(inflow, returned), compensated), byOrigin };
}

/** Caixa próprio por conta bancária (receber menos pagar próprios mais as pernas de transferência liquidadas) e a abertura de cada conta. */
async function readByAccount(r, transaction) {
  const ledger = await rows(
    `SELECT COALESCE(e.bank_account_id::text, '${NO_ACCOUNT}') AS account,
            COALESCE(SUM(${SIGNED}) FILTER (WHERE ${OWN_LEDGER}), 0)::text AS own,
            COALESCE(SUM(${LEG_SIGNED}) FILTER (WHERE e.nature = 'ADJUSTMENT' AND ${INTERCOMPANY_KEY}), 0)::text AS legs
       FROM finance.financial_entries e WHERE ${BASE} GROUP BY 1`, r, transaction);
  const openings = await rows(
    `SELECT id::text AS account, opening_balance::text AS opening FROM finance.bank_accounts
      WHERE company_id = :companyId AND deleted_at IS NULL AND owner_person_id IS NULL AND opening_balance <> 0`, r, transaction);
  const byAccount = {};
  for (const l of ledger) byAccount[l.account] = { ledger: total([l.own, l.legs]), opening: '0.00', own: l.own, legs: l.legs };
  for (const o of openings) byAccount[o.account] = { ...(byAccount[o.account] || { ledger: '0.00', own: '0.00', legs: '0.00' }), opening: o.opening };
  return { byAccount, openingTotal: total(openings.map((o) => o.opening)) };
}

async function readByCostCenter(r, transaction) {
  const found = await rows(
    `SELECT COALESCE(e.cost_center_id::text, '${NO_CENTER}') AS center, COALESCE(SUM(${SIGNED}), 0)::text AS own
       FROM finance.financial_entries e WHERE ${BASE} AND ${OWN_LEDGER} GROUP BY 1`, r, transaction);
  return Object.fromEntries(found.map((f) => [f.center, f.own]));
}

/**
 * `bounds` = financeBounds(...); `params` = readCashParams. Devolve os campos de rm_finance_health que o caixa livre e o dinheiro de terceiros
 * usam (free_cash e third_party_cash já com a regra desta demanda) e os componentes que os reproduzem.
 */
async function readCashComponents(companyId, bounds, params, transaction) {
  const r = { companyId, dayEnd: iso(bounds.dayEnd), realized: params.realizedStatuses, caucaoTerms: params.caucaoTerms, repasseTerms: params.repasseTerms };
  const thirdParty = await readThirdParty(r, transaction);
  const { byAccount, openingTotal } = await readByAccount(r, transaction);
  const byCostCenter = await readByCostCenter(r, transaction);
  const accounts = Object.values(byAccount);
  const own = total(accounts.map((a) => a.own));
  const legs = total(accounts.map((a) => a.legs));
  const opening = params.includeOpening ? openingTotal : '0.00';
  const freeCash = total([own, legs, opening]);
  return {
    free_cash: freeCash,
    third_party_cash: thirdParty.balance,
    total_cash: total([freeCash, thirdParty.balance]),
    opening_balance_total: openingTotal,
    intercompany_cash_net: legs,
    third_party_inflow: thirdParty.inflow,
    third_party_returned: thirdParty.returned,
    third_party_compensated: thirdParty.compensated,
    third_party_by_origin: thirdParty.byOrigin,
    cash_by_bank_account: Object.fromEntries(Object.entries(byAccount).map(([k, v]) => [k, { ledger: v.ledger, opening: v.opening }])),
    cash_by_cost_center: byCostCenter,
  };
}

module.exports = { readCashComponents, NO_ACCOUNT, NO_CENTER, ORIGINS };
