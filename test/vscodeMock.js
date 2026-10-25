const Module = require('module');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

class Uri {
  constructor(path) {
    this.path = path;
    this.fsPath = path;
  }
  static file(path) {
    return new Uri(path);
  }
  static parse(value) {
    return new Uri(value.replace(/^file:\/\//, ''));
  }
  with(change) {
    return new Uri(change.path || this.path);
  }
  toString() {
    return `file://${this.path}`;
  }
}

function loadWithVscode(modulePath, vscode) {
  const original = Module._load;
  Module._load = function (id, ...args) {
    return id === 'vscode' ? vscode : original.call(this, id, ...args);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = original;
  }
}

module.exports = { EventEmitter, Uri, loadWithVscode };
