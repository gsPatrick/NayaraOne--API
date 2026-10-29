'use strict';

// Cenário dos fatos do dia da M9-D710. "Agora" = 28/10/2026 12:00 em São Paulo (15:00Z); janela de 24 h = [27/10 15:00Z, 28/10 15:00Z], janela anterior = [26/10 15:00Z, 27/10 15:00Z).
// Cada função grava as fontes (contrato com versão e assinatura, oportunidade com proposta, lançamento financeiro) e, quando pedido, o evento do outbox que o produziu.
const bi = require('./biObrasJuridicoEnv');

const at = (day, time) => `2026-10-${day}T${time}Z`;
const AUDIT = { created_at: at('20', '12:00:00'), updated_at: at('28', '14:00:00') };

/** Evento do outbox já processado (a prova de que o fato existiu: o read model grava o id do primeiro evento do registro). */
const outbox = (env, t, { type, aggregateId, payload = {}, when }) => bi.seed(env, t, 'integration.outbox_events', {
  aggregate_type: 'Seed', aggregate_id: aggregateId, event_type: type, payload_json: JSON.stringify(payload), idempotency_key: `m9d710:${bi.uuid()}`, occurred_at: when, status: 'PROCESSED',
});

/** Contrato com uma assinatura SIGNED em `signedAt` (nulo = assinatura sem data). */
async function contract(env, t, { type = 'SALE', total = null, status = 'SIGNED', signedAt = null, deletedAt = null, signed = true } = {}) {
  const id = await bi.seed(env, t, 'legal.contracts', { contract_type: type, status, total_value: total, deleted_at: deletedAt, ...AUDIT });
  const version = await bi.seed(env, t, 'legal.contract_versions', { contract_id: id, version_number: 1, content: 'v1', content_hash: bi.uuid().replace(/-/g, ''), effective_from: '2026-10-20', ...AUDIT });
  if (signed) await bi.seed(env, t, 'legal.signatures', { contract_version_id: version, person_id: bi.uuid(), status: 'SIGNED', signed_at: signedAt, ...AUDIT });
  return id;
}

/** Oportunidade (CLOSED_WON por padrão) com proposta no estado dado (ACCEPTED soma; outro estado não). */
async function opportunity(env, t, { stage = 'CLOSED_WON', closedAt = null, broker = null, origin = 'SITE', proposal = null, proposalStatus = 'ACCEPTED', deletedAt = null } = {}) {
  const id = await bi.seed(env, t, 'crm.opportunities', { person_id: bi.uuid(), stage, owner_user_id: broker, lead_source: origin, closed_at: closedAt, won_reason: stage === 'CLOSED_WON' ? 'PRICE' : null, deleted_at: deletedAt, ...AUDIT });
  if (proposal !== null) await bi.seed(env, t, 'crm.proposals', { opportunity_id: id, value: proposal, status: proposalStatus, decided_at: closedAt, ...AUDIT });
  return id;
}

/** Saída (DEBIT PAYABLE) liquidada por padrão. */
const payment = (env, t, { amount, settledAt, status = 'SETTLED', third = false, account = null, parent = null, entryType = 'DEBIT', nature = 'PAYABLE' } = {}) => bi.seed(env, t, 'finance.financial_entries', {
  entry_type: entryType, nature, amount, status, settled_at: settledAt, is_third_party_funds: third, bank_account_id: account, parent_entry_id: parent, ...AUDIT,
});

const BROKER_A = '11111111-1111-4111-8111-111111111111';
const BROKER_B = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_B = '44444444-4444-4444-8444-444444444444';

/**
 * Contratos: 3 na janela (480.000,00 às 07:00 SP de 28/10; 2.400,00 às 17:00 SP de 27/10; 100,00 às 23:30 SP de 27/10 = 02:30Z de 28/10), 1 na janela anterior (1.000,00), 1 em rascunho.
 * Cada contrato assinado tem o evento status_changed -> SIGNED no outbox.
 */
