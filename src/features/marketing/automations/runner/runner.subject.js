'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

const PERSON_FIELDS = ['personId', 'subjectId', 'deliveredToPersonId', 'clientPersonId', 'customerId'];

/**
 * Sujeito do evento do outbox: eventos `person.*` têm a própria pessoa como agregado; os demais trazem `personId` (ou campo equivalente) no payload. Sem
 * pessoa, o evento roda sem sujeito (as ações de envio ficam sem endereço).
 */
function resolveSubject(event) {
  const payload = event.payloadJson || event.payload || {};
  if (String(event.eventType || '').startsWith('person.') && event.aggregateId) return { type: 'PERSON', id: event.aggregateId };
  for (const field of PERSON_FIELDS) if (payload[field]) return { type: 'PERSON', id: String(payload[field]) };
  return null;
}

/**
 * Isolamento (M9-D414): a pessoa precisa existir na empresa do evento (a RLS esconde a de outra empresa) e o payload não pode apontar para outra empresa.
 * Sujeito que não passa é CROSS_COMPANY; a run nasce BLOCKED e nenhuma ação executa.
 */
async function subjectIsInCompany(subject, tenant, payload, transaction) {
  if (payload && payload.companyId && payload.companyId !== tenant.companyId) return false;
  if (!subject) return true;
  const rows = await sequelize.query('SELECT 1 AS ok FROM people.persons WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL',
    { replacements: { id: subject.id, companyId: tenant.companyId }, transaction, type: QueryTypes.SELECT });
  return rows.length > 0;
}

module.exports = { resolveSubject, subjectIsInCompany };
