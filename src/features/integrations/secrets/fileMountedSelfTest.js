'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { storeUnusable } = require('./secrets.errors');
const { encryptValue, decryptValue } = require('./secretCrypto');

const CANARY_AAD = 'nayara/cofre/canario';

/** Primeiro segredo já gravado (pasta com meta.json e versão corrente em disco), em ordem estável; null se o cofre está vazio. */
function firstStoredSecret(raiz) {
  const pastas = fs.readdirSync(raiz, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f]{64}$/.test(e.name)).map((e) => e.name).sort();
  for (const nome of pastas) {
    const metaPath = path.join(raiz, nome, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const arquivo = meta && meta.current ? path.join(raiz, nome, `v${meta.current}.enc`) : null;
    if (meta && meta.ref && arquivo && fs.existsSync(arquivo)) return { arquivo, aad: `${meta.ref}#${meta.current}` };
  }
  return null;
}

/**
 * Prova de que o cofre em arquivo FUNCIONA para o usuário do processo (verificação K=7, item 7b), sem tocar em segredo nenhum:
 *  1. o diretório existe (ou é criado) e aceita leitura, escrita e listagem;
 *  2. um canário aleatório é cifrado com a chave mestra, gravado, lido, decifrado, conferido e apagado;
 *  3. se já há segredos gravados, a versão corrente do primeiro abre com a chave mestra (chave trocada deixaria todas as chaves da empresa ilegíveis).
 * Falha -> INTEGRATION_SECRET_STORE_UNUSABLE com o motivo, sem caminho, valor nem chave.
 */
function selfTestFileMounted(raiz, key) {
  let etapa = 'acessar o diretório';
  try {
    fs.mkdirSync(raiz, { recursive: true, mode: 0o700 });
    fs.accessSync(raiz, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    etapa = 'gravar e ler o canário';
    const canario = path.join(raiz, `.canario-${crypto.randomBytes(6).toString('hex')}.tmp`);
    const valor = crypto.randomBytes(16).toString('hex');
    try {
      fs.writeFileSync(canario, encryptValue(valor, key, CANARY_AAD), { mode: 0o600 });
      if (decryptValue(fs.readFileSync(canario), key, CANARY_AAD) !== valor) throw new Error('canário diferente');
    } finally {
      fs.rmSync(canario, { force: true });
    }
    etapa = 'abrir os segredos já gravados com a chave mestra';
    const existente = firstStoredSecret(raiz);
    if (existente) decryptValue(fs.readFileSync(existente.arquivo), key, existente.aad);
    return { ok: true, storedSecrets: Boolean(existente) };
  } catch (err) {
    const dica = etapa === 'abrir os segredos já gravados com a chave mestra'
      ? 'confira se SECRET_STORE_MASTER_KEY é a mesma usada quando os segredos foram gravados.'
      : 'o diretório (SECRET_STORE_DIR) precisa existir num volume persistente com leitura e escrita para o usuário do processo (uid 1001 na imagem).';
    throw storeUnusable(`não foi possível ${etapa} (${(err && err.code) || 'erro'}); ${dica}`);
  }
}

module.exports = { selfTestFileMounted };
