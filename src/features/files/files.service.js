'use strict';

const crypto = require('crypto');
const { File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const diskStorage = require('../../utils/diskStorage');
const { resolveAntivirusAdapter } = require('../people/adapters/resolveDocumentAdapters');
const { encryptFileBuffer, decryptFileBuffer, isEncryptedBuffer } = require('../../utils/fileCrypto');

// 20MB — cobre foto, PDF, docx e um vídeo curto de vistoria.
const MAX_BYTES = 20 * 1024 * 1024;

// Categorias reconhecidas de uploads/<categoria>/ — usadas pra organizar o disco por tipo de
// documento (levantado lendo todos os usos reais de File no código: inspections media, laudos
// de vistoria, documentos de pessoa, documentos de imóvel, contratos). "generic" é o default
// pra quem não informar `category` no payload (compatibilidade com chamadores antigos).
// "contracts-signed" é usada só internamente por signatures.service.js#handleEnvelopeClosedWebhook
// (documento assinado baixado do provedor) — não é um upload manual via este service, mas
// listada aqui pra manter a validação de categoria centralizada.
// "inventory-invoices": NF/foto de nota fiscal de entrada de estoque (Guia §6 — "NF/foto
// armazenada em files"), enviada por receiptOcr.service.js antes da sugestão de OCR/IA.
const KNOWN_CATEGORIES = ['correspondent', 'contracts', 'contracts-signed', 'inspections', 'people-documents', 'property-documents', 'insurance', 'inventory-invoices', 'generic'];

// BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 4, 2026-10-06): uploadFile aceitava
// QUALQUER mimeType enviado pelo cliente, sem allowlist — um arquivo marcado "text/html" (mesmo
// contendo <script>) era aceito, e GET /files/:id/content servia de volta com
// Content-Type: text/html + Content-Disposition: inline, executando o script no navegador de
// quem abrisse o link (stored XSS). Também aceitava executáveis (.exe) sem bloqueio nenhum.
// Allowlist cobre os tipos reais usados pelo sistema (foto/vistoria, PDF/laudo, documento
// office, vídeo curto de RDO) — nunca html/svg/script/executável.
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/mp4', 'audio/webm',
];

