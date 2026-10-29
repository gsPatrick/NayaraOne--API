'use strict';

process.env.NODE_ENV = 'test'; // o guarda SSRF só aceita os ganchos de teste (conexão desviada, autoridade de teste) com NODE_ENV=test

// Servidor HTTPS local para a ingestão por URL (M9-D022): certificado do host de teste gerado na hora, DNS simulado (IP público) e a
// conexão física desviada para o servidor local. As regras do guarda (esquema, host, IP validado) rodam sobre o IP simulado.
const { gerarCertificado, subirServidor } = require('./tlsFixture');
const { montarPdf } = require('./ragDocs');

const HOST = 'docs.example.test';
const IP_PUBLICO = '93.184.216.34';

/** Cabeçalho: devolve { hooks, consultas, conexoes, url(caminho), fechar }. `corpo` é o PDF servido (padrão: um PDF simples). */
async function subirUrlEnv({ corpo = montarPdf(['Política de privacidade da imobiliária.', 'Os dados dos clientes ficam na empresa.']) } = {}) {
  const par = gerarCertificado([HOST, 'localhost']);
  const srv = await subirServidor(par, {}, (_req, res) => { res.setHeader('content-type', 'application/pdf'); res.end(corpo); });
  const consultas = []; const conexoes = [];
  const hooks = {
    resolver: async (h) => { consultas.push(h); return [{ address: IP_PUBLICO, family: 4 }]; },
    _tls: { ca: par.cert },
    _connect: (address) => { conexoes.push(address); return { host: '127.0.0.1', port: srv.port }; },
  };
  return { hooks, consultas, conexoes, url: (caminho = '/politica.pdf') => `https://${HOST}${caminho}`, fechar: () => srv.close() };
}

module.exports = { subirUrlEnv, HOST };
