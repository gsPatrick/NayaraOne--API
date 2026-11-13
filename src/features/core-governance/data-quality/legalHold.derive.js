'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { SCOPE_TYPES, COMPANY, WILDCARD, ORIGIN } = require('./legalHold.constants');
const { TABLES, LINK_TYPES, qualified, localDate } = require('./legalHold.catalog');

/**
 * Do item de escopo aos registros protegidos (M9-D912 §3.1). Cada item vira linhas em legal_hold_targets: o registro isolado, a pessoa (com os contratos, processos, notas e
 * arquivos dela), o contrato (com processos, notas e arquivos), o processo (com os arquivos), a empresa inteira (linha COMPANY) e o tipo de dado (linha '*' sem período; com
 * período, os registros do tipo cuja data cai nele). Registros que passam a cair no escopo DEPOIS da criação (o contrato novo da pessoa em hold) entram por `ensure`, chamado
 * pela checagem. Tudo é INSERT ... SELECT em lote com ON CONFLICT DO NOTHING (idempotente).
 */
const CONTRACTS_OF_PERSON = 'SELECT cp.contract_id::text FROM legal.contract_parties cp WHERE cp.person_id::text = :itemId AND cp.deleted_at IS NULL';
const CASES_OF_PERSON = `SELECT lp.legal_case_id::text FROM legal.case_parties lp WHERE lp.person_id::text = :itemId UNION SELECT lc.id::text FROM legal.legal_cases lc WHERE lc.contract_id::text IN (${CONTRACTS_OF_PERSON})`;
const CASES_OF_CONTRACT = 'SELECT lc.id::text FROM legal.legal_cases lc WHERE lc.contract_id::text = :itemId';

const linked = (alternatives) => `EXISTS (SELECT 1 FROM people.file_links fl WHERE fl.file_id = x.id AND fl.deleted_at IS NULL AND (${alternatives.join(' OR ')}))`;
const link = (kind, idSql) => `(fl.related_entity_type IN (:${kind}Types) AND fl.related_entity_id::text ${idSql})`;

/** Predicados (alias x) por tipo de registro, para cada item que se espalha. */
const SPREAD = {
  [SCOPE_TYPES.PERSON]: {
    PERSON: 'x.id::text = :itemId',
    CONTRACT: `x.id::text IN (${CONTRACTS_OF_PERSON})`,
    LEGAL_CASE: `x.id::text IN (${CASES_OF_PERSON})`,
    TAX_DOCUMENT: `x.contract_id::text IN (${CONTRACTS_OF_PERSON})`,
    FILE: linked([link('person', '= :itemId'), link('contract', `IN (${CONTRACTS_OF_PERSON})`), link('case', `IN (${CASES_OF_PERSON})`)]),
  },
  [SCOPE_TYPES.CONTRACT]: {
    CONTRACT: 'x.id::text = :itemId',
    LEGAL_CASE: 'x.contract_id::text = :itemId',
    TAX_DOCUMENT: 'x.contract_id::text = :itemId',
    FILE: linked([link('contract', '= :itemId'), link('case', `IN (${CASES_OF_CONTRACT})`)]),
  },
  [SCOPE_TYPES.LEGAL_CASE]: {
    LEGAL_CASE: 'x.id::text = :itemId',
    FILE: linked([link('case', '= :itemId')]),
  },
};

/** Predicados do item para cada tipo que ele alcança (vazio: o item não se espalha, só tem linha própria). */
function predicates(item) {
  if (SPREAD[item.type]) return SPREAD[item.type];
  if (item.type === SCOPE_TYPES.DATA_TYPE && (item.from || item.to) && TABLES[item.entityType]) {
    return { [item.entityType]: `${localDate(item.entityType)} BETWEEN COALESCE(CAST(:from AS date), DATE '0001-01-01') AND COALESCE(CAST(:to AS date), DATE '9999-12-31')` };
  }
  return {};
}

const replacementsOf = (hold, item, extra) => ({
  groupId: hold.groupId, companyId: hold.companyId, holdId: hold.id, itemId: item.id || null, from: item.from || null, to: item.to || null,
  personTypes: LINK_TYPES.PERSON, contractTypes: LINK_TYPES.CONTRACT, caseTypes: LINK_TYPES.LEGAL_CASE, ...extra,
});

async function insertSpread(hold, item, type, predicate, ids, transaction) {
  const restrict = ids ? ' AND x.id::text IN (:ids)' : '';
  await sequelize.query(
    `INSERT INTO governance.legal_hold_targets (group_id, company_id, hold_id, entity_type, entity_id, origin)
     SELECT :groupId, :companyId, :holdId, '${type}', x.id::text, '${ORIGIN.DERIVED}' FROM ${qualified(type)} x
      WHERE x.company_id = :companyId AND (${predicate})${restrict} ON CONFLICT (hold_id, entity_type, entity_id) DO NOTHING`,
    { type: QueryTypes.INSERT, transaction, replacements: replacementsOf(hold, item, ids ? { ids } : {}) }
  );
}

async function insertRow(hold, entityType, entityId, origin, transaction) {
  await sequelize.query(
    `INSERT INTO governance.legal_hold_targets (group_id, company_id, hold_id, entity_type, entity_id, origin) VALUES (:groupId, :companyId, :holdId, :entityType, :entityId, :origin)
     ON CONFLICT (hold_id, entity_type, entity_id) DO NOTHING`,
    { type: QueryTypes.INSERT, transaction, replacements: { groupId: hold.groupId, companyId: hold.companyId, holdId: hold.id, entityType, entityId, origin } }
  );
}

/** Materializa o escopo inteiro da retenção (criação, e recálculo antes de mostrar o impacto). */
async function expand(hold, transaction) {
  for (const item of hold.scope) {
    if (item.type === SCOPE_TYPES.COMPANY) await insertRow(hold, COMPANY, WILDCARD, ORIGIN.EXPLICIT, transaction);
    else if (item.type === SCOPE_TYPES.ENTITY) await insertRow(hold, item.entityType, item.id, ORIGIN.EXPLICIT, transaction);
    else if (item.type === SCOPE_TYPES.DATA_TYPE && !(item.from || item.to)) await insertRow(hold, item.entityType, WILDCARD, ORIGIN.EXPLICIT, transaction);
    else for (const [type, predicate] of Object.entries(predicates(item))) await insertSpread(hold, item, type, predicate, null, transaction);
  }
}

/** Inclui nos alvos, para os `ids` do `type` pedidos, os registros que as retenções ativas passaram a alcançar depois de criadas. */
async function ensure(holds, type, ids, transaction) {
  for (const hold of holds) {
    for (const item of hold.scope) {
      const predicate = predicates(item)[type];
      if (predicate) await insertSpread(hold, item, type, predicate, ids, transaction);
    }
  }
}

module.exports = { expand, ensure, predicates };
