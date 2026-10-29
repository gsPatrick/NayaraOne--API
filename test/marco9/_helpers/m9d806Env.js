'use strict';

// Apoio dos testes M9-D806 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const base = require('./m9d805Env');
const { PersonAddress, PersonRole, PropertyAddress, PropertyOwner, PropertyMedia, SupplierQualification, File } = require('../../../src/models');

const { sequelize } = base;
const FULL_ADDRESS = { zipCode: '01310-100', street: 'Avenida Paulista', number: '1000', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP' };

/** Pessoa que passa em tudo, menos nas dimensões desligadas pelas opções (contato, endereço, nascimento, papel). */
async function fullPerson(tenant, tx, fields = {}, { contact = true, address = true, role = true, birth = true } = {}) {
  const person = await base.person(tenant, tx, {
    taxIdNormalized: base.cpf(), legalName: 'Maria Souza', ...(birth ? { birthOrFoundationDate: '1985-04-12' } : {}), ...fields,
  });
  const ids = { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, createdBy: tenant.userId, updatedBy: tenant.userId };
  if (contact) await base.contact(tenant, tx, person.id, '11999990000');
  if (address) await PersonAddress.create({ ...ids, ...FULL_ADDRESS, isCurrent: true }, { transaction: tx });
  if (role) await PersonRole.create({ ...ids, roleCode: 'CLIENTE' }, { transaction: tx });
  return person;
}

/** Imóvel com matrícula, endereço, proprietário, área, oferta ativa e mídia (o que as 6 regras pedem). */
async function fullProperty(tenant, tx, fields = {}, { owner = true, media = true, offer = true } = {}) {
  const address = await PropertyAddress.create({ ...FULL_ADDRESS, zipCode: '01310100' }, { transaction: tx });
  const property = await base.property(tenant, tx, { registryNumber: `MAT-${base.suffix()}`, addressId: address.id, areaTotalM2: 80, ...fields });
  const ids = { groupId: tenant.groupId, companyId: tenant.companyId, createdBy: tenant.userId, updatedBy: tenant.userId };
  if (owner) {
    const holder = await base.person(tenant, tx);
    await PropertyOwner.create({ ...ids, propertyId: property.id, personId: holder.id, ownershipPercent: 100, roleCode: 'OWNER' }, { transaction: tx });
  }
  if (media) await PropertyMedia.create({ ...ids, propertyId: property.id, mediaType: 'PHOTO', storageKey: `qa-m9/${base.suffix()}`, position: 1 }, { transaction: tx });
  if (offer) {
    await sequelize.query(
      `INSERT INTO real_estate.property_offers (id, group_id, company_id, property_id, offer_type, asking_price, status, created_at, updated_at)
       VALUES (gen_random_uuid(), :groupId, :companyId, :propertyId, 'SALE', 500000, 'ACTIVE', now(), now())`,
      { transaction: tx, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id } }
    );
  }
  return property;
}

/** Fornecedor PJ completo: CNPJ válido, contato, conta ACTIVE, categoria e qualificação vigente com documento. */
async function fullSupplier(tenant, tx, fields = {}, { qualification = true, category = 'SERVICOS' } = {}) {
  const supplier = await base.supplier(tenant, tx, { taxIdNormalized: cnpj(), legalName: 'Fornecedora Alfa Ltda', riskFlagsJson: category ? { category } : null, ...fields });
  await base.contact(tenant, tx, supplier.id, '1133334444');
  await base.bankAccount(tenant, tx, supplier.id, { status: 'ACTIVE' });
  if (qualification) {
    const file = await base.file(tenant, tx);
    const next = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    await SupplierQualification.create({
      groupId: tenant.groupId, companyId: tenant.companyId, supplierPersonId: supplier.id, documentFileIds: [file.id], validUntil: next,
      highRisk: false, dueDiligenceStatus: 'NOT_REQUIRED', createdBy: tenant.userId, updatedBy: tenant.userId,
    }, { transaction: tx });
  }
  return supplier;
}

/** CNPJ válido aleatório. */
function cnpj() {
  const digits = Array.from({ length: 12 }, (_, i) => (i < 8 ? Math.floor(Math.random() * 10) : [0, 0, 0, 1][i - 8]));
  const check = (list, weights) => { const sum = list.reduce((acc, n, i) => acc + n * weights[i], 0) % 11; return sum < 2 ? 0 : 11 - sum; };
  const d1 = check(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = check([...digits, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...digits, d1, d2].join('');
}

/** Documentos de dígito verificador errado e únicos (a unicidade por grupo impede repetir um valor fixo entre testes que gravam de verdade). */
const invalidCnpj = () => { const valid = cnpj(); return `${valid.slice(0, 13)}${(Number(valid[13]) + 1) % 10}`; };
const invalidCpf = () => { const valid = base.cpf(); return `${valid.slice(0, 10)}${(Number(valid[10]) + 1) % 10}`; };

const outboxEvents = (aggregateId, tx) => base.query(
  "SELECT * FROM integration.outbox_events WHERE event_type = 'data.quality.issue.opened' AND payload_json->>'entityId' = :aggregateId ORDER BY created_at", { aggregateId }, tx
);
const issues = (tenant, entityId, tx, where = 'TRUE') => base.query(
  `SELECT * FROM governance.quality_issues WHERE company_id = :companyId AND entity_id = :entityId AND ${where} ORDER BY opened_at, rule_code`, { companyId: tenant.companyId, entityId }, tx
);

module.exports = { ...base, FULL_ADDRESS, PersonAddress, fullPerson, fullProperty, fullSupplier, cnpj, invalidCnpj, invalidCpf, outboxEvents, issues, File, sequelize };
