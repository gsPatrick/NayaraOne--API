'use strict';

// M9-D703 (3.4) — dois ack simultâneos em duas conexões: o reconhecimento trava a linha da instância (FOR UPDATE) e relê o estado; um altera
// e o outro recebe o estado atual. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d703Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

test('m9d703 dois ack simultâneos em 2 conexões', async () => {
  for (let round = 0; round < 5; round += 1) {
    const a = await e.openAlert(env, tenant, { extraMembers: 1 });
    env.events.length = 0;
    const [r1, r2] = await Promise.all([
      env.call('POST', `/analytics/alerts/${a.instance.id}/ack`, { perms: e.ACK, user: a.member }),
      env.call('POST', `/analytics/alerts/${a.instance.id}/ack`, { perms: e.ACK, user: a.others[0] }),
    ]);
    assert.deepEqual([r1.status, r2.status], [200, 200], JSON.stringify([r1.body, r2.body]));
    assert.equal(r1.body.data.acknowledgedBy, r2.body.data.acknowledgedBy, 'os dois recebem o mesmo autor: o vencedor');
    assert.ok([a.member, a.others[0]].includes(r1.body.data.acknowledgedBy));
    assert.equal(r1.body.data.acknowledgedAt, r2.body.data.acknowledgedAt);
    const [[db]] = await env.admin.query('SELECT status, acknowledged_by FROM analytics.alert_instances WHERE id = :id', { replacements: { id: a.instance.id } });
    assert.deepEqual([db.status, db.acknowledged_by], ['ACKNOWLEDGED', r1.body.data.acknowledgedBy]);
    assert.equal(env.events.filter((x) => x.type === 'analytics.alert.acknowledged' && x.instanceId === a.instance.id).length, 1, 'um só evento');
    assert.equal((await e.auditOf(env, tenant, 'analytics.alert.ack')).filter((r) => r.entity_id === a.instance.id).length, 1, 'uma só auditoria');
  }
});
