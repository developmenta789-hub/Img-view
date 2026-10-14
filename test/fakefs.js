'use strict';

/** Tiny in-memory Firestore: only what the server uses. Transaction writes apply at the end, like the real one. */
function fakeFs() {
  const store = new Map();
  const snap = (path) => ({ exists: store.has(path), id: path.split('/').pop(), data: () => store.get(path) });
  const direct = (path) => [...store.entries()].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop(), data: () => v }));
  const num = (v) => (v instanceof Date ? v.getTime() : Number(v) || 0);
  const query = (path, filters = [], order = null, lim = Infinity) => ({
    isQuery: true,
    where: (f, op, v) => query(path, [...filters, [f, v]], order, lim),
    orderBy: (f, dir) => query(path, filters, [f, dir || 'asc'], lim),
    limit: (n) => query(path, filters, order, n),
    select: () => query(path, filters, order, lim),
    get: async () => {
      let rows = direct(path).filter((r) => filters.every(([f, v]) => r.data()[f] === v));
      if (order) rows.sort((a, b) => (num(a.data()[order[0]]) - num(b.data()[order[0]])) * (order[1] === 'desc' ? -1 : 1));
      return { docs: rows.slice(0, lim) };
    },
  });
  const doc = (path) => ({
    path, id: path.split('/').pop(),
    collection: (n) => col(path + '/' + n),
    get: async () => snap(path),
    set: async (d, o) => { store.set(path, o && o.merge ? { ...(store.get(path) || {}), ...d } : d); },
    delete: async () => { store.delete(path); },
  });
  const col = (path) => ({ path, doc: (id) => doc(path + '/' + id), ...query(path) });
  return {
    store, collection: (n) => col(n),
    async runTransaction(fn) {
      const writes = [];
      const t = {
        get: async (x) => (x.isQuery ? x.get() : snap(x.path)),
        create: (ref, d) => { if (store.has(ref.path) || writes.some((w) => w.path === ref.path && w.op === 'create')) throw new Error('ALREADY_EXISTS'); writes.push({ op: 'create', path: ref.path, d }); },
        set: (ref, d, o) => writes.push({ op: 'set', path: ref.path, d, merge: o && o.merge }),
        delete: (ref) => writes.push({ op: 'delete', path: ref.path }),
        update: (ref, d) => { if (!store.has(ref.path)) throw new Error('NOT_FOUND'); writes.push({ op: 'update', path: ref.path, d, merge: true }); },
      };
      const out = await fn(t);
      for (const w of writes) if (w.op === 'delete') store.delete(w.path); else store.set(w.path, w.merge ? { ...(store.get(w.path) || {}), ...w.d } : w.d);
      return out;
    },
  };
}

module.exports = { fakeFs };
