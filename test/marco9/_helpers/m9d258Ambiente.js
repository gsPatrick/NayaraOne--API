'use strict';

/** M9-D258: ambiente falso da autochecagem, tudo verde por padrão; cada teste derruba um fato de cada vez (o script real lê os mesmos fatos nos arquivos, ver scripts/int-autocheck/lib/ambiente.js). */
const manifesto = require('../../../scripts/int-ci/adversarial-manifest-int.json');

const NOMES_ADVERSARIAIS = manifesto.itens.flatMap((i) => i.testes);
const PADROES_VERDES = ['m9d211.canal', 'm9d212.envio', 'm9d213.limites', 'm9d216.fluxo', 'm9d217.maquina', 'm9d222.cenarios', 'm9d245.ssrf', 'm9d252.ssrf', 'redaction.canary'];
const ARQUIVOS = [...PADROES_VERDES.map((p) => `test/marco9/integracoes/${p}.test.js`), 'test/marco9/integracoes/m9d251.webhook.test.js'];

function relatorioVerde() {
  const arquivos = Object.fromEntries(ARQUIVOS.map((a) => [a, [[`caso de ${a}`, 'pass']]]));
  arquivos['test/marco9/integracoes/m9d251.webhook.test.js'] = NOMES_ADVERSARIAIS.map((n) => [n, 'pass']);
  return { chamadasExternas: 0, arquivos };
}

const demandaOk = (id, status = 'verificada') => ({ id, status, dependencias: [], erros: [] });
const idsDoBloco = Array.from({ length: 60 }, (_, i) => `M9-D${200 + i}`);
const idsDaIa = Array.from({ length: 47 }, (_, i) => `M9-D${String(i + 1).padStart(3, '0')}`);
const mapaVerde = () => ({ erro: null, semSprint: [], emVarios: [], inexistentes: [], passosSemDestino: [], dependenciasIncoerentes: [], ciclos: [] });

function ambienteVerde(mexer = {}) {
  const relatorio = relatorioVerde();
  const amb = {
    demandas: () => [...idsDaIa, ...idsDoBloco].map((id) => demandaOk(id)),
    mapa: () => mapaVerde(),
    existeDocumento: () => true,
    existeArquivo: () => true,
    relatorioOffline: () => relatorio,
    arquivosEsperados: () => ARQUIVOS,
    runbooksFaltando: () => [],
    runbookIa: () => [],
    nomesAdversariais: () => NOMES_ADVERSARIAIS,
    guardasNaoImprovisar: () => ({ ok: true, detalhe: '' }),
    varreduraSegredos: () => ({ ok: true, detalhe: '' }),
    contratosFaltando: () => [],
    familiasSemAdapter: () => [],
    esteira: () => ({ problemas: [] }),
    problemasDaMatriz: () => [],
    parametrosNaoCobertos: () => [],
    estadoDoPortao: () => ({ consultado: true, familiasTotal: 14, familiasLiberadas: 2, liberados: ['messaging-sandbox', 'bank-sandbox'], naoLiberados: ['email-sandbox', 'site-sandbox'] }),
    ...mexer,
  };
  return { amb, relatorio };
}

module.exports = { idsDaIa, ambienteVerde, relatorioVerde, NOMES_ADVERSARIAIS, ARQUIVOS, idsDoBloco, demandaOk, mapaVerde };
