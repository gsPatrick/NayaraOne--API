'use strict';

const AppError = require('../../utils/AppError');
const { getCurrentCorrelationId } = require('../../middlewares/correlationId.middleware');
const { onlyDigits, validateDocumentFormat } = require('./personDocumentFormat.service');
const { readPersonLinkParams } = require('./personLink.settings');
const { contextCompanyId } = require('./personView');

/**
 * Vínculo de uma pessoa já cadastrada no grupo com a empresa da sessão (CRMX-015; DI-M9I-2 a DI-M9I-6).
 *
 * Quem vincula informa o CPF/CNPJ e o nome como está no documento. O banco só mostra a pessoa de outra empresa à sessão que
 * apresenta os dois (prova em app.vinculo_documento/app.vinculo_nome, política persons_company_select) e só aceita o vínculo
 * LINKED para pessoa assim visível (política person_company_links_insert). Não encontrou e nome que não confere dão a MESMA
 * resposta (422 PERSON_LINK_NOT_MATCHED), sem id nem nome: o vínculo não serve para descobrir quem é dono de um CPF.
 * Cada tentativa que não confere fica na auditoria (people.person.link_attempt, gravada mesmo com o rollback) e conta para o
 * limite por usuário e janela (parâmetros people.vinculo.*). O vínculo, a reativação e o desfazer são auditados pelo gatilho
 * do banco (people.person.link / relink / unlink), no mesmo commit.
 */
const ACAO_TENTATIVA = 'people.person.link_attempt';

const q = (transaction, sql, replacements = {}) => transaction.sequelize.query(sql, { replacements, transaction });

function setProva(transaction, documento, nome, motivo) {
  const corr = getCurrentCorrelationId() || '';
  return q(transaction, `SELECT set_config('app.vinculo_documento', :d, true), set_config('app.vinculo_nome', :n, true),
    set_config('app.vinculo_motivo', :m, true), set_config('app.correlation_id', :corr, true)`, { d: documento, n: nome, m: motivo, corr });
}

const limparProva = (transaction) => setProva(transaction, '', '', '');

/** Recusa (429) quando o usuário já esgotou as tentativas que não conferiram na janela. */
async function assertWithinAttemptLimit({ groupId, companyId }, actorUserId, transaction) {
  const { tentativasMax, janelaMinutos } = await readPersonLinkParams({ groupId, companyId }, transaction);
  const [[row]] = await q(transaction, `SELECT count(*)::int AS n FROM audit.audit_log
     WHERE action = :acao AND company_id = :c AND user_id = :u AND occurred_at > now() - make_interval(mins => :min)`,
  { acao: ACAO_TENTATIVA, c: companyId, u: actorUserId, min: janelaMinutos });
  if (row.n >= tentativasMax) {
    throw new AppError(
      `Você chegou ao limite de ${tentativasMax} tentativas sem conferência em ${janelaMinutos} minutos. Espere e tente de novo, ou peça ajuda a quem administra o cadastro.`,
      429, 'PERSON_LINK_RATE_LIMIT', { tentativasMax, janelaMinutos }
    );
  }
}

/** Tentativa que não conferiu: entra na auditoria mesmo com o rollback da requisição (tenant.middleware, afterRollbackAudits). */
function registrarTentativa(transaction, { groupId, companyId }, actorUserId, resultado) {
  const entry = { groupId, companyId, actorUserId, action: ACAO_TENTATIVA, entityType: 'Person', entityId: null,
    afterJson: { resultado }, reason: resultado === 'CPF_CNPJ_JA_NO_GRUPO'
      ? 'Cadastro recusado: o CPF/CNPJ já existe em outra empresa do grupo.'
      : 'Vínculo recusado: CPF/CNPJ e nome não conferem com um cadastro do grupo.' };
  transaction.afterRollbackAudits = [...(transaction.afterRollbackAudits || []), entry];
}

function normalizarDocumento(taxIdNormalized) {
  const digitos = onlyDigits(taxIdNormalized);
  if (!digitos || ![11, 14].includes(digitos.length)) {
    throw AppError.badRequest('Informe o CPF (11 dígitos) ou o CNPJ (14 dígitos).', 'PERSON_LINK_VALIDATION', { fields: [{ field: 'taxIdNormalized', message: 'Informe o CPF ou o CNPJ.' }] });
  }
  validateDocumentFormat(digitos.length === 11 ? 'CPF' : 'CNPJ', digitos);
  return digitos;
}

async function criarDadosDestaEmpresa(personId, payload, actorUserId, transaction) {
  const contatos = require('./personContacts.service');
  const enderecos = require('./personAddresses.service');
  const papeis = require('./personRoles.service');
  for (const c of Array.isArray(payload.contacts) ? payload.contacts : []) {
    const contactType = c && (c.contactType || c.channel);
    const valueNormalized = c && (c.valueNormalized || c.value);
    if (contactType && valueNormalized) await contatos.createContact(personId, { ...c, contactType, valueNormalized }, actorUserId, transaction);
  }
  const addresses = Array.isArray(payload.addresses) ? payload.addresses : payload.address ? [payload.address] : [];
  for (const a of addresses) if (a) await enderecos.createAddress(personId, a, actorUserId, transaction);
  for (const r of Array.isArray(payload.roles) ? payload.roles : []) {
    const roleCode = typeof r === 'string' ? r : r && r.roleCode;
    if (roleCode) await papeis.createRole(personId, typeof r === 'string' ? { roleCode } : r, actorUserId, transaction);
  }
  // Documentos com arquivo já enviado nesta empresa (o fileAttachGuard confere, antes, que o arquivo é legível por quem vincula).
  const documentos = require('./personDocuments.service');
  for (const d of Array.isArray(payload.documents) ? payload.documents : []) {
    if (d && d.documentType && d.fileId) await documentos.createDocument(personId, d, actorUserId, transaction);
  }
}