async function contratos(env, t) {
  const ids = {};
  const signedNow = async (key, args) => {
    ids[key] = await contract(env, t, args);
    await outbox(env, t, { type: 'legal.contract.status_changed', aggregateId: ids[key], payload: { id: ids[key], fromStatus: 'SIGNING', toStatus: 'SIGNED' }, when: args.signedAt });
  };
  await signedNow('grande', { type: 'SALE', total: '480000.00', signedAt: at('28', '10:00:00') });
  await signedNow('aluguel', { type: 'LEASE', total: '2400.00', signedAt: at('27', '20:00:00') });
  await signedNow('noite', { type: 'LEASE', total: '100.00', signedAt: at('28', '02:30:00') }); // 27/10 23:30 em SP
  await signedNow('anterior', { type: 'SALE', total: '1000.00', signedAt: at('27', '14:59:59') }); // um segundo antes da janela
  ids.rascunho = await contract(env, t, { type: 'SALE', total: '900.00', status: 'DRAFT', signed: false });
  return ids;
}

/** Oportunidades: 3 ganhas na janela (300.000,00 e 210.000,00 aceitas; uma só com proposta ENVIADA = sem valor), 1 ganha na janela anterior, 1 perdida (fora). */
async function oportunidades(env, t) {
  const ids = {};
  const won = async (key, args) => {
    ids[key] = await opportunity(env, t, args);
    await outbox(env, t, { type: 'crm.opportunity.won', aggregateId: ids[key], payload: { id: ids[key] }, when: args.closedAt });
  };
  await won('a', { closedAt: at('28', '09:00:00'), broker: BROKER_A, origin: 'SITE', proposal: '300000.00' });
  await won('b', { closedAt: at('28', '10:30:00'), broker: BROKER_A, origin: 'INDICACAO', proposal: '210000.00' });
  await won('semProposta', { closedAt: at('28', '11:00:00'), broker: BROKER_B, origin: 'SITE', proposal: '50000.00', proposalStatus: 'SENT' });
  await won('anterior', { closedAt: at('27', '14:00:00'), broker: BROKER_B, origin: 'SITE', proposal: '77000.00' });
  ids.perdida = await opportunity(env, t, { stage: 'CLOSED_LOST', closedAt: at('28', '09:30:00'), broker: BROKER_A, proposal: '999.00' });
  return ids;
}

/** Pagamentos: 9.999,99 / 10.000,00 / 25.000,00 na janela, 50.000,00 de terceiros, 15.000,00 na janela anterior; pendente, cancelado e recebimento ficam fora. */
async function pagamentos(env, t) {
  const ids = {};
  const paid = async (key, args) => {
    ids[key] = await payment(env, t, args);
    await outbox(env, t, { type: 'finance.entry.settled', aggregateId: ids[key], payload: { id: ids[key] }, when: args.settledAt });
  };
  await paid('abaixo', { amount: '9999.99', settledAt: at('28', '10:00:00'), account: ACCOUNT_A });
  await paid('limiar', { amount: '10000.00', settledAt: at('28', '10:30:00'), account: ACCOUNT_A });
  await paid('grande', { amount: '25000.00', settledAt: at('28', '11:00:00'), account: ACCOUNT_B });
  await paid('terceiros', { amount: '50000.00', settledAt: at('28', '09:00:00'), account: ACCOUNT_B, third: true });
  await paid('anterior', { amount: '15000.00', settledAt: at('27', '14:00:00'), account: ACCOUNT_A });
  ids.pendente = await payment(env, t, { amount: '20000.00', settledAt: null, status: 'PENDING' });
  ids.cancelado = await payment(env, t, { amount: '20000.00', settledAt: null, status: 'CANCELLED' });
  ids.recebimento = await payment(env, t, { amount: '99999.00', settledAt: at('28', '10:00:00'), entryType: 'CREDIT', nature: 'RECEIVABLE' });
  return ids;
}

/** Estorna total o pagamento: o original vira REVERSED e nasce o lançamento compensatório (CREDIT) que aponta para ele; devolve o id do compensatório. */
async function estornar(env, t, id, amount, when) {
  await bi.update(env, 'finance.financial_entries', id, { status: 'REVERSED' });
  const reversal = await bi.seed(env, t, 'finance.financial_entries', { entry_type: 'CREDIT', nature: 'ADJUSTMENT', amount, status: 'SETTLED', settled_at: when, reversal_of_entry_id: id, ...AUDIT });
  await outbox(env, t, { type: 'finance.entry.reversed', aggregateId: id, payload: { originalEntryId: id }, when });
  return reversal;
}

module.exports = { at, outbox, contract, opportunity, payment, contratos, oportunidades, pagamentos, estornar, BROKER_A, BROKER_B, ACCOUNT_A, ACCOUNT_B };
