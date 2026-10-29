'use strict';

// Cenário de Atendimento da M9-D672. Data-base 28/10/2026 (SP). Outubro: 5 avaliações públicas (5,5,4,4,5 = 4,60), 5 respostas de satisfação (5,4,3,5,4 = 4,20 e 80,00%),
// 12 reclamações (7 do tipo reclamação e 5 de conflito), 7 casos resolvidos (5 dentro do SLA da prioridade) e 1 caso aberto já vencido. Setembro e o pedido sem retorno ficam fora.
const bi = require('./biObrasJuridicoEnv');
const src = require('./m9d627Sources');

const iso = (day, hour = 15, minute = 0) => `2026-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
const hoursAfter = (start, hours) => new Date(new Date(start).getTime() + hours * 3600000).toISOString();

const rev = (env, t, c) => src.review(env, t, { status: 'COMPLETED', platform: 'GOOGLE', completedAt: iso('10-10'), at: iso('10-09'), ...c });

async function avaliacoes(env, t) {
  for (const rating of [5, 5, 4, 4, 5]) await rev(env, t, { rating });
  await rev(env, t, { rating: 1, completedAt: iso('09-15'), at: iso('09-14') }); // setembro: fora do mês
  await src.review(env, t, { status: 'PENDING', at: iso('10-12') }); // pedido sem retorno da plataforma: sem nota, não entra
  for (const score of [5, 4, 3, 5, 4]) await rev(env, t, { score, rating: null }); // pesquisa de satisfação respondida, sem avaliação pública
  await rev(env, t, { score: 1, rating: null, completedAt: iso('09-20'), at: iso('09-19') });
}

async function reclamacoes(env, t) {
  const make = (type, n, at = iso('10-05')) => Promise.all(Array.from({ length: n }, () => src.feedbackCase(env, t, { type, at, slaDueAt: iso('12-01') })));
  await make('COMPLAINT', 7);
  await make('CONFLICT', 5);
  await make('COMPLIMENT', 2); // elogio não é reclamação
  await make('COMPLAINT', 3, iso('09-05')); // setembro
}

/** Casos resolvidos: [severidade, horas até resolver, origem]. ALTA 24 h, MEDIA 72 h, BAIXA 120 h (padrões de analytics.sla.horas.*). */
const RESOLVED = [['HIGH', 22], ['HIGH', 30], ['MEDIUM', 50], ['MEDIUM', 80], ['LOW', 100], ['LOW', 100, 'maintenance'], ['MEDIUM', 10, 'maintenance']];

async function slas(env, t) {
  for (const [severity, hours, origin] of RESOLVED) {
    const at = iso('10-01', 10);
    const resolvedAt = hoursAfter(at, hours);
    if (origin === 'maintenance') await src.insert(env, 'construction.maintenance_cases', t, { property_id: bi.uuid(), description: 'Chamado', status: 'RESOLVED', severity, created_at: at, updated_at: resolvedAt });
    else await src.feedbackCase(env, t, { type: 'COMPLAINT', severity, status: 'RESOLVED', at, resolvedAt, slaDueAt: hoursAfter(at, 24) });
  }
  await src.feedbackCase(env, t, { type: 'COMPLAINT', severity: 'HIGH', status: 'RESOLVED', at: iso('09-01', 10), resolvedAt: iso('09-01', 20), slaDueAt: iso('09-02', 10) }); // setembro
  await src.feedbackCase(env, t, { type: 'COMPLAINT', severity: 'HIGH', status: 'OPEN', at: iso('10-20', 10), slaDueAt: iso('10-21', 10) }); // aberto e vencido
  await src.feedbackCase(env, t, { type: 'COMPLAINT', severity: 'HIGH', status: 'OPEN', at: iso('10-28', 14), slaDueAt: iso('10-29', 14) }); // aberto, ainda no prazo (1 h)
}

module.exports = { avaliacoes, reclamacoes, slas, RESOLVED, iso, hoursAfter };
