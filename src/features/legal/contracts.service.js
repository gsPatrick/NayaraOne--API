'use strict';

const { Contract, ContractParty, ContractVersion, Signature, Guarantee, Person, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishContractStatusChanged } = require('./legalEvents.service');

// M6-104: CONSTRUCTION adicionado (dependência cruzada com o Marco 6/Obras) — contrato de
// empreitada, precisa se vincular a uma obra em construction.projects (ver validação em
// createContract abaixo e migrations/20260101000237-add-construction_project_id-to-legal-contracts.js).
const CONTRACT_TYPES = ['SALE', 'LEASE', 'SERVICE', 'CONSTRUCTION'];

// Prefixo de numeração por contractType — ver 20260101000177-create-legal-contract_number_sequences.js.
const CONTRACT_NUMBER_PREFIX = { LEASE: 'LOC', SALE: 'VEN', SERVICE: 'SRV', CONSTRUCTION: 'OBR' };

/**
 * generateContractNumber — gera o próximo número no formato "{PREFIXO}-{ANO}-{SEQ:04d}"
 * (ex.: "LOC-2026-0001"), sequencial reiniciando por (companyId, contractType, ano corrente).
 *
 * CONCORRÊNCIA: usa um único `INSERT ... ON CONFLICT (company_id, contract_type, year)
 * DO UPDATE SET last_seq = contract_number_sequences.last_seq + 1 RETURNING last_seq` — é uma
 * instrução atômica no Postgres (o UPDATE de um upsert em conflito roda sob o lock de linha
 * implícito da própria operação), então duas criações concorrentes NUNCA leem o mesmo
 * last_seq: a segunda transação a chegar espera a primeira liberar a linha (lock de índice
 * único) e enxerga o valor já incrementado. Deliberadamente NÃO usamos `SELECT COUNT(*) + 1`
 * (corrida real: duas transações podem contar o mesmo total e gerar o mesmo próximo número).
 */
async function generateContractNumber(companyId, contractType, transaction) {
  const prefix = CONTRACT_NUMBER_PREFIX[contractType];
  if (!prefix) {
    throw AppError.badRequest(`Não há prefixo de numeração configurado para contractType "${contractType}".`, 'LEGAL_CONTRACT_VALIDATION');
  }
  const year = new Date().getFullYear();

  const [rows] = await sequelize.query(
    `INSERT INTO "legal"."contract_number_sequences" (id, company_id, contract_type, "year", last_seq, created_at, updated_at)
     VALUES (gen_random_uuid(), :companyId, :contractType, :year, 1, now(), now())
     ON CONFLICT (company_id, contract_type, "year")
     DO UPDATE SET last_seq = "legal"."contract_number_sequences".last_seq + 1, updated_at = now()
     RETURNING last_seq`,
    {
      replacements: { companyId, contractType, year },
      transaction,
    }
  );
  const seq = rows[0].last_seq;
  const seqPadded = String(seq).padStart(4, '0');
  return `${prefix}-${year}-${seqPadded}`;
}

// Máquina de estados do Contract.status. Ordem linear conforme especificado no doc do Marco 5:
// DRAFT -> DOCUMENTS_PENDING -> LEGAL_REVIEW -> APPROVED -> SIGNING -> SIGNED -> ACTIVE.
// DECISÃO DE ENGENHARIA: nenhum caminho de "voltar" ou "cancelar" foi especificado no doc —
// modelamos apenas as transições avante da linha do tempo (nada de LEGAL_REVIEW -> DRAFT),
// e adicionamos CANCELLED como estado terminal alcançável de qualquer estado não-ACTIVE, já
// que todo processo de negócio real precisa de uma saída de cancelamento — mas isso NÃO está
// no doc, é decisão nossa, documentada aqui explicitamente.
const VALID_TRANSITIONS = {
  DRAFT: ['DOCUMENTS_PENDING', 'CANCELLED'],
  DOCUMENTS_PENDING: ['LEGAL_REVIEW', 'CANCELLED'],
  LEGAL_REVIEW: ['APPROVED', 'DOCUMENTS_PENDING', 'CANCELLED'],
  APPROVED: ['SIGNING', 'CANCELLED'],
  SIGNING: ['SIGNED', 'CANCELLED'],
  SIGNED: ['ACTIVE'],
  ACTIVE: [],
  CANCELLED: [],
};

