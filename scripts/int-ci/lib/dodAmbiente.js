'use strict';

/** Ambiente real do Definition of Done (M9-D253): lê os arquivos de uma raiz do repositório. Não abre conexão de banco e não imprime caminho absoluto. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nomesDeclarados, verificarNomes } = require('./adversarial');

function arquivosDeTeste(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') arquivosDeTeste(p, acc); } else if (/\.test\.js$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function ambienteReal(raiz) {
  const existeArquivo = (rel) => fs.existsSync(path.join(raiz, rel));
  let nomes = null;
  const existeTeste = (nome) => {
    if (!nomes) nomes = new Set(arquivosDeTeste(path.join(raiz, 'test')).flatMap((a) => [...nomesDeclarados(fs.readFileSync(a, 'utf8'))]));
    return nomes.has(nome);
  };
  // Itens que dependem do código do catálogo e dos relatórios gravados pela etapa 3 da esteira só são calculados na raiz do próprio repositório.
  const doRepositorio = path.resolve(raiz) === path.resolve(__dirname, '..', '..', '..');
  const catalogo = () => require(path.join(raiz, 'src/features/integrations/providers/catalog.providers')).SEED_PROVIDERS;
  return {
    existeArquivo,
    existeTeste,
    contratosFaltando: () => {
      if (!doRepositorio) return ['relatórios de contrato indisponíveis fora do repositório'];
      process.env.PORT = process.env.PORT || '0';
      require(path.join(raiz, 'src/features/integrations/adapters')).registerBuiltInAdapters();
      const contract = require(path.join(raiz, 'src/features/integrations/contract'));
      return contract.listTargets().filter((t) => { const r = contract.readReport(t.providerCode); return !r || r.status !== 'PASSED'; }).map((t) => t.providerCode);
    },
    runbooksFaltando: () => {
      if (!doRepositorio) return ['catálogo indisponível fora do repositório'];
      const rb = require(path.join(raiz, 'src/features/integrations/health/runbooks'));
      return catalogo().map((p) => p.code).filter((codigo) => {
        const arq = path.join(raiz, rb.runbookPathFor(codigo));
        return !fs.existsSync(arq) || rb.validateRunbook(fs.readFileSync(arq, 'utf8')).length > 0;
      });
    },
    familiasSemSandbox: () => {
      if (!doRepositorio) return ['catálogo indisponível fora do repositório'];
      const prov = catalogo();
      return [...new Set(prov.map((p) => p.domain))].filter((d) => !prov.some((p) => p.domain === d && p.sandboxAvailable && /-sandbox$/.test(p.code)));
    },
    adversariais: () => (existeArquivo('scripts/int-ci/adversarial-manifest-int.json')
      ? verificarNomes({ manifesto: path.join(raiz, 'scripts/int-ci/adversarial-manifest-int.json'), raizes: [path.join(raiz, 'test')] })
      : { ok: false, problemas: ['manifesto ausente'], ausentes: [] }),
    autochecagem: () => {
      if (!existeArquivo('scripts/integrationAutocheck.js')) return null;
      const r = spawnSync('node', ['scripts/integrationAutocheck.js'], { cwd: raiz, encoding: 'utf8' });
      return { code: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
    },
  };
}

module.exports = { ambienteReal, arquivosDeTeste };
