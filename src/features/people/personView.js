'use strict';

const AppError = require('../../utils/AppError');

/**
 * O que cada empresa vê da pessoa (DI-M9I-3).
 * - Empresa responsável pela base (persons.company_id = empresa da sessão): tudo, como antes, com `vinculo.origem = PROPRIA`.
 * - Empresa vinculada: só a base do cadastro único (TAB-0100: tipo, nome, nome de uso, CPF/CNPJ, data de nascimento/fundação,
 *   status), com `vinculo.origem = VINCULADA`. Fica de fora o que é da relação da outra empresa: qual empresa do grupo é a
 *   responsável, quem cadastrou/alterou e quando, as marcações de risco dela, versão e marcas internas. Contatos, endereços,
 *   documentos, papéis, consentimentos, arquivos, oportunidades e mensagens já vêm só da empresa da sessão (RLS por empresa).
 */
const CAMPOS_DA_BASE = ['id', 'groupId', 'personType', 'legalName', 'preferredName', 'taxIdNormalized', 'birthOrFoundationDate', 'status'];
const SUBRECURSOS = ['contacts', 'documents', 'roles', 'addresses', 'dataQuality'];

async function contextCompanyId(transaction) {
  const [[row]] = await transaction.sequelize.query("SELECT NULLIF(current_setting('app.company_id', true), '') AS c", { transaction });
  return row ? row.c : null;
}

/** Empresa dona do dado filho (contato, endereço, documento, papel, consentimento): a da sessão; sem sessão, a da base. */
async function sessionCompanyId(person, transaction) {
  return (await contextCompanyId(transaction)) || person.companyId;
}

function toPlain(person) {
  return person && typeof person.toJSON === 'function' ? person.toJSON() : person;
}

/** Projeção da pessoa para a empresa da sessão. `linkedAt` = data do vínculo dessa empresa (só para a vinculada). */
function personForCompany(person, companyId, linkedAt = null) {
  const plain = toPlain(person);
  if (!plain) return plain;
  if (plain.companyId === companyId) return { ...plain, vinculo: { origem: 'PROPRIA' } };
  const base = {};
  for (const campo of [...CAMPOS_DA_BASE, ...SUBRECURSOS]) if (plain[campo] !== undefined) base[campo] = plain[campo];
  return { ...base, vinculo: { origem: 'VINCULADA', vinculadaEm: linkedAt } };
}

async function linkDates(personIds, transaction) {
  if (!personIds.length) return new Map();
  const [rows] = await transaction.sequelize.query(
    "SELECT person_id, linked_at FROM people.person_company_links WHERE person_id IN (:ids) AND status = 'ACTIVE'",
    { replacements: { ids: personIds }, transaction }
  );
  return new Map(rows.map((r) => [r.person_id, r.linked_at]));
}

/** Projeta uma lista (ou uma pessoa) para a empresa da sessão. */
async function projectForSession(persons, transaction) {
  const companyId = await contextCompanyId(transaction);
  const lista = Array.isArray(persons) ? persons.map(toPlain) : [toPlain(persons)];
  const datas = await linkDates(lista.filter((p) => p && p.companyId !== companyId).map((p) => p.id), transaction);
  const projetadas = lista.map((p) => personForCompany(p, companyId, datas.get(p && p.id) || null));
  return Array.isArray(persons) ? projetadas : projetadas[0];
}

/** A base (nome, CPF/CNPJ, nascimento, status, exclusão, mescla) só é alterada pela empresa responsável por ela. */
async function assertBaseOwner(person, transaction) {
  const companyId = await contextCompanyId(transaction);
  if (person.companyId !== companyId) {
    throw AppError.forbidden(
      'O cadastro base desta pessoa é mantido por outra empresa do grupo. Aqui você altera os contatos, endereços, documentos, papéis e consentimentos desta empresa.',
      'PERSON_BASE_OWNER_ONLY'
    );
  }
}

/** Erro do gatilho persons_base_vinculada_nao_some (base com vínculo ativo em outra empresa). */
function isLinkedElsewhereError(err) {
  const pg = err && (err.parent || err.original);
  return Boolean(pg && pg.code === 'P0001' && /PERSON_LINKED_ELSEWHERE/.test(String(pg.message || '')));
}

function linkedElsewhereError() {
  return AppError.conflict(
    'Esta pessoa também tem vínculo com outra empresa do grupo. O cadastro base não pode ser excluído nem mesclado enquanto esse vínculo existir.',
    'PERSON_LINKED_ELSEWHERE'
  );
}

/**
 * Rede de segurança do errorHandler para caminhos fora de Pessoas: a base com vínculo em outra empresa (gatilho) vira 409, e
 * dado filho apontando para pessoa sem vínculo com a empresa (FK composta *_person_company_link_fkey, migration 20260101010941)
 * vira 403, nunca 500.
 */
function mapPeopleLinkDatabaseError(err) {
  if (isLinkedElsewhereError(err)) {
    const e = linkedElsewhereError();
    return { statusCode: e.statusCode, code: e.code, message: e.message };
  }
  const pg = err && (err.parent || err.original);
  if (pg && pg.code === '23503' && /_person_company_link_fkey$/.test(String(pg.constraint || ''))) {
    return { statusCode: 403, code: 'PERSON_NOT_LINKED', message: 'Esta pessoa não está vinculada à empresa em uso.' };
  }
  return null;
}

module.exports = { mapPeopleLinkDatabaseError, CAMPOS_DA_BASE, contextCompanyId, sessionCompanyId, personForCompany, projectForSession, assertBaseOwner, isLinkedElsewhereError, linkedElsewhereError };
