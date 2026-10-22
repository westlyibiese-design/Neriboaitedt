// Firestore's REST API represents every field as a typed wrapper object
// (e.g. {stringValue: "x"}, {integerValue: "3"}) rather than plain JSON.
// These helpers convert to/from that shape for the specific value types
// the usage document needs. Deliberately small — not a general-purpose
// Firestore ORM, just enough for functions/_shared/firestoreClient.js.

export function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  // Plain object → Firestore map, e.g. appConfig/models' per-model-ID
  // sub-fields (functions/api/admin/set-model-display.js). Recurses
  // through encodeValue so a map can itself hold strings/numbers/dates/
  // arrays/nested maps. Every existing caller of encodeFields before
  // this was added passed only flat primitive values, so this is purely
  // additive — nothing that worked before changes behavior.
  if (typeof value === "object") return { mapValue: { fields: encodeFields(value) } };
  throw new Error(`encodeValue: unsupported value type: ${typeof value}`);
}

export function encodeFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = encodeValue(value);
  }
  return fields;
}

export function decodeValue(fieldValue) {
  if (!fieldValue) return undefined;
  if ("stringValue" in fieldValue) return fieldValue.stringValue;
  if ("booleanValue" in fieldValue) return fieldValue.booleanValue;
  if ("integerValue" in fieldValue) return parseInt(fieldValue.integerValue, 10);
  if ("doubleValue" in fieldValue) return fieldValue.doubleValue;
  if ("timestampValue" in fieldValue) return fieldValue.timestampValue; // ISO string
  if ("nullValue" in fieldValue) return null;
  if ("arrayValue" in fieldValue) {
    const values = (fieldValue.arrayValue && fieldValue.arrayValue.values) || [];
    return values.map(decodeValue);
  }
  if ("mapValue" in fieldValue) {
    return decodeFields(fieldValue.mapValue && fieldValue.mapValue.fields);
  }
  return undefined;
}

export function decodeFields(fields) {
  if (!fields) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = decodeValue(value);
  }
  return out;
}
