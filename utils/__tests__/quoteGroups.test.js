const test = require('node:test');
const assert = require('node:assert');
const { isColourSet, groupPickMode, groupPickModes, designKey } = require('../quoteGroups');

// The order that prompted this: one design, two garment colours, 50 of each.
// Under the old flat pick-one rule the client could take only one of them.
const BLACK = { group: 'T-Shirts', styleCode: 'G500', description: 'Heavy Cotton Tee', printDetails: '1c front', color: 'Black', qty: 50 };
const WHITE = { ...BLACK, color: 'White' };

test('two colourways of one design are an any_of group', () => {
  assert.equal(isColourSet([BLACK, WHITE]), true);
  assert.equal(groupPickMode([BLACK, WHITE]), 'any_of');
});

test('the same colour twice is not a colour set — that is a quantity matrix', () => {
  assert.equal(isColourSet([BLACK, { ...BLACK, qty: 100 }]), false);
  assert.equal(groupPickMode([BLACK, { ...BLACK, qty: 100 }]), 'one_of');
});

test('different brands stay alternatives even when each names a colour', () => {
  const gildan = { ...BLACK, styleCode: 'G500', description: 'Gildan Heavy Cotton' };
  const bella  = { ...BLACK, styleCode: '3001', description: 'Bella Jersey Tee', color: 'White' };
  assert.equal(isColourSet([gildan, bella]), false);
  assert.equal(groupPickMode([gildan, bella]), 'one_of');
});

test('a differing print spec is a real alternative, not a colourway', () => {
  // Same garment, same colour name, but one is a 1-colour front and one is 3c —
  // genuinely different jobs at different prices. Pick one.
  const oneColour   = { ...BLACK, printDetails: '1c front' };
  const threeColour = { ...BLACK, printDetails: '3c front', color: 'White' };
  assert.equal(groupPickMode([oneColour, threeColour]), 'one_of');
});

test('an unnamed colour never derives any_of — we must not guess', () => {
  // The owner often types the colour into `description` instead. Guessing there
  // would let a client take two lines the owner meant as alternatives.
  assert.equal(isColourSet([{ ...BLACK, color: '' }, WHITE]), false);
  assert.equal(groupPickMode([{ ...BLACK, color: '' }, WHITE]), 'one_of');
});

test('a single line is never a colour set', () => {
  assert.equal(isColourSet([BLACK]), false);
  assert.equal(groupPickMode([BLACK]), 'one_of');
});

test('colour comparison ignores case and padding', () => {
  assert.equal(isColourSet([{ ...BLACK, color: ' black ' }, { ...WHITE, color: 'WHITE' }]), true);
  // …and two spellings of ONE colour still is not a set.
  assert.equal(isColourSet([{ ...BLACK, color: 'Black' }, { ...BLACK, color: ' BLACK ' }]), false);
});

test('an owner pin overrides the derivation in both directions', () => {
  // "Pick your favourite colour" — colourways the owner wants as alternatives.
  assert.equal(groupPickMode([{ ...BLACK, groupMode: 'one_of' }, WHITE]), 'one_of');
  // …and add-ons that do not look like a colour set but should add up.
  const a = { group: 'Extras', description: 'Stickers', qty: 100 };
  const b = { group: 'Extras', description: 'Koozies', qty: 100, groupMode: 'any_of' };
  assert.equal(groupPickMode([a, b]), 'any_of');
});

test('a pin on any line of the group counts — the group is not its own document', () => {
  assert.equal(groupPickMode([{ ...BLACK }, { ...WHITE, groupMode: 'one_of' }]), 'one_of');
});

test('an unrecognized mode string falls back to the derivation, never throws', () => {
  assert.equal(groupPickMode([{ ...BLACK, groupMode: 'whatever' }, WHITE]), 'any_of');
});

test('groupPickModes maps a whole quote and skips standalone lines', () => {
  const hats = { group: 'Hats', styleCode: 'C112', description: 'Trucker', color: 'Black', qty: 50 };
  const alt  = { ...hats, styleCode: 'RC104', description: 'Richardson 112' };
  const loose = { group: '', description: 'Setup', qty: 1 };
  const modes = groupPickModes([BLACK, WHITE, hats, alt, loose]);
  assert.deepEqual(modes, { 'T-Shirts': 'any_of', Hats: 'one_of' });
  assert.equal(Object.prototype.hasOwnProperty.call(modes, ''), false);
});

test('designKey ignores colour so colourways collapse to one design', () => {
  assert.equal(designKey(BLACK), designKey(WHITE));
  assert.notEqual(designKey(BLACK), designKey({ ...BLACK, styleCode: '3001' }));
});

test('empty / junk input is safe', () => {
  assert.equal(groupPickMode([]), 'one_of');
  assert.equal(groupPickMode(null), 'one_of');
  assert.equal(isColourSet(null), false);
  assert.deepEqual(groupPickModes(null), {});
  assert.equal(isColourSet([null, undefined]), false);
});