// DECISÃO DE ENGENHARIA — "Requirements Gate": o doc pede para "escolher um ponto de
// verificação sensato e documentar". Escolhemos o ponto DRAFT -> DOCUMENTS_PENDING: antes de
// sair de rascunho, o contrato precisa ter as partes mínimas para o seu contract_type, porque
// a etapa seguinte (DOCUMENTS_PENDING) já pressupõe que sabemos QUEM vai assinar/documentar.
// Papéis mínimos por tipo de contrato (não estão explicitados literalmente no doc — inferidos
// dos party_role documentados em ContractParty: LANDLORD|TENANT|GUARANTOR|BUYER|SELLER):
const REQUIRED_ROLES_BY_TYPE = {
  LEASE: ['LANDLORD', 'TENANT'],
  SALE: ['SELLER', 'BUYER'],
  SERVICE: [], // prestação de serviço não tem papéis fixos definidos no doc — sem gate de partes.
};

async function assertRequirementsGate(contract, transaction) {
  const requiredRoles = REQUIRED_ROLES_BY_TYPE[contract.contractType] || [];
  if (requiredRoles.length === 0) return;

  const parties = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
  const presentRoles = new Set(parties.map((p) => p.partyRole));
  const missing = requiredRoles.filter((role) => !presentRoles.has(role));
  if (missing.length > 0) {
    throw AppError.conflict(
      `Contrato do tipo "${contract.contractType}" precisa ter partes com os papéis: ${missing.join(', ')} antes de avançar de status.`,
      'LEGAL_CONTRACT_REQUIREMENTS_GATE'
    );
  }
}

// FIX HOM-001 (homologação 28/08/2026, reportado pela cliente): a transição de status era
// exposta via POST /legal/contracts/:id/transition chamando transitionContractStatus
// diretamente com QUALQUER targetStatus permitido em VALID_TRANSITIONS, sem checar se existia
// versão documental ou assinatura — só o fluxo automático do webhook (handleSignatureWebhook)
// validava assinaturas antes de virar SIGNED, mas nada impedia chamar a transição manual e
// pular esse caminho. Resultado real observado: contrato foi de DRAFT a ACTIVE sem nenhuma
// versão de documento nem assinatura. Os dois gates abaixo fecham essa lacuna na própria
// máquina de estados, então qualquer chamador (endpoint manual ou webhook) fica protegido.
// FIX AUD-008 (homologação 14/09/2026, reprovado pela cliente com evidência real — contrato
// b7198a6c-7748-433b-9efc-331e1a87b64d): o gate anterior só checava se EXISTIA alguma
// ContractVersion (versionCount > 0), sem checar se essa versão tinha um documento real
// anexado (documentFileId). Isso permitia criar uma versão só com um texto qualquer (satisfaz
// "content não vazio", ver contractVersions.service.js) e avançar até SIGNING com um
// content_hash calculado em cima de nada que representasse o documento de verdade. Confirmado
// no ambiente: contrato tinha v1 com hash mas documentFileId null, em SIGNING. Agora o gate
// exige que a ÚLTIMA versão tenha um documentFileId real (arquivo efetivamente anexado).
async function assertDocumentGate(contract, transaction) {
  const latestVersion = await ContractVersion.findOne({
    where: { contractId: contract.id },
    order: [['version_number', 'DESC']],
    transaction,
  });
  if (!latestVersion) {
    throw AppError.conflict(
      'O contrato precisa ter ao menos uma versão de documento registrada antes de avançar para "SIGNING".',
      'LEGAL_CONTRACT_DOCUMENT_GATE'
    );
  }
  if (!latestVersion.documentFileId) {
    throw AppError.conflict(
      'A versão mais recente do contrato não tem um documento real anexado (documentFileId ausente) — não é possível avançar para "SIGNING" com um hash calculado sobre um conteúdo que não representa o documento de verdade.',
      'LEGAL_CONTRACT_DOCUMENT_GATE'
    );
  }
}

