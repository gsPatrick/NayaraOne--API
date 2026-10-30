'use strict';

/**
 * Ambiente real da autochecagem (M9-D258): lê os fatos dos arquivos, dos relatórios e das guardas do repositório. Somente leitura. Não abre banco, exceto o estado do portão de produção
 * (M9-D256), consultado só em banco descartável (DISPOSABLE_DB=1, usuário dono do cluster descartável); sem ele nenhum provider é dado como liberado. Nunca lê o .env.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listarDemandas, mapaDoEscopo, parametrosNaoCobertos, pastaPadrao } = require('./ambienteDemandas');
const { arquivosDaSuite } = require('./ambienteSuite');
const { ESCOPOS } = require('./escopos');

const API = path.resolve(__dirname, '..', '..', '..');

function ambienteReal({ demandas, raiz, portao } = {}) {
  const base = raiz || API;
  const pasta = demandas || pastaPadrao();
  const doRepositorio = path.resolve(base) === API;
  const dod = () => require('../../int-ci/lib/dodAmbiente').ambienteReal(base);
  const cache = {};
  const unico = (chave, calcular) => { if (!(chave in cache)) cache[chave] = calcular(); return cache[chave]; };
  const rodar = (script, args = []) => spawnSync('node', [script, ...args], { cwd: base, encoding: 'utf8', env: { ...process.env, CI: process.env.CI || '' } });
  const lerJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(base, rel), 'utf8')); } catch (e) { return null; } };
  const indisponivel = (motivo) => [motivo];
  return {
    demandas: () => unico('demandas', () => listarDemandas(pasta)),
    mapa: (escopo) => unico(`mapa-${escopo}`, () => mapaDoEscopo(pasta, escopo)),
    existeDocumento: (chave) => (chave === 'plano' ? fs.existsSync(path.join(pasta, 'marco-9', '_PLANO.md')) : false),
    existeArquivo: (rel) => fs.existsSync(path.join(base, rel)),
    relatorioOffline: (escopo) => lerJson(ESCOPOS[escopo].relatorioOffline),
    arquivosEsperados: (escopo) => arquivosDaSuite(escopo, base),
    runbooksFaltando: () => (doRepositorio ? dod().runbooksFaltando() : indisponivel('catálogo indisponível fora do repositório')),
    runbookIa: () => {
      const rel = ESCOPOS['ia-nay'].runbook;
      if (!fs.existsSync(path.join(base, rel))) return [`arquivo ${rel} ausente`];
      const rb = require(path.join(base, 'src/features/integrations/health/runbooks'));
      return rb.validateRunbook(fs.readFileSync(path.join(base, rel), 'utf8')).map((p) => `${rel}: ${p}`);
    },
    nomesAdversariais: () => (lerJson('scripts/int-ci/adversarial-manifest-int.json') || { itens: [] }).itens.flatMap((i) => i.testes || []),
    guardasNaoImprovisar: () => { const r = rodar('scripts/checkNaoImprovisar.js'); return { ok: r.status === 0, detalhe: r.status === 0 ? '' : `saída ${r.status} em guard:nao-improvisar` }; },
    varreduraSegredos: () => { const r = rodar('scripts/secretScan.js'); return { ok: r.status === 0, detalhe: r.status === 0 ? '' : `saída ${r.status} em scan:secrets` }; },
    contratosFaltando: () => (doRepositorio ? dod().contratosFaltando() : indisponivel('relatórios de contrato indisponíveis fora do repositório')),
    familiasSemAdapter: () => unico('familias', () => {
      if (!doRepositorio) return indisponivel('catálogo indisponível fora do repositório');
      process.env.PORT = process.env.PORT || '0';
      require(path.join(base, 'src/features/integrations/adapters')).registerBuiltInAdapters();
      const registrados = new Set(require(path.join(base, 'src/features/integrations/registry/adapterRegistry')).list().map((a) => a.domain));
      const dominios = [...new Set(require(path.join(base, 'src/features/integrations/providers/catalog.providers')).SEED_PROVIDERS.map((p) => p.domain))];
      return dominios.filter((d) => !registrados.has(d));
    }),
    esteira: () => {
      const E = require(path.join(base, 'scripts/int-ci/lib/estagios'));
      try { E.carregar(path.join(base, 'scripts/int-ci/estagios.json')); return { problemas: [] }; } catch (e) { return { problemas: String(e.message).split('; ') }; }
    },
    problemasDaMatriz: () => {
      const M = require(path.join(base, 'scripts/int-ci/lib/matrizInt'));
      const arq = path.join(base, 'docs/integrations/MATRIZ_INT.md');
      return M.problemasDaMatriz(fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : '', dod().existeTeste);
    },
    parametrosNaoCobertos: () => parametrosNaoCobertos(pasta, require('./ambienteChaves').chavesDeCodigo(base)),
    estadoDoPortao: () => portao,
  };
}

module.exports = { ambienteReal };
