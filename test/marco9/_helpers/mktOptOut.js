'use strict';

// Apoio dos testes do opt-out como evento (M9-D419): leitura do outbox, da supressão e do consentimento da pessoa. Não é teste.
const env = require('./mktPolicyEnv');
const { OutboxEvent } = require('../../../src/models');

const { q } = env;
const ADDRESS_LIKE = /@|\+?\d{8,}/;

/** Eventos do tipo para a pessoa (linhas do outbox, com o envelope em payload_json). */
const events = (t, personId, type = 'customer.opted_out') => q(t,
  'SELECT id, payload_json FROM integration.outbox_events WHERE aggregate_id = :p AND event_type = :ty ORDER BY created_at, id', { p: personId, ty: type });
const suppressions = (t, personId) => q(t, 'SELECT * FROM marketing.suppression_list WHERE person_id = :p ORDER BY created_at, id', { p: personId });
const optOutConsents = (t, personId) => q(t, "SELECT channel, purpose, status FROM people.communication_consents WHERE person_id = :p AND status = 'OPT_OUT'", { p: personId });
/** Linha do outbox como o dispatcher a entrega aos consumidores (modelo OutboxEvent). */
const outboxRow = (t, personId, type = 'customer.opted_out') => OutboxEvent.findOne({ where: { aggregateId: personId, eventType: type }, order: [['created_at', 'DESC']], transaction: t });

module.exports = { ...env, events, suppressions, optOutConsents, outboxRow, ADDRESS_LIKE };