async function assertSignatureGate(contract, transaction) {
  const latestVersion = await ContractVersion.findOne({
    where: { contractId: contract.id },
    order: [['version_number', 'DESC']],
    transaction,
  });
  if (!latestVersion) {
    throw AppError.conflict(
      'O contrato precisa ter uma versão de documento antes de avançar para "SIGNED".',
      'LEGAL_CONTRACT_DOCUMENT_GATE'
    );
  }
  // FIX (29/09/2026, mesmo padrão do gate de ativação abaixo): "toda Signature que existe está
  // SIGNED" não garante que EXISTE uma Signature pra cada parte obrigatória — cruza contra
  // REQUIRED_ROLES_BY_TYPE.
  const signatures = await Signature.findAll({ where: { contractVersionId: latestVersion.id }, transaction });
  const requiredRolesForSigning = REQUIRED_ROLES_BY_TYPE[contract.contractType] || [];
  let allSigned = signatures.length > 0 && signatures.every((s) => s.status === 'SIGNED');
  if (allSigned && requiredRolesForSigning.length > 0) {
    const parties = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
    const signedPersonIds = new Set(signatures.filter((s) => s.status === 'SIGNED').map((s) => s.personId));
    allSigned = requiredRolesForSigning.every((role) =>
      parties.some((p) => p.partyRole === role && signedPersonIds.has(p.personId))
    );
  }
  if (!allSigned) {
    throw AppError.conflict(
      'O contrato precisa ter todas as assinaturas confirmadas (status "SIGNED") de TODAS as partes obrigatórias antes de avançar para "SIGNED".',
      'LEGAL_CONTRACT_SIGNATURE_GATE'
    );
  }
}

/**
 * M5-10 (fechamento) — GATE DE ATIVAÇÃO (SIGNED -> ACTIVE).
 *
 * Até aqui a transição SIGNED -> ACTIVE estava protegida apenas por TRANSITIVIDADE: para
 * chegar em SIGNED o contrato já teria passado por assertDocumentGate (SIGNING) e
 * assertSignatureGate (SIGNED). Isso é frágil por dois motivos reais:
 *   1) quem chama `transitionContractStatus` passa a INSTÂNCIA do contrato em mãos — basta ela
 *      ter `status = 'SIGNED'` (carregada de uma linha adulterada por fora, ou mutada em
 *      memória por um chamador interno) para que a ativação aconteça sem nenhuma reconferência;
 *   2) o mundo muda ENTRE a assinatura e a ativação (uma assinatura pode ser cancelada, uma
 *      garantia pode ser recusada/expirada) — ativar sem reconferir congela uma decisão tomada
 *      com dados velhos.
 *
 * O gate abaixo NÃO assume nada do passado: reconfirma ativamente, no momento da ativação:
 *   (a) existe ContractVersion vigente com `documentFileId` real (documento anexado);
 *   (b) TODAS as Signature dessa versão estão SIGNED (e há ao menos uma);
 *   (c) SE existir alguma Guarantee vinculada ao contrato, ao menos uma está ACTIVE.
 *
 * DECISÃO DE ENGENHARIA DOCUMENTADA sobre (c): contrato SEM NENHUMA garantia cadastrada NÃO é
 * bloqueado. "Todo contrato exige garantia" não está definido no Caderno e não é verdade no
 * mercado (locação com pagamento antecipado, contratos de venda, prestação de serviço). O que
 * é inaceitável — e é o que travamos — é ativar um contrato cuja ÚNICA garantia registrada
 * está CANCELLED/EXPIRED/PENDING: nesse caso alguém quis garantia, ela não está valendo, e
 * ativar seria entregar o imóvel sem a proteção que o próprio contrato previu. Se no futuro a
 * cliente definir tipos de contrato com garantia obrigatória, a regra entra aqui (e vira
 * configuração por tenant, no mesmo padrão de legal.contract_version_requires_document).
 */
