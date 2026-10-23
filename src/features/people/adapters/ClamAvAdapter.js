'use strict';

const net = require('net');
const AppError = require('../../../utils/AppError');

// ClamAvAdapter — antivírus real via daemon clamd (protocolo INSTREAM sobre TCP). Mesma interface
// do SandboxAntivirusAdapter: scan(buffer) -> { clean, signature, raw }.
//
// Falha FECHADA: se o clamd não responde, o arquivo NÃO é tratado como limpo — a operação
// termina com erro de negócio (503) em vez de aprovar sem varredura.

const CHUNK_SIZE = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

function scanWithClamd(buffer, { host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let settled = false;

    function finish(err, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    }

    socket.setTimeout(timeoutMs, () => finish(new Error('timeout')));
    socket.on('error', (err) => finish(err));
    socket.on('data', (data) => chunks.push(data));
    socket.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        const part = buffer.subarray(offset, offset + CHUNK_SIZE);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length, 0);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

class ClamAvAdapter {
  constructor(options = {}) {
    this.host = options.host || process.env.CLAMAV_HOST || '127.0.0.1';
    this.port = Number(options.port || process.env.CLAMAV_PORT || 3310);
    this.timeoutMs = Number(options.timeoutMs || process.env.CLAMAV_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  }

  async scan(buffer) {
    let reply;
    try {
      reply = await scanWithClamd(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ''), this);
    } catch (err) {
      throw AppError.internal(
        'O antivírus não está disponível no momento. O arquivo não foi aceito; tente novamente mais tarde.',
        'ANTIVIRUS_UNAVAILABLE'
      );
    }

    // Respostas do clamd: "stream: OK", "stream: <assinatura> FOUND", "... ERROR".
    if (/\bOK$/.test(reply)) {
      return { clean: true, signature: null, raw: { engine: 'clamav', reply } };
    }
    const found = reply.match(/^stream:\s+(.+)\s+FOUND$/);
    if (found) {
      return { clean: false, signature: found[1], raw: { engine: 'clamav', reply } };
    }
    throw AppError.internal(
      'O antivírus não conseguiu varrer o arquivo. O arquivo não foi aceito.',
      'ANTIVIRUS_SCAN_ERROR',
      { reply }
    );
  }
}

module.exports = { ClamAvAdapter };
