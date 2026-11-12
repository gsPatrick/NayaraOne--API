'use strict';

/**
 * Lista REVISADA de toda referência à pessoa que o merge trata (M3-04, DI-M3PE-5). Conferida no catálogo do banco em 11/11/2026: 39 colunas
 * com chave estrangeira para people.persons(id) e 13 sem chave estrangeira (12 uuid e 1 lista JSON). O teste people.merge.referencias compara esta lista com o
 * catálogo e FALHA se aparecer FK nova (ou coluna `*person*_id` nova sem FK) que não esteja aqui.
 *
 * Políticas:
 *   REMAPEAR - a linha passa a apontar para a pessoa canônica (UPDATE na transação do merge);
 *   ESPECIAL - remapeada depois do ajuste que evita violar a chave única (personMerge.references.prepararEspeciais);
 *   FORA     - não muda, com o motivo. A pessoa absorvida nunca é apagada (status MERGED, merged_into_id = canônica): a referência continua
 *              válida e leva à canônica.
 * Conflito de chave única que o ajuste não resolve (ex.: as duas pessoas na mesma audiência de campanha, ou com conversa no mesmo canal)
 * bloqueia o merge inteiro com 422 PERSON_MERGE_UNIQUE_CONFLICT (nada é gravado) e a recusa fica na auditoria.
 */
const R = Object.freeze({ politica: 'REMAPEAR' });
const E = Object.freeze({ politica: 'ESPECIAL' });
const fora = (motivo) => Object.freeze({ politica: 'FORA', motivo });

const REFERENCIAS_REVISADAS = Object.freeze({
  // Pessoas (os filhos da própria pessoa).
  'people.person_contacts.person_id': R,
  'people.person_addresses.person_id': E, // um endereço atual por pessoa e empresa
  'people.person_documents.person_id': E, // versão única por pessoa, empresa e tipo
  'people.person_roles.person_id': E, // chave pessoa + papel + empresa
  'people.communication_consents.person_id': R,
  'people.person_company_links.person_id': fora('O vínculo da pessoa absorvida com cada empresa é histórico; a canônica tem os seus (UNIQUE pessoa+empresa).'),
  'people.persons.merged_into_id': fora('Cadeia de mesclagem: quem já foi mesclado na absorvida continua apontando para ela, que aponta para a canônica.'),
  // Imóveis e CRM.
  'real_estate.property_owners.person_id': R,
  'crm.opportunities.person_id': R,
  'crm.visits.person_id': R,
  'crm.property_radars.person_id': R,
  'crm.messages.person_id': R,
  'crm.conversations.person_id': R,
  'crm.feedback_cases.person_id': R,
  'crm.proposals.proposed_by_person_id': R,
  // Financeiro.
  'finance.bank_accounts.owner_person_id': R,
  'finance.owner_repasses.owner_person_id': R,
  'finance.ownership_transfer_tasks.from_person_id': R,
  'finance.ownership_transfer_tasks.to_person_id': R,
  'finance.utility_accounts.holder_person_id': R,
  'finance.financial_entries.third_party_holder_person_id': fora('Lançamento financeiro é append-only (FIN-003/010): a coluna não muda depois de criada; a absorvida leva à canônica.'),
  // Jurídico e locação.
  'legal.contract_parties.person_id': R,
  'legal.contract_parties.represented_by_person_id': R,
  'legal.signatures.person_id': R,
  'legal.addendum_signatures.person_id': fora('Assinatura de aditivo é imutável (gatilho addendum_signatures_immutable).'),
  'legal.case_parties.person_id': R,
  'legal.guarantees.guarantor_person_id': R,
  'legal.guarantees.holder_person_id': R,
  'legal.key_deliveries.delivered_to_person_id': R,
  // Compras, correspondente e obras.
  'procurement.supplier_qualifications.supplier_person_id': R,
  'correspondent.case_applicants.person_id': R,
  'construction.maintenance_cases.opened_by_person_id': R,
  'construction.daily_workers.person_id': R,
  // Marketing.
  'marketing.attribution_events.person_id': R,
  'marketing.campaign_audience_members.person_id': R,
  'marketing.campaign_step_deliveries.person_id': R,
  'marketing.reminder_pendings.person_id': R,
  'marketing.review_requests.person_id': R,
  'marketing.suppression_list.person_id': R,
});

/** Referências SEM chave estrangeira que apontam para a pessoa (lista fechada, conferida nos models): [tabela, coluna]. Todas REMAPEAR. */
const REFERENCIAS_SEM_FK = Object.freeze([
  ['procurement.purchase_orders', 'supplier_person_id'],
  ['procurement.supplier_offers', 'supplier_person_id'],
  ['procurement.supplier_evaluations', 'supplier_person_id'],
  ['procurement.goods_receipts', 'supplier_person_id'],
  ['procurement.insurance_policy_parties', 'person_id'],
  ['inventory.receipts', 'supplier_person_id'],
  ['inventory.inventory_movements', 'responsible_person_id'],
  ['inventory.loss_cases', 'responsible_person_id'],
  ['legal.key_deliveries', 'term_signed_by_person_id'],
  ['legal.notices', 'recipient_person_id'],
]);

/** Colunas com "person" no nome que NÃO são referência a pessoa remapeável, com o motivo (o teste exige que toda coluna esteja numa lista). */
const COLUNAS_SEM_FK_FORA = Object.freeze({
  'inventory.tool_loans.person_user_id': 'É usuário do sistema (core.users), não pessoa do cadastro.',
  'legal.notice_versions.recipient_person_id': 'Versão de notificação é append-only (gatilho notice_versions_append_only): registro do que foi enviado.',
  'legal.guarantees.additional_guarantor_person_ids': 'Lista JSON de fiadores adicionais: remapeada item a item (personMerge.references, garantias).',
});

/** Tipos do vínculo polimórfico de arquivos (people.file_links.related_entity_type) que são a pessoa. */
const TIPOS_DE_ARQUIVO = Object.freeze(['Person', 'Supplier']);

module.exports = { REFERENCIAS_REVISADAS, REFERENCIAS_SEM_FK, COLUNAS_SEM_FK_FORA, TIPOS_DE_ARQUIVO };
