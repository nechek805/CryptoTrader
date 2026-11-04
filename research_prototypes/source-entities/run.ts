import { evaluateEntityPrototype } from './index.js';
import { entityPrototypeFixture } from './fixture.js';
const f = entityPrototypeFixture();
process.stdout.write(`${JSON.stringify(evaluateEntityPrototype(f.input, f.labels), null, 2)}\n`);
