'use strict';
/**
 * sanearLog — remove de um test-results.log tudo o que NÃO é resultado de teste e pode conter
 * segredo, sem tocar em nenhuma linha de resultado (✔ ✖ ﹣ ▶ ℹ e cabeçalhos "#").
 *
 * Regras (declaradas na página de entrega e no README de docs/evidencias/ci):
 *  1. linhas que começam com {"level": são log JSON do pino (log de requisição/erro da API
 *     durante os testes); as antigas traziam o cabeçalho Authorization completo (Bearer eyJ…).
 *     São removidas inteiras; não são resultado de teste.
 *  2. qualquer outra linha que ainda case com os padrões de segredo (Bearer ey…, eyJ…,
 *     postgres://, DevAdmin, DevAprovador, 2.25.115) também é removida (contada à parte).
 *  Nada é alterado dentro de uma linha: ou a linha fica idêntica ou é removida.
 */
const crypto = require('node:crypto');

const SECRET_RE = /Bearer ey|eyJ|postgres:\/\/|DevAdmin|DevAprovador|2\.25\.115/;
const PINO_RE = /^\{"level":/;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function sanearLog(originalText, { nomeOriginal = 'test-results.log' } = {}) {
  const linhas = originalText.split('\n');
  const mantidas = [];
  let jsonRemovidas = 0;
  let segredoRemovidas = 0;
  for (const l of linhas) {
    if (PINO_RE.test(l)) { jsonRemovidas += 1; continue; }
    if (SECRET_RE.test(l)) { segredoRemovidas += 1; continue; }
    mantidas.push(l);
  }
  const shaOriginal = sha256(Buffer.from(originalText, 'utf8'));
  const cabecalho = [
    `# SANEADO por scripts/sanear-log-teste.js — este NÃO é o arquivo original do artifact (${nomeOriginal}).`,
    `# sha256 do original: ${shaOriginal}`,
    `# removidas ${jsonRemovidas} linhas de log JSON de requisição da API (pino; não são resultado de teste) e ${segredoRemovidas} linhas adicionais com padrão de segredo.`,
    '# Nenhuma linha de resultado de teste (✔ ✖ ﹣ ▶ ℹ) foi alterada ou removida; as demais linhas estão idênticas ao original.',
    '#',
  ];
  const texto = `${cabecalho.join('\n')}\n${mantidas.join('\n')}`;
  return {
    texto,
    shaOriginal,
    shaSaneado: sha256(Buffer.from(texto, 'utf8')),
    bytesOriginal: Buffer.byteLength(originalText, 'utf8'),
    bytesSaneado: Buffer.byteLength(texto, 'utf8'),
    linhasOriginal: linhas.length,
    linhasSaneado: texto.split('\n').length,
    jsonRemovidas,
    segredoRemovidas,
  };
}

module.exports = { sanearLog, sha256, SECRET_RE };
