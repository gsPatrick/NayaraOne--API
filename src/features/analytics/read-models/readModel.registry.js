'use strict';

/**
 * M9-D607 — registro dos read models do BI. Cada demanda de domínio (M9-D615 a M9-D628) registra o seu:
 *
 *   registerReadModel({
 *     name: 'rm_finance_cash',            // tabela em analytics (mesmo nome)
 *     version: 1,                         // versão do esquema do read model (sobe quando o formato muda)
 *     keyColumns: ['account_id'],         // chave do agregado, além de company_id (índice único em (company_id, ...keyColumns))
 *     eventTypes: ['finance.entry.settled'],
 *     aggregateKey: (event) => ({ account_id: event.payloadJson.accountId }),   // null = evento não interessa
 *     recompute: async ({ companyId, groupId, key, limit, asOfDate, now, event, transaction }) =>
 *       ({ fields: { balance: '120000.00' }, sourceSnapshotAt, truncated }),    // lê o ESTADO atual da fonte, nunca soma delta
 *     scheduled: { keys: async ({ companyId, groupId, limit, transaction }) => [{ account_id }] },   // só para quem depende do relógio
 *     rebuild: { keys: async ({ companyId, groupId, transaction }) => [{ account_id }],   // M9-D608: TODOS os agregados da fonte da empresa
 *               corrections: async ({ companyId, groupId, snapshotAt, transaction }) => [snapshotInput] },   // opcional: valores do passado a corrigir
 *   })
 *
 * `recompute` lê a fonte restrita ao agregado, com no máximo `limit` linhas (parâmetro analytics.refresh.max_linhas_agregado);
 * se houver mais, devolve `{ truncated: true }` e o agregado vai para a janela do job agendado (nunca varredura por evento, BI-012).
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;
const MODEL_RE = /^rm_[a-z][a-z0-9_]*$/;

const models = new Map();
const byEventType = new Map();
let consumerInstaller = null;

function assertDefinition(def) {
  if (!def || typeof def.name !== 'string' || !MODEL_RE.test(def.name)) throw new Error('Read model: o nome deve seguir rm_nome_em_snake.');
  if (!Number.isInteger(def.version) || def.version < 1) throw new Error(`Read model ${def.name}: version deve ser um inteiro a partir de 1.`);
  if (!Array.isArray(def.keyColumns) || !def.keyColumns.length || !def.keyColumns.every((c) => IDENT.test(c))) {
    throw new Error(`Read model ${def.name}: keyColumns deve listar as colunas da chave do agregado.`);
  }
  if (!Array.isArray(def.eventTypes) || !def.eventTypes.every((t) => typeof t === 'string' && t)) throw new Error(`Read model ${def.name}: eventTypes inválido.`);
  if (typeof def.aggregateKey !== 'function' || typeof def.recompute !== 'function') throw new Error(`Read model ${def.name}: informe aggregateKey e recompute.`);
  if (def.scheduled && typeof def.scheduled.keys !== 'function') throw new Error(`Read model ${def.name}: scheduled.keys deve ser função.`);
  if (def.rebuild && (typeof def.rebuild.keys !== 'function' || (def.rebuild.corrections && typeof def.rebuild.corrections !== 'function'))) {
    throw new Error(`Read model ${def.name}: rebuild.keys (e rebuild.corrections, se houver) devem ser funções.`);
  }
}

/** Liga o worker ao despacho de eventos (injetado por consumer.js para o registro não depender do outbox no carregamento). */
function setConsumerInstaller(fn) {
  consumerInstaller = fn;
}

function registerReadModel(def) {
  assertDefinition(def);
  if (models.has(def.name)) throw new Error(`Read model duplicado: ${def.name}.`);
  models.set(def.name, def);
  for (const type of def.eventTypes) {
    const list = byEventType.get(type) || [];
    list.push(def);
    byEventType.set(type, list);
    if (consumerInstaller) consumerInstaller(type);
  }
  return def;
}

const getReadModel = (name) => models.get(name) || null;
const listReadModels = () => [...models.values()];
const modelsFor = (eventType) => byEventType.get(eventType) || [];
const knownEventTypes = () => [...byEventType.keys()];

/** Só para teste: esquece um read model registrado. */
function unregisterReadModel(name) {
  const def = models.get(name);
  if (!def) return;
  models.delete(name);
  for (const type of def.eventTypes) {
    const list = (byEventType.get(type) || []).filter((d) => d.name !== name);
    if (list.length) byEventType.set(type, list); else byEventType.delete(type);
  }
}

module.exports = { IDENT, registerReadModel, unregisterReadModel, getReadModel, listReadModels, modelsFor, knownEventTypes, setConsumerInstaller };
