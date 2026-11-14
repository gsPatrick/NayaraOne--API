'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { LINK_TYPES } = require('./legalHold.catalog');

/** Os contratos, processos e arquivos ligados a uma pessoa (o que a exclusão ou anonimização dela alcança). Respeita a RLS da transação. */
async function relatedOf(personId, transaction) {
  const ask = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements: { personId: String(personId), personTypes: LINK_TYPES.PERSON, contractTypes: LINK_TYPES.CONTRACT, caseTypes: LINK_TYPES.LEGAL_CASE } });
  const contracts = (await ask("SELECT cp.contract_id::text AS id FROM legal.contract_parties cp WHERE cp.person_id::text = :personId AND cp.deleted_at IS NULL")).map((r) => r.id);
  const cases = (await ask(`SELECT lp.legal_case_id::text AS id FROM legal.case_parties lp WHERE lp.person_id::text = :personId
    UNION SELECT lc.id::text FROM legal.legal_cases lc WHERE lc.contract_id::text IN (SELECT cp.contract_id::text FROM legal.contract_parties cp WHERE cp.person_id::text = :personId AND cp.deleted_at IS NULL)`)).map((r) => r.id);
  const files = (await ask(`SELECT DISTINCT fl.file_id::text AS id FROM people.file_links fl WHERE fl.deleted_at IS NULL AND fl.related_entity_type IN (:personTypes) AND fl.related_entity_id::text = :personId`)).map((r) => r.id);
  return { CONTRACT: contracts, LEGAL_CASE: cases, FILE: files };
}

module.exports = { relatedOf };
