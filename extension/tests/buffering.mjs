import assert from 'node:assert/strict';
import { BufferPlanner } from '../src/buffering.ts';

const fast = new BufferPlanner();
assert.equal(fast.targetMs, 10000);
fast.observe(4000, 100000, 1, true);
assert.equal(fast.estimate(6000, 100000), null, 'No inventar un tiempo antes de medir');
fast.observe(8000, 102000, 1, true);
assert.equal(fast.targetMs, 8000, 'Un equipo rápido debe arrancar con menos reserva');
assert.equal(fast.estimate(4000, 102000), 2);
assert.equal(fast.estimate(4000, 118000), null, 'Una generación trabada no puede mostrar cero');
fast.rebuffer(1);
assert.equal(fast.targetMs, 12000, 'Aumentar reserva después de un corte');

const slow = new BufferPlanner();
slow.observe(4000, 10000, 1, true);
slow.observe(8000, 18000, 1, true);
assert.equal(slow.targetMs, 24000);
slow.rebuffer(1.25);
assert.equal(slow.targetMs, 30000);
slow.observe(6000, 19000, 1, true); // Ignore replayed/stale watermarks.
assert.equal(slow.estimate(4000, 19000), 8);
slow.reset();
assert.equal(slow.targetMs, 10000);
assert.equal(slow.estimate(4000, 19000), null);
console.log('Buffer adaptable, estimación honesta y reinicio: OK');
