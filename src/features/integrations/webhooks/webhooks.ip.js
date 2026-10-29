'use strict';

/** IP truncado para o rastro das rejeições (M9-D211 passo 5): IPv4 sem o último octeto (/24), IPv6 só os três primeiros blocos (/48). Nunca o endereço inteiro. */
function truncateIp(ip) {
  const texto = String(ip || '').trim();
  if (!texto) return 'desconhecido';
  const mapeado = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(texto);
  const v4 = mapeado ? mapeado[1] : (/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(texto) || [])[1];
  if (v4) return `${v4}.x/24`;
  if (texto.includes(':')) {
    const blocos = texto.split(':').filter((b, i) => b !== '' || i === 0).slice(0, 3);
    return `${blocos.join(':')}::/48`;
  }
  return 'desconhecido';
}

module.exports = { truncateIp };