/**
 * Vincula a pessoa do grupo (CPF/CNPJ + nome) à empresa da sessão e, na mesma transação, grava os contatos, endereços e
 * papéis DESTA empresa que vieram no corpo. Resultado: VINCULADA, REATIVADA ou JA_NESTA_EMPRESA.
 */
async function linkPersonByTaxId(payload, actorUserId, transaction) {
  const { groupId, companyId } = payload;
  const documento = normalizarDocumento(payload.taxIdNormalized);
  const nome = String(payload.legalName || '').trim();
  if (!nome) {
    throw AppError.badRequest('Informe o nome como está no documento.', 'PERSON_LINK_VALIDATION', { fields: [{ field: 'legalName', message: 'Informe o nome como está no documento.' }] });
  }
  if ((await contextCompanyId(transaction)) !== companyId) throw AppError.forbidden('Contexto de empresa divergente.', 'TENANT_SCOPE_DENIED');

  const [jaVisivel] = await q(transaction, 'SELECT id FROM people.persons WHERE tax_id_normalized = :d AND deleted_at IS NULL', { d: documento });
  if (jaVisivel.length) return { resultado: 'JA_NESTA_EMPRESA', personId: jaVisivel[0].id };

  await assertWithinAttemptLimit({ groupId, companyId }, actorUserId, transaction);
  const motivo = String(payload.reason || '').trim().slice(0, 500) || null;
  await setProva(transaction, documento, nome, motivo || '');
  const [achada] = await q(transaction, 'SELECT id FROM people.persons WHERE tax_id_normalized = :d AND company_id <> :c', { d: documento, c: companyId });
  if (!achada.length) {
    await limparProva(transaction);
    registrarTentativa(transaction, { groupId, companyId }, actorUserId, 'NAO_CONFERE');
    throw AppError.unprocessable(
      'Não encontramos no grupo um cadastro com este CPF/CNPJ e este nome. Confira o nome como está no documento.',
      'PERSON_LINK_NOT_MATCHED'
    );
  }
  const personId = achada[0].id;
  const [existente] = await q(transaction, 'SELECT id, status FROM people.person_company_links WHERE person_id = :p AND company_id = :c', { p: personId, c: companyId });
  let resultado;
  if (existente.length) {
    await q(transaction, `UPDATE people.person_company_links SET status = 'ACTIVE', ended_at = NULL, ended_by = NULL, end_reason = NULL,
      linked_by = :u, linked_at = now(), updated_at = now() WHERE id = :id`, { u: actorUserId, id: existente[0].id });
    resultado = 'REATIVADA';
  } else {
    await q(transaction, `INSERT INTO people.person_company_links (group_id, company_id, person_id, origin, status, linked_by)
      VALUES (:g, :c, :p, 'LINKED', 'ACTIVE', :u)`, { g: groupId, c: companyId, p: personId, u: actorUserId });
    resultado = 'VINCULADA';
  }
  await limparProva(transaction);
  await criarDadosDestaEmpresa(personId, payload, actorUserId, transaction);
  return { resultado, personId };
}

/** Desfaz o vínculo LINKED da empresa da sessão (motivo obrigatório). A empresa responsável pela base não se desvincula. */
async function unlinkPerson(personId, payload, actorUserId, transaction) {
  const motivo = String((payload && payload.reason) || '').trim();
  if (motivo.length < 5) {
    throw AppError.badRequest('Informe o motivo para desfazer o vínculo (mínimo de 5 caracteres).', 'PERSON_LINK_VALIDATION', { fields: [{ field: 'reason', message: 'Informe o motivo.' }] });
  }
  const companyId = await contextCompanyId(transaction);
  const [links] = await q(transaction, `SELECT l.id, l.origin FROM people.person_company_links l JOIN people.persons p ON p.id = l.person_id
     WHERE l.person_id = :p AND l.company_id = :c AND l.status = 'ACTIVE' AND p.deleted_at IS NULL`, { p: personId, c: companyId });
  if (!links.length) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  if (links[0].origin === 'OWNER') {
    throw AppError.conflict('Esta empresa é a responsável pelo cadastro base desta pessoa; não há vínculo a desfazer.', 'PERSON_LINK_OWNER');
  }
  await setProva(transaction, '', '', motivo.slice(0, 500));
  await q(transaction, `UPDATE people.person_company_links SET status = 'ENDED', ended_at = now(), ended_by = :u, end_reason = :m, updated_at = now()
    WHERE id = :id`, { u: actorUserId, m: motivo.slice(0, 500), id: links[0].id });
  await limparProva(transaction);
  return { id: personId, vinculo: 'ENCERRADO' };
}

module.exports = { ACAO_TENTATIVA, linkPersonByTaxId, unlinkPerson, assertWithinAttemptLimit, registrarTentativa };
