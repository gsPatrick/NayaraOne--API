'use strict';

const crypto = require('node:crypto');
const { MAX_BYTES } = require('../../files/files.service');
const { redactForStorage } = require('../security/piiRedactor');
const { readSource } = require('./ingestion.sources');
const { fetchForIngestion } = require('./urlFetcher');
const { isClean, registryClean } = require('./ingestion.scan');
const { parseDocument } = require('./parse');
const { scanSecrets } = require('./secretScanner');
const { chunkText } = require('./chunker');
const { embedTexts } = require('./embedder');
const repo = require('./ingestion.repository');
const { STEPS, CLASSIFICATIONS } = require('./retrieval.constants');

/**
 * Pipeline de ingestão (M9-D022), na ordem do Guia §6: autorização (feita antes, em describeSource) -> malware -> hash e idempotência ->
 * classificação -> leitura do texto -> segredos e PII -> chunks -> vetores. Nada é gravado aqui: devolve o que aconteceu (`replay`,
 * `stop` com etapa e código, ou `done` com chunks e vetores) e quem grava é ingestion.settle. Uma parada REJECTED é uma decisão do
 * pipeline (conteúdo recusado); FAILED é erro técnico e reenviar é seguro (idempotente pelo hash).
 */
class Stop extends Error {
  constructor(status, step, code) { super(code); this.status = status; this.step = step; this.code = code; }
}
const reject = (step, code) => new Stop('REJECTED', step, code);
const failure = (step) => new Stop('FAILED', step, 'AI_INGEST_FAILED');

async function acquireContent(ctx, desc, params, transaction, hooks) {
  if (desc.kind === 'URL') {
    try {
      const r = await fetchForIngestion(desc.sourceRef, { tenant: { groupId: ctx.groupId, companyId: ctx.companyId }, allowedDomains: params.allowedDomains }, transaction, hooks.fetchOptions);
      return { buffer: r.buffer, mimeType: r.contentType };
    } catch (err) {
      throw err && err.code === 'URL_BLOCKED' ? reject(STEPS.fetch, 'AI_INGEST_URL_BLOCKED') : failure(STEPS.fetch);
    }
  }
  try {
    return await readSource(desc, ctx, transaction);
  } catch (err) {
    if (err && err.isOperational) throw failure(STEPS.fetch);
    throw err;
  }
}

/** Passo 4: a classificação vem do registro; sem ela a ingestão é recusada, e RESTRICTED só entra com o parâmetro ligado. */
function checkClassification(desc, params) {
  if (!CLASSIFICATIONS.includes(desc.classification)) throw reject(STEPS.classify, 'AI_INGEST_UNCLASSIFIED');
  if (desc.classification === 'RESTRICTED' && !params.indexRestricted) throw reject(STEPS.classify, 'AI_INGEST_RESTRICTED_BLOCKED');
}

function readText(content) {
  try {
    return parseDocument(content.buffer, { mimeType: content.mimeType, maxBytes: MAX_BYTES });
  } catch (err) {
    throw reject(STEPS.parse, err && err.code === 'PARSE_UNSUPPORTED' ? 'AI_INGEST_UNSUPPORTED' : 'AI_INGEST_UNREADABLE');
  }
}

/** Idempotência (passo 3): mesmo conteúdo já INDEXED na versão vigente não reindexa, salvo pedido explícito de reindexação. */
async function findReplay(ctx, desc, hash, reindex, transaction) {
  if (desc.kind === 'KNOWLEDGE_ENTRY' || reindex) return null;
  const vigente = await repo.findIndexed(ctx, desc.kind, desc.sourceId, transaction);
  return vigente && vigente.contentHash === hash ? vigente : null;
}

/** runPipeline(ctx, input, desc, params, transaction, hooks) => { replay } | { stop, track } | { done, track, chunks, vectors, model }. */
async function runPipeline(ctx, input, desc, params, transaction, hooks = {}) {
  const track = { contentHash: null, secretsRemoved: 0, activeContentDiscarded: 0, version: null };
  try {
    if (desc.kind === 'URL') checkClassification(desc, params); // não gasta rede com URL que seria recusada por falta de classificação
    if (!registryClean(desc.file)) throw reject(STEPS.scan, 'AI_INGEST_MALWARE');
    const content = await acquireContent(ctx, desc, params, transaction, hooks);
    if (!(await isClean({ groupId: ctx.groupId, companyId: ctx.companyId }, content.buffer, transaction))) throw reject(STEPS.scan, 'AI_INGEST_MALWARE');
    track.contentHash = crypto.createHash('sha256').update(content.buffer).digest('hex');
    const replay = await findReplay(ctx, desc, track.contentHash, input.reindex, transaction);
    if (replay) return { replay };
    checkClassification(desc, params);
    const parsed = readText(content);
    track.activeContentDiscarded = parsed.activeDiscarded;
    const scanned = scanSecrets(parsed.text);
    track.secretsRemoved = scanned.removed;
    if (scanned.percent > params.secretsRejectPercent) throw reject(STEPS.secrets, 'AI_INGEST_SECRETS');
    const chunks = chunkText(redactForStorage(scanned.text), params);
    if (!chunks.length) throw reject(STEPS.chunk, 'AI_INGEST_EMPTY');
    let embedded;
    try {
      embedded = await embedTexts({ groupId: ctx.groupId, companyId: ctx.companyId }, chunks.map((c) => c.text), { classification: desc.classification, batch: params.embeddingBatch }, transaction);
    } catch (err) {
      throw failure(STEPS.embed);
    }
    return { done: true, track, chunks, vectors: embedded.vectors, model: embedded.model };
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return { stop: err, track };
  }
}

module.exports = { runPipeline, Stop };
