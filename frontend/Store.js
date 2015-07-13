/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @ xx flow
 *
 * flow disabled because of the following bug:
 * possibly undefined value
 * https://github.com/facebook/flow/issues/603
 */
'use strict';

var {EventEmitter} = require('events');
var {Map, Set, List} = require('./imm');
var assign = require('object-assign');
var nodeMatchesText = require('./nodeMatchesText');

import type Bridge from '../backend/Bridge'
import type {DOMNode, DOMEvent, Dir, Dest} from './types'

type ElementID = string;

type ListenerFunction = () => void;
type DataType = Map;
type ContextMenu = {
  type: string,
  x: number,
  y: number,
  args: Array<any>,
};

/**
 * Public events:
 *
 * - connected / connection failed
 * - roots
 * - searchText
 * - searchRoots
 * - contextMenu
 * - hover
 * - selected
 * - [node id]
 *
 * Public state:
 *  see attrs / constructor
 *
 * Public actions:
 * - scrollToNode(id)
 * - changeTextContent(id, text)
 * - changeSearch
 * - hoverClass
 * - selectFirstOfClass
 * - showContextMenu
 * - hideContextMenu
 * - selectFirstSearchResult
 * 
 * Public methods:
 * - get(id) => Map (the node)
 * - getParent(id) => pid
 */
class Store extends EventEmitter {
  _bridge: Bridge;
  _nodes: Map;
  _parents: Map;
  _nodesByName: Map;

  // Public state
  contextMenu: ?ContextMenu;
  hovered: ?ElementID;
  isBottomTagSelected: boolean;
  roots: List;
  searchRoots: ?List;
  searchText: string;
  selected: ?ElementID;
  // an object describing the capabilities of the inspected runtime.
  capabilities: {
    scroll?: boolean,
  };

  constructor(bridge: Bridge) {
    super()
    this._nodes = new Map();
    this._parents = new Map();
    this._nodesByName = new Map();
    this._bridge = bridge;

    // Public state
    this.roots = new List();
    this.contextMenu = null;
    this.searchRoots = null;
    this.hovered = null;
    this.selected = null;
    this.isBottomTagSelected = false;
    this.searchText = '';
    this.capabilities = {};

    // for debugging
    window.store = this;

    // events from the backend
    this._bridge.on('root', id => {
      if (this.roots.contains(id)) {
        return;
      }
      this.roots = this.roots.push(id);
      if (!this.selected) {
        this.selected = id;
        this.emit('selected');
        this._bridge.send('selected', id);
      }
      this.emit('roots');
    });
    this._bridge.on('mount', (data) => this.mountComponent(data));
    this._bridge.on('update', (data) => this.updateComponent(data));
    this._bridge.on('unmount', id => this.unmountComponenent(id));
    this._bridge.on('select', ({id, quiet}) => {
      this._revealDeep(id);
      this.selectTop(this.skipWrapper(id), quiet);
    });

    this._establishConnection();
  }

  _establishConnection() {
    var tries = 0;
    var requestInt;
    this._bridge.once('capabilities', capabilities => {
      clearInterval(requestInt);
      this.capabilities = assign(this.capabilities, capabilities);
      this.emit('connected');
    });
    this._bridge.send('requestCapabilities');
    requestInt = setInterval(() => {
      tries += 1;
      if (tries > 100) {
        console.error('failed to connect');
        clearInterval(requestInt);
        this.emit('connection failed');
        return;
      }
      this._bridge.send('requestCapabilities');
    }, 500);
  }

  scrollToNode(id: ElementID): void {
    this._bridge.send('scrollToNode', id);
  }

  // TODO(jared): get this working for react native
  changeTextContent(id: ElementID, text: string): void {
    this._bridge.send('changeTextContent', {id, text});
    var node = this._nodes.get(id);
    if (node.get('nodeType') === 'Text') {
      this._nodes = this._nodes.set(id, node.set('text', text));
    } else {
      this._nodes = this._nodes.set(id, node.set('children', text));
      var props = node.get('props');
      props.children = text;
    }
    this.emit(id);
  }

