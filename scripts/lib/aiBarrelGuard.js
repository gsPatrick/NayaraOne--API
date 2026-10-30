'use strict';

// Complemento do archGuard da NAY (DI-IA-LEVE-2): nenhum arquivo FORA de src/features/ai importa um ARQUIVO de dentro dela;
// o import tem de apontar para a raiz da feature ou para uma pasta com index.js (o barrel dono). Antes o guard só varria o
// que está dentro de src/features/ai e não pegava jobs/serviços que furavam o barrel.
const fs = require('node:fs');
const path = require('node:path');
const { limparComentarios, listarArquivos } = require('./aiArchGuard');

const SRC_PADRAO = path.join(__dirname, '..', '..', 'src');
const IMPORT = /(?:require\(\s*|from\s+|import\s*\(\s*)(['"`])([^'"`]+)\1/g;

// Entradas públicas aceitas por arquivo (relativas a src/features/ai, sem extensão), com o motivo.
const ENTRADAS_PUBLICAS = Object.freeze({
  // folha de schema carregada na inicialização de settings.service; o barrel da raiz traz as rotas e fecharia um ciclo.
  'ai.settings': 'schema de configuração (folha, evita ciclo com settings.service)',
});

// Dívida anterior ao guard, congelada: arquivo (relativo a src) -> alvos tolerados. Só pode diminuir; import novo reprova.
const LEGADO = Object.freeze({
  'features/core-governance/finops/collectors/ai.js': ['providers/ProviderRegistry', 'providers/providers.cost'],
  'features/integrations/adapters/index.js': ['providers/builtIn'],
});

function resolverAlvo(arquivo, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(arquivo), spec);
  for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.json`]) { if (fs.existsSync(c) && fs.statSync(c).isFile()) return { alvo: c, ehPasta: false }; }
  if (fs.existsSync(path.join(base, 'index.js'))) return { alvo: base, ehPasta: true };
  return { alvo: base, ehPasta: false };
}

function varrerImportsForaDoBarrel(srcRaiz = SRC_PADRAO, { legado = LEGADO } = {}) {
  const dono = path.join(srcRaiz, 'features', 'ai');
  const violacoes = [];
  for (const arquivo of listarArquivos(srcRaiz)) {
    if (arquivo.endsWith('.json') || arquivo.startsWith(dono + path.sep)) continue;
    const rel = path.relative(srcRaiz, arquivo).split(path.sep).join('/');
    const linhas = limparComentarios(fs.readFileSync(arquivo, 'utf8')).split('\n');
    linhas.forEach((linha, idx) => {
      for (const m of linha.matchAll(IMPORT)) {
        const r = resolverAlvo(arquivo, m[2]);
        if (!r || !(r.alvo === dono || r.alvo.startsWith(dono + path.sep))) continue;
        if (r.ehPasta) continue;
        const dentro = path.relative(dono, r.alvo).split(path.sep).join('/').replace(/\.(?:js|cjs|json)$/, '');
        if (ENTRADAS_PUBLICAS[dentro] || (legado[rel] || []).includes(dentro)) continue;
        violacoes.push({ regra: 'import-fora-do-barrel', arquivo: path.join('src', rel), linha: idx + 1, mensagem: 'import de arquivo interno de src/features/ai; use o barrel (index.js) da pasta dona', trecho: linha.trim().slice(0, 160) });
      }
    });
  }
  return violacoes;
}

module.exports = { varrerImportsForaDoBarrel, ENTRADAS_PUBLICAS, LEGADO };
