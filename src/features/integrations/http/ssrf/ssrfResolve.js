'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { isBlockedIp } = require('./ipRanges');
const { blocked } = require('./ssrfErrors');

const defaultLookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve o host UMA vez no servidor e valida CADA IP devolvido (M9-D245 3.1 itens 3 e 4). Qualquer IP proibido recusa a
 * busca inteira: um nome com um endereço público e outro interno não passa. O resultado é o que a conexão usa; a busca nunca
 * resolve de novo (anti DNS rebinding). Falha de DNS vira recusa genérica, sem detalhe.
 */
async function resolveAndValidate(hostname, { resolver = defaultLookup } = {}) {
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw blocked('PRIVATE_IP', hostname);
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  let lista;
  try { lista = await resolver(hostname); } catch { throw blocked('DNS_FAILED', hostname); }
  const enderecos = (Array.isArray(lista) ? lista : [lista]).filter((e) => e && e.address);
  if (!enderecos.length) throw blocked('DNS_FAILED', hostname);
  for (const e of enderecos) {
    if (isBlockedIp(e.address)) throw blocked('PRIVATE_IP', hostname);
  }
  return enderecos.map((e) => ({ address: e.address, family: e.family || net.isIP(e.address) }));
}

module.exports = { resolveAndValidate, defaultLookup };
