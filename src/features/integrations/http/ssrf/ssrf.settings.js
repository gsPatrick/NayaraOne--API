'use strict';

const AppError = require('../../../../utils/AppError');
const { parseList } = require('../sdkPolicy');

const HOST = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const FLUXO = /^[a-z][a-z0-9_]{1,40}$/;
const TIPO = /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i;
const invalido = (key, value, dica) => AppError.badRequest(`O valor de "${key}" ${dica}`, 'SETTING_INVALID_VALUE', { key, value });

/** "fluxo:host1,host2;outro:host3" -> { fluxo: [hosts], outro: [...] }; null se o formato estiver errado. */
function parseFlowHosts(texto) {
  const out = {};
  for (const bloco of String(texto).split(';').map((b) => b.trim()).filter(Boolean)) {
    const i = bloco.indexOf(':');
    if (i < 1) return null;
    const fluxo = bloco.slice(0, i).trim();
    const hosts = parseList(bloco.slice(i + 1)).map((h) => h.toLowerCase());
    if (!FLUXO.test(fluxo) || !hosts.length || !hosts.every((h) => HOST.test(h))) return null;
    out[fluxo] = [...new Set([...(out[fluxo] || []), ...hosts])];
  }
  return Object.keys(out).length ? out : null;
}

/** Parâmetros da busca de URL de terceiro (M9-D245): só o dicionário de SETTINGS_SCHEMA; a leitura está em ssrf.params.js. */
const SSRF_SETTINGS_SCHEMA = Object.freeze({
  // INT-P057: o livro só admite https; o parâmetro existe para a empresa nunca precisar de código e para o teste provar a recusa dos demais.
  'integration.ssrf.allowed_schemes': {
    type: 'string',
    validate: (key, value) => {
      if (!parseList(value).every((s) => s.toLowerCase() === 'https')) throw invalido(key, value, 'só aceita https (http, file, ftp, gopher e data são recusados).');
    },
  },
  // INT-P058: redirecionamentos seguidos (cada salto repete todas as verificações).
  'integration.ssrf.max_redirects': { type: 'integer', min: 0, max: 5 },
  // INT-P059: tamanho máximo, em bytes, da resposta; a leitura é cortada ao passar disso.
  'integration.ssrf.max_bytes': { type: 'integer', min: 1024, max: 104857600 },
  // INT-P060: hosts que cada fluxo pode baixar, além dos que o próprio fluxo declara. Formato: fluxo:host1,host2;outro:host3.
  'integration.ssrf.fetch_allowlist': {
    type: 'string',
    validate: (key, value) => {
      if (!parseFlowHosts(value)) throw invalido(key, value, 'deve ser fluxo:host1,host2;outro:host3, com hosts válidos (aceita *.dominio.com).');
    },
  },
  // Tempo total, em ms, de uma busca (o livro fixa 10 s).
  'integration.ssrf.timeout_ms': { type: 'integer', min: 1000, max: 60000 },
  // Portas permitidas (o livro: 443 ou allowlist).
  'integration.ssrf.allowed_ports': {
    type: 'string',
    validate: (key, value) => {
      const itens = parseList(value);
      if (!itens.length || !itens.every((p) => /^\d{1,5}$/.test(p) && Number(p) > 0 && Number(p) < 65536)) throw invalido(key, value, 'deve ser uma lista de portas separadas por vírgula (ex.: 443).');
    },
  },
  // Tipos de conteúdo aceitos na resposta (cada fluxo ainda pode estreitar a lista).
  'integration.ssrf.content_types': {
    type: 'string',
    validate: (key, value) => {
      const itens = parseList(value);
      if (!itens.length || !itens.every((t) => TIPO.test(t) && !t.startsWith('text/html'))) throw invalido(key, value, 'deve ser uma lista de tipos de conteúdo separados por vírgula, sem HTML (ex.: image/jpeg,application/pdf).');
    },
  },
});

module.exports = { SSRF_SETTINGS_SCHEMA, parseFlowHosts };
