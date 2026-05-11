const assert = require('assert');
const { createRegistry } = require('./metrics.cjs');

function main() {
  const reg = createRegistry();
  const reqs = reg.counter('http_requests_total', 'count', ['method', 'status']);
  reqs.inc({ method: 'GET', status: '200' });
  reqs.inc({ method: 'GET', status: '200' });
  reqs.inc({ method: 'POST', status: '500' });

  const g = reg.gauge('memory_bytes', 'mem');
  g.set({}, 12345);

  const h = reg.histogram('latency_ms', 'lat', ['route'], [10, 100, 1000]);
  h.observe({ route: 'home' }, 5);
  h.observe({ route: 'home' }, 50);
  h.observe({ route: 'home' }, 500);

  const out = reg.render();
  assert(out.includes('http_requests_total{method="GET",status="200"} 2'));
  assert(out.includes('http_requests_total{method="POST",status="500"} 1'));
  assert(out.includes('memory_bytes 12345'));
  assert(out.includes('latency_ms_bucket{route="home",le="10"} 1'));
  assert(out.includes('latency_ms_bucket{route="home",le="100"} 2'));
  assert(out.includes('latency_ms_bucket{route="home",le="1000"} 3'));
  assert(out.includes('latency_ms_sum{route="home"} 555'));
  assert(out.includes('latency_ms_count{route="home"} 3'));

  // Escape quotes in label values.
  const c = reg.counter('weird', 'w', ['x']);
  c.inc({ x: 'has"quote' });
  assert(reg.render().includes('x="has\\"quote"'));

  console.log('metrics.test.cjs OK');
}

main();
