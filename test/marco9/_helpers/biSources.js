'use strict';

// Fábricas das tabelas de ORIGEM dos read models de Comercial/Imóveis (M9-D616) e de Locação (M9-D617). Gravam por conexão de superusuário
// com session_replication_role = replica (sem FK nem gatilho): só o que o teste precisa. Banco descartável apenas. O env guarda as empresas
// criadas e a limpeza apaga tudo por empresa (ver biEnv.cleanup).
const crypto = require('node:crypto');

const uuid = () => crypto.randomUUID();

async function insert(env, table, tenant, columns) {
  const id = columns.id || uuid();
  const all = { id, group_id: tenant.groupId, company_id: tenant.companyId, ...columns };
  const names = Object.keys(all);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query(`INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')})`, { replacements: all, transaction });
  });
  return id;
}

async function update(env, table, id, set) {
  const names = Object.keys(set);
  await env.admin.query(`UPDATE ${table} SET ${names.map((n) => `"${n}" = :${n}`).join(', ')} WHERE id = :id`, { replacements: { ...set, id } });
}

const when = (c, from) => (c[from] ? { [from]: c[from] } : {});

const opportunity = (env, t, c = {}) => insert(env, 'crm.opportunities', t, {
  person_id: c.person || uuid(), owner_user_id: c.owner || null, stage: c.stage || 'NEW', lead_source: c.source || null, closed_at: c.closedAt || null,
  lost_reason: c.lostReason || null, next_action: c.nextAction || null, property_id: c.property || null, created_at: c.created || '2026-10-20T15:00:00Z', updated_at: c.updated || c.created || '2026-10-20T15:00:00Z',
});

const message = (env, t, c) => insert(env, 'crm.messages', t, {
  opportunity_id: c.opportunity, direction: c.direction || 'OUTBOUND', author_type: c.author || 'EMPLOYEE', person_id: c.person || null, created_at: c.created, updated_at: c.created,
});

const visit = (env, t, c) => insert(env, 'crm.visits', t, { property_id: c.property || uuid(), person_id: uuid(), scheduled_at: c.at, status: c.status || 'SCHEDULED', opportunity_id: c.opportunity || null });

const proposal = (env, t, c) => insert(env, 'crm.proposals', t, {
  opportunity_id: c.opportunity || uuid(), value: c.value || '1000.00', status: c.status || 'SENT', sent_at: c.sentAt || null, decided_at: c.decidedAt || null,
});

const property = (env, t, c = {}) => insert(env, 'real_estate.properties', t, {
  title: c.title || 'Imóvel M9', property_type: 'RESIDENTIAL', internal_code: c.code || `M9-${uuid().slice(0, 8)}`, availability_status: c.status || 'AVAILABLE',
  publication_status: c.publication || 'PUBLISHED', published_at: c.publishedAt || null, created_by: c.createdBy || null, created_at: c.created || '2026-10-01T15:00:00Z', updated_at: c.created || '2026-10-01T15:00:00Z',
});

const offer = (env, t, c) => insert(env, 'real_estate.property_offers', t, { property_id: c.property, offer_type: c.type || 'RENT', asking_price: c.price || '2500.00', status: c.status || 'ACTIVE' });

const priceHistory = (env, t, c) => insert(env, 'real_estate.property_price_history', t, {
  offer_id: c.offer || uuid(), old_price: c.oldPrice, new_price: c.newPrice, changed_at: c.at, changed_by: uuid(), reason_code: 'AJUSTE',
});

const radarEvent = (env, t, c) => insert(env, 'integration.outbox_events', t, {
  aggregate_type: 'PropertyRadar', aggregate_id: uuid(), event_type: 'radar.matched', payload_json: JSON.stringify({ radarId: uuid(), personId: c.person, propertyId: c.property }),
  idempotency_key: `radar.matched:${uuid()}`, occurred_at: c.at, status: 'PROCESSED',
});