async function assertActivationGate(contract, transaction) {
  const latestVersion = await ContractVersion.findOne({
    where: { contractId: contract.id },
    order: [['version_number', 'DESC']],
    transaction,
  });
  if (!latestVersion || !latestVersion.documentFileId) {
    throw AppError.conflict(
      'Não é possível ATIVAR o contrato: não há versão de documento com arquivo real anexado (documentFileId).',
      'LEGAL_CONTRACT_ACTIVATION_GATE'
    );
  }

  // FIX (29/09/2026 — cliente achou um contrato de teste ativo com só 1 de 2 partes
  // obrigatórias assinadas): checar "toda Signature que existe está SIGNED" NÃO é suficiente —
  // se só foi criada Signature pra UMA das partes (ex.: a outra nunca foi convidada a assinar,
  // ou a criação da Signature dela falhou em silêncio antes de outro fix desta sessão),
  // `signatures.every(...)` passa igual, porque não há nenhuma Signature ruim pra reprovar, só
  // falta uma inteira. Precisa cruzar contra REQUIRED_ROLES_BY_TYPE + as partes reais do
  // contrato (mesmo padrão já usado em handleSignatureWebhook, signatures.service.js) — cada
  // papel obrigatório do tipo de contrato precisa ter uma pessoa titular com Signature SIGNED,
  // não só "as assinaturas que existem estão OK".
  const signatures = await Signature.findAll({ where: { contractVersionId: latestVersion.id }, transaction });
  const requiredRoles = REQUIRED_ROLES_BY_TYPE[contract.contractType] || [];
  let allSigned = signatures.length > 0 && signatures.every((s) => s.status === 'SIGNED');
  if (allSigned && requiredRoles.length > 0) {
    const parties = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
    const signedPersonIds = new Set(signatures.filter((s) => s.status === 'SIGNED').map((s) => s.personId));
    allSigned = requiredRoles.every((role) =>
      parties.some((p) => p.partyRole === role && signedPersonIds.has(p.personId))
    );
  }
  if (!allSigned) {
    throw AppError.conflict(
      'Não é possível ATIVAR o contrato: a versão vigente do documento não tem todas as assinaturas confirmadas (status "SIGNED") de TODAS as partes obrigatórias.',
      'LEGAL_CONTRACT_ACTIVATION_GATE'
    );
  }

  const guarantees = await Guarantee.findAll({ where: { contractId: contract.id }, transaction });
  if (guarantees.length > 0 && !guarantees.some((g) => g.status === 'ACTIVE')) {
    throw AppError.conflict(
      'Não é possível ATIVAR o contrato: existem garantias cadastradas, mas nenhuma delas está com status "ACTIVE".',
      'LEGAL_CONTRACT_ACTIVATION_GATE'
    );
  }
}

async function createContract(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, opportunityId, contractType, contractNumber, totalValue, startsAt, endsAt, constructionProjectId } = payload;
  if (!groupId || !companyId || !contractType) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "contractType" são obrigatórios.', 'LEGAL_CONTRACT_VALIDATION');
  }
  if (!CONTRACT_TYPES.includes(contractType)) {
    throw AppError.badRequest(`"contractType" deve ser um de: ${CONTRACT_TYPES.join(', ')}.`, 'LEGAL_CONTRACT_VALIDATION');
  }
  // M6-104: contrato de empreitada (CONSTRUCTION) precisa nascer já vinculado à obra —
  // sem isso não há como o Marco 6 amarrar o contrato à execução física da obra.
  if (contractType === 'CONSTRUCTION' && !constructionProjectId) {
    throw AppError.badRequest(
      '"constructionProjectId" é obrigatório para contratos do tipo "CONSTRUCTION".',
      'LEGAL_CONTRACT_CONSTRUCTION_PROJECT_REQUIRED'
    );
  }

  // Numeração automática: só gera se o chamador não informou um número explícito (correção
  // manual via correctContractData continua livre para sobrescrever depois, se necessário).
  const finalContractNumber = contractNumber || (await generateContractNumber(companyId, contractType, transaction));

  const contract = await Contract.create(
    {
      groupId,
      companyId,
      propertyId: propertyId || null,
      opportunityId: opportunityId || null,
      constructionProjectId: constructionProjectId || null,
      contractType,
      contractNumber: finalContractNumber,
      status: 'DRAFT',
      totalValue: totalValue !== undefined ? totalValue : null,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'legal.contract.create',
      entityType: 'Contract',
      entityId: contract.id,
      afterJson: contract.toJSON(),
      reason: `Contrato do tipo "${contractType}" criado em DRAFT.`,
    },
    transaction
  );

  return contract;
}

async function listContracts(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.contractType) where.contractType = String(filters.contractType).toUpperCase();
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return Contract.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getContract(id, transaction) {
  const contract = await Contract.findByPk(id, {
    include: [{ model: ContractVersion, as: 'versions', include: [{ association: 'template', attributes: ['id', 'name'] }] }],
    transaction,
  });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  return contract;
}

/**
 * transitionContractStatus — valida a transição contra VALID_TRANSITIONS, roda o
 * Requirements Gate quando a transição de saída é DRAFT -> DOCUMENTS_PENDING, persiste,
 * audita e publica o evento de domínio. Sempre recebe/retorna a MESMA instância `contract`
 * (evita 2 SELECTs quando o chamador já a tem em mãos, ex.: signatures.service.js).
 */