// Assinatura (bytes iniciais) esperada por tipo declarado. Usada nos documentos do Correspondente, que
// são restritos (renda, identidade): o tipo declarado pelo cliente precisa bater com o conteúdo real.
const SIGNATURES = {
  'image/jpeg': [(b) => b[0] === 0xff && b[1] === 0xd8],
  'image/png': [(b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  'image/gif': [(b) => /^GIF8[79]a/.test(b.slice(0, 6).toString('latin1'))],
  'image/webp': [(b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'],
  'image/heic': [(b) => b.slice(4, 8).toString('latin1') === 'ftyp'],
  'image/heif': [(b) => b.slice(4, 8).toString('latin1') === 'ftyp'],
  'application/pdf': [(b) => b.slice(0, 1024).toString('latin1').includes('%PDF-')],
  'application/msword': [(b) => b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))],
  'application/vnd.ms-excel': [(b) => b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [(b) => b[0] === 0x50 && b[1] === 0x4b],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [(b) => b[0] === 0x50 && b[1] === 0x4b],
  'video/mp4': [(b) => b.slice(4, 8).toString('latin1') === 'ftyp'],
  'video/quicktime': [(b) => ['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(b.slice(4, 8).toString('latin1'))],
  'video/webm': [(b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3],
  'audio/mpeg': [(b) => b.slice(0, 3).toString('latin1') === 'ID3', (b) => b[0] === 0xff && (b[1] & 0xe0) === 0xe0],
  'audio/mp4': [(b) => b.slice(4, 8).toString('latin1') === 'ftyp'],
  'audio/webm': [(b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3],
};

function matchesDeclaredType(buffer, mimeType) {
  const checks = SIGNATURES[String(mimeType || '').toLowerCase()];
  return !checks || checks.some((check) => check(buffer));
}

function resolveCategory(category) {
  if (category && KNOWN_CATEGORIES.includes(category)) return category;
  return 'generic';
}

/**
 * uploadFile — grava o binário em disco (uploads/<category>/<groupId>/..., ver
 * src/utils/diskStorage.js) e persiste em File apenas o `storageKey` (caminho relativo) e os
 * metadados de integridade (sizeBytes/checksumSha256 calculados sobre o buffer decodificado).
 * A coluna `content` (BLOB) NÃO é mais escrita em uploads novos — ela continua existindo no
 * schema só pra servir de fallback de leitura de arquivos antigos já gravados nela (ver
 * getFileContent). Aceita o conteúdo como base64 (mesmo formato já usado no adapter do
 * Clicksign) para não depender de multipart/multer (dependência que este projeto não tem
 * instalada).
 */
async function uploadFile(payload, actorUserId, transaction) {
  const { groupId, companyId, fileName, mimeType, contentBase64, category } = payload;
  if (!groupId || !companyId || !fileName) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId" e "fileName" são obrigatórios.',
      'FILE_UPLOAD_VALIDATION'
    );
  }
  if (String(fileName).length > 255) {
    throw AppError.badRequest('O nome do arquivo deve ter até 255 caracteres.', 'FILE_UPLOAD_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 15, 2026-10-06): upload de arquivo
  // vazio (0 bytes) chega com contentBase64="" — a checagem acima tratava string vazia igual a
  // campo AUSENTE, vazando nomes de parâmetro interno da API ("groupId", "companyId") numa
  // mensagem de erro de tela de upload de foto, em vez da mensagem de negócio correta ("arquivo
  // vazio") que nunca era alcançada nesse caso.
  if (!contentBase64) {
    throw AppError.badRequest('O arquivo enviado está vazio.', 'FILE_UPLOAD_VALIDATION');
  }

  let buffer;
  try {
    buffer = Buffer.from(String(contentBase64), 'base64');
  } catch (err) {
    throw AppError.badRequest('"contentBase64" não é um base64 válido.', 'FILE_UPLOAD_VALIDATION');
  }
  if (buffer.length === 0) {
    throw AppError.badRequest('O arquivo enviado está vazio.', 'FILE_UPLOAD_VALIDATION');
  }
  if (!mimeType || !ALLOWED_MIME_TYPES.includes(String(mimeType).toLowerCase())) {
    throw AppError.badRequest(
      `Tipo de arquivo não permitido${mimeType ? ` ("${mimeType}")` : ''}. Tipos aceitos: imagem, PDF, documento Office, áudio ou vídeo.`,
      'FILE_UPLOAD_TYPE_NOT_ALLOWED'
    );
  }
  if (buffer.length > MAX_BYTES) {
    throw AppError.badRequest(
      `O arquivo excede o limite de ${MAX_BYTES / (1024 * 1024)}MB.`,
      'FILE_UPLOAD_TOO_LARGE'
    );
  }

  // Documento do Correspondente (restrito): o conteúdo precisa ser do tipo que o cliente declarou.
  if (resolveCategory(category) === 'correspondent' && !matchesDeclaredType(buffer, mimeType)) {
    throw AppError.badRequest(
      'O conteúdo do arquivo não corresponde ao tipo informado. Envie o arquivo original (PDF ou imagem) sem renomear a extensão.',
      'FILE_UPLOAD_TYPE_MISMATCH'
    );
  }

  // GAP REAL CORRIGIDO (auditoria 2026-10-08): este era o ÚNICO ponto de upload (POST /files
  // genérico, usado por qualquer feature que apenas vincula um fileId depois — ex.
  // procurement/insurance.service.js#attachPolicyDocument) que NUNCA passava por scan de
  // antivírus. O scan existia só "espalhado" nos chamadores que decidiram chamá-lo manualmente
  // antes de uploadFile (ex. inventory/receiptOcr.service.js), não dentro do próprio
  // uploadFile — então qualquer outra tela que suba um arquivo e depois só vincule o fileId
  // (Seguros, Jurídico, etc.) nunca scaneava nada. Centralizando aqui, com o MESMO adapter
  // plugável (resolveAntivirusAdapter, people/adapters/resolveDocumentAdapters.js) já usado no
  // Estoque, nenhum arquivo entra no sistema por QUALQUER caminho sem passar pelo antivírus.
  const antivirus = await resolveAntivirusAdapter({ groupId, companyId }, transaction);
  const scan = await antivirus.scan(buffer);
  if (!scan.clean) {
    throw AppError.unprocessable('Arquivo rejeitado pelo antivírus: assinatura de malware detectada.', 'FILE_UPLOAD_MALWARE_DETECTED', { signature: scan.signature });
  }

  // Checksum é sempre sobre o conteúdo PLAINTEXT (o que o cliente enviou/vai receber de volta),
  // nunca sobre o blob criptografado — senão o checksum devolvido na resposta não bateria com o
  // arquivo que o usuário efetivamente baixa depois.
  const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const encryptedBuffer = encryptFileBuffer(buffer);
  const storageKey = diskStorage.saveFile(resolveCategory(category), groupId, fileName, encryptedBuffer);
  // O binário já está em disco antes do registro no banco: se a transação voltar (por este ou por um passo
  // seguinte da requisição), o arquivo cifrado órfão é removido.
  if (transaction) {
    transaction.afterRollbackCleanups = [...(transaction.afterRollbackCleanups || []), () => diskStorage.deleteFile(storageKey)];
  }

  const file = await File.create(
    {
      groupId,
      companyId,
      storageKey,
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: buffer.length,
      checksumSha256,
      encryptedAtRest: true,
      scanStatus: 'CLEAN',
      scannedAt: new Date(),
      uploadedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'files.upload',
      entityType: 'File',
      entityId: file.id,
      afterJson: { id: file.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes, checksumSha256 },
      reason: `Arquivo "${fileName}" enviado (${buffer.length} bytes).`,
    },
    transaction
  );

  // `defaultScope` (exclude content) só se aplica a queries (findAll/findByPk) — a instância
  // devolvida por `.create()` continua com `content` carregado em memória. Sem isso, a resposta
  // da API devolveria o binário inteiro de volta pro cliente em toda criação.
  file.setDataValue('content', undefined);
  return file;
}

/**
 * getFileContent — recupera o binário pra servir de volta ao cliente. RLS de "people"."files"
 * já garante que só o tenant dono enxerga a linha.
 *
 * Caminho novo (storageKey aponta pra uploads/): lê do disco via diskStorage.readFile.
 * Fallback de compatibilidade (arquivos ANTIGOS gravados antes desta migração de storage):
 * storageKey ainda começa com "local-db/" e o binário está no BLOB `content` do Postgres — lê
 * de lá via File.scope('withContent'). Não dá pra simplesmente reprocessar esses arquivos
 * antigos pro disco aqui (efeito colateral de leitura), então o fallback fica permanente até
 * uma eventual migração de dados que mova esse binário legado pro disco.
 */
/**
 * Integridade na leitura (I4, revisão independente de 18/10/2026): antes, qualquer buffer sem o
 * marcador de cifra era tratado como "legado" e servido sem verificação — bastava remover o
 * marcador para a API entregar bytes adulterados. Agora:
 *  - arquivo gravado já cifrado (`encryptedAtRest = true`, todos os uploads a partir da
 *    migration 20260101000395) precisa vir com o marcador e decifrar com a tag de autenticação;
 *  - TODO arquivo com `checksumSha256` (todos os uploads reais — o checksum é sobre o conteúdo
 *    original) tem o conteúdo servido conferido contra o checksum gravado, inclusive os legados
 *    em texto puro e os do BLOB `local-db/`.
 * Divergência = 409 FILE_INTEGRITY_VIOLATION e registro de auditoria (gravado fora da transação
 * da requisição, para não ser desfeito junto com o erro). Arquivo legado sem checksum só existe
 * como fixture de teste gravada direto no banco; esse continua servido como está.
 */
async function rejectTamperedFile(metadata, actorUserId, detail) {
  await registrarAuditoria({
    groupId: metadata.groupId,
    companyId: metadata.companyId,
    actorUserId: actorUserId || null,
    action: 'files.integrity_violation',
    entityType: 'File',
    entityId: metadata.id,
    afterJson: { storageKey: metadata.storageKey, expectedChecksumSha256: metadata.checksumSha256, detail },
    reason: `Leitura recusada: o conteúdo do arquivo "${metadata.fileName}" não confere com o que foi gravado (${detail}).`,
  });
  throw AppError.conflict(
    'O conteúdo deste arquivo não confere com o que foi gravado no envio — a leitura foi bloqueada e o incidente registrado.',
    'FILE_INTEGRITY_VIOLATION'
  );
}

// `preloadedMetadata`: o File já lido pelo controller na checagem de acesso (evita repetir a
// mesma consulta a cada download).
async function getFileContent(id, transaction, actorUserId, preloadedMetadata) {
  const metadata = preloadedMetadata || (await File.findByPk(id, { transaction }));
  if (!metadata) throw AppError.notFound('Arquivo não encontrado.', 'FILE_NOT_FOUND');

  let content;
  if (metadata.storageKey && metadata.storageKey.startsWith('local-db/')) {
    const legacy = await File.scope('withContent').findByPk(id, { transaction });
    if (!legacy || !legacy.content) {
      throw AppError.notFound('Este arquivo não tem binário armazenado (metadado apenas).', 'FILE_CONTENT_NOT_FOUND');
    }
    content = legacy.content;
  } else {
    let buffer;
    try {
      buffer = diskStorage.readFile(metadata.storageKey);
    } catch (err) {
      throw AppError.notFound('Arquivo não encontrado em disco.', 'FILE_CONTENT_NOT_FOUND');
    }
    if (metadata.encryptedAtRest && !isEncryptedBuffer(buffer)) {
      await rejectTamperedFile(metadata, actorUserId, 'arquivo gravado cifrado está sem o marcador de cifra');
    }
    try {
      // decryptFileBuffer devolve como está um buffer sem marcador (legado, encryptedAtRest=false).
      content = decryptFileBuffer(buffer);
    } catch (err) {
      if (err instanceof AppError) throw err;
      await rejectTamperedFile(metadata, actorUserId, 'falha na autenticação da cifra (AES-GCM)');
    }
  }

  if (metadata.checksumSha256) {
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (actual !== metadata.checksumSha256) {
      await rejectTamperedFile(metadata, actorUserId, 'checksum SHA-256 divergente');
    }
  }

  metadata.setDataValue('content', content);
  return metadata;
}

/**
 * getFileMetadata — metadado puro (sem o binário), pra front decidir COMO exibir um arquivo
 * (visualizador universal: imagem, PDF, áudio, vídeo, download simples) antes de baixar os
 * bytes de verdade.
 */
async function getFileMetadata(id, transaction) {
  const file = await File.findByPk(id, { transaction });
  if (!file) throw AppError.notFound('Arquivo não encontrado.', 'FILE_NOT_FOUND');
  return file;
}

module.exports = { uploadFile, getFileContent, getFileMetadata, matchesDeclaredType, MAX_BYTES, ALLOWED_MIME_TYPES };
