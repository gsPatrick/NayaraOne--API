'use strict';

const { endOfDayInZone } = require('../calendar/sources/time');

/** Meia-noite de Brasília que ABRE o dia AAAA-MM-DD (fim exclusivo do dia anterior). */
const startOfDay = (dayKey) => new Date(endOfDayInZone(dayKey).getTime() + 1000 - 86400000);
/** Meia-noite de Brasília que FECHA o dia AAAA-MM-DD (início exclusivo do dia seguinte). */
const endOfDayExclusive = (dayKey) => new Date(endOfDayInZone(dayKey).getTime() + 1000);

module.exports = { startOfDay, endOfDayExclusive };
