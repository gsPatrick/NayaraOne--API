'use strict';

/**
 * M9-D255 — o que o portão de saída de cada sprint exige além de "todas as demandas verificadas" (coluna "Portão de saída" da tabela do livro).
 * Testes: os arquivos `m9d<NNN>.*.test.js` de cada demanda do sprint (um item por demanda, para um vermelho não esconder outro) mais os extras
 * do próprio portão. Demanda sem nenhum teste nomeado entra como item ausente (reprova o portão).
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..', '..');
const T = require('../../ai-sprint/lib/testes');

const pastas = (...ps) => ps.map((p) => ({ arquivos: [`${p}/*.test.js`] }));
const lerManifesto = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts/int-ci/adversarial-manifest-int.json'), 'utf8'));

/** Extras por sprint: testes dos marcos anteriores que o livro cita no portão e comandos de verificação. */
function extrasDoSprint(codigo) {
  switch (codigo) {
    case 'I1': return {
      testes: [...pastas('test/integrations/dispatch', 'test/integrations/inbox', 'test/integrations/secrets'), { arquivos: ['test/integrations/registry.test.js', 'test/integrations/registry.conexoes.test.js', 'test/correspondent.*.test.js'] }],
      comandos: [],
    };
    case 'I2': return { testes: pastas('test/integrations/health', 'test/integrations/errors'), comandos: [] };
    case 'I7': return { testes: [{ arquivos: ['test/correspondent.*.test.js'] }], comandos: [] };
    case 'I9': return {
      testes: [...lerManifesto().itens.flatMap((i) => i.testes || []).map((nome) => ({ nome })), ...pastas('test/integrations/redaction')],
      comandos: [
        { rotulo: 'Definition of Done das integrações (scripts/integrationDod.js)', argv: ['node', 'scripts/integrationDod.js'] },
        { rotulo: 'nomes dos testes adversariais (scripts/checkAdversarialNames.js)', argv: ['node', 'scripts/checkAdversarialNames.js'] },
        { rotulo: 'varredura de segredos (scripts/secretScan.js)', argv: ['node', 'scripts/secretScan.js'] },
        { rotulo: 'ensaio de falha do messaging-sandbox (scripts/failureDrill.js provider-down)', argv: ['node', 'scripts/failureDrill.js', 'messaging-sandbox', 'provider-down'] },
        { rotulo: 'teste de carga das integrações (scripts/loadTestIntegrations.js)', argv: ['node', 'scripts/loadTestIntegrations.js'] },
      ],
    };
    default: return { testes: [], comandos: [] };
  }
}

/** Demandas sem teste nomeado `m9d<NNN>.*` cujo teste é uma suíte antiga, citada nos extras do sprint (a ausência de qualquer outra reprova o portão). */
const COBERTAS_PELOS_EXTRAS = Object.freeze({
  I1: ['M9-D200', 'M9-D201', 'M9-D202', 'M9-D203', 'M9-D204', 'M9-D205', 'M9-D208', 'M9-D209'],
  I2: ['M9-D206', 'M9-D207'],
  I9: ['M9-D246'],
});

/** Exigências do sprint: { testes: [{arquivos}|{nome}], comandos, semTeste: [ids] }. */
function exigenciasDoSprint(mapa, codigo, { raiz = RAIZ } = {}) {
  const sprint = mapa.sprints.find((s) => s.codigo === codigo);
  const ids = sprint ? sprint.demandas : [];
  const todos = T.arquivosDeTeste(raiz).map((f) => path.relative(raiz, f));
  const testes = [];
  const semTeste = [];
  for (const id of ids) {
    const re = new RegExp(`^m9d${id.slice(4)}\\.[^/]*\\.test\\.js$`);
    const achados = todos.filter((f) => re.test(path.basename(f)));
    if (achados.length) testes.push({ arquivos: achados });
    else if (!(COBERTAS_PELOS_EXTRAS[codigo] || []).includes(id)) semTeste.push(id);
  }
  const extras = extrasDoSprint(codigo);
  return { semTeste, testes: [...testes, ...extras.testes], comandos: extras.comandos };
}

module.exports = { exigenciasDoSprint, extrasDoSprint, COBERTAS_PELOS_EXTRAS, RAIZ };