const contract = (env, t, c = {}) => insert(env, 'legal.contracts', t, {
  contract_type: c.type || 'LEASE', status: c.status || 'ACTIVE', property_id: c.property || null, total_value: c.value || null, starts_at: c.startsAt || null, ends_at: c.endsAt || null,
});

const guarantee = (env, t, c) => insert(env, 'legal.guarantees', t, { contract_id: c.contract, guarantee_type: ({ DEPOSIT: 'SECURITY_DEPOSIT', CAPITALIZATION_TITLE: 'CAPITALIZATION' })[c.type] || c.type || 'GUARANTOR', status: c.status || 'ACTIVE', ends_at: c.endsAt || null, starts_at: '2026-01-01' });

const inspection = (env, t, c) => insert(env, 'legal.inspections', t, { property_id: c.property || uuid(), contract_id: c.contract, inspection_type: 'ENTRY', status: c.status || 'SCHEDULED' });

const keyDelivery = (env, t, c) => insert(env, 'legal.key_deliveries', t, { contract_id: c.contract, delivered_to_person_id: uuid(), status: c.status || 'PENDING' });

const requirement = (env, t, c) => insert(env, 'legal.contract_requirements', t, {
  contract_id: c.contract, requirement_code: `REQ-${uuid().slice(0, 6)}`, description: 'Exigência', requirement_type: 'DOCUMENT', status: c.status || 'PENDING', created_at: '2026-10-01T15:00:00Z', updated_at: '2026-10-01T15:00:00Z',
});

const utility = (env, t, c) => insert(env, 'legal.lease_obligations', t, {
  contract_id: c.contract, utility_type: 'WATER', responsible_party: 'TENANT', transfer_required: true, evidence_file_id: c.evidence || null, status: 'ACTIVE',
});

const party = (env, t, c) => insert(env, 'legal.contract_parties', t, { contract_id: c.contract, person_id: c.person, party_role: 'TENANT' });

const entry = (env, t, c) => insert(env, 'finance.financial_entries', t, {
  entry_type: 'CREDIT', nature: c.nature || 'RECEIVABLE', amount: c.amount, status: c.status || 'PENDING', due_at: c.due || null, contract_id: c.contract || null,
  is_third_party_funds: Boolean(c.third), reversal_of_entry_id: c.reversalOf || null,
});

const repass = (env, t, c) => insert(env, 'finance.owner_repasses', t, {
  property_id: uuid(), owner_person_id: uuid(), gross_amount: c.amount, net_amount: c.amount, reference_month: c.month, status: c.status || 'PENDING', paid_at: c.paidAt || null,
  ...(['APPROVED', 'PAID'].includes(c.status) ? { approved_by_user_id: uuid(), confirmed_by_user_id: uuid(), approved_at: c.paidAt || '2026-10-01T15:00:00Z', created_by: uuid(), financial_entry_id: uuid(), payment_settlement_method: 'BANK_CONFIRMED' } : {}),
});

const maintenance = (env, t, c) => insert(env, 'construction.maintenance_cases', t, {
  property_id: c.property, description: 'Chamado', status: c.status || 'OPEN', created_at: c.created, updated_at: c.updated || c.created,
});

const feedback = (env, t, c) => insert(env, 'crm.feedback_cases', t, {
  person_id: c.person, type: c.type, description: 'Registro', sla_due_at: '2026-12-01T15:00:00Z', status: 'OPEN', created_at: c.created, updated_at: c.created,
});

const project = (env, t, c) => insert(env, 'construction.projects', t, { name: 'Obra M9', property_id: c.property, status: c.status || 'ACTIVE' });

module.exports = {
  uuid, insert, update, when, opportunity, message, visit, proposal, property, offer, priceHistory, radarEvent, contract, guarantee, inspection, keyDelivery, requirement,
  utility, party, entry, repass, maintenance, feedback, project,
};