  changeSearch(text: string): void {
    var needle = text.toLowerCase();
    if (needle === this.searchText.toLowerCase()) {
      return;
    }
    if (!text) {
      this.searchRoots = null;
    } else {
      var base;
      if (this.searchRoots && needle.indexOf(this.searchText.toLowerCase()) === 0) {
        this.searchRoots = this.searchRoots
          .filter(item => {
            var node = this.get(item)
            return (node.get('name') && node.get('name').toLowerCase().indexOf(needle) !== -1) ||
              (node.get('text') && node.get('text').toLowerCase().indexOf(needle) !== -1) ||
              ('string' === typeof node.get('children') && node.get('children').toLowerCase().indexOf(needle) !== -1);
          });
      } else {
        this.searchRoots = this._nodes.entrySeq()
          .filter(([key, val]) => nodeMatchesText(val, needle))
          .map(([key, val]) => key)
          .toList();
      }
      // $FlowFixMe
      this.searchRoots.forEach(id => {
        if (this.hasBottom(id)) {
          this._nodes = this._nodes.setIn([id, 'collapsed'], true);
        }
      });
    }
    this.searchText = text;
    this.emit('searchText');
    this.emit('searchRoots');
    if (this.searchRoots && !this.searchRoots.contains(this.selected)) {
      this.select(null, true);
    } else if (!this.searchRoots) {
      if (this.selected) {
        this._revealDeep(this.selected);
      } else {
        this.select(this.roots.get(0));
      }
    }
  }

  hoverClass(name: string): void {
    if (name === null) {
      this._bridge.send('hideHighlight');
      return;
    }
    var ids = this._nodesByName.get(name);
    if (!ids) {
      return;
    }
    this._bridge.send('highlightMany', ids.toArray());
  }

  selectFirstOfClass(name: string): void {
    var ids = this._nodesByName.get(name);
    if (!ids || !ids.size) {
      return;
    }
    var id = ids.toSeq().first()
    this._revealDeep(id);
    this.selectTop(id);
  }

  showContextMenu(type: string, evt: DOMEvent, ...args: Array<any>) {
    evt.preventDefault();
    this.contextMenu = {type, x: evt.pageX, y: evt.pageY, args};
    this.emit('contextMenu');
  }

  hideContextMenu() {
    this.contextMenu = null;
    this.emit('contextMenu');
  }

  selectFirstSearchResult() {
    if (this.searchRoots) {
      this.select(this.searchRoots.get(0), true);
    }
  }

  _revealDeep(id: ElementID) {
    if (this.searchRoots && this.searchRoots.contains(id)) {
      return;
    }
    var pid = this._parents.get(id);
    while (pid) {
      if (this._nodes.getIn([pid, 'collapsed'])) {
        this._nodes = this._nodes.setIn([pid, 'collapsed'], false);
        this.emit(pid);
      }
      if (this.searchRoots && this.searchRoots.contains(pid)) {
        return;
      }
      pid = this._parents.get(pid);
    }
  }

  skipWrapper(id: ElementID, up?: boolean): ?ElementID {
    if (!id) {
      return;
    }
    var node = this.get(id);
    if (node.get('nodeType') !== 'Wrapper') {
      return id;
    }
    if (up) {
      return this._parents.get(id);
    }
    return node.get('children')[0];
  }

  hasBottom(id: ElementID): boolean {
    var node = this.get(id);
    var children = node.get('children');
    if ('string' === typeof children || !children || !children.length || node.get('collapsed')) {
      return false;
    }
    return true;
  }

  get(id: ElementID): DataType {
    return this._nodes.get(id);
  }

  getParent(id: ElementID): ElementID {
    return this._parents.get(id);
  }

  off(evt: DOMEvent, fn: ListenerFunction): void {
    this.removeListener(evt, fn);
  }

  toggleCollapse(id: ElementID) {
    this._nodes = this._nodes.updateIn([id, 'collapsed'], c => !c);
    this.emit(id);
  }

  setProps(id: ElementID, path: Array<string>, value: any) {
    this._bridge.send('setProps', {id, path, value});
  }

  setState(id: ElementID, path: Array<string>, value: any) {
    this._bridge.send('setState', {id, path, value});
  }

  setContext(id: ElementID, path: Array<string>, value: any) {
    this._bridge.send('setContext', {id, path, value});
  }

  inspect(id: ElementID, path: Array<string>, cb: (val: any) => void) {
    this._bridge.inspect(id, path, cb)
  }

  makeGlobal(id: ElementID, path: Array<string>) {
    this._bridge.send('makeGlobal', {id, path});
  }

  setHover(id: ElementID, isHovered: boolean) {
    if (isHovered) {
      var old = this.hovered;
      this.hovered = id;
      if (old) {
        this.emit(old);
      }
      this.emit(id);
      this.emit('hover');
      this._bridge.send('highlight', id);
    } else if (this.hovered === id) {
      this.hovered = null;
      this.emit(id);
      this.emit('hover');
      this._bridge.send('hideHighlight');
    }
  }

  selectBottom(id: ElementID) {
    this.isBottomTagSelected = true;
    this.select(id);
  }

  selectTop(id: ?ElementID, noHighlight?: boolean) {
    this.isBottomTagSelected = false;
    this.select(id, noHighlight);
  }

  select(id: ?ElementID, noHighlight?: boolean) {
    var oldSel = this.selected;
    this.selected = id;
    if (oldSel) {
      this.emit(oldSel);
    }
    if (id) {
      this.emit(id);
    }
    this.emit('selected');
    this._bridge.send('selected', id);
    if (!noHighlight) {
      this._bridge.send('highlight', id);
    }
  }

  mountComponent(data: DataType) {
    var map = Map(data).set('renders', 1);
    if (data.nodeType === 'Custom') {
      map = map.set('collapsed', true);
    }
    this._nodes = this._nodes.set(data.id, map);
    if (data.children && data.children.forEach) {
      data.children.forEach(cid => {
        this._parents = this._parents.set(cid, data.id);
      });
    }
    var curNodes = this._nodesByName.get(data.name) || new Set();
    this._nodesByName = this._nodesByName.set(data.name, curNodes.add(data.id));
    this.emit(data.id);
    if (this.searchRoots && nodeMatchesText(map, this.searchText.toLowerCase())) {
      // $FlowFixMe - flow things this might still be null (but it's not b/c
      // of line 271)
      this.searchRoots = this.searchRoots.push(data.id);
      this.emit('searchRoots');
    }
  }

  updateComponent(data: DataType) {
    var node = this.get(data.id)
    if (!node) {
      return;
    }
    data.renders = node.get('renders') + 1;
    this._nodes = this._nodes.mergeIn([data.id], Map(data));
    if (data.children && data.children.forEach) {
      data.children.forEach(cid => {
        this._parents = this._parents.set(cid, data.id);
      });
    }
    this.emit(data.id);
  }

  unmountComponenent(id: ElementID) {
    var pid = this._parents.get(id);
    this._removeFromNodesByName(id);
    this._parents = this._parents.delete(id);
    this._nodes = this._nodes.delete(id)
    if (pid) {
      this.emit(pid);
    } else {
      var ix = this.roots.indexOf(id);
      if (ix !== -1) {
        this.roots = this.roots.delete(ix);
        this.emit('roots');
      }
    }
    if (id === this.selected) {
      var newsel = pid || this.roots.get(0);
      this.selectTop(newsel);
    }
    if (this.searchRoots && this.searchRoots.contains(id)) {
      // $FlowFixMe flow things searchRoots might be null
      this.searchRoots = this.searchRoots.delete(this.searchRoots.indexOf(id));
      this.emit('searchRoots');
    }
  }

  _removeFromNodesByName(id: ElementID) {
    var node = this._nodes.get(id);
    this._nodesByName = this._nodesByName.set(node.get('name'), this._nodesByName.get(node.get('name')).delete(id));
  }
}

module.exports = Store;