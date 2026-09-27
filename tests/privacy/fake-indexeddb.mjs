/**
 * A minimal in-memory IndexedDB, sufficient for the vault key store.
 *
 * Node provides WebCrypto but not IndexedDB, and the vault's key is held in
 * IndexedDB precisely so its bytes are never exportable. Without a stand-in
 * here the tests would only ever exercise the "encryption unavailable" path and
 * prove nothing about the envelope format, IV rotation, or tamper detection.
 *
 * Only the surface the vault uses is implemented: open with an upgrade hook,
 * a single object store, get/put, and a transaction that aborts cleanly.
 */

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    // A real IDBRequest exposes the connection on `request.result` and the
    // upgrade event handler reads the database from the event, not the request.
    this.result = undefined;
    this.error = null;
  }
}

class FakeTransaction {
  constructor(store) {
    this.store = store;
    this.error = null;
    this.onabort = null;
    this.oncomplete = null;
  }

  abort() {
    this.error = new Error('aborted');
    if (this.onabort) this.onabort();
  }
}

class FakeObjectStore {
  constructor(backing, transaction) {
    this.backing = backing;
    // A real IDBObjectStore exposes its own transaction, and the vault reads
    // `store.transaction` when awaiting a request.
    this.transaction = transaction;
  }

  get(key) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      request.result = this.backing.has(key) ? this.backing.get(key) : undefined;
      if (request.onsuccess) request.onsuccess();
    });
    return request;
  }

  put(value, key) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.backing.set(key, value);
      request.result = key;
      if (request.onsuccess) request.onsuccess();
    });
    return request;
  }
}

class FakeDatabase {
  constructor(name) {
    this.name = name;
    this.stores = new Map();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }

  createObjectStore(name) {
    const backing = new Map();
    const transaction = new FakeTransaction(null);
    const store = new FakeObjectStore(backing, transaction);
    this.stores.set(name, store);
    return store;
  }

  transaction(storeName, _mode) {
    const store = this.stores.get(storeName);
    if (!store) throw new Error(`No object store named "${storeName}"`);
    // A real IDBTransaction exposes objectStore(name); the vault always uses
    // the one it just opened.
    const transaction = new FakeTransaction(store);
    transaction.objectStore = (name) => {
      if (name !== storeName) throw new Error(`No object store named "${name}"`);
      return store;
    };
    return transaction;
  }

  close() {}
}

/**
 * Install a fake `indexedDB` on globalThis for the duration of a test.
 *
 * @param {Map} [databases] Shared backing store. Pass the same map when
 *   simulating a browser restart within one test: IndexedDB persists across
 *   sessions in a real browser, so a "reloaded" vault must still find the key
 *   it stored earlier. A fresh map models a genuinely new profile.
 * @returns {() => void} restore function
 */
export function installFakeIndexedDB(databases = new Map()) {
  const previous = globalThis.indexedDB;

  globalThis.indexedDB = {
    open(name, _version) {
      const request = new FakeRequest();
      queueMicrotask(() => {
        if (!databases.has(name)) databases.set(name, new FakeDatabase(name));
        const db = databases.get(name);
        // In a real open, `request.result` is already the database when the
        // upgrade handler runs. Setting it first is what lets the handler
        // create its object store.
        request.result = db;
        // The handler is a plain property, not an event listener, and it
        // receives the open request.
        if (request.onupgradeneeded) request.onupgradeneeded(request);
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    }
  };

  return () => {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  };
}
