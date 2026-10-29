'use strict';

const ingestion = require('./ingestion.service');
const { enqueueKnowledge, retractKnowledge } = require('./ingestion.knowledge');
const { classifyFile } = require('./fileClassification.service');
const { chunkText } = require('./chunker');
const { scanSecrets } = require('./secretScanner');
const { writeChunks, assertChunkMetadata } = require('./chunks.write');
const { readRagParams } = require('./retrieval.params');
const { rejectionError } = require('./retrieval.errors');

/** RAG da NAY (M9-D022): ingestão segura, chunks com metadados e gravação com a versão anterior substituída. A busca (M9-D023) entra na demanda seguinte. */
module.exports = {
  ingest: ingestion.ingest, getIngestion: ingestion.get, processPending: ingestion.processPending, enqueueKnowledge, retractKnowledge,
  classifyFile, chunkText, scanSecrets, writeChunks, assertChunkMetadata, readRagParams, rejectionError,
};
