'use strict';

const {
  Person,
  PersonRole,
  PersonContact,
  PersonDocument,
  PersonAddress,
  CommunicationConsent,
  PropertyOwner,
  Opportunity,
  Visit,
  PropertyRadar,
  Message,
  ContractParty,
  Signature,
  BankAccount,
  OwnerRepass,
  MaintenanceCase,
  AuditLog,
  Contract: ContractModel,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { publishPersonMerged } = require('./personEvents.service');

/**
 * mergePersons — POST /people/:id/merge ("Merge controlado.") — REFORÇADO no ciclo de
 * auditoria externa Marco 3 (item 1), lendo o contrato bruto diretamente:
 *
 *   Caderno Pessoas/Imóveis/CRM/Radar, §29 ("Merge seguro de Pessoas"):
 *     1. Detectar possível duplicidade e abrir merge_case.
 *     2. Bloquear merge automático se houver conflito de CPF/CNPJ, contratos ativos
 *        incompatíveis ou restrição jurídica.
 *     3. Escolher canonical_person_id.
 *     4. Criar snapshot das duas pessoas e referências afetadas.
 *     5. Em uma única transação, remapear FKs permitidas para canonical_person_id.
 *     6. Preservar documentos/versionamento; nunca sobrescrever arquivo.
 *     7. Marcar absorbed_person status=MERGED e merged_into_id=canonical.
 *     8. Gerar evento person.merged e audit log com mapa de referências.
 *     9. Permitir reversão somente por processo técnico supervisionado; nunca botão comum.
 *
 * DIVERGÊNCIA DOCUMENTADA (migrations bloqueadas nesta sessão — credencial de
 * `nayara_migration` em `.env.migration.local` rejeitada pelo Postgres, sem acesso para
 * corrigi-la): o Caderno fala em abrir um "merge_case" como registro de duplicidade detectada.
 * Não há tabela "merge_cases" no schema físico atual e não foi possível criar uma via DDL
 * nesta sessão. Em vez disso, o "merge_case" é registrado como uma entrada própria em
 * "audit"."audit_log" (action='person.merge_case.opened', ANTES de qualquer checagem de
 * conflito), contendo os dois ids e o motivo da duplicidade suspeitada — preserva a
 * rastreabilidade exigida pelo item 1 enquanto a tabela dedicada não puder ser migrada.
 *
 * Passo 2 (bloqueios) nesta implementação:
 *   - conflito de CPF/CNPJ (já existia): ambas preenchidas e diferentes.
 *   - contratos ativos incompatíveis (NOVO): qualquer "legal"."contracts" com status='ACTIVE'
 *     em que AMBAS as pessoas (canônica e absorvida) apareçam como "legal"."contract_parties"
 *     do MESMO contrato — duas partes do mesmo instrumento jurídico ativo não podem colapsar
 *     em uma só pessoa (ex.: comprador e vendedor do mesmo contrato).
 *   - restrição jurídica: sem uma tabela "LegalCase.restriction"/equivalente confirmada pelo
 *     contrato especificamente para bloquear merge, não implementada nesta iteração (mesma
 *     lacuna já documentada antes desta auditoria).
 *
 * Passo 4 (snapshot): `beforeJson` agora grava o estado COMPLETO de ambas as pessoas
 * (`toJSON()`) antes de qualquer alteração, não só os ids — "Criar snapshot das duas pessoas e
 * referências afetadas."
 *
 * Passo 8 (mapa de referências): o payload de `person.merged` e o `afterJson` da auditoria
 * final passam a incluir `remappedReferences` — contagem de linhas remapeadas por tabela,
 * para efetivamente documentar o "mapa de referências" exigido pelo Caderno (até aqui o
 * evento só carregava canonicalId/absorbedId, sem dizer o que foi remapeado).
 *
 * Passo 9 (reversão supervisionada): ver `reverseMergeSupervised` abaixo — função SEPARADA,
 * não um simples "desfazer", exige `reason` com justificativa mínima e fica registrada com uma
 * action distinta (`person.merge.reversed_supervised`) para nunca ser confundida com uma
 * operação de usuário comum.
 *
 * Remapeamento de FKs — cobre TODA tabela do schema físico atual com uma coluna apontando para
 * people.persons (auditado em src/models/*.js, não só os módulos com feature/CRUD já
 * construído): person_roles, person_contacts, person_documents, person_addresses,
 * communication_consents, real_estate.property_owners, crm.opportunities, crm.visits,
 * crm.property_radars, crm.messages, legal.contract_parties, legal.signatures,
 * finance.bank_accounts (owner_person_id), finance.owner_repasses (owner_person_id),
 * construction.maintenance_cases (opened_by_person_id). A coluna existir no banco já obriga o
 * remapeamento, independente de já existir uma rota HTTP para aquele módulo — senão o merge
 * deixa dado órfão apontando para a pessoa MERGED. Se um módulo novo adicionar uma FK de pessoa
 * no futuro, ela precisa ser adicionada aqui também.
 */
async function assertNoIncompatibleActiveContracts(canonicalId, absorbedId, transaction) {
  if (!ContractModel) return; // modelo ainda não carregado neste ambiente — não bloqueia por omissão de dependência técnica.

  const canonicalPartyContractIds = (
    await ContractParty.findAll({ where: { personId: canonicalId }, transaction, attributes: ['contractId'] })
  ).map((p) => p.contractId);
  const absorbedPartyContractIds = (
    await ContractParty.findAll({ where: { personId: absorbedId }, transaction, attributes: ['contractId'] })
  ).map((p) => p.contractId);

  const sharedContractIds = canonicalPartyContractIds.filter((id) => absorbedPartyContractIds.includes(id));
  if (sharedContractIds.length === 0) return;

  const activeSharedContracts = await ContractModel.findAll({
    where: { id: sharedContractIds, status: 'ACTIVE' },
    transaction,
  });

  if (activeSharedContracts.length > 0) {
    throw AppError.unprocessable(
      'Merge bloqueado: as duas pessoas são partes do MESMO contrato ativo — fundi-las colapsaria duas partes distintas de um instrumento jurídico em vigor.',
      'PERSON_MERGE_CONFLICT_ACTIVE_CONTRACT',
      { contractIds: activeSharedContracts.map((c) => c.id) }
    );
  }
}

async function mergePersons(canonicalId, absorbedId, actorUserId, transaction) {
  if (!absorbedId) {
    throw AppError.badRequest('O campo "absorbedId" é obrigatório.', 'PERSON_MERGE_VALIDATION');
  }
  if (canonicalId === absorbedId) {
    throw AppError.badRequest('"absorbedId" não pode ser igual ao id canônico.', 'PERSON_MERGE_VALIDATION');
  }

  // FIX (homologação 23/09/2026 — auditoria adversarial, mesmo padrão do bug de conciliação
  // bancária corrigido nesta sessão): sem lock pessimista aqui, dois merges concorrentes do
  // MESMO absorbedId pra canônicos DIFERENTES (duplo clique, duas abas) liam
  // `absorbed.status !== 'MERGED'` ao mesmo tempo e os dois passavam — resultado: FKs
  // remapeadas de forma inconsistente entre os dois canônicos (a segunda escrita de
  // mergedIntoId vence, mas os UPDATEs de FK de cada merge já rodaram parcialmente contra o
  // canônico errado), dois eventos person.merged publicados, duas linhas de auditoria
  // contraditórias descrevendo o mesmo absorbedId fundido em pessoas diferentes. FOR UPDATE na
  // leitura de `absorbed` serializa: o segundo merge concorrente espera o primeiro commitar e
  // então reavalia `status === 'MERGED'` corretamente, barrando a segunda tentativa.
  const canonical = await Person.findByPk(canonicalId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!canonical) throw AppError.notFound('Pessoa canônica não encontrada.', 'PERSON_NOT_FOUND');

  const absorbed = await Person.findByPk(absorbedId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!absorbed) throw AppError.notFound('Pessoa absorvida não encontrada.', 'PERSON_NOT_FOUND');

  if (absorbed.status === 'MERGED') {
    throw AppError.unprocessable('A pessoa absorvida já foi fundida anteriormente.', 'PERSON_ALREADY_MERGED');
  }

  // Passo 1 do Caderno ("Detectar possível duplicidade e abrir merge_case") — registrado
  // ANTES de qualquer checagem de conflito, para que a tentativa de merge fique rastreada
  // mesmo quando é bloqueada a seguir. Ver nota de divergência no cabeçalho do módulo (sem
  // tabela merge_cases dedicada nesta sessão — migrations bloqueadas).
  await AuditLog.create(
    {
      groupId: canonical.groupId,
      companyId: canonical.companyId,
      userId: actorUserId || null,
      action: 'person.merge_case.opened',
      entityType: 'Person',
      entityId: canonicalId,
      beforeJson: null,
      afterJson: { canonicalId, absorbedId, detectedAt: new Date().toISOString() },
      occurredAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  if (canonical.taxIdNormalized && absorbed.taxIdNormalized && canonical.taxIdNormalized !== absorbed.taxIdNormalized) {
    throw AppError.unprocessable(
      'Conflito de identidade: as duas pessoas têm documentos (CPF/CNPJ) preenchidos e diferentes entre si.',
      'PERSON_MERGE_CONFLICT',
      { canonicalTaxId: canonical.taxIdNormalized, absorbedTaxId: absorbed.taxIdNormalized }
    );
  }

  await assertNoIncompatibleActiveContracts(canonicalId, absorbedId, transaction);

  // Passo 4 ("Criar snapshot das duas pessoas e referências afetadas") — snapshot COMPLETO de
  // ambas, não só os ids/status.
  const beforeJson = { canonical: canonical.toJSON(), absorbed: absorbed.toJSON() };

  // Remapeamento de FKs — todas as linhas do absorvido passam a apontar para o canônico.
  // `remappedReferences` acumula quantas linhas foram afetadas por tabela — é o "mapa de
  // referências" exigido pelo passo 8 do Caderno.
  const remappedReferences = {};

  async function remapAndCount(key, Model, where) {
    if (!Model) return;
    const [count] = await Model.update({ personId: canonicalId }, { where, transaction });
    remappedReferences[key] = count;
  }

  await remapAndCount('people.person_roles', PersonRole, { personId: absorbedId });
  await remapAndCount('people.person_contacts', PersonContact, { personId: absorbedId });
  await remapAndCount('people.person_documents', PersonDocument, { personId: absorbedId });
  await remapAndCount('people.person_addresses', PersonAddress, { personId: absorbedId });
  await remapAndCount('people.communication_consents', CommunicationConsent, { personId: absorbedId });
  await remapAndCount('real_estate.property_owners', PropertyOwner, { personId: absorbedId });
  // crm.opportunities / crm.visits / crm.property_radars já existem e referenciam person_id
  // diretamente (Marco 3, não é módulo futuro) — remapear é obrigatório para o merge não deixar
  // oportunidades/visitas/radares órfãos apontando para a pessoa MERGED.
  await remapAndCount('crm.opportunities', Opportunity, { personId: absorbedId });
  await remapAndCount('crm.visits', Visit, { personId: absorbedId });
  await remapAndCount('crm.property_radars', PropertyRadar, { personId: absorbedId });
  await remapAndCount('crm.messages', Message, { personId: absorbedId });
  // Tabelas com FK de pessoa já existentes no schema físico (Marco 1&2), ainda sem
  // feature/CRUD próprio construído — a coluna existe no banco, então precisa ser remapeada
  // igual, senão o merge deixa dado órfão silenciosamente.
  await remapAndCount('legal.contract_parties', ContractParty, { personId: absorbedId });
  await remapAndCount('legal.signatures', Signature, { personId: absorbedId });
  if (BankAccount) {
    const [count] = await BankAccount.update({ ownerPersonId: canonicalId }, { where: { ownerPersonId: absorbedId }, transaction });
    remappedReferences['finance.bank_accounts'] = count;
  }
  if (OwnerRepass) {
    const [count] = await OwnerRepass.update({ ownerPersonId: canonicalId }, { where: { ownerPersonId: absorbedId }, transaction });
    remappedReferences['finance.owner_repasses'] = count;
  }
  if (MaintenanceCase) {
    const [count] = await MaintenanceCase.update({ openedByPersonId: canonicalId }, { where: { openedByPersonId: absorbedId }, transaction });
    remappedReferences['construction.maintenance_cases'] = count;
  }

  absorbed.status = 'MERGED';
  absorbed.mergedIntoId = canonicalId;
  absorbed.updatedBy = actorUserId || null;
  await absorbed.save({ transaction });

  await publishPersonMerged(canonical, absorbed, remappedReferences, transaction);

  // audit.audit_log — trilha de auditoria append-only (AuditLog model já existe; escrita
  // direta aqui pois não há um helper reusável de auditoria compartilhado pelas outras
  // features ainda — ver observação no relatório de entrega).
  await AuditLog.create(
    {
      groupId: canonical.groupId,
      companyId: canonical.companyId,
      userId: actorUserId || null,
      action: 'person.merge',
      entityType: 'Person',
      entityId: canonicalId,
      beforeJson,
      afterJson: { canonicalId, absorbedId, absorbedStatus: 'MERGED', remappedReferences },
      occurredAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return { canonicalId, absorbedId, status: 'MERGED', remappedReferences };
}

/**
 * reverseMergeSupervised — Passo 9 do Caderno: "Permitir reversão somente por processo técnico
 * supervisionado; nunca botão comum." NÃO é um "desfazer" de um clique — exige `reason` (texto
 * de justificativa com conteúdo real, não vazio/trivial) e grava uma action de auditoria
 * DISTINTA (`person.merge.reversed_supervised`) para que fique claramente marcado como uma
 * operação excepcional, nunca confundível com um fluxo de usuário comum (não existe rota
 * pública "desfazer merge" nem botão equivalente na API — quem chama esta função precisa ser
 * um processo técnico, com motivo registrado).
 *
 * Reversão aqui = devolver a pessoa absorvida ao status ACTIVE e desfazer o vínculo
 * merged_into_id — ela NÃO tenta "desfazer" os remapeamentos de FK automaticamente (as
 * referências já remapeadas continuam apontando para o canônico; mover cada uma de volta
 * exigiria saber quais já existiam antes do merge vs. quais foram criadas depois, o que o
 * snapshot em `beforeJson` registrado no merge original permite auditar manualmente, mas não
 * foi pedido pelo Caderno como automático).
 */
async function reverseMergeSupervised(canonicalId, absorbedId, reason, actorUserId, transaction) {
  if (!reason || String(reason).trim().length < 10) {
    throw AppError.badRequest(
      'Reversão de merge exige "reason" com justificativa real (mínimo 10 caracteres) — processo técnico supervisionado, não um botão comum.',
      'PERSON_MERGE_REVERSAL_REASON_REQUIRED'
    );
  }

  const absorbed = await Person.findByPk(absorbedId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!absorbed) throw AppError.notFound('Pessoa absorvida não encontrada.', 'PERSON_NOT_FOUND');
  if (absorbed.status !== 'MERGED' || absorbed.mergedIntoId !== canonicalId) {
    throw AppError.unprocessable(
      'Esta pessoa não está fundida no canônico informado — não há merge para reverter.',
      'PERSON_MERGE_REVERSAL_NOT_MERGED'
    );
  }

  const beforeJson = { absorbed: absorbed.toJSON() };

  absorbed.status = 'ACTIVE';
  absorbed.mergedIntoId = null;
  absorbed.updatedBy = actorUserId || null;
  await absorbed.save({ transaction });

  await AuditLog.create(
    {
      groupId: absorbed.groupId,
      companyId: absorbed.companyId,
      userId: actorUserId || null,
      action: 'person.merge.reversed_supervised',
      entityType: 'Person',
      entityId: absorbedId,
      beforeJson,
      afterJson: { canonicalId, absorbedId, status: 'ACTIVE', reason: String(reason) },
      occurredAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return { canonicalId, absorbedId, status: 'ACTIVE' };
}

module.exports = { mergePersons, reverseMergeSupervised };
