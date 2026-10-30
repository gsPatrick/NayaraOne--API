'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Ambiente de contrato dos adapters de armazenamento (M9-D242 + M9-D222): a suíte não abre rede nem banco.
 * - `storage-local-disk`: a raiz de uploads é uma pasta temporária (UPLOADS_DIR) e a chave de cifra de laboratório vale só durante a suíte; tudo é apagado ao fim.
 * - `storage-s3`: serviço S3 compatível falso em memória (PUT, GET, HEAD, DELETE com a mesma interface de `ctx.http`), conta e bucket de laboratório; o que se prova é do adapter
 *   (assinatura, chave com prefixo da empresa, hash, URL assinada), não o servidor.
 */
function makeS3Http() {
  const objetos = new Map();
  const resposta = (status, headers = {}, corpo = Buffer.alloc(0)) => ({
    status,
    headers: { get: (n) => (headers[String(n).toLowerCase()] === undefined ? null : headers[String(n).toLowerCase()]) },
    arrayBuffer: async () => corpo.buffer.slice(corpo.byteOffset, corpo.byteOffset + corpo.length),
  });
  return {
    async request({ method, url, headers, body }) {
      if (!headers || !/^AWS4-HMAC-SHA256 Credential=/.test(String(headers.authorization || headers.Authorization || ''))) return resposta(403);
      const chave = new URL(url).pathname;
      if (method === 'PUT') { objetos.set(chave, { corpo: Buffer.from(body), tipo: headers['content-type'], sha: headers['x-amz-meta-sha256'] }); return resposta(200, { 'x-amz-request-id': `req-contrato-${objetos.size}` }); }
      const o = objetos.get(chave);
      if (method === 'DELETE') { objetos.delete(chave); return resposta(204, { 'x-amz-request-id': 'req-contrato-del' }); }
      if (!o) return resposta(404);
      const cab = { 'x-amz-request-id': 'req-contrato-get', 'content-type': o.tipo, 'content-length': String(o.corpo.length), 'x-amz-meta-sha256': o.sha };
      return resposta(200, cab, method === 'GET' ? o.corpo : Buffer.alloc(0));
    },
  };
}

const s3Context = () => ({
  config: { endpoint: 's3.contrato.invalid', region: 'sa-east-1', bucket: 'bucket-contrato', pathStyle: true },
  secret: async () => JSON.stringify({ accessKeyId: 'chave-de-contrato', secretAccessKey: 'segredo-de-contrato-nao-real' }),
  http: makeS3Http(),
});

/** Prepara a raiz de uploads temporária e a chave de cifra de laboratório; devolve a função que desfaz. */
function setupLocalDisk() {
  const anterior = { dir: process.env.UPLOADS_DIR, chave: process.env.FILES_ENCRYPTION_KEY };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-contrato-disco-'));
  process.env.UPLOADS_DIR = tmp;
  process.env.FILES_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex');
  return () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (anterior.dir === undefined) delete process.env.UPLOADS_DIR; else process.env.UPLOADS_DIR = anterior.dir;
    if (anterior.chave === undefined) delete process.env.FILES_ENCRYPTION_KEY; else process.env.FILES_ENCRYPTION_KEY = anterior.chave;
  };
}

module.exports = { makeS3Http, s3Context, setupLocalDisk };
