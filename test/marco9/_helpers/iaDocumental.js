'use strict';

// Apoio dos testes da NAY Documental (M9-D040): agente ativado pelo ciclo completo (iaAgenteNay) e arquivos da empresa de teste (documento
// com marcador de OCR do sandbox, PDF com camada de texto e imagem), todos enviados pelo upload real (antivírus, hash e cifra em disco).

const { ativarAgente, rodar, como, svc, FIXO } = require('./iaAgenteNay');
const nay = require('../../../src/features/ai/agents/nay_documental');
const { uploadFile } = require('../../../src/features/files/files.service');
const { montarPdf } = require('./ragDocs');
const { Person, PersonDocument } = require('../../../src/models');
const { q, run, uid } = require('../../helpers/aiAgents');

const PERMS = ['ai:use', 'people:read'];

/** NAY_DOCUMENTAL ativa (ciclo de alto impacto). `perms` são as permissões de quem pergunta (o arquivo de `people-documents` pede people:read). */
const cenario = (tenant, tx, opts = {}) => ativarAgente(tenant, tx, {
  CODE: nay.CODE, DEFINITION: nay.DEFINITION, GOLDEN_CASES: nay.GOLDEN_CASES, register: nay.registerNayDocumental,
}, { perms: PERMS, ...opts });

const enviar = (tenant, tx, { nome, mime, buffer, categoria = 'people-documents' }) => uploadFile({
  groupId: tenant.groupId, companyId: tenant.companyId, fileName: nome, mimeType: mime, contentBase64: buffer.toString('base64'), category: categoria,
}, tenant.userId, tx);

/** Arquivo cujo conteúdo é o marcador de OCR do sandbox: o que ele "lê" é exatamente `fields`, com a confiança e a posição informadas. */
const arquivoOcr = (tenant, tx, { fields, confidence = 0.95, positions, fieldConfidence, nome = `doc-${uid().slice(0, 8)}.png`, mime = 'image/png' }) => enviar(tenant, tx, {
  nome, mime, buffer: Buffer.from(JSON.stringify({ __mockOcr: { fields, confidence, ...(positions ? { positions } : {}), ...(fieldConfidence ? { fieldConfidence } : {}) } }), 'utf8'),
});

/** PDF com camada de texto (as `linhas` aparecem na leitura). */
const arquivoPdf = (tenant, tx, { linhas, nome = `doc-${uid().slice(0, 8)}.pdf` }) => enviar(tenant, tx, { nome, mime: 'application/pdf', buffer: montarPdf(linhas) });

/** Arquivo sem marcador (ilegível para o OCR do sandbox). */
const arquivoIlegivel = (tenant, tx) => enviar(tenant, tx, { nome: `borrado-${uid().slice(0, 8)}.png`, mime: 'image/png', buffer: Buffer.from('conteudo sem texto legivel', 'utf8') });

/** Dá dono ao arquivo (documento de uma pessoa): daí só lê quem tem a permissão do módulo dono (people:read), nem o administrador da empresa escapa. */
async function vincularAPessoa(tenant, tx, fileId) {
  const pessoa = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa M9D040 ${uid().slice(0, 8)}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: tx });
  return PersonDocument.create({ groupId: tenant.groupId, companyId: tenant.companyId, personId: pessoa.id, documentType: 'RG', fileId, versionNo: 1, verificationStatus: 'PENDING', extractedDataJson: {}, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: tx });
}

const marcarNaoVerificado = (fileId, tx, status = 'PENDING') => run("UPDATE people.files SET scan_status = :status WHERE id = :id", { id: fileId, status }, tx);

/** Contagens das tabelas que a NAY Documental NUNCA pode alterar (cadastro de documentos, arquivos e índice do RAG). */
async function contagens(tx) {
  const n = async (sql) => (await q(sql, {}, tx))[0].n;
  return {
    pessoaDocumentos: await n('SELECT count(*)::int AS n FROM people.person_documents'),
    casoDocumentos: await n('SELECT count(*)::int AS n FROM correspondent.case_documents'),
    arquivos: await n('SELECT count(*)::int AS n FROM people.files'),
    chunks: await n('SELECT count(*)::int AS n FROM ai.chunks'),
    ingestoes: await n('SELECT count(*)::int AS n FROM ai.ingestions'),
    recomendacoes: await n('SELECT count(*)::int AS n FROM ai.ai_recommendations'),
    tarefas: await n('SELECT count(*)::int AS n FROM core.tasks'),
  };
}

const lerRun = async (id, tx) => (await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const chamadas = (runId, tx) => q('SELECT tool_name, status, blocked_reason, result_summary FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const recomendacoesDe = (fileId, tx) => q('SELECT * FROM ai.ai_recommendations WHERE related_entity_id = :id ORDER BY created_at', { id: fileId }, tx);

const chamar = (tool, args) => `[[TOOL:${tool}:${JSON.stringify(args)}]]`;

module.exports = {
  cenario, como, svc, rodar, enviar, arquivoOcr, arquivoPdf, arquivoIlegivel, marcarNaoVerificado, vincularAPessoa, contagens, lerRun, chamadas, recomendacoesDe, chamar, PERMS, FIXO, q, run, uid,
};
