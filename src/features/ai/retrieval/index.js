'use strict';

const { RetrievalService } = require('./RetrievalService');
const ingestion = require('./ingestion.service');
const { enqueueKnowledge, retractKnowledge } = require('./ingestion.knowledge');
const { reconcileChunks } = require('./reconcileJob');
const { classifyFile } = require('./fileClassification.service');
const { chunkText } = require('./chunker');
const { scanSecrets } = require('./secretScanner');
const { writeChunks, assertChunkMetadata } = require('./chunks.write');
const { readRagParams } = require('./retrieval.params');
const { rejectionError } = require('./retrieval.errors');
const { expireSources } = require('./expiry');
const { revokeSource } = require('./revocation');
const { detectConflicts } = require('./conflictDetector');
const vigencia = require('./vigencia');

/** RAG da NAY (M9-D022 e M9-D023): ingestão segura, chunks com metadados e busca com empresa e permissão antes do conteúdo. */
module.exports = {
  RetrievalService, ingest: ingestion.ingest, getIngestion: ingestion.get, processPending: ingestion.processPending, enqueueKnowledge, retractKnowledge,
  reconcileChunks, classifyFile, chunkText, scanSecrets, writeChunks, assertChunkMetadata, readRagParams, rejectionError,
  expireSources, revokeSource, detectConflicts, vigencia,
};
