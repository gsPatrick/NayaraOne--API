'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Cria uma árvore `src/` temporária com os arquivos informados (caminho relativo a src -> conteúdo) e devolve { srcRoot, limpar }. */
function criarFixture(arquivos) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-fronteiras-'));
  const srcRoot = path.join(base, 'src');
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const destino = path.join(srcRoot, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, conteudo);
  }
  return { base, srcRoot, limpar: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** Roda a varredura numa fixture e devolve só os códigos e arquivos achados. */
function achados(scan, arquivos, opts = {}) {
  const f = criarFixture(arquivos);
  try {
    return scan({ srcRoot: f.srcRoot, ...opts }).map((v) => ({ code: v.code, file: v.file.replace(/^.*?src\//, 'src/'), line: v.line }));
  } finally {
    f.limpar();
  }
}

module.exports = { criarFixture, achados };