async function transitionContractStatus(contract, targetStatus, actorUserId, transaction) {
  // NOTA DE INVESTIGAÇÃO (homologação, contrato c00af665-98b9-47bc-8aa2-b7c7143ec894 —
  // "Violação de restrição de unicidade" ao avançar para SIGNING): a hipótese inicial foi uma
  // corrida de concorrência aqui (duas transições simultâneas do mesmo `fromStatus` disputando
  // o mesmo INSERT no outbox de eventos). Investigação confirmou que essa corrida específica JÁ
  // é coberta pelo lock otimista existente no model `Contract` (`lockVersion`/`version` — ver
  // Contract.js): `contract.save()` abaixo falha primeiro com `OptimisticLockError` quando duas
  // transições concorrentes partem do mesmo estado, então a segunda NUNCA chega a tentar o
  // INSERT duplicado no outbox — não há violação de UNIQUE possível por esse caminho (ver
  // ADV-L17 em test/adversarial.legal.test.js, que já provava isso). Adicionar aqui um `SELECT
  // ... FOR UPDATE` extra SERIALIZARIA as duas transições em vez de rejeitar a perdedora — o que
  // mudaria um comportamento correto (a segunda falha rápido e o cliente decide se tenta de
  // novo) para um comportamento diferente (a segunda espera e reaplica sobre o estado novo),
  // sem necessidade real. A CAUSA RAIZ verdadeira do "Violação de restrição de unicidade" deste
  // contrato estava em `createContractVersion` (contractVersions.service.js) — o cálculo de
  // `nextVersionNumber` ali SIM tinha um SELECT sem lock antes de decidir, e é lá que o fix e o
  // teste de regressão (ADV-L18) foram aplicados.
  const fromStatus = contract.status;
  const allowedTargets = VALID_TRANSITIONS[fromStatus] || [];
  if (!allowedTargets.includes(targetStatus)) {
    throw AppError.conflict(
      `Transição de status inválida: "${fromStatus}" -> "${targetStatus}". Transições permitidas a partir de "${fromStatus}": ${allowedTargets.join(', ') || '(nenhuma)'}.`,
      'LEGAL_CONTRACT_INVALID_TRANSITION'
    );
  }

  if (fromStatus === 'DRAFT' && targetStatus === 'DOCUMENTS_PENDING') {
    await assertRequirementsGate(contract, transaction);
  }
  if (targetStatus === 'SIGNING') {
    await assertDocumentGate(contract, transaction);
  }
  if (targetStatus === 'SIGNED') {
    await assertSignatureGate(contract, transaction);
  }
  if (targetStatus === 'ACTIVE') {
    await assertActivationGate(contract, transaction);
  }

  const beforeJson = contract.toJSON();
  contract.status = targetStatus;
  contract.updatedBy = actorUserId || null;
  await contract.save({ transaction });

  await publishContractStatusChanged(contract, fromStatus, transaction);

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract.status_change',
      entityType: 'Contract',
      entityId: contract.id,
      beforeJson,
      afterJson: contract.toJSON(),
      reason: `Contrato transicionado de "${fromStatus}" para "${targetStatus}".`,
    },
    transaction
  );

  return contract;
}

async function addContractParty(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { personId, partyRole } = payload;
  const VALID_ROLES = ['LANDLORD', 'TENANT', 'GUARANTOR', 'BUYER', 'SELLER'];
  if (!personId || !partyRole) {
    throw AppError.badRequest('Os campos "personId" e "partyRole" são obrigatórios.', 'LEGAL_CONTRACT_PARTY_VALIDATION');
  }
  if (!VALID_ROLES.includes(partyRole)) {
    throw AppError.badRequest(`"partyRole" deve ser um de: ${VALID_ROLES.join(', ')}.`, 'LEGAL_CONTRACT_PARTY_VALIDATION');
  }

  // FIX (homologação — contrato com "as partes aparecem sem nome"): `personId` nunca era
  // conferido contra a tabela `people.persons`. Um `personId` inválido/de outro tenant (RLS faz
  // `Person.findByPk` sob o mesmo tenant do `getContract` acima simplesmente não achar a
  // pessoa) ainda assim criava a linha em `legal.contract_parties` — o contrato ficava com uma
  // parte "órfã" que nenhuma tela consegue resolver (a listagem de pessoas do tenant nunca
  // contém esse id), e a tela de detalhe do contrato cai no fallback "—"/"?" do nome, porque o
  // dado nunca existiu de fato, não porque a tela falhou em exibi-lo. Fail closed: exige que a
  // pessoa exista (mesmo tenant, via RLS) antes de gravar a parte.
  const person = await Person.findByPk(personId, { transaction });
  if (!person) {
    throw AppError.badRequest(
      `Pessoa "${personId}" não encontrada — não é possível adicionar uma parte ao contrato com um "personId" inexistente.`,
      'LEGAL_CONTRACT_PARTY_PERSON_NOT_FOUND'
    );
  }

  const party = await ContractParty.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId: contract.id,
      personId,
      partyRole,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract_party.create',
      entityType: 'ContractParty',
      entityId: party.id,
      afterJson: party.toJSON(),
      reason: `Parte "${partyRole}" adicionada ao contrato ${contract.id}.`,
    },
    transaction
  );

  return party;
}

