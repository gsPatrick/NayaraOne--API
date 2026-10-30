'use strict';

/**
 * Pergunta 2, "Está blindado?" (livro 512): SIM para brechas previsíveis, CONDICIONADO a homologação por provider. As quatro partes calculadas são (a) os 18 testes adversariais do manifesto
 * (M9-D251/D252) verdes, (b) as 7 guardas da M9-D257 verdes, (c) o canário de segredo, o SSRF e a varredura do repositório verdes e (d) as suítes de contrato (M9-D222) verdes para todos os
 * adapters. A condição nunca vira SIM incondicional: o estado do portão (M9-D256) é impresso sempre, com a lista dos providers NOT_RELEASED.
 */
const { verificacao } = require('./verificacao');
const { nomeVerde, arquivosVerdes } = require('./relatorio');

function blindado(amb) {
  const rel = amb.relatorioOffline('integracoes');
  const manifesto = amb.nomesAdversariais();
  const adversariais = manifesto.length ? manifesto.map((n) => nomeVerde(rel, n)).filter((r) => !r.ok).map((r) => r.detalhe) : ['manifesto dos testes adversariais vazio ou ilegível'];
  const guardas = amb.guardasNaoImprovisar();
  const varredura = amb.varreduraSegredos();
  const seguranca = [
    ...[nomeVerde(rel, 'adv_secret_em_log_canario_nao_aparece'), arquivosVerdes(rel, /redaction\.canary\.test\.js$/, 'do canário de segredo (redaction.canary)'), arquivosVerdes(rel, /m9d245\.[^/]*\.test\.js$/, 'do egress e SSRF (m9d245)'), arquivosVerdes(rel, /m9d252\.ssrf\.test\.js$/, 'adversarial de SSRF (m9d252.ssrf)')].filter((r) => !r.ok).map((r) => r.detalhe),
    ...(varredura.ok ? [] : [`varredura de segredo do repositório com achados${varredura.detalhe ? ` (${varredura.detalhe})` : ''}`]),
  ];
  const contrato = [...amb.contratosFaltando().map((c) => `contrato sem relatório verde: ${c}`), ...[arquivosVerdes(rel, /m9d222\.[^/]*\.test\.js$/, 'de contrato (m9d222)')].filter((r) => !r.ok).map((r) => r.detalhe)];
  return [
    verificacao(`os ${manifesto.length || 18} testes adversariais do manifesto (D251/D252)`, adversariais),
    verificacao('as 7 guardas do Não improvisar (D257)', guardas.ok ? [] : [guardas.detalhe || 'guarda vermelha']),
    verificacao('o canário de segredo, o SSRF e a varredura do repositório (D245, D246)', seguranca),
    verificacao('as suítes de contrato de todos os adapters (D222)', contrato),
  ];
}

/** A condição do livro, calculada com o estado do portão: "X de 14 famílias com pelo menos um provider liberado para produção (D256); homologação pendente: <lista>". */
function condicao(amb) {
  const e = amb.estadoDoPortao();
  const pendente = e.naoLiberados.length ? e.naoLiberados.join(', ') : 'nenhuma';
  const aviso = e.consultado ? '' : ' (estado do portão não consultado: sem banco descartável, nenhum provider é dado como liberado)';
  return `condicionado a homologação por provider: ${e.familiasLiberadas} de ${e.familiasTotal} famílias com pelo menos um provider liberado para produção (D256); homologação pendente: ${pendente}${aviso}`;
}

module.exports = { blindado, condicao };
