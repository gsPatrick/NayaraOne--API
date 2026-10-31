'use strict';

const dgram = require('node:dgram');
const { getSetting } = require('../../settings/settings.service');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { KEYS, CLOCK_SETTING_DEFAULTS } = require('./clock.settings');

const NTP_EPOCH_OFFSET_S = 2208988800; // segundos de 1900 a 1970
const PACKET_BYTES = 48;

/** Segundos (com fração) do carimbo NTP de 64 bits que começa em `at`, na escala Unix, em milissegundos. */
function stamp(buffer, at) {
  return (buffer.readUInt32BE(at) - NTP_EPOCH_OFFSET_S) * 1000 + (buffer.readUInt32BE(at + 4) / 4294967296) * 1000;
}

/** `servidor` ou `servidor:porta` (padrão 123) -> { host, port }. */
function parseServer(text) {
  const match = /^(.+):(\d{1,5})$/.exec(String(text).trim());
  return match ? { host: match[1], port: Number(match[2]) } : { host: String(text).trim(), port: 123 };
}

/** Uma consulta SNTP (RFC 4330): devolve o deslocamento do relógio local em relação ao servidor, em ms (positivo = o servidor está à frente). `server`: servidor ou servidor:porta. */
function queryNtp(server, timeoutMs) {
  const { host, port } = parseServer(server);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const request = Buffer.alloc(PACKET_BYTES);
    request[0] = 0x1b; // versão 3, modo cliente
    const timer = setTimeout(() => { socket.close(); reject(new Error('NTP_TIMEOUT')); }, timeoutMs);
    const t1 = Date.now();
    socket.once('error', (err) => { clearTimeout(timer); socket.close(); reject(err); });
    socket.once('message', (message) => {
      const t4 = Date.now();
      clearTimeout(timer);
      socket.close();
      if (message.length < PACKET_BYTES) { reject(new Error('NTP_BAD_RESPONSE')); return; }
      const t2 = stamp(message, 32);
      const t3 = stamp(message, 40);
      resolve(((t2 - t1) + (t3 - t4)) / 2);
    });
    socket.send(request, port, host, (err) => { if (err) { clearTimeout(timer); socket.close(); reject(err); } });
  });
}

/** Leitor do NTP para o registro de leitores do relógio. Servidor e tempo máximo vêm dos parâmetros; NTP desligado (migracao.relogio.ntp_ativo) = nenhuma leitura. */
async function readNtp({ tenant }) {
  const { enabled, host, timeoutMs } = await openTenantTx(tenant, async (transaction) => ({
    enabled: await getSetting(KEYS.NTP_ENABLED, tenant, transaction, CLOCK_SETTING_DEFAULTS[KEYS.NTP_ENABLED]) !== false,
    host: String(await getSetting(KEYS.NTP_SERVER, tenant, transaction, CLOCK_SETTING_DEFAULTS[KEYS.NTP_SERVER]) || '').trim(),
    timeoutMs: Number(await getSetting(KEYS.NTP_TIMEOUT_MS, tenant, transaction, CLOCK_SETTING_DEFAULTS[KEYS.NTP_TIMEOUT_MS])),
  }));
  if (!enabled || !host) return [];
  return [{ system: 'NTP', offsetMs: Math.round(await queryNtp(host, timeoutMs)) }];
}

module.exports = { readNtp, queryNtp, stamp, parseServer };
