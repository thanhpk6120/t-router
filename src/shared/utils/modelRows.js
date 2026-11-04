// One `{ id, name }` contract for every model row that reaches the dashboard.
//
// Provider /models endpoints are not uniform. OpenAI-shaped catalogs return
// `{ id, object, created, owned_by }` with no display name, Anthropic returns
// `display_name`, and a few resolvers answer with bare id strings. A raw row
// used to reach the UI as a blank chip and, in the model picker, as
// `name: undefined` — where the alphabetical sort threw
// "Cannot read properties of undefined (reading 'localeCompare')" and the whole
// dialog crashed. Normalizing once, at the API boundary and again when the
// picker reads a payload, keeps every consumer on the same shape.
export function normalizeModelRows(models) {
  return (Array.isArray(models) ? models : [])
    .map((model) => {
      if (typeof model === "string") return { id: model, name: model };
      if (!model || typeof model !== "object") return null;
      const id = model.id || model.model || model.name;
      if (!id) return null;
      return {
        ...model,
        id,
        name: model.name || model.display_name || model.displayName || id,
      };
    })
    .filter(Boolean);
}
