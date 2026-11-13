'use strict';

const legalHold = require('../core-governance/data-quality/legalHold.guard');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { Person, PersonContact, PersonDocument, PersonRole, PersonAddress } = require('../../models');
const AppError = require('../../utils/AppError');
const { onlyDigits, hashTaxId, assertValidTaxId } = require('./personDocumentFormat.service');
const { assertCreationAllowed, registrarRevisoes } = require('./personDedupGate');
const { createChildren } = require('./personCreateChildren');
const { publishPersonCreated, publishPersonUpdated } = require('./personEvents.service');
const { scorePersonDataQuality } = require('./personDataQuality.service');
const { projectForSession, assertBaseOwner, isLinkedElsewhereError, linkedElsewhereError } = require('./personView');
const { registrarTentativa } = require('./personLinks.service');
const { assertEvidenceForCriticalChange, recordFieldChangeEvidence, personEntity } = require('../core-governance/data-quality/evidence');

/**
 * CRUD puro de Person (mais a criação inicial de seus contacts/documents embutidos no payload
 * de criação). Deduplicação vive em personDedup.service.js; validação de formato de documento
 * vive em personDocumentFormat.service.js; contacts/documents/roles como sub-recursos têm CRUD
 * próprio em personContacts.service.js / personDocuments.service.js / personRoles.service.js.
 *
 * "people"."persons" é o cadastro do GRUPO visto por VÍNCULO com a empresa (migration 20260101010940, DI-M9I-1): a sessão lê a
 * pessoa da empresa responsável pela base (company_id) ou com vínculo ACTIVE em people.person_company_links; só a responsável
 * grava a base (persons_company_insert/update/delete, migration 20260101009965). Os filhos (contatos, endereços, documentos,
 * papéis, consentimentos) são da empresa da sessão, com RLS por `company_id = current_setting('app.company_id', true)` e chave
 * composta para o vínculo (migration 20260101010941). Toda query aqui recebe `transaction` já aberta por
 * `req.withTenantTransaction` (ver src/middlewares/tenant.middleware.js).
 */

/**
 * createPerson — `options.podeForcarDuplicidade` (a sessão tem people:dedup:override; o controller informa; chamadas internas = sistema) e
 * `options.modoSemelhante` ('EXIGIR' pela tela: o cadastro parecido só é criado com similarReviewed=true; 'FILA', o padrão das criações
 * automáticas: cria e manda o par à fila de revisão). Ver personDedupGate.js.
 */
async function createPerson(payload, actorUserId, transaction, options = {}) {
  const { groupId, companyId, personType, legalName, taxIdNormalized, birthOrFoundationDate, status, contacts } = payload;

  // groupId/companyId vêm da sessão (não são campos que a pessoa preenche): faltar é falha de contexto, e a mensagem não cita nome técnico.
  if (!groupId || !companyId) {
    throw AppError.badRequest('Não foi possível identificar a empresa da sua sessão. Entre novamente e tente de novo.', 'PERSON_VALIDATION', {
      fields: [],
    });
  }
  if (!legalName || !String(legalName).trim()) {
    throw AppError.badRequest('Informe o nome da pessoa.', 'PERSON_VALIDATION', {
      fields: [{ field: 'legalName', message: 'Informe o nome da pessoa.' }],
    });
  }

  const normalizedType = (personType || 'PF').toUpperCase();
  if (!['PF', 'PJ'].includes(normalizedType)) {
    throw AppError.badRequest('O campo "personType" deve ser "PF" ou "PJ".', 'PERSON_VALIDATION', {
      fields: [{ field: 'personType', message: 'Escolha pessoa física (PF) ou jurídica (PJ).' }],
    });
  }

  const taxIdDigits = onlyDigits(taxIdNormalized) || null;
  assertValidTaxId(normalizedType, taxIdDigits); // M3-01: formato (400) e dígito verificador (422 PERSON_TAX_ID_INVALID)

  // Deduplicação ANTES de criar (livro §4, CRMX-010): forte, forte no grupo, médio, médio no grupo e fraco (personDedupGate.js).
  const ctx = { groupId, companyId, actorUserId, podeForcarDuplicidade: options.podeForcarDuplicidade, modoSemelhante: options.modoSemelhante || 'FILA' };
  const plano = await assertCreationAllowed({ ...payload, taxIdDigits, contacts }, ctx, transaction);
  let person;
  try {
    person = await Person.create(
      {
        groupId,
        companyId,
        personType: normalizedType,
        legalName,
        preferredName: payload.preferredName || null,
        taxIdNormalized: taxIdDigits,
        taxIdNormalizedHash: hashTaxId(taxIdDigits),
        birthOrFoundationDate: birthOrFoundationDate || null,
        status: status || 'ACTIVE',
        riskFlagsJson: payload.riskFlagsJson || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } catch (error) {
    // UNIQUE(group_id, tax_id_normalized) é a identidade rígida do banco (TAB-0100) e nada a contorna. O portão já recusou o CPF/CNPJ
    // desta empresa e o das outras empresas do grupo; chegar aqui é corrida com um cadastro gravado ao mesmo tempo: o caminho é o vínculo.
    if (error.name === 'SequelizeUniqueConstraintError' && /tax_id_normalized/.test(error.parent?.detail || error.parent?.message || '')) {
      registrarTentativa(transaction, { groupId, companyId }, actorUserId, 'CPF_CNPJ_JA_NO_GRUPO');
      throw AppError.conflict(
        'Este CPF/CNPJ já tem cadastro em outra empresa do grupo. Para usar esse cadastro aqui, vincule-o a esta empresa informando o CPF/CNPJ e o nome como está no documento.',
        'PERSON_TAX_ID_IN_GROUP'
      );
    }
    throw error;
  }

  await publishPersonCreated(person, transaction);
  // Quem cadastrou, o quê e quando. Sem documento nem contato no registro: a trilha guarda a identidade e o tipo, não o dado pessoal.
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'people.person.create',
      entityType: 'Person',
      entityId: person.id,
      beforeJson: null,
      afterJson: { id: person.id, personType: normalizedType, status: person.status },
      reason: 'Pessoa cadastrada.',
    },
    transaction
  );

  await createChildren(person, payload, actorUserId, transaction);
  await registrarRevisoes(person, plano, ctx, transaction);

  return getPerson(person.id, transaction);
}

// Sub-recursos sempre devolvidos junto da Person. `roles` e `addresses` entram aqui porque a
// listagem/ficha de contatos precisa filtrar por papel e exibir o endereço atual sem ter que
// fazer uma chamada extra por pessoa (N+1) — os sub-recursos continuam tendo CRUD próprio em
// /people/:id/roles e /people/:id/addresses.
const PERSON_INCLUDE = [
  { model: PersonContact, as: 'contacts' },
  { model: PersonDocument, as: 'documents' },
  { model: PersonRole, as: 'roles' },
  { model: PersonAddress, as: 'addresses' },
];

async function listPersons(transaction, filters = {}) {
  const where = {};
  if (filters.personType) where.personType = String(filters.personType).toUpperCase();
  if (filters.status) where.status = filters.status;
  const persons = await Person.findAll({
    where,
    include: PERSON_INCLUDE,
    order: [['created_at', 'DESC']],
    transaction,
  });
  return projectForSession(persons, transaction); // DI-M9I-3: pessoa vinculada vem só com a base
}

async function getPerson(id, transaction) {
  const person = await Person.findByPk(id, {
    include: PERSON_INCLUDE,
    transaction,
  });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  // Caderno (seção 16, "NAY Comercial" — "classifica qualidade do cadastro e documentos
  // faltantes"): derivado na leitura, não persistido. IMPORTANTE: `Model#toJSON()` do Sequelize
  // só serializa atributos reais — uma propriedade solta atribuída à instância (`person.x = y`)
  // é silenciosamente descartada por `res.json`/`JSON.stringify`. Por isso devolvemos um objeto
  // plano (`{ ...person.toJSON(), dataQuality }`), mesmo padrão já usado em `afterJson` em todo
  // o projeto (ex: opportunity.service.js), em vez de anexar a propriedade na instância.
  return projectForSession({ ...person.toJSON(), dataQuality: scorePersonDataQuality(person) }, transaction);
}

async function updatePerson(id, payload, actorUserId, transaction) {
  const person = await Person.findByPk(id, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  await assertBaseOwner(person, transaction); // DI-M9I-3: a base só muda pela empresa responsável

  const currentCritical = { legalName: person.legalName, taxIdNormalized: person.taxIdNormalized, birthOrFoundationDate: person.birthOrFoundationDate };
  const { legalName, preferredName, taxIdNormalized, birthOrFoundationDate, status, personType, riskFlagsJson } = payload;
  if (legalName !== undefined) person.legalName = legalName;
  if (preferredName !== undefined) person.preferredName = preferredName;
  if (personType !== undefined) {
    const normalizedType = String(personType).toUpperCase();
    if (!['PF', 'PJ'].includes(normalizedType)) {
      throw AppError.badRequest('O campo "personType" deve ser "PF" ou "PJ".', 'PERSON_VALIDATION');
    }
    person.personType = normalizedType;
  }
  if (taxIdNormalized !== undefined) {
    const taxIdDigits = onlyDigits(taxIdNormalized) || null;
    assertValidTaxId(person.personType, taxIdDigits); // M3-01: a troca do CPF/CNPJ também confere o dígito verificador
    person.taxIdNormalized = taxIdDigits;
    person.taxIdNormalizedHash = hashTaxId(taxIdDigits);
  }
  if (birthOrFoundationDate !== undefined) person.birthOrFoundationDate = birthOrFoundationDate;
  if (status !== undefined) person.status = status;
  if (riskFlagsJson !== undefined) person.riskFlagsJson = riskFlagsJson;
  // M9-D807: campo crítico (CPF/CNPJ, nome, nascimento) só muda com origem e comprovante, gravados na mesma transação.
  const patch = {};
  ['legalName', 'taxIdNormalized', 'birthOrFoundationDate'].forEach((field) => { if (payload[field] !== undefined) patch[field] = person[field]; });
  const entity = await personEntity(person, currentCritical, transaction);
  const assertion = await assertEvidenceForCriticalChange(entity, patch, payload.changeEvidence, { transaction, actorUserId });
  person.updatedBy = actorUserId || null;
  await person.save({ transaction });
  await recordFieldChangeEvidence(entity, assertion, { transaction, actorUserId });
  await publishPersonUpdated(person, transaction);
  return getPerson(id, transaction);
}

async function deletePerson(id, actorUserId, transaction) {
  await legalHold.assertPersonErasable(id, transaction); // M9-D912: pessoa (ou contrato, processo e arquivo dela) sob retenção legal não se apaga
  const person = await Person.findByPk(id, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  await assertBaseOwner(person, transaction); // DI-M9I-3: a vinculada desfaz o vínculo (POST /people/:id/unlink), não exclui a base
  person.deletedBy = actorUserId || null;
  try {
    await person.save({ transaction });
    await person.destroy({ transaction }); // soft delete (paranoid: true no model)
  } catch (err) {
    if (isLinkedElsewhereError(err)) throw linkedElsewhereError(); // gatilho persons_base_vinculada_nao_some
    throw err;
  }
  return { id };
}

module.exports = { createPerson, listPersons, getPerson, updatePerson, deletePerson };
