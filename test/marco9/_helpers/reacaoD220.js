'use strict';

// Auxiliar das provas "padrão da D220" de cada módulo de domínio: consumir o evento interno do envio (duas vezes, como a reentrega), contar auditoria e eventos. Roda com COMMIT (banco descartável).
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { OutboxEvent } = require('../../../src/models');

/** Linha do evento do envio no outbox (tipo `integration.dispatch.<x>`), ou null. */
async function eventoDoEnvio(env, tipo, dispatchId) {
  const [linha] = await env.ler("SELECT id FROM integration.outbox_events WHERE company_id = :c AND event_type = :t AND payload_json->>'dispatchId' = :d", { t: tipo, d: dispatchId });
  return linha || null;
}

/** Entrega o evento aos consumidores DUAS vezes (reentrega do despachante). Devolve o id do evento. */
async function consumirDuasVezes(env, tipo, dispatchId) {
  const linha = await eventoDoEnvio(env, tipo, dispatchId);
  if (!linha) throw new Error(`Sem evento ${tipo} para o envio ${dispatchId}.`);
  await env.comTenant(env.tenant, async (t) => {
    const evento = await OutboxEvent.findByPk(linha.id, { transaction: t });
    await runEventConsumers(evento, t);
    await runEventConsumers(evento, t);
  });
  return linha.id;
}

/** Quantas reações auditadas existem para a entidade (a reação do consumidor grava `integration.reaction.<consumidor>`). */
async function reacoesAuditadas(env, consumidor, entityId) {
  const [{ n }] = await env.ler('SELECT count(*)::int AS n FROM audit.audit_log WHERE action = :a AND entity_id = :id', { a: `integration.reaction.${consumidor}`, id: entityId });
  return n;
}

/** Variante dentro de UMA transação (testes com rollback): publica o evento do envio como o motor faz e entrega aos consumidores duas vezes. Devolve o id do evento. */
async function consumirNaTransacao(sequelize, t, tipo, dispatchId) {
  const [linhas] = await sequelize.query("SELECT id FROM integration.outbox_events WHERE event_type = :t AND payload_json->>'dispatchId' = :d", { replacements: { t: tipo, d: dispatchId }, transaction: t });
  if (!linhas.length) throw new Error(`Sem evento ${tipo} para o envio ${dispatchId}.`);
  const evento = await OutboxEvent.findByPk(linhas[0].id, { transaction: t });
  await runEventConsumers(evento, t);
  await runEventConsumers(evento, t);
  return evento.id;
}

/** Quantas reações auditadas existem para a entidade, dentro da transação. */
async function reacoesNaTransacao(sequelize, t, consumidor, entityId) {
  const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM audit.audit_log WHERE action = :a AND entity_id = :id', { replacements: { a: `integration.reaction.${consumidor}`, id: entityId }, transaction: t });
  return n;
}

const contar = async (env, sql, replacements) => (await env.ler(sql, replacements))[0].n;

module.exports = { eventoDoEnvio, consumirDuasVezes, reacoesAuditadas, consumirNaTransacao, reacoesNaTransacao, contar };
