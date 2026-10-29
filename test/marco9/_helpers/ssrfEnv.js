'use strict';

process.env.NODE_ENV = 'test'; // o guarda só aceita os ganchos de teste (conexão desviada, autoridade de teste) com NODE_ENV=test

const { gerarCertificado, subirServidor } = require('./tlsFixture');
const { fetchExternalUrl } = require('../../../src/features/integrations/http/ssrfGuard');

const HOST = 'foto.example.test';
const IP_PUBLICO = '93.184.216.34';

/**
 * Ambiente do guarda SSRF: servidor HTTPS local (certificado de `foto.example.test` gerado na hora) e um `buscar` que usa o
 * guarda de verdade, com DNS simulado (devolve um IP público e conta as consultas) e a conexão física desviada para o servidor
 * local. A validação de IP, o esquema, a porta e o host rodam sobre o IP simulado, exatamente como em produção.
 */
async function montarAmbiente(handler, { dns } = {}) {
  const par = gerarCertificado([HOST, 'localhost']);
  const srv = await subirServidor(par, {}, handler);
  const consultas = []; const conexoes = [];
  const resolver = dns || (async (h) => { consultas.push(h); return [{ address: IP_PUBLICO, family: 4 }]; });
  const buscar = (url, opts = {}) => fetchExternalUrl(url, {
    flow: 'import_by_url', resolver, _tls: { ca: par.cert },
    _connect: (address) => { conexoes.push(address); return { host: '127.0.0.1', port: srv.port }; },
    ...opts, _params: { flowHosts: { import_by_url: [HOST] }, ...(opts._params || {}) },
  });
  /** Igual a `buscar`, mas sem a lista de hosts de teste: vale só o que o fluxo e os parâmetros da empresa dizem. */
  const buscarComParametrosDaEmpresa = (url, opts = {}) => fetchExternalUrl(url, {
    flow: 'import_by_url', resolver, _tls: { ca: par.cert }, _connect: (address) => { conexoes.push(address); return { host: '127.0.0.1', port: srv.port }; }, ...opts,
  });
  return { buscar, buscarComParametrosDaEmpresa, consultas, conexoes, port: srv.port, fechar: () => srv.close() };
}

/** Handler do servidor de teste: responde um PDF mínimo. */
const pdf = (_req, res) => { res.setHeader('content-type', 'application/pdf'); res.end(Buffer.from('%PDF-1.4 teste')); };

module.exports = { montarAmbiente, pdf, HOST, IP_PUBLICO };
