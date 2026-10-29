'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Consultas dos tipos de conteúdo (M9-D409). Só as visões marketing.* (nunca tabela de origem); a RLS vale na transação do chamador. */
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/** Situação do imóvel (publicação e disponibilidade), sem nenhum dado pessoal. */
async function readPropertyStatus(propertyId, tenant, transaction) {
  const [row] = await run(
    'SELECT publication_status, availability_status FROM marketing.v_property_status WHERE company_id = :companyId AND property_id = :propertyId',
    { companyId: tenant.companyId, propertyId }, transaction
  );
  return row ? { publication: row.publication_status, availability: row.availability_status } : null;
}

/** Empreendimentos com etapa publicável: { projectId, stage } (a etapa pública mais avançada de cada um). */
async function listPublicConstructions(tenant, transaction) {
  const rows = await run('SELECT project_id, etapa_publica FROM marketing.v_public_construction WHERE company_id = :companyId ORDER BY project_id', { companyId: tenant.companyId }, transaction);
  return rows.map((r) => ({ projectId: r.project_id, stage: r.etapa_publica }));
}

/** Pessoas que fazem aniversário no dia e mês informados (primeiro nome, dia e mês: nada além disso). */
async function listBirthdays({ day, month }, tenant, transaction) {
  const rows = await run(
    `SELECT person_id, primeiro_nome, dia, mes FROM marketing.v_relationship_facts
      WHERE company_id = :companyId AND marco = 'BIRTHDAY' AND dia = :day AND mes = :month ORDER BY person_id`,
    { companyId: tenant.companyId, day, month }, transaction
  );
  return rows.map((r) => ({ personId: r.person_id, primeiroNome: r.primeiro_nome, dia: r.dia, mes: r.mes }));
}

module.exports = { readPropertyStatus, listPublicConstructions, listBirthdays };
