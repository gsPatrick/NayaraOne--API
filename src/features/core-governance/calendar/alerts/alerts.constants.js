'use strict';

/** Canal e tipos do registro de alertas de governança (governance.calendar_alert_log): enumerações de domínio. */
const CHANNEL_IN_APP = 'IN_APP';
const ALERT_TYPE = Object.freeze({ OVERDUE: 'OVERDUE', CONFLICT: 'CALENDAR_CONFLICT', DQ_DOMAIN_PENDING: 'DQ_DOMAIN_PENDING' });

module.exports = { CHANNEL_IN_APP, ALERT_TYPE };
