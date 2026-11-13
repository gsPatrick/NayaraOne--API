'use strict';

/**
 * M4-D140 (teste 13): inventário estático da bateria do `npm test` — os arquivos que os padrões do script `test`
 * do package.json expandem e, em cada um, quantas declarações de teste (`test(` / `it(`) e quantas marcas de teste
 * ignorado (`.skip`, `{ skip`, `.todo`, `{ todo`) existem. Serve para provar que a reorganização não tirou teste nem
 * criou teste ignorado; os totais executados (passes e falhas) ficam no registro da bateria.
 */
const fs = require('node:fs');
const path = require('node:path');

function expandir(root, padrao) {
  const partes = padrao.split('/');
  const percorrer = (dir, i) => {
    if (i === partes.length) return [dir];
    const parte = partes[i];
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return [];
    if (parte === '**') {
      const aqui = percorrer(dir, i + 1);
      const sub = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => percorrer(path.posix.join(dir, e.name), i));
      return [...aqui, ...sub];
    }
    const re = new RegExp(`^${parte.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`);
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => re.test(e.name) && (i === partes.length - 1 ? e.isFile() : e.isDirectory()))
      .flatMap((e) => percorrer(dir ? path.posix.join(dir, e.name) : e.name, i + 1));
  };
  return percorrer('', 0);
}

function arquivosDaBateria(root) {
  const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;
  const padroes = script.replace(/^node --test\s+/, '').match(/"[^"]+"|\S+/g).map((p) => p.replace(/^"|"$/g, ''));
  return [...new Set(padroes.flatMap((p) => expandir(root, p)))].sort();
}

function contar(fonte) {
  const testes = (fonte.match(/(^|[^\w.])(test|it)(\.(only|skip|todo))?\s*\(/gm) || []).length;
  const ignorados = (fonte.match(/\b(test|it|describe)\.(skip|todo)\s*\(|[{,]\s*(skip|todo)\s*:/g) || []).length;
  return { testes, ignorados };
}

function inventario(root) {
  const arquivos = {};
  for (const rel of arquivosDaBateria(root)) arquivos[rel] = contar(fs.readFileSync(path.join(root, rel), 'utf8'));
  const total = Object.values(arquivos).reduce((acc, a) => ({ testes: acc.testes + a.testes, ignorados: acc.ignorados + a.ignorados }), { testes: 0, ignorados: 0 });
  return { arquivos: Object.keys(arquivos).length, declaracoes: total.testes, marcasDeIgnorado: total.ignorados, porArquivo: arquivos };
}

module.exports = { inventario, arquivosDaBateria };
