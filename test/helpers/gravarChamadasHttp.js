'use strict';

// Gravador de evidência HTTP (não é teste). Carregado com `node --require ./test/helpers/gravarChamadasHttp.js --test <arquivos>` e
// M3PE_EVIDENCIA_DIR no ambiente: cada arquivo de teste grava em <dir>/<arquivo>.chamadas.json as chamadas que fez à API local (método,
// rota, status, código de erro e o corpo da resposta), SEM cabeçalhos e com senha, token e segredo trocados por "[omitido]".
// Sem M3PE_EVIDENCIA_DIR não faz nada. Usado na recaptura das provas de Pessoas do Marco 3 (M3-23 e demais linhas do m3pe).
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.M3PE_EVIDENCIA_DIR;
const SEGREDOS = /pass(word)?|senha|token|secret|segredo|authorization|cookie|totp|otp/i;
const LIMITE = 1500;

function limpar(valor) {
  if (Array.isArray(valor)) return valor.map(limpar);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, SEGREDOS.test(k) ? '[omitido]' : limpar(v)]));
  return valor;
}

const resumo = (obj) => { const txt = JSON.stringify(obj); return txt && txt.length > LIMITE ? `${txt.slice(0, LIMITE)}…` : obj; };

if (DIR && typeof globalThis.fetch === 'function' && process.argv[1] && /\.test\.js$/.test(process.argv[1])) {
  const arquivo = path.basename(process.argv[1], '.test.js');
  const chamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const res = await original(url, init);
    const u = new URL(String(url));
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return res;
    let corpo = null;
    try { corpo = await res.clone().json(); } catch (_) { corpo = null; }
    let enviado = null;
    try { enviado = init.body ? JSON.parse(init.body) : null; } catch (_) { enviado = null; }
    chamadas.push({ em: new Date().toISOString(), requisicao: `${init.method || 'GET'} ${u.pathname}${u.search}`, corpoEnviado: resumo(limpar(enviado)),
      status: res.status, codigo: corpo && corpo.error ? corpo.error.code : null, resposta: resumo(limpar(corpo)) });
    return res;
  };
  process.on('exit', () => {
    if (!chamadas.length) return;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, `${arquivo}.chamadas.json`), `${JSON.stringify({ geradoEm: new Date().toISOString(), arquivoDeTeste: `test/${arquivo}.test.js`, chamadas }, null, 2)}\n`);
  });
}
