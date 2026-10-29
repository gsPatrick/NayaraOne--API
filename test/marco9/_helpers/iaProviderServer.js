'use strict';

// Fornecedor de modelo FALSO, em 127.0.0.1 (M9-D010/D011): atende o formato da Anthropic (/v1/messages) e da OpenAI
// (/v1/chat/completions, /v1/embeddings, /v1/models). O comportamento vem de marcadores no último texto do usuário:
// [[HTTP:401]] responde esse status; [[SLEEP:ms]] demora; [[ECHO_KEY]] devolve a credencial recebida num erro 401 (para provar que
// ela não vaza); [[TOOL:nome]] pede uma tool; [[SAFETY]] recusa por segurança. Nenhuma rede externa.

const http = require('node:http');

const USAGE_IN = 1000;
const USAGE_OUT = 200;
const EMBED_DIMS = 8;

const ultimoTexto = (j) => {
  const msgs = j.messages || [];
  const last = msgs[msgs.length - 1];
  return last ? String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
};
const key = (req) => String(req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, ''));

function responder(req, res, body) {
  const j = body ? JSON.parse(body) : {};
  const texto = req.url.includes('embeddings') ? (Array.isArray(j.input) ? j.input.join(' ') : '') : ultimoTexto(j);
  const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const sleep = /\[\[SLEEP:(\d+)\]\]/.exec(texto);
  const http_ = /\[\[HTTP:(\d{3})\]\]/.exec(texto);
  const go = () => {
    if (/\[\[ECHO_KEY\]\]/.test(texto)) return send(401, { error: { message: `invalid api key: ${key(req)}` } });
    if (http_) return send(Number(http_[1]), { error: { message: `falha ${http_[1]} para ${key(req)}` } });
    if (req.url === '/v1/models') return send(200, { data: [] });
    if (req.url === '/v1/messages') {
      if (/\[\[SAFETY\]\]/.test(texto)) return send(200, { id: 'msg_s', content: [], stop_reason: 'refusal', usage: { input_tokens: 5, output_tokens: 0 } });
      const tool = /\[\[TOOL:([a-z_.]+)\]\]/.exec(texto);
      const content = tool ? [{ type: 'tool_use', name: tool[1], input: { a: 1 } }] : [{ type: 'text', text: `Resposta: ${texto}` }];
      return send(200, { id: 'msg_1', content, stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: USAGE_IN, output_tokens: USAGE_OUT } });
    }
    if (req.url === '/v1/chat/completions') {
      if (/\[\[SAFETY\]\]/.test(texto)) return send(200, { id: 'c_s', choices: [{ finish_reason: 'content_filter', message: { content: null } }], usage: { prompt_tokens: 5, completion_tokens: 0 } });
      const tool = /\[\[TOOL:([a-z_.]+)\]\]/.exec(texto);
      const message = tool ? { content: null, tool_calls: [{ function: { name: tool[1], arguments: '{"a":1}' } }] } : { content: `Resposta: ${texto}` };
      return send(200, { id: 'chatcmpl_1', choices: [{ finish_reason: tool ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: USAGE_IN, completion_tokens: USAGE_OUT } });
    }
    if (req.url === '/v1/embeddings') {
      const inputs = j.input || [];
      const quebrado = inputs.some((t) => /\[\[EMBED_BAD\]\]/.test(t));
      const data = (quebrado ? inputs.slice(1) : inputs).map((t, i) => ({ index: i, embedding: Array.from({ length: EMBED_DIMS }, (_, d) => (t.length + d) / 100) }));
      return send(200, { id: 'emb_1', data, usage: { prompt_tokens: 10 * inputs.length } });
    }
    return send(404, {});
  };
  if (sleep) setTimeout(go, Number(sleep[1])); else go();
}

/** Sobe o servidor. `hits` conta chamadas por caminho; `lastHeaders` guarda os cabeçalhos da última. */
async function startProviderServer() {
  const hits = {};
  const server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    server.lastHeaders = req.headers;
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => responder(req, res, Buffer.concat(partes).toString('utf8')));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, hits, server, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(ok); }) };
}

module.exports = { startProviderServer, USAGE_IN, USAGE_OUT, EMBED_DIMS };
