'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * diskStorage — storage de arquivos binários em disco local do servidor.
 *
 * Substitui o stopgap anterior (binário direto no Postgres, ver migration
 * 20260101000173/models/File.js) por arquivos reais em `uploads/<categoria>/<groupId>/...`,
 * na raiz do projeto (mesmo nível de app.js). `storageKey` (gravado em File.storageKey) é
 * sempre o caminho RELATIVO à pasta `uploads/` (ex.: "contracts/51cca.../uuid-arquivo.pdf") —
 * nunca o caminho absoluto do disco, pra não vazar detalhe de infraestrutura do host e pra
 * continuar portátil se a raiz do projeto mudar de lugar.
 *
 * LIMITAÇÃO OPERACIONAL CONHECIDA (fora do escopo deste código, é infraestrutura): em
 * produção este projeto roda em container (Easypanel/Docker, ver Dockerfile node:20-alpine) —
 * o filesystem do container é EFÊMERO. Qualquer redeploy/recriação do container apaga
 * `uploads/` inteiro se não houver um VOLUME PERSISTENTE montado apontando pra `/app/uploads`.
 * Configurar esse volume é uma tarefa de infraestrutura (Easypanel), não algo que este código
 * resolve sozinho — sem o volume, todo arquivo enviado sobrevive só até o próximo deploy.
 */

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');

// Sanitize: remove qualquer coisa que não seja letra/número/ponto/hífen/underscore, e colapsa
// tentativas de path traversal ("..", "/", "\") — o nome de arquivo do usuário NUNCA é usado
// cru para montar caminho em disco.
function sanitizeFileName(fileName) {
  const base = path.basename(String(fileName || 'arquivo'));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'arquivo';
}

function sanitizeSegment(segment) {
  const cleaned = String(segment || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Segmento de caminho inválido: "${segment}"`);
  }
  return cleaned;
}

/**
 * saveFile — grava `buffer` em uploads/<category>/<groupId>/<uuid>-<fileNameSanitizado>,
 * criando os diretórios necessários. Retorna o storageKey relativo.
 */
function saveFile(category, groupId, fileName, buffer) {
  const safeCategory = sanitizeSegment(category || 'generic');
  const safeGroupId = sanitizeSegment(groupId);
  const safeFileName = sanitizeFileName(fileName);
  const uniqueName = `${crypto.randomUUID()}-${safeFileName}`;

  const dir = path.join(UPLOADS_ROOT, safeCategory, safeGroupId);
  fs.mkdirSync(dir, { recursive: true });

  const absolutePath = path.join(dir, uniqueName);
  fs.writeFileSync(absolutePath, buffer);

  return path.posix.join(safeCategory, safeGroupId, uniqueName);
}

// Resolve um storageKey relativo pro caminho absoluto em disco, garantindo (defesa em
// profundidade, além do sanitize já aplicado em saveFile) que o resultado nunca escapa de
// UPLOADS_ROOT — mesmo que um storageKey malicioso/corrompido chegue até aqui.
function resolveAbsolutePath(storageKey) {
  const absolutePath = path.join(UPLOADS_ROOT, storageKey);
  const normalizedRoot = path.join(UPLOADS_ROOT, path.sep);
  if (!absolutePath.startsWith(normalizedRoot) && absolutePath !== UPLOADS_ROOT) {
    throw new Error(`storageKey fora da raiz de uploads: "${storageKey}"`);
  }
  return absolutePath;
}

/**
 * readFile — lê o arquivo apontado por `storageKey` (relativo a uploads/) e retorna um Buffer.
 * Lança erro claro se o arquivo não existir em disco.
 */
function readFile(storageKey) {
  const absolutePath = resolveAbsolutePath(storageKey);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Arquivo não encontrado em disco: "${storageKey}"`);
  }
  return fs.readFileSync(absolutePath);
}

/**
 * deleteFile — remove o arquivo em disco, best-effort (não lança se já não existir — chamador
 * não precisa tratar "já tinha sido apagado" como erro).
 */
function deleteFile(storageKey) {
  try {
    const absolutePath = resolveAbsolutePath(storageKey);
    fs.unlinkSync(absolutePath);
  } catch (err) {
    // best-effort — arquivo já ausente ou storageKey inválido não deve derrubar o chamador.
  }
}

module.exports = { saveFile, readFile, deleteFile, sanitizeFileName, UPLOADS_ROOT };
