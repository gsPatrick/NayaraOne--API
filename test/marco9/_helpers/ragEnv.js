'use strict';

// Ambiente do RAG (M9-D022 e M9-D023): tenants, pessoas, arquivos enviados pelo módulo de arquivos e atalhos da ingestão e da busca.
// Tudo roda com nayara_runtime (RLS real) em transação com rollback, salvo os testes de concorrência.

const { File } = require('../../../src/models');
const { uploadFile } = require('../../../src/features/files/files.service');
const rag = require('../../../src/features/ai/retrieval');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { montarPdf } = require('./ragDocs');

registerAiAdapters(); // o servidor registra no boot; o teste de serviço registra aqui (sandbox determinístico)
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const comPerm = (ctx, ...permissions) => ({ ...ctx, permissions });
let servicoBusca = null; // busca (M9-D023): criada só quando um teste a pede

/** Envia um PDF pelo módulo de arquivos (antivírus, cifra e hash reais) e devolve o registro. `classificacao` já grava a do registro. */
async function enviarPdf(tenant, tx, { linhas, nome = `doc-${uid().slice(0, 8)}.pdf`, userId, classificacao = 'INTERNAL', buffer, categoria, mime = PDF } = {}) {
  const conteudo = buffer || montarPdf(linhas || ['Documento de teste.']);
  const file = await uploadFile({ groupId: tenant.groupId, companyId: tenant.companyId, fileName: nome, mimeType: mime, contentBase64: conteudo.toString('base64'), category: categoria }, userId || tenant.userId, tx);
  if (classificacao) await File.update({ classification: classificacao }, { where: { id: file.id }, transaction: tx });
  return file;
}

const ingerirArquivo = (ctx, fileId, tx, extra = {}, opts = {}) => rag.ingest(ctx, { sourceKind: 'FILE', sourceRef: fileId, ...extra }, tx, opts);
const chunksDe = (sourceId, tx, status = 'ACTIVE') => q('SELECT * FROM ai.chunks WHERE source_id = :id AND status = :status ORDER BY source_version, chunk_index', { id: sourceId, status }, tx);

async function rejeita(promessa, status, code) {
  const assert = require('node:assert/strict');
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}

module.exports = {
  sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants, comPerm, enviarPdf, ingerirArquivo, chunksDe, rejeita, rag, PDF, DOCX,
  get servico() { servicoBusca = servicoBusca || new rag.RetrievalService(); return servicoBusca; },
};
