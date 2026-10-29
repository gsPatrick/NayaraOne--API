'use strict';

/**
 * M9-D617 / M9-D640 — a regra de "imóvel locável" num só lugar, para o read model de vacância (rm_rental_vacancy) e a origem do KPI de vacância (detalhe) contarem os mesmos
 * imóveis: não excluído nem inativo, com situação disponível ou alugada, com oferta de locação ou contrato de locação em vigor (ACTIVE ou SUSPENDED) e sem obra em andamento.
 * SQL fixo do código; os nomes dos parâmetros (tipos de contrato de locação e situações de obra) e o apelido da tabela de imóveis vêm de quem chama.
 */
function rentableWhere(alias, { leaseTypes, worksStatuses }) {
  const lease = (status) => `EXISTS (SELECT 1 FROM legal.contracts c WHERE c.company_id = ${alias}.company_id AND c.property_id = ${alias}.id AND c.deleted_at IS NULL AND c.contract_type IN (${leaseTypes}) AND c.status = '${status}')`;
  const offer = `EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.company_id = ${alias}.company_id AND o.property_id = ${alias}.id AND o.deleted_at IS NULL AND o.offer_type IN ('RENT', 'SEASONAL'))`;
  return {
    sql: `${alias}.deleted_at IS NULL AND COALESCE(${alias}.publication_status, '') <> 'INACTIVE' AND ${alias}.availability_status IN ('AVAILABLE', 'RENTED') AND (${offer} OR ${lease('ACTIVE')} OR ${lease('SUSPENDED')})
       AND NOT EXISTS (SELECT 1 FROM construction.projects w WHERE w.company_id = ${alias}.company_id AND w.property_id = ${alias}.id AND w.deleted_at IS NULL AND w.status IN (${worksStatuses}))`,
    rented: lease('ACTIVE'),
  };
}

module.exports = { rentableWhere };
