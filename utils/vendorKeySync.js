// utils/vendorKeySync.js
//
// Keeps a derived `vendorKey` in lockstep with the name it describes, on EVERY
// mongoose write path. Vendor and PurchaseOrder both need this and their hooks
// were byte-identical apart from the field name, so it lives once, here, and is
// pure enough to unit-test without a database.
//
// Why every path matters: a pre('save') hook alone misses findOneAndUpdate, and
// the contact book learns vendors precisely via an upsert. A key that only
// SOMETIMES tracks its name is worse than no key — lookups become silently
// partial, and the fallback quietly carries the rows the key missed, so the bug
// hides instead of failing loudly.

const { vendorKey } = require('./poCost');

// The name this update is setting, wherever it's hiding: $set, $setOnInsert
// (upsert path), or a bare top-level assignment. Returns undefined when the
// update doesn't touch the name at all — then there's nothing to re-derive.
function nameInUpdate(update, nameField) {
  const u = update || {};
  if (u.$set && u.$set[nameField] != null) return u.$set[nameField];
  if (u.$setOnInsert && u.$setOnInsert[nameField] != null) return u.$setOnInsert[nameField];
  if (u[nameField] != null) return u[nameField];
  return undefined;
}

// Return the update with vendorKey written alongside the name. Placed in $set
// whenever the update already uses operators (mixing operator and plain-path
// forms in one update is a mongo error); otherwise assigned inline.
//
// PURE — returns a new object, never mutates the caller's.
function withVendorKey(update, nameField = 'name') {
  const u = update || {};
  const name = nameInUpdate(u, nameField);
  if (name === undefined) return u;
  const key = vendorKey(name);
  const usesOperators = Object.keys(u).some((k) => k.startsWith('$'));
  if (usesOperators) return { ...u, $set: { ...(u.$set || {}), vendorKey: key } };
  return { ...u, vendorKey: key };
}

// The mongoose pre-hook itself, bound to a name field.
function vendorKeyUpdateHook(nameField) {
  return function hook(next) {
    this.setUpdate(withVendorKey(this.getUpdate(), nameField));
    next();
  };
}

// Attach every write path at once, so adding a path can't be forgotten.
function attachVendorKeySync(schema, nameField) {
  schema.pre('validate', function setKey(next) {
    this.vendorKey = vendorKey(this[nameField]);
    next();
  });
  const hook = vendorKeyUpdateHook(nameField);
  schema.pre('findOneAndUpdate', hook);
  schema.pre('updateOne', hook);
  schema.pre('updateMany', hook);
}

module.exports = { nameInUpdate, withVendorKey, vendorKeyUpdateHook, attachVendorKeySync };
