'use strict';

/** Enumerações da fila de merge e review (M9-D805). São valores de domínio, não códigos de erro. */
const ENTITY_TYPES = Object.freeze(['PERSON', 'PROPERTY', 'SUPPLIER']);
const KINDS = Object.freeze({ MERGE_CANDIDATE: 'MERGE_CANDIDATE', REVIEW: 'REVIEW' });
const STATUS = Object.freeze({ OPEN: 'OPEN', IN_REVIEW: 'IN_REVIEW', MERGED: 'MERGED', KEPT_SEPARATE: 'KEPT_SEPARATE', DISMISSED: 'DISMISSED' });
const FINAL_STATUSES = Object.freeze([STATUS.MERGED, STATUS.KEPT_SEPARATE, STATUS.DISMISSED]);
const DECISIONS = Object.freeze([STATUS.MERGED, STATUS.KEPT_SEPARATE, STATUS.DISMISSED]);

/** Domínio de dados (M9-D804) cujo owner ou steward decide cada tipo de entidade. */
const DOMAIN_BY_ENTITY = Object.freeze({ PERSON: 'PESSOAS', PROPERTY: 'IMOVEIS', SUPPLIER: 'FORNECEDORES' });

/** Regras de detecção; o score de cada uma é o parâmetro governanca.dados.merge.scores (padrão do item 3.2). */
const REASONS = Object.freeze({
  PERSON_TAX_ID: 'PERSON_TAX_ID',
  PERSON_NAME_CONTACT: 'PERSON_NAME_CONTACT',
  PERSON_NAME_BIRTH: 'PERSON_NAME_BIRTH',
  PROPERTY_REGISTRY: 'PROPERTY_REGISTRY',
  PROPERTY_ADDRESS_UNIT: 'PROPERTY_ADDRESS_UNIT',
  PROPERTY_ADDRESS_AREA: 'PROPERTY_ADDRESS_AREA',
  SUPPLIER_CNPJ_ROOT: 'SUPPLIER_CNPJ_ROOT',
  SUPPLIER_NAME: 'SUPPLIER_NAME',
  QUALITY_CRITICAL: 'QUALITY_CRITICAL',
});

/** Quem o papel SUPPLIER torna fornecedor (pessoa com este papel ativo). */
const SUPPLIER_ROLE = 'SUPPLIER';

/** Referências sem chave estrangeira que também seguem o sobrevivente (lista fechada do item 3.4): [tabela, coluna]. */
const SUPPLIER_EXTRA_REFERENCES = Object.freeze([
  ['procurement.purchase_orders', 'supplier_person_id'],
  ['procurement.supplier_offers', 'supplier_person_id'],
  ['procurement.supplier_evaluations', 'supplier_person_id'],
  ['procurement.goods_receipts', 'supplier_person_id'],
  ['inventory.receipts', 'supplier_person_id'],
]);

/** Tipos de entidade do vínculo polimórfico de arquivos (people.file_links.related_entity_type) que seguem o sobrevivente. */
const FILE_LINK_TYPES = Object.freeze({ PERSON: ['Person', 'Supplier'], SUPPLIER: ['Person', 'Supplier'], PROPERTY: ['Property'] });

/** Tabelas que o reapontamento genérico não toca: leitura derivada (a linha do absorvido é removida) e papéis (tratados por retireSharedRoles; a chave é pessoa+papel+empresa). */
const DERIVED_TABLES = Object.freeze(['real_estate.public_property_read_model', 'people.person_roles']);

/**
 * Histórico imutável dos Marcos 3 e 5 (gatilhos do banco): a linha guarda o cadastro como era no fato e NÃO é reapontada; continua no cadastro
 * absorvido, que segue existindo com merged_into_id para o sobrevivente (nada se perde e o histórico não é reescrito). Chave 'tabela.coluna';
 * valor: condição SQL das linhas congeladas (as demais seguem o sobrevivente).
 *   crm.radar_matches (migration 9972, Guia M3 §9) e crm.cart_events (10313): rastro append-only;
 *   legal.addendum_signatures (9986): assinatura do aditivo;
 *   legal.guarantees (15600): só a garantia SUBSTITUÍDA, que faz parte do histórico do contrato; a vigente segue o sobrevivente;
 *   marketing.campaign_step_deliveries (Marco 9, 0757): a identidade da entrega não muda. A mesma política está no catálogo do merge de
 *   Pessoas (people/personMerge.catalog.js), que roda antes deste reapontamento genérico.
 */
const HISTORY_REFERENCES = Object.freeze({
  'crm.radar_matches.property_id': 'true',
  'crm.cart_events.property_id': 'true',
  'legal.addendum_signatures.person_id': 'true',
  'legal.guarantees.holder_person_id': 'replaced_by_guarantee_id IS NOT NULL',
  'legal.guarantees.guarantor_person_id': 'replaced_by_guarantee_id IS NOT NULL',
  // Marco 9 (mkt_campaign_step_deliveries_guard): a pessoa da entrega da campanha não muda; o envio fica com quem recebeu.
  'marketing.campaign_step_deliveries.person_id': 'true',
});

/** Identificadores dos impedimentos de união (os mesmos dos serviços de pessoa e de imóvel) devolvidos por /impact. */
const BLOCKERS = Object.freeze({
  PERSON_TAX_ID: 'PERSON_MERGE_CONFLICT',
  PERSON_ACTIVE_CONTRACT: 'PERSON_MERGE_CONFLICT_ACTIVE_CONTRACT',
  PROPERTY_REGISTRY: 'PROPERTY_MERGE_CONFLICT_DISTINCT_REGISTRY',
});

module.exports = {
  BLOCKERS, ENTITY_TYPES, KINDS, STATUS, FINAL_STATUSES, DECISIONS, DOMAIN_BY_ENTITY, REASONS, SUPPLIER_ROLE, SUPPLIER_EXTRA_REFERENCES, FILE_LINK_TYPES, DERIVED_TABLES, HISTORY_REFERENCES,
};
