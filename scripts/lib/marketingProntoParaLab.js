'use strict';

/**
 * M9-D444 — declaração "PRONTO PARA LAB" do Marketing e as quatro respostas da autochecagem do Guia §16. Somente leitura, sem banco.
 *  - cada item do DoD da M9-D439 (seção 3) tem as demandas que o provam; o item só fica verde com TODAS `verificada` (a própria M9-D444 declara, então não entra na prova);
 *  - o item "testes e failure drills verdes" exige também o relatório da esteira de 14 estágios todo VERDE (relatórios gerados por `npm run ci:marketing`);
 *  - a declaração só vale com os 16 itens verdes; a liberação de produção continua sendo canal por canal (parâmetro `marketing.channel.<canal>.liberado`, M9-D430).
 * O mapa item -> demandas é decisão de implementação (DI-D444-3): o livro dá a lista do DoD, não quem prova cada item.
 */
const fs = require('node:fs');
const path = require('node:path');

const MENSAGEM_PENDENTE = 'O bloco não é declarado PRONTO PARA LAB enquanto houver item pendente.';
const D = (...n) => n.map((x) => `M9-D${x}`);

/** Item do DoD (texto exato da lista da M9-D439) -> demandas que o provam. */
const PROVAS_DO_DOD = Object.freeze({
  'content pipeline': D(405, 406, 407, 409),
  'templates e versionamento': D(400, 404),
  'campaign/automation engine': D(412, 413, 414, 415),
  'consent/suppression/frequency caps': D(416, 417, 418, 419),
  'kill switch': D(425),
  adapters: D(428, 429, 430),
  'tracking/attribution': D(412, 431, 432),
  'nay factual': D(407, 426),
  'social/site/whatsapp/e-mail': D(427, 428, 429),
  '15 testes adversariais': D(436, 437),
  'rls/redaction': D(400, 401, 403, 433),
  'failure drills de provedor': D(442),
  'versioned content/templates': D(404, 405),
  'idempotência': D(410, 411, 415),
  'factual validator': D(407),
  'testes e failure drills verdes': D(435, 438, 440, 441, 442),
});

/** As quatro perguntas do Guia §16 (resposta do livro) e as demandas cuja evidência sustenta cada uma. */
const AUTOCHECAGEM = Object.freeze([
  { pergunta: 'Marcelo consegue fazer sozinho?', resposta: 'SIM', provas: D(439, 438, 435, 402), evidencia: 'mapa de sprints, ordem de 11 passos e esteira de CI (M9-D439, M9-D438), as 10 APIs (M9-D435) e a estrutura de pastas (M9-D402)' },
  { pergunta: 'Está blindado?', resposta: 'SIM para brechas previsíveis', provas: D(436, 437, 440, 441, 433), evidencia: '15 testes adversariais (M9-D436, M9-D437), 8 guardas (M9-D440), carga e segurança (M9-D441) e antifraude (M9-D433)' },
  { pergunta: 'Tem caminho técnico?', resposta: 'SIM: engine, código lógico, APIs, eventos, CI, testes e sprints', provas: D(413, 414, 418, 435, 434, 438, 436, 437, 439), evidencia: 'engine e runner (M9-D413, M9-D414), canSend (M9-D418), APIs (M9-D435), eventos (M9-D434), CI (M9-D438), testes (M9-D436, M9-D437) e sprints (M9-D439)' },
  { pergunta: 'Outro programador assume?', resposta: 'SIM', provas: D(402, 439, 438, 442), evidencia: 'estrutura e erros padronizados (M9-D402), mapa e DoD (M9-D439), esteira (M9-D438) e failure drills (M9-D442)' },
]);

const verificada = (demandas, id) => (demandas.get(id) || {}).status === 'verificada';

/** Relatórios JSON da esteira (push e entrega): estágio -> status. Devolve { estagios: Map(numero -> status), arquivos }. */
function lerRelatoriosEsteira(dir, nomes = ['esteira-marketing.json', 'esteira-marketing-entrega.json']) {
  const estagios = new Map();
  const arquivos = [];
  for (const nome of nomes) {
    const arq = path.join(dir, nome);
    if (!fs.existsSync(arq)) continue;
    arquivos.push(nome);
    for (const e of (JSON.parse(fs.readFileSync(arq, 'utf8')).estagios || [])) estagios.set(e.numero, e.status);
  }
  return { estagios, arquivos };
}

const esteiraVerde = (r) => r.estagios.size === 14 && [...r.estagios.values()].every((s) => s === 'VERDE');

/** Itens do DoD com o estado de cada um; `pronto` só com todos verdes. `demandas`: Map id -> { status }; `esteira`: resultado de lerRelatoriosEsteira. */
function declaracao({ demandas, esteira, dod }) {
  const itens = dod.map((item) => {
    const chave = item.toLowerCase();
    const provas = PROVAS_DO_DOD[chave] || [];
    const pendentes = provas.filter((id) => !verificada(demandas, id)).map((id) => `${id} está ${(demandas.get(id) || { status: 'sem arquivo' }).status}`);
    if (!provas.length) pendentes.push('item do DoD sem demanda que o prove');
    if (chave === 'testes e failure drills verdes' && !esteiraVerde(esteira)) pendentes.push('esteira de 14 estágios sem relatório todo VERDE');
    return { item, demandas: provas, verde: pendentes.length === 0, pendentes };
  });
  const respostas = AUTOCHECAGEM.map((a) => {
    const pendentes = a.provas.filter((id) => !verificada(demandas, id)).map((id) => `${id} está ${(demandas.get(id) || { status: 'sem arquivo' }).status}`);
    return { pergunta: a.pergunta, resposta: pendentes.length ? 'NÃO COMPROVADA' : a.resposta, evidencia: a.evidencia, pendentes };
  });
  const pronto = itens.every((i) => i.verde) && respostas.every((r) => !r.pendentes.length);
  return { pronto, itens, respostas, mensagem: pronto ? 'PRONTO PARA LAB; produção liberada canal por canal' : MENSAGEM_PENDENTE };
}

module.exports = { MENSAGEM_PENDENTE, PROVAS_DO_DOD, AUTOCHECAGEM, lerRelatoriosEsteira, esteiraVerde, declaracao };
