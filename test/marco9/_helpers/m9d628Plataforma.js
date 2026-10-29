'use strict';

// Fontes de plataforma da M9-D628: sondas de saúde, filas (outbox e inbox) e atualizações dos read models. Instantes relativos a NOW = 2026-10-28T15:00Z (12:00 de São Paulo).
const env628 = require('./m9d628Env');

async function sondas(env) {
  for (let i = 0; i < 10; i += 1) await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: env628.minutesBefore(60 + i) });
  for (let i = 0; i < 5; i += 1) await env628.signal(env, { kind: 'PROBE', probe: 'DATABASE', ok: i !== 2, occurredAt: env628.minutesBefore(30 + i) });
  await env628.signal(env, { kind: 'PROBE', probe: 'DATABASE', ok: true, occurredAt: env628.at('2026-10-28T02:30:00Z') }); // 23:30 de 27/10 em São Paulo
  await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: env628.at('2026-10-28T20:00:00Z') }); // depois de "agora": fora
  await env628.signal(env, { kind: 'PROBE', probe: 'CACHE', ok: true, occurredAt: env628.minutesBefore(5) }); // sonda não ligada: fora
}

async function filas(env, t) {
  const outbox = (eventType, status, createdAt) => env628.seed(env, t, 'integration.outbox_events', {
    aggregate_type: 'X', aggregate_id: env628.uuid(), event_type: eventType, payload_json: '{}', idempotency_key: `m9d628-${env628.uuid()}`, occurred_at: createdAt, created_at: createdAt, updated_at: createdAt, status,
  });
  await outbox('crm.x', 'PENDING', '2026-10-28T11:00:00Z');
  await outbox('crm.x', 'PENDING', '2026-10-28T11:30:00Z');
  await outbox('crm.x', 'PENDING', '2026-10-28T12:00:00Z');
  await outbox('crm.x', 'DEAD_LETTER', '2026-10-28T10:00:00Z');
  await outbox('crm.x', 'PUBLISHED', '2026-10-28T09:00:00Z');
  await outbox('finance.y', 'DEAD_LETTER', '2026-10-28T10:30:00Z');
  const inbox = (status, createdAt) => env628.seed(env, t, 'integration.integration_inbox', {
    consumer_name: 'm9d628-consumer', event_id: env628.uuid(), idempotency_key: `m9d628-${env628.uuid()}`, status, created_at: createdAt, updated_at: createdAt,
  });
  await inbox('RECEIVED', '2026-10-28T13:00:00Z');
  await inbox('FAILED', '2026-10-28T13:30:00Z');
  await inbox('DEAD', '2026-10-28T08:00:00Z');
  await inbox('PROCESSED', '2026-10-28T07:00:00Z');
}

async function atualizacoes(env, t) {
  // Nomes fictícios com o prefixo do domínio: a agenda do próprio teste não grava atualização para eles, então a idade é a semeada.
  await env628.refresh(env, t, { model: 'rm_finance_m9d628', snapshotAt: env628.minutesBefore(30) }); // limite FINANCE 60: FRESH
  await env628.refresh(env, t, { model: 'rm_legal_m9d628', snapshotAt: env628.minutesBefore(600) }); // limite LEGAL 240: 600 min, STALE
  await env628.refresh(env, t, { model: 'rm_rental_m9d628', snapshotAt: env628.minutesBefore(1200) }); // limite RENTAL 240 x 4 = 960: 1200 min, EXPIRED
  await env628.refresh(env, t, { model: 'rm_m9d628_tec', snapshotAt: env628.minutesBefore(5) }); // sem prefixo conhecido: limite TECH_AI 15, FRESH
  await env628.refresh(env, t, { model: 'rm_m9d628_tec', snapshotAt: env628.minutesBefore(90) }); // a mais antiga não conta: vale o maior source_snapshot_at
  await env628.refresh(env, t, { model: 'rm_support_m9d628', status: 'FAILED', snapshotAt: env628.minutesBefore(5) }); // falhou: não conta
}

module.exports = { sondas, filas, atualizacoes };
