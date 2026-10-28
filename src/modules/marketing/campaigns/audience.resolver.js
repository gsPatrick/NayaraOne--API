'use strict';

/**
 * Monta o SELECT de pessoas de uma audiência (M9-D412). Sempre restrito à empresa da campanha e a pessoas ativas, não excluídas e
 * não mescladas em outra. O resultado é só uma lista de ids para materializar e contar: nada daqui é exportado (Caderno §14).
 * Devolve { sql, replacements } com a coluna person_id; `p` é people.persons.
 */
const BASE = `FROM people.persons p
   WHERE p.company_id = :companyId AND p.deleted_at IS NULL AND p.status = 'ACTIVE' AND p.merged_into_id IS NULL`;

function segmentConditions(filter, replacements) {
  const where = [];
  if (filter.roles) {
    replacements.roles = filter.roles;
    where.push(`EXISTS (SELECT 1 FROM people.person_roles r WHERE r.person_id = p.id AND r.company_id = :companyId AND r.deleted_at IS NULL
      AND r.role_code IN (:roles) AND (r.ends_at IS NULL OR r.ends_at > :now))`);
  }
  if (filter.opportunityStages || filter.temperatures) {
    const parts = ['o.person_id = p.id', 'o.company_id = :companyId', 'o.deleted_at IS NULL'];
    if (filter.opportunityStages) { replacements.stages = filter.opportunityStages; parts.push('o.stage IN (:stages)'); }
    if (filter.temperatures) { replacements.temperatures = filter.temperatures; parts.push('o.temperature IN (:temperatures)'); }
    where.push(`EXISTS (SELECT 1 FROM crm.opportunities o WHERE ${parts.join(' AND ')})`);
  }
  if (filter.personType) { replacements.personType = filter.personType; where.push('p.person_type = :personType'); }
  return where;
}

function radarConditions(filter, replacements) {
  const parts = ['rd.person_id = p.id', 'rd.company_id = :companyId', 'rd.deleted_at IS NULL', "rd.status = 'ACTIVE'"];
  if (filter.radarIds) { replacements.radarIds = filter.radarIds; parts.push('rd.id IN (:radarIds)'); }
  for (const key of ['propertyType', 'offerType', 'city', 'state']) {
    if (filter[key]) {
      replacements[`radar_${key}`] = filter[key];
      parts.push(`upper(rd.criteria_json->>'${key}') = upper(:radar_${key})`);
    }
  }
  return [`EXISTS (SELECT 1 FROM crm.property_radars rd WHERE ${parts.join(' AND ')})`];
}

function buildPersonQuery(audience, tenant, now) {
  const replacements = { companyId: tenant.companyId, now };
  let where = [];
  if (audience.kind === 'PERSON_LIST') { replacements.personIds = audience.filter.personIds; where = ['p.id IN (:personIds)']; }
  else if (audience.kind === 'SEGMENT') where = segmentConditions(audience.filter, replacements);
  else where = radarConditions(audience.filter, replacements);
  return { sql: `SELECT p.id AS person_id ${BASE}${where.map((w) => ` AND ${w}`).join('')}`, replacements };
}

module.exports = { buildPersonQuery };
