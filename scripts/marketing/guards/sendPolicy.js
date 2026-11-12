'use strict';

const { achar, ler, linhaDe, listar } = require('./source');

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
    // Cada envio do wrapper (o envio novo e o reenvio da fila, DI-M9F-2) precisa de um canSend próprio entre o envio anterior e ele:
    // um canSend no começo do arquivo não pode "cobrir" um segundo caminho de envio que deixou de consultar.
    const envios = [...texto.matchAll(/\bsendToChannel\(/g)].map((m) => m.index);
    const consultas = [...texto.matchAll(/\bcanSend\(/g)].map((m) => m.index);
    if (envios.length === 0 || consultas.length === 0) {
      problemas.push({ arquivo: WRAPPER, linha: 1, regra: 'o wrapper deve chamar canSend (opt-out, silêncio, limite, consentimento) antes de sendToChannel' });
    }
    envios.forEach((envio, k) => {
      const inicio = k === 0 ? -1 : envios[k - 1];
      if (!consultas.some((c) => c > inicio && c < envio)) {
        problemas.push({ arquivo: WRAPPER, linha: linhaDe(texto, envio), regra: 'o wrapper deve chamar canSend (opt-out, silêncio, limite, consentimento) antes de cada sendToChannel' });
      }
    });
  }
  const semArquivos = listar(raiz).length === 0 ? [{ arquivo: '(raiz)', linha: 1, regra: 'nenhum arquivo do Marketing encontrado na raiz informada' }] : [];
  return [...semArquivos, ...diretas, ...operacao, ...problemas];
}

module.exports = { NOME, verificar };