async function listContractParties(contractId, transaction) {
  return ContractParty.findAll({ where: { contractId }, transaction });
}

// Campos corrigíveis via correctContractData — deliberadamente NÃO inclui `status`
// (isso é responsabilidade exclusiva de transitionContractStatus, que valida a máquina de
// estados) nem `id`/`groupId`/`companyId` (identidade do registro, nunca "corrigida").
const CORRECTABLE_FIELDS = ['startsAt', 'endsAt', 'totalValue', 'contractNumber', 'propertyId', 'opportunityId'];

/**
 * correctContractData — AUD-004: a homologação apontou que não existia nenhuma forma
 * auditada de corrigir dados já registrados de um contrato (ex.: vigência informada errada).
 * Diferente de um update genérico, esta função:
 *   - Exige um motivo (`reason`) não vazio — correção de dado já gravado sem justificativa
 *     documentada não é aceitável (rastreabilidade).
 *   - Só aceita campos em CORRECTABLE_FIELDS — nunca o status (a máquina de estados já cobre
 *     isso com suas próprias regras) nem colunas de identidade/tenant.
 *   - Bloqueia contratos CANCELLED (nada a corrigir num contrato encerrado).
 *   - Sempre grava um evento de auditoria append-only `legal.contract.data_correction` com
 *     beforeJson/afterJson completos, o motivo e o autor — nunca sobrescreve silenciosamente.
 */
async function correctContractData(contractId, payload, actorUserId, transaction) {
  const { reason, ...fields } = payload || {};
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('O campo "reason" é obrigatório para justificar a correção.', 'LEGAL_CONTRACT_CORRECTION_VALIDATION');
  }

  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) {
    throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  }
  if (contract.status === 'CANCELLED') {
    throw AppError.conflict('Contrato cancelado não pode ter dados corrigidos.', 'LEGAL_CONTRACT_CORRECTION_CANCELLED');
  }

  const requestedFields = Object.keys(fields).filter((key) => fields[key] !== undefined);
  const invalidFields = requestedFields.filter((key) => !CORRECTABLE_FIELDS.includes(key));
  if (invalidFields.length > 0) {
    throw AppError.badRequest(
      `Os campos [${invalidFields.join(', ')}] não podem ser corrigidos por esta ação. Campos permitidos: ${CORRECTABLE_FIELDS.join(', ')}.`,
      'LEGAL_CONTRACT_CORRECTION_FIELD_NOT_ALLOWED'
    );
  }
  if (requestedFields.length === 0) {
    throw AppError.badRequest('Informe ao menos um campo para corrigir.', 'LEGAL_CONTRACT_CORRECTION_VALIDATION');
  }

  const beforeJson = contract.toJSON();
  for (const field of requestedFields) {
    contract[field] = fields[field];
  }
  contract.updatedBy = actorUserId || null;
  await contract.save({ transaction });

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract.data_correction',
      entityType: 'Contract',
      entityId: contract.id,
      beforeJson,
      afterJson: contract.toJSON(),
      reason: `Correção de dados do contrato: ${reason}`,
    },
    transaction
  );

  return contract;
}

module.exports = {
  createContract,
  listContracts,
  getContract,
  transitionContractStatus,
  addContractParty,
  listContractParties,
  correctContractData,
  assertActivationGate,
  generateContractNumber,
  CORRECTABLE_FIELDS,
  CONTRACT_TYPES,
  VALID_TRANSITIONS,
  REQUIRED_ROLES_BY_TYPE,
  CONTRACT_NUMBER_PREFIX,
};
