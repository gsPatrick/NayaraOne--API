'use strict';

/**
 * Varredura anti-segredo do registro de integrações (M9-D200 3.2 d).
 * config_json e policy_json guardam parâmetros NÃO secretos; o segredo mora no cofre (secret_ref).
 */
const { looksLikeEmbeddedSecret } = require('../../../shared/redaction');

const NOMES_DE_SEGREDO = ['secret', 'token', 'password', 'passwd', 'apikey', 'privatekey', 'clientsecret', 'webhooksecret'];
const TAMANHO_MINIMO_PADRAO = 40;

function chaveParecidaComSegredo(chave) {
  const normal = String(chave).toLowerCase().replace(/[^a-z0-9]/g, '');
  return NOMES_DE_SEGREDO.some((n) => normal.includes(n));
}

function textoParecidoComSegredoEmbutido(valor) {
  return looksLikeEmbeddedSecret(valor);
}

function textoLongoOpaco(valor, tamanhoMinimo) {
  const texto = String(valor);
  return texto.length >= tamanhoMinimo && /^[A-Za-z0-9+/=_-]+$/.test(texto);
}

/**
 * Devolve o caminho do primeiro valor com cara de segredo, ou null se estiver limpo.
 */
function acharSegredo(valor, { tamanhoMinimo = TAMANHO_MINIMO_PADRAO, caminho = '' } = {}) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string') {
    if (!valor.trim()) return null;
    if (textoParecidoComSegredoEmbutido(valor) || textoLongoOpaco(valor, tamanhoMinimo)) return caminho || '(valor)';
    return null;
  }
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achou = acharSegredo(valor[i], { tamanhoMinimo, caminho: `${caminho}[${i}]` });
      if (achou) return achou;
    }
    return null;
  }
  if (typeof valor === 'object') {
    for (const [chave, v] of Object.entries(valor)) {
      const sub = caminho ? `${caminho}.${chave}` : chave;
      if (chaveParecidaComSegredo(chave) && acharSegredoPorChave(v)) return sub;
      const achou = acharSegredo(v, { tamanhoMinimo, caminho: sub });
      if (achou) return achou;
    }
  }
  return null;
}

// Valor debaixo de uma chave de segredo: qualquer valor não vazio conta, seja texto, número,
// booleano (inclusive false e 0) ou lista/objeto que contenha algum.
function acharSegredoPorChave(valor) {
  if (typeof valor === 'string') return valor.trim() !== '';
  if (typeof valor === 'number' || typeof valor === 'boolean' || typeof valor === 'bigint') return true;
  if (Array.isArray(valor)) return valor.some(acharSegredoPorChave);
  if (valor && typeof valor === 'object') return Object.values(valor).some(acharSegredoPorChave);
  return false;
}

module.exports = { acharSegredo, chaveParecidaComSegredo, textoParecidoComSegredoEmbutido, TAMANHO_MINIMO_PADRAO };
