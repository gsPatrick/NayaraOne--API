'use strict';

// Apoio dos testes M9-D444 (ordem de 11 passos e portão de sprints do Marketing): fontes reais de Maturacao e cópias com status/dependência alterados. Não é teste.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fonte = require('./mktSprintsFonte');
const S = require('../../../scripts/lib/marketingSprints');
const P = require('../../../scripts/lib/marketingPassos');
const { avaliarPasta } = require('../../../scripts/marketing/checkSprintGates');

const SCRIPT = path.join(fonte.RAIZ_API, 'scripts', 'marketing', 'checkSprintGates.js');
const todas = () => fonte.demandas();
const pastaDemandas = () => require('../../../scripts/analytics/sprints/demandasMd').pastaPadrao();

/** Fontes lidas das demandas reais (ou de um Map alterado). */
function fontes(demandas = todas()) {
  const d439 = demandas.get('M9-D439').texto;
  const d444 = demandas.get('M9-D444').texto;
  return { demandas, mapa: S.lerMapaSprints(d439), mapaD444: P.lerMapaD444(d444), passos: P.lerPassos(d444), adiantadas: S.lerAdiantadas(d444) };
}

/** Cópia do Map com os status trocados: `padrao` para todo o bloco D400..D444 e `especificos` { id: status } por cima. */
function comStatus(demandas, padrao, especificos = {}, { fora = 'verificada' } = {}) {
  const copia = new Map();
  for (const [id, d] of demandas) {
    const noBloco = Number(id.slice(4)) >= 400 && Number(id.slice(4)) <= 444;
    copia.set(id, { ...d, status: especificos[id] || (noBloco ? padrao : fora) });
  }
  return copia;
}

/**
 * Cópia da pasta de demandas (só marco-9) num diretório temporário, para o script ler com --demandas. O estado do portão é do TESTE, não do andamento real do
 * projeto (M9-D438, hermeticidade): na cópia toda demanda está `verificada`, para o resultado não mudar quando outra demanda é reaberta ou está em execução.
 */
function copiarDemandas() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d444-'));
  const dest = path.join(raiz, 'marco-9');
  fs.mkdirSync(dest);
  const origem = path.join(path.dirname(fonte.CADERNO), 'demandas', 'marco-9');
  for (const f of fs.readdirSync(origem)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    fs.writeFileSync(path.join(dest, f), fs.readFileSync(path.join(origem, f), 'utf8').replace(/^\| Status \|[^|\n]*\|/m, '| Status | verificada |'));
  }
  return { raiz, dest, limpar: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

/** Troca `de` por `para` (uma vez) no arquivo da demanda `id` dentro da cópia. */
function editar(copia, id, de, para) {
  const arq = fs.readdirSync(copia.dest).find((f) => f.startsWith(`${id}-`));
  const caminho = path.join(copia.dest, arq);
  const texto = fs.readFileSync(caminho, 'utf8');
  if (!texto.includes(de)) throw new Error(`${id}: trecho não encontrado: ${de}`);
  fs.writeFileSync(caminho, texto.replace(de, para));
}

const rodar = (pasta, extras = []) => spawnSync('node', [SCRIPT, '--demandas', pasta, ...extras], { encoding: 'utf8' });

module.exports = { ...fonte, SCRIPT, todas, pastaDemandas, fontes, comStatus, copiarDemandas, editar, rodar, avaliarPasta };
