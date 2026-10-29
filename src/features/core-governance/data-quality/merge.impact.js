'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const errors = require('./merge.errors');
const references = require('./merge.references');
const { KINDS, BLOCKERS } = require('./merge.constants');
const { isUuid } = require('./merge.input');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** O que impede a união (as mesmas travas dos serviços de cada módulo), para o aviso antes da confirmação. */
async function blockers(entityType, survivorId, otherId, transaction) {
  const found = [];
  if (entityType === 'PROPERTY') {
    const [row] = await q('SELECT count(*)::int AS n FROM real_estate.properties a, real_estate.properties b WHERE a.id = :s AND b.id = :o AND a.registry_number IS NOT NULL AND b.registry_number IS NOT NULL AND a.registry_number <> b.registry_number', transaction, { s: survivorId, o: otherId });
    if (row.n) found.push({ code: BLOCKERS.PROPERTY_REGISTRY, message: 'Os dois imóveis têm matrículas preenchidas e distintas.' });
    return found;
  }
  const [tax] = await q('SELECT count(*)::int AS n FROM people.persons a, people.persons b WHERE a.id = :s AND b.id = :o AND a.tax_id_normalized IS NOT NULL AND b.tax_id_normalized IS NOT NULL AND a.tax_id_normalized <> b.tax_id_normalized', transaction, { s: survivorId, o: otherId });
  if (tax.n) found.push({ code: BLOCKERS.PERSON_TAX_ID, message: 'As duas pessoas têm CPF/CNPJ preenchidos e diferentes.' });
  const [contracts] = await q(
    `SELECT count(DISTINCT c.id)::int AS n FROM legal.contracts c JOIN legal.contract_parties x ON x.contract_id = c.id AND x.person_id = :s JOIN legal.contract_parties y ON y.contract_id = c.id AND y.person_id = :o WHERE c.status = 'ACTIVE'`,
    transaction, { s: survivorId, o: otherId }
  );
  if (contracts.n) found.push({ code: BLOCKERS.PERSON_ACTIVE_CONTRACT, message: 'As duas pessoas são partes do mesmo contrato ativo.' });
  return found;
}

/** Valor em reais dos repasses ligados ao cadastro que sai, em centavos. */
async function totalAmountCents(entityType, otherId, transaction) {
  if (entityType === 'SUPPLIER') return 0;
  const column = entityType === 'PROPERTY' ? 'property_id' : 'owner_person_id';
  const [row] = await q(`SELECT coalesce(round(sum(net_amount) * 100), 0)::bigint AS cents FROM finance.owner_repasses WHERE ${column} = :otherId`, transaction, { otherId });
  return Number(row.cents);
}

/** GET /data-quality/queue/:id/impact?survivorId= — {counts, totalAmountCents, blockers} do que a união moveria (linha 8 do inventário da M9-D852). */
async function impactOf(tenant, itemId, survivorId, transaction) {
  if (!isUuid(itemId)) throw errors.itemNotFound();
  const [item] = await q('SELECT * FROM governance.review_queue_items WHERE id = :id AND company_id = :companyId', transaction, { id: itemId, companyId: tenant.companyId });
  if (!item) throw errors.itemNotFound();
  if (item.kind !== KINDS.MERGE_CANDIDATE) throw errors.decisionInvalid();
  const survivor = survivorId || item.primary_id;
  if (![item.primary_id, item.secondary_id].includes(survivor)) throw errors.survivorInvalid();
  const other = survivor === item.primary_id ? item.secondary_id : item.primary_id;
  return {
    survivorId: survivor, absorbedId: other, counts: await references.countReferences(item.entity_type, other, transaction),
    totalAmountCents: await totalAmountCents(item.entity_type, other, transaction), blockers: await blockers(item.entity_type, survivor, other, transaction),
  };
}

module.exports = { impactOf };
