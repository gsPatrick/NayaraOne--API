'use strict';

const { IntegrationSyncCursor, IntegrationConnection, IntegrationProvider } = require('../../../models');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { effectiveCriticality } = require('../providers/catalog.service');
const { readSyncParams } = require('./sync.params');
const { eventoParado } = require('./sync.failure');

/**
 * Sync parado (livro, seção 17): `agora - último sucesso` acima do limite da criticidade da família (CRITICAL 15 min,
 * HIGH 30, MEDIUM 120, LOW 1440 — parâmetros). Fluxo que nunca teve sucesso conta desde que foi criado.
 * Cada atraso gera UM evento `integration.sync.stalled` (chave por cursor + último sucesso), que o D224 vira alerta SYNC_STALLED.
 * Conexão que não está ACTIVE (pausada, desativada) não alerta: não é para estar sincronizando.
 */
async function detectStalledSyncs(ctx, transaction, { now = new Date() } = {}) {
  const params = await readSyncParams(ctx, transaction);
  const cursores = await IntegrationSyncCursor.findAll({ where: { companyId: ctx.companyId }, transaction });
  if (!cursores.length) return [];
  const conexoes = new Map((await IntegrationConnection.findAll({ where: { id: [...new Set(cursores.map((c) => c.connectionId))] }, transaction })).map((c) => [c.id, c]));
  const providers = new Map((await IntegrationProvider.findAll({ transaction })).map((p) => [p.code, p]));
  const criticidade = new Map();
  const achados = [];
  for (const cursor of cursores) {
    const conexao = conexoes.get(cursor.connectionId);
    const provider = conexao && providers.get(conexao.providerCode);
    if (!conexao || conexao.status !== 'ACTIVE' || !provider) continue;
    if (!criticidade.has(provider.domain)) criticidade.set(provider.domain, await effectiveCriticality(provider.domain, ctx, transaction));
    const nivel = criticidade.get(provider.domain);
    const limite = params.stalledAfterMinutes[nivel];
    const referencia = cursor.lastSuccessAt || cursor.createdAt;
    const minutos = Math.floor((now.getTime() - new Date(referencia).getTime()) / 60000);
    if (minutos <= limite) continue;
    await publishDomainEvent(eventoParado(cursor, conexao, 'NO_SUCCESS', new Date(referencia).getTime()), transaction);
    achados.push({
      cursorId: cursor.id, connectionId: conexao.id, providerCode: conexao.providerCode, domain: provider.domain,
      stream: cursor.stream, criticality: nivel, minutesWithoutSuccess: minutos, limitMinutes: limite,
    });
  }
  return achados;
}

module.exports = { detectStalledSyncs };
