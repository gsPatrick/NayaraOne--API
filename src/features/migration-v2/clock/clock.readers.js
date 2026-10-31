'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const connectors = require('../ingest/connectors');
const sources = require('../ingest/source.repository');

/**
 * Leitores de relógio (M9-D908 §3.1). Cada leitor é `async ({ tenant, connectors? }) => [{ system, offsetMs }]` e devolve quanto o relógio daquele sistema está à frente (+) ou atrás (-)
 * do relógio da aplicação, em ms; a aplicação é a referência (deslocamento 0). Leitor que falha vira leitura não medida. Embutidos: o banco de destino (`SELECT now()`), a fonte antiga
 * (conector com `readClock()`); o NTP é registrado pelo processo da API (clock.job), para os testes e o laboratório offline não dependerem da rede.
 */
const registry = new Map();
const register = (name, fn) => { registry.set(name, fn); return () => registry.delete(name); };
const unregister = (name) => registry.delete(name);
const list = () => [...registry.entries()];

/** Deslocamento do relógio `remote()` em relação ao local, medido no meio da chamada (compensa a latência da consulta). */
async function measure(remote) {
  const before = Date.now();
  const at = await remote();
  const after = Date.now();
  const remoteMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(remoteMs)) throw new Error('CLOCK_UNREADABLE');
  return Math.round(remoteMs - (before + after) / 2);
}

async function readDatabase() {
  const offsetMs = await measure(async () => (await sequelize.query('SELECT now() AS now', { type: QueryTypes.SELECT }))[0].now);
  return [{ system: 'DB', offsetMs }];
}

async function readSources({ tenant, connectors: given }) {
  const own = [];
  let targets = given;
  if (!targets) {
    const rows = await openTenantTx(tenant, (transaction) => sources.list(tenant, {}, transaction));
    targets = [];
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.source_system)) continue;
      seen.add(row.source_system);
      try { const connector = await connectors.open(row); own.push(connector); targets.push({ system: row.source_system, connector }); } catch (err) { targets.push({ system: row.source_system, failure: err }); }
    }
  }
  const out = [];
  try {
    for (const target of targets) {
      if (target.failure) { out.push({ system: `SOURCE:${target.system}`, error: target.failure.code || 'SOURCE_UNREACHABLE' }); continue; }
      if (typeof target.connector.readClock !== 'function') continue; // fonte sem relógio legível: não entra na conta
      try {
        out.push({ system: `SOURCE:${target.system}`, offsetMs: await measure(() => target.connector.readClock()) });
      } catch (err) { out.push({ system: `SOURCE:${target.system}`, error: err.code || 'CLOCK_UNREADABLE' }); }
    }
  } finally {
    await Promise.all(own.map((connector) => connector.close().catch(() => {})));
  }
  return out;
}

register('DB', readDatabase);
register('SOURCE', readSources);

module.exports = { register, unregister, list, measure };
