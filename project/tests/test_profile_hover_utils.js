const assert = require('assert');
const { nearestIndex, clampClimateHoverX, isValidHoverIndex, pointInsideRect } = require('../frontend/profile_hover_utils.js');

assert.strictEqual(nearestIndex([10, 20, 30], 9), 0);
assert.strictEqual(nearestIndex([10, 20, 30], 19), 1);
assert.strictEqual(nearestIndex([10, 20, 30], 29), 2);
assert.strictEqual(nearestIndex([10, 20, 30], Number.NaN), -1);
assert.strictEqual(nearestIndex([], 12), -1);

assert.strictEqual(clampClimateHoverX(150, 100, { padL: 20, innerW: 90 }), 50);
assert.strictEqual(clampClimateHoverX(80, 100, { padL: 20, innerW: 90 }), 20);
assert.strictEqual(clampClimateHoverX(260, 100, { padL: 20, innerW: 90 }), 110);

assert.strictEqual(isValidHoverIndex(null, 10), false);
assert.strictEqual(isValidHoverIndex(undefined, 10), false);
assert.strictEqual(isValidHoverIndex(0, 10), true);
assert.strictEqual(isValidHoverIndex(9, 10), true);
assert.strictEqual(isValidHoverIndex(10, 10), false);

assert.strictEqual(pointInsideRect(50, 50, { left: 10, top: 20, right: 100, bottom: 80 }), true);
assert.strictEqual(pointInsideRect(9, 50, { left: 10, top: 20, right: 100, bottom: 80 }), false);
assert.strictEqual(pointInsideRect(50, 81, { left: 10, top: 20, right: 100, bottom: 80 }), false);

console.log('test_profile_hover_utils.js: ok');