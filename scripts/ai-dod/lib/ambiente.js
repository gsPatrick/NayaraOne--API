'use strict';

/**
 * Ambiente real do DoD da NAY (M9-D047): os fatos da autochecagem das integrações (M9-D258: demandas, relatório offline, mapa da M9-D045, runbook) mais os do DoD (testes
 * existentes, relatório adversarial, red-team). Somente leitura, sem banco, sem segredo, nunca lê o .env.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ambienteReal: ambienteDaAutochecagem } = require('../../int-autocheck/lib/ambiente');
const { arquivosDaPasta } = require('../../int-autocheck/lib/ambienteSuite');
const { nomesDeclarados } = require('../../int-ci/lib/adversarial');
const { validateReport } = require('../../ai-adversarial/gate');
const { RAIZ } = require('./matriz');
const { casaComNome } = require('./avaliar');

const MANIFESTO_ADVERSARIAL = 'test/marco9/ia/adversarial/adversarial.manifest.json';
const PASTA_REDTEAM = 'docs/evidencias/ai/redteam';
const DEMANDA_REDTEAM = 'M9-D046';

function ambienteReal({ demandas, raiz = RAIZ, relatorioAdversarial: caminhoAdversarial = 'docs/evidencias/ci/adversarial-report.json' } = {}) {
  const base = ambienteDaAutochecagem({ demandas, raiz });
  const lerJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(raiz, rel), 'utf8')); } catch (e) { return null; } };
  let nomes = null;
  return {
    ...base,
    testeDeclarado: (nome) => {
      if (!nomes) nomes = new Set(arquivosDaPasta(path.join(raiz, 'test'), raiz).flatMap((a) => [...nomesDeclarados(fs.readFileSync(path.join(raiz, a), 'utf8'))]));
      return [...nomes].some((n) => casaComNome(n, nome));
    },
    relatorioAdversarial: () => {
      const relatorio = lerJson(caminhoAdversarial);
      const manifesto = lerJson(MANIFESTO_ADVERSARIAL);
      if (!relatorio) return { ausente: true, problemas: [] };
      if (!manifesto) return { ausente: false, problemas: ['manifesto dos 15 testes adversariais ilegível'] };
      return { ausente: false, problemas: validateReport(relatorio, manifesto) };
    },
    /** Falhas do red-team (M9-D046): a demanda `verificada` e o relatório mais recente de docs/evidencias/ai/redteam com resultado APROVADO. */
    redTeam: () => {
      const falhas = [];
      const d = base.demandas().find((x) => x.id === DEMANDA_REDTEAM);
      if (!d || d.status !== 'verificada') falhas.push(`${DEMANDA_REDTEAM} está ${d ? d.status || 'sem status' : 'ausente'}`);
      const pasta = path.join(raiz, PASTA_REDTEAM);
      const arquivos = fs.existsSync(pasta) ? fs.readdirSync(pasta).filter((f) => /^redteam-.*\.json$/.test(f)).sort() : [];
      const ultimo = arquivos.length ? lerJson(path.join(PASTA_REDTEAM, arquivos[arquivos.length - 1])) : null;
      if (!ultimo) falhas.push(`relatório de red-team ausente em ${PASTA_REDTEAM} (node scripts/ai-redteam.js em banco descartável)`);
      else if (ultimo.resultado !== 'APROVADO') falhas.push(`o relatório de red-team mais recente está ${ultimo.resultado || 'sem resultado'}`);
      return falhas;
    },
  };
}

module.exports = { ambienteReal, MANIFESTO_ADVERSARIAL, PASTA_REDTEAM };
