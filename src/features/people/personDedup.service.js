'use strict';

const { Op, QueryTypes } = require('sequelize');
const { Person, PersonAddress } = require('../../models');
const { onlyDigits } = require('./personDocumentFormat.service');

const { draftContactKeys, contactKeySql, kindSql } = require('./personContactKey');
const { readDedupParams } = require('./personDedup.settings');
const { contextCompanyId } = require('./personView');

/**
 * Deduplicação de Pessoas (livro §4; Guia §3 DedupService.findPossibleDuplicates). Três níveis:
 *   - forte: CPF/CNPJ normalizado (dígitos; o hash HMAC é a mesma chave) — bloqueia e oferece o cadastro existente;
 *   - médio: telefone/e-mail iguais, comparados pela chave normalizada (personContactKey.js), em QUALQUER contato do rascunho contra
 *     QUALQUER contato da empresa (não só o principal; telefone e WhatsApp juntos) — abre revisão;
 *   - fraco: nome semelhante + endereço/data de nascimento — abre revisão.
 * Nenhum nível mescla sozinho. A decisão (bloquear, exigir revisão, exceção auditada) fica em personDedupGate.js; aqui só as consultas,
 * todas pela transação da requisição (RLS: só o que a empresa da sessão enxerga). O que existe nas outras empresas do grupo é consultado
 * pelas funções do banco people.documento_no_grupo / people.contato_no_grupo (verdadeiro/falso, nunca qual pessoa).
 */

async function tenantOf(transaction) {
  const [[row]] = await transaction.sequelize.query(
    "SELECT NULLIF(current_setting('app.group_id', true), '') AS g, NULLIF(current_setting('app.company_id', true), '') AS c", { transaction }
  );
  return { groupId: row ? row.g : null, companyId: (row && row.c) || (await contextCompanyId(transaction)) };
}

/** Match forte visível nesta empresa (própria ou vinculada): a Person, ou null. */
async function findStrongInCompany(taxIdDigits, transaction) {
  if (!taxIdDigits) return null;
  return Person.findOne({ where: { taxIdNormalized: taxIdDigits }, transaction });
}

/**
 * Match médio nesta empresa: [{ personId, legalName, motivo: MESMO_EMAIL|MESMO_TELEFONE, contactType }], sem repetir pessoa, sem as
 * mescladas e as excluídas. `ddi` vem do parâmetro da empresa.
 */
async function findMediumCandidates(contacts, ddi, transaction, { excludePersonId = null } = {}) {
  const keys = draftContactKeys(contacts, ddi);
  if (!keys.length) return [];
  const rows = await transaction.sequelize.query(
    `SELECT DISTINCT ON (p.id) p.id AS person_id, p.legal_name, ${kindSql('c')} AS kind, c.contact_type
       FROM people.person_contacts c JOIN people.persons p ON p.id = c.person_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status <> 'MERGED' AND (CAST(:exclude AS uuid) IS NULL OR p.id <> CAST(:exclude AS uuid))
        AND (${kindSql('c')} || '|' || ${contactKeySql('c')}) IN (:keys)
      ORDER BY p.id, c.is_primary DESC`,
    { type: QueryTypes.SELECT, transaction, replacements: { ddi, exclude: excludePersonId, keys: keys.map((k) => `${k.kind}|${k.key}`) } }
  );
  return rows.map((r) => ({ personId: r.person_id, legalName: r.legal_name, motivo: r.kind === 'EMAIL' ? 'MESMO_EMAIL' : 'MESMO_TELEFONE', contactType: r.contact_type }));
}

/** CPF/CNPJ com cadastro em OUTRA empresa do grupo que esta não enxerga (verdadeiro/falso). */
async function taxIdInOtherCompany(taxIdDigits, transaction) {
  if (!taxIdDigits) return false;
  const [[row]] = await transaction.sequelize.query('SELECT people.documento_no_grupo(:t) AS existe', { replacements: { t: taxIdDigits }, transaction });
  return Boolean(row && row.existe);
}

/** Algum telefone/e-mail do rascunho no cadastro de OUTRA empresa do grupo (verdadeiro/falso, sem dizer qual nem de quem). */
async function contactInOtherCompany(contacts, ddi, transaction) {
  const keys = draftContactKeys(contacts, ddi);
  for (const k of keys) {
    const [[row]] = await transaction.sequelize.query('SELECT people.contato_no_grupo(:kind, :key, :ddi) AS existe', { replacements: { kind: k.kind, key: k.key, ddi }, transaction });
    if (row && row.existe) return true;
  }
  return false;
}

/**
 * findPotentialDuplicate — compatível com os chamadores antigos (importação do BCP): o match forte ou o primeiro médio desta empresa, como
 * Person, ou null. O DDI é o parâmetro da empresa da sessão.
 */
async function findPotentialDuplicate(personData, transaction) {
  const strong = await findStrongInCompany(onlyDigits(personData.taxIdNormalized), transaction);
  if (strong) return strong;
  const { ddi } = await readDedupParams(await tenantOf(transaction), transaction);
  const [first] = await findMediumCandidates(personData.contacts, ddi, transaction);
  return first ? Person.findByPk(first.personId, { transaction }) : null;
}

function normalizeNameKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * nameFirstLastTokens — "nome semelhante" (seção 4) é tratado, de forma determinística, como o
 * mesmo PRIMEIRO + ÚLTIMO token do nome normalizado — cobre o caso comum (mesmo nome completo
 * digitado com abreviação/acento diferente) sem exigir uma biblioteca de distância fonética.
 */
function nameFirstLastTokens(name) {
  const tokens = normalizeNameKey(name).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  return `${tokens[0]}|${tokens[tokens.length - 1]}`;
}

function normalizeAddressKeyForPerson(address) {
  const normalize = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  const street = normalize(address?.street);
  const city = normalize(address?.city);
  if (!street || !city) return null;
  return `${street}|${normalize(address?.number)}|${city}`;
}

/**
 * findWeakDuplicateCandidates — match fraco (livro §4: "nome semelhante + endereço/data de nascimento"). Consultado ANTES de criar
 * (personDedupGate.js e POST /people/duplicates/check): no cadastro pela tela a criação exige a revisão confirmada; nas criações
 * automáticas o par vai para a fila de revisão. `personData` aceita `legalName`, `birthOrFoundationDate` e o endereço em `addresses`
 * (primeiro item) ou `address`, no formato do corpo de criação.
 */
async function findWeakDuplicateCandidates(personData, transaction) {
  const nameKey = nameFirstLastTokens(personData.legalName);
  if (!nameKey) return [];

  const birthDate = personData.birthOrFoundationDate || null;
  const address = Array.isArray(personData.addresses) ? personData.addresses[0] : personData.address || null;
  const addressKey = address ? normalizeAddressKeyForPerson(address) : null;
  if (!birthDate && !addressKey) return [];

  const where = { status: { [Op.ne]: 'MERGED' } };
  if (personData.excludePersonId) where.id = { [Op.ne]: personData.excludePersonId };
  if (birthDate) where.birthOrFoundationDate = birthDate;

  const candidates = [];

  if (birthDate) {
    const byBirthDate = await Person.findAll({ where, transaction });
    for (const candidate of byBirthDate) {
      if (nameFirstLastTokens(candidate.legalName) === nameKey) {
        candidates.push({ personId: candidate.id, legalName: candidate.legalName, reason: 'NOME_E_DATA_NASCIMENTO_SEMELHANTES' });
      }
    }
  }

  if (addressKey) {
    const addressWhere = { ...where };
    delete addressWhere.birthOrFoundationDate;
    const personAddresses = await PersonAddress.findAll({ where: { isCurrent: true }, transaction });
    const matchingPersonIds = personAddresses
      .filter((a) => normalizeAddressKeyForPerson(a) === addressKey)
      .map((a) => a.personId);
    if (matchingPersonIds.length > 0) {
      const byAddress = await Person.findAll({
        where: { ...addressWhere, id: matchingPersonIds },
        transaction,
      });
      for (const candidate of byAddress) {
        if (nameFirstLastTokens(candidate.legalName) === nameKey && !candidates.some((c) => c.personId === candidate.id)) {
          candidates.push({ personId: candidate.id, legalName: candidate.legalName, reason: 'NOME_E_ENDERECO_SEMELHANTES' });
        }
      }
    }
  }

  return candidates;
}

/**
 * listPotentialDuplicatePairs — varredura da empresa pelo match médio (a listagem de Pessoas sinaliza "possível duplicata" e oferece o
 * merge controlado). Usa a MESMA chave normalizada do cadastro (e-mail em minúsculas e sem espaços; telefone com DDI, telefone e WhatsApp
 * juntos) e qualquer contato, não só o principal. O forte não gera par: UNIQUE(group_id, tax_id_normalized) impede o mesmo CPF/CNPJ duas
 * vezes. Mescladas e excluídas ficam de fora. Retorna [{ contactType, value, personIds }], com `value` = a chave comparada.
 */
async function listPotentialDuplicatePairs(transaction) {
  const { ddi } = await readDedupParams(await tenantOf(transaction), transaction);
  const rows = await transaction.sequelize.query(
    `SELECT ${kindSql('c')} AS kind, ${contactKeySql('c')} AS chave, array_agg(DISTINCT p.id::text) AS ids
       FROM people.person_contacts c JOIN people.persons p ON p.id = c.person_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status <> 'MERGED' AND c.value_normalized IS NOT NULL AND btrim(c.value_normalized) <> ''
      GROUP BY 1, 2 HAVING count(DISTINCT p.id) > 1 ORDER BY 1, 2`,
    { type: QueryTypes.SELECT, transaction, replacements: { ddi } }
  );
  return rows
    .filter((r) => (r.kind === 'EMAIL' ? r.chave.includes('@') : r.chave.length >= 8 + ddi.length))
    .map((r) => ({ contactType: r.kind === 'EMAIL' ? 'EMAIL' : 'PHONE', value: r.chave, personIds: [...r.ids].sort() }));
}

module.exports = {
  findPotentialDuplicate, findStrongInCompany, findMediumCandidates, taxIdInOtherCompany, contactInOtherCompany, listPotentialDuplicatePairs,
  findWeakDuplicateCandidates, tenantOf,
};
