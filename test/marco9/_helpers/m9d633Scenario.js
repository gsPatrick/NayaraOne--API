'use strict';

// Cenário da M9-D633: hoje é 28/10/2026 12:00 de São Paulo. Radar (12 cruzamentos no mês, 10 avisados, 2 que geraram visita ou oportunidade => 16,67%), captação por corretor
// (Ana 12, Bruno 8, Sem captador 1 => 4,76%, abaixo do limite de 5%) e conversão por corretor (Ana 7 ganhas e 13 perdidas => 35,00%; Bruno com 3 fechadas
// fica fora do ranking). Entram também os registros que NÃO devem contar (outro mês, excluídos, depois da data-base, na virada do dia).
const base = require('./m9d632Scenario');

const { src, iso } = base;

const radar = (env, t, c) => src.insert(env, 'crm.property_radars', t, {
  person_id: c.person || src.uuid(), opportunity_id: c.opportunity || null, criteria_json: JSON.stringify({ type: 'APARTMENT' }), status: 'ACTIVE', created_by: c.createdBy || null,
});

const match = (env, t, c) => src.insert(env, 'integration.outbox_events', t, {
  aggregate_type: 'PropertyRadar', aggregate_id: c.radar, event_type: 'radar.matched', payload_json: JSON.stringify({ radarId: c.radar, personId: c.person, propertyId: c.property }),
  idempotency_key: `radar.matched:${c.radar}:${c.property}:${src.uuid()}`, occurred_at: c.at, status: c.status || 'PUBLISHED',
});

/** 12 cruzamentos no mês (10 avisados, 2 convertidos) em radares válidos, mais os que ficam de fora. Devolve ids úteis ao teste. */
async function seedRadar(env, t, brokerA, brokerB) {
  const opp = await src.opportunity(env, t, { owner: brokerB, created: iso('2026-10-01') });
  const rA = await radar(env, t, { createdBy: brokerA });
  const rB = await radar(env, t, { createdBy: brokerB, opportunity: opp });
  const props = [];
  for (let i = 0; i < 4; i += 1) props.push(await base.property(env, t, { publishedAt: iso('2026-10-10'), offers: ['SALE'], createdBy: brokerA }));
  const person = src.uuid();
  const events = [];
  const add = async (radarId, property, at, status = 'PUBLISHED', personId = person) => events.push(await match(env, t, { radar: radarId, person: personId, property, at, status }));
  const old = src.uuid();
  const canceled = src.uuid();
  await add(rA, props[0], iso('2026-10-08'), 'PUBLISHED', old); // já tinha oportunidade ANTES do cruzamento: não foi o Radar que a gerou
  await src.opportunity(env, t, { owner: brokerA, person: old, property: props[0], created: iso('2026-10-01') });
  await add(rA, props[1], iso('2026-10-08'), 'PUBLISHED', canceled); // visita cancelada não conta
  await src.insert(env, 'crm.visits', t, { property_id: props[1], person_id: canceled, scheduled_at: iso('2026-10-15'), status: 'CANCELED', created_at: iso('2026-10-09') });
  for (let i = 2; i < 5; i += 1) await add(rA, props[i % 4], iso('2026-10-08'));
  for (let i = 0; i < 3; i += 1) await add(rB, props[i % 4], iso('2026-10-09'));
  await add(rA, props[0], iso('2026-10-10'), 'PENDING');
  await add(rB, props[1], '2026-10-29T02:30:00Z', 'PENDING'); // 23:30 de 28/10 em São Paulo: dentro do mês
  await add(rA, props[2], '2026-10-29T03:30:00Z'); // 00:30 de 29/10: depois da data-base, fora
  await add(rA, props[2], iso('2026-09-20')); // setembro: fora
  // dois cruzamentos geraram visita ou oportunidade (depois do cruzamento, no mesmo imóvel); um deles também tem negócio GANHO (o campo antigo da M9-D616)
  const winner = src.uuid();
  await add(rA, props[3], iso('2026-10-12'), 'PUBLISHED', winner);
  await src.insert(env, 'crm.visits', t, { property_id: props[3], person_id: winner, scheduled_at: iso('2026-10-16'), status: 'SCHEDULED', created_at: iso('2026-10-14') });
  const winner2 = src.uuid();
  await add(rB, props[2], iso('2026-10-13'), 'PUBLISHED', winner2);
  await src.opportunity(env, t, { owner: brokerB, person: winner2, property: props[2], stage: 'CLOSED_WON', closedAt: iso('2026-09-21'), created: iso('2026-10-15') });
  return { rA, rB, props, events };
}

/** Captação do mês: Ana 12, Bruno 8 e 1 sem captador (4,76%); só parte tem oferta ativa (valor). Mais um captado em setembro e um excluído (fora). */
async function seedCapture(env, t, ana, bruno) {
  const mk = (createdBy, extra = {}) => base.property(env, t, { createdBy, created: iso('2026-10-05'), publishedAt: iso('2026-10-06'), ...extra });
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(await mk(ana, { offers: i < 6 ? ['SALE'] : [], price: '600000.00' }));
  for (let i = 0; i < 8; i += 1) ids.push(await mk(bruno, { offers: i < 2 ? ['RENT'] : [], price: '4000.00' }));
  ids.push(await mk(null));
  await mk(ana, { created: iso('2026-09-30', '20:00:00') });
  const gone = await mk(ana);
  await src.update(env, 'real_estate.properties', gone, { deleted_at: iso('2026-10-10') });
  return ids;
}

/** Fechadas do mês: Ana 7 ganhas e 13 perdidas, Bruno 1 e 2; mais desistência, setembro e excluída (fora). */
async function seedClosed(env, t, ana, bruno) {
  const mk = (owner, stage, extra = {}) => src.opportunity(env, t, { owner, stage, created: iso('2026-09-01'), closedAt: iso('2026-10-15'), lostReason: stage === 'CLOSED_LOST' ? 'PRICE' : null, ...extra });
  const ids = [];
  for (let i = 0; i < 7; i += 1) ids.push(await mk(ana, 'CLOSED_WON'));
  for (let i = 0; i < 13; i += 1) ids.push(await mk(ana, 'CLOSED_LOST'));
  ids.push(await mk(bruno, 'CLOSED_WON'));
  for (let i = 0; i < 2; i += 1) ids.push(await mk(bruno, 'CLOSED_LOST'));
  await mk(ana, 'WITHDRAWN');
  await mk(ana, 'CLOSED_WON', { closedAt: iso('2026-09-15') });
  const gone = await mk(ana, 'CLOSED_LOST');
  await src.update(env, 'crm.opportunities', gone, { deleted_at: iso('2026-10-16') });
  return ids;
}

module.exports = { ...base, radar, match, seedRadar, seedCapture, seedClosed };
