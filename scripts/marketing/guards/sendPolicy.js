'use strict';

const { achar, ler, posicao, linhaDe, listar } = require('./source');

const NOME = 'guard_send_requires_cansend';
const WRAPPER = 'publications/messaging/message/message.send.js';
// Quem pode chamar sendToChannel direto, e por quê: o wrapper (sendMarketingMessage = o "sendThroughPolicy" do livro: kill switch e canSend antes do canal), o worker de publicação
// (publica conteúdo, sem destinatário nem consentimento), a sonda do kill switch, os cenários dos failure drills em sandbox e o próprio sendToChannel.
const PERMITIDOS = [WRAPPER, 'publications/worker/worker.call.js', 'killswitch.probe.js', 'publications/adapters/sendToChannel.js', 'publications/adapters/index.js'];
const PREFIXOS_PERMITIDOS = ['publications/drill/'];
const OPERACAO_DIRETA = /\badapters?\.(?:send|publish)\(/;

const permitido = (arquivo) => PERMITIDOS.includes(arquivo) || PREFIXOS_PERMITIDOS.some((p) => arquivo.startsWith(p));

/** Todo caminho que chama o adapter de canal passa pelo wrapper com canSend; o wrapper chama canSend antes do canal. */
function verificar(raiz) {
  const regra = 'chamada direta ao canal fora do wrapper sendMarketingMessage (sendThroughPolicy): toda mensagem a uma pessoa passa por kill switch e canSend antes do adapter';
  const diretas = achar(raiz, /\bsendToChannel\(/, { somente: (a) => !permitido(a) }).map((a) => ({ arquivo: a.arquivo, linha: a.linha, regra }));
  const operacao = achar(raiz, OPERACAO_DIRETA, { somente: (a) => !a.startsWith('publications/adapters/') && !permitido(a) })
    .map((a) => ({ arquivo: a.arquivo, linha: a.linha, regra: `${regra} (${a.trecho})` }));
  const texto = ler(raiz, WRAPPER);
  const problemas = [];
  if (texto === null) problemas.push({ arquivo: WRAPPER, linha: 1, regra: 'o wrapper sendMarketingMessage não existe' });
  else {
    const envio = texto.lastIndexOf('sendToChannel(');
    const consulta = posicao(texto, /\bcanSend\(/);
    if (consulta === -1 || envio === -1 || consulta > envio) {
      problemas.push({ arquivo: WRAPPER, linha: linhaDe(texto, Math.max(envio, 0)), regra: 'o wrapper deve chamar canSend (opt-out, silêncio, limite, consentimento) antes de sendToChannel' });
    }
  }
  const semArquivos = listar(raiz).length === 0 ? [{ arquivo: '(raiz)', linha: 1, regra: 'nenhum arquivo do Marketing encontrado na raiz informada' }] : [];
  return [...semArquivos, ...diretas, ...operacao, ...problemas];
}

module.exports = { NOME, verificar };
