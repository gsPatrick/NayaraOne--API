'use strict';

// Montagem comum dos testes de vínculo de pessoa entre empresas do MESMO grupo (DI-M9I-1 a DI-M9I-7): a empresa B nasce no
// grupo da empresa semente (A), a pessoa P é cadastrada em A com contato, endereço, documento (com arquivo), papel e
// consentimento. Tudo dentro da transação do teste (rollback no fim).

const crypto = require('node:crypto');
const { sequelize, uniqueSuffix } = require('../testHelpers');
const { Company } = require('../../src/models');
const peopleService = require('../../src/features/people/people.service');
const contacts = require('../../src/features/people/personContacts.service');
const addresses = require('../../src/features/people/personAddresses.service');
const documents = require('../../src/features/people/personDocuments.service');
const roles = require('../../src/features/people/personRoles.service');
const consents = require('../../src/features/people/personConsents.service');

const FILHOS = ['person_contacts', 'person_addresses', 'person_documents', 'person_roles', 'communication_consents'];

function randomCpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const f = arr.length + 1; const r = (arr.reduce((acc, d, i) => acc + d * (f - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}

const q = (transaction, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction });
const usarEmpresa = (transaction, companyId) => q(transaction, "SELECT set_config('app.company_id', :c, true)", { c: companyId || '' });
const prova = (transaction, documento, nome) => q(transaction,
  "SELECT set_config('app.vinculo_documento', :d, true), set_config('app.vinculo_nome', :n, true)", { d: documento || '', n: nome || '' });

/** Roda fn dentro de um SAVEPOINT; devolve { erro, valor } e desfaz só o savepoint quando falha. */
async function tentar(transaction, fn) {
  await q(transaction, 'SAVEPOINT vinc');
  try {
    const valor = await fn();
    await q(transaction, 'RELEASE SAVEPOINT vinc');
    return { erro: null, valor };
  } catch (erro) {
    await q(transaction, 'ROLLBACK TO SAVEPOINT vinc');
    return { erro, valor: null };
  }
}

async function arquivoDaEmpresa(transaction, tenant, companyId) {
  const id = crypto.randomUUID();
  await q(transaction, `INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, mime_type, size_bytes, scan_status, classification, created_at, updated_at)
    VALUES (:id, :g, :c, :k, 'rg.pdf', 'application/pdf', 10, 'CLEAN', 'HIGH', now(), now())`, { id, g: tenant.groupId, c: companyId, k: `teste/vinculo/${id}` });
  return id;
}

/** Empresa B no grupo de A e a pessoa P de A com um filho de cada tipo. O contexto termina na empresa A. */
async function cenario(transaction, tenant, { nome } = {}) {
  const suf = uniqueSuffix();
  const empresaB = await Company.create({ groupId: tenant.groupId, name: `Vínculo B ${suf}`, status: 'ACTIVE' }, { transaction });
  await usarEmpresa(transaction, tenant.companyId);
  const cpf = randomCpf();
  const legalName = nome || `Maria Aparecida Vinculo ${suf} Souza`;
  const pessoa = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName, taxIdNormalized: cpf, riskFlagsJson: { category: 'RISCO_DA_EMPRESA_A' } },
    tenant.userId, transaction
  );
  await contacts.createContact(pessoa.id, { contactType: 'EMAIL', valueNormalized: `a${suf}@exemplo.test`, isPrimary: true }, tenant.userId, transaction);
  await addresses.createAddress(pessoa.id, { street: 'Rua de A', number: '1', city: 'São Paulo', state: 'SP' }, tenant.userId, transaction);
  const fileId = await arquivoDaEmpresa(transaction, tenant, tenant.companyId);
  await documents.createDocument(pessoa.id, { documentType: 'RG', fileId }, tenant.userId, transaction);
  await roles.createRole(pessoa.id, { roleCode: 'CLIENTE' }, tenant.userId, transaction);
  await consents.recordConsent(pessoa.id, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, transaction);
  return { empresaB, pessoa, cpf, legalName, suf, fileId };
}

/** Quantas linhas de cada tabela filha da pessoa estão visíveis na sessão, separando as da empresa informada. */
async function contarFilhos(transaction, personId, companyId) {
  const out = {};
  for (const t of FILHOS) {
    const [[r]] = await q(transaction, `SELECT count(*)::int AS total, count(*) FILTER (WHERE company_id = :c)::int AS da_empresa FROM people.${t} WHERE person_id = :p`, { p: personId, c: companyId });
    out[t] = r;
  }
  return out;
}

module.exports = { FILHOS, randomCpf, q, usarEmpresa, prova, tentar, arquivoDaEmpresa, cenario, contarFilhos };
