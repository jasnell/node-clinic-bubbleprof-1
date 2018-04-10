'use strict'

const Frame = require('./frame.js')
const { CallbackEvent } = require('./callback-event.js')
const { isNumber } = require('../validation.js')

class DataNode {
  constructor (dataSet) {
    // Reference to settings on data map
    this.settings = dataSet.settings
    this.dataSet = dataSet

    const node = this
    this.stats = {
      // For nodes whose sourceNodes contain no callbackEvents (.before and .after arrays are empty), these
      // stats are not set, so default 0 values are accessed. Such cases are rare but valid, e.g. root
      // TODO: give examples of some of the async_hook types that often have no callbackEvents.

      sync: 0,
      setSync (num) { node.stats.sync = node.validateStat(num, 'stats.sync') },

      async: {
        between: 0,
        setBetween (num) { node.stats.async.between = node.validateStat(num, 'stats.async.between') },

        within: 0,
        setWithin (num) { node.stats.async.within = node.validateStat(num, 'stats.async.within') }
      },

      rawTotals: {
        sync: 0,
        async: {
          between: 0,
          within: 0
        }
      }
    }
  }

  getWithinTime () { return this.stats.sync + this.stats.async.within }
  getBetweenTime () { return this.stats.async.between }

  getParentNode () {
    return this.dataSet.getByNodeType(this.constructor.name, this.parentId)
  }

  getSameType (nodeId) {
    return this.dataSet.getByNodeType(this.constructor.name, nodeId)
  }

  validateStat (num, statType) {
    if (!isNumber(num)) throw new Error(`Tried to set ${typeof num} "${num}" to ${this.constructor.name} ${this.id} ${statType}, should be number`)
    return num
  }
}

class ClusterNode extends DataNode {
  constructor (node, dataSet) {
    super(dataSet)

    this.isRoot = (node.clusterId === 1)

    this.clusterId = node.clusterId
    this.parentClusterId = node.parentClusterId
    this.name = node.name

    this.children = node.children

    // These contain decimals referring to the portion of a clusterNode's delay attributable to some label
    this.decimals = {
      type: {between: new Map(), within: new Map()}, // Node async_hook types: 'HTTPPARSER', 'TickObject'...
      // TODO: subTypeCategories stats
      typeCategory: {between: new Map(), within: new Map()}, // Defined in .getAsyncTypeCategories() below
      party: {between: new Map(), within: new Map()} // From .mark - 'user', 'module' or 'nodecore'
    }

    this.nodeIds = new Set(node.nodes.map(node => node.aggregateId))

    const aggregateNodes = node.nodes.map((aggregateNode) => [
      aggregateNode.aggregateId,
      new AggregateNode(aggregateNode, this)
    ])

    this.nodes = new Map(aggregateNodes)

    // All aggregateNodes within a clusterNode are by definition from the same party
    this.mark = aggregateNodes[0][1].mark
  }
  setDecimal (num, classification, position, label = 'nodecore') {
    const raw = this.stats.rawTotals
    const rawTotal = position === 'within' ? raw.async.within + raw.sync : raw.async.between
    const statType = `decimals.${classification}.${position}->${label}`
    const decimal = (num === 0 && rawTotal === 0) ? 0 : this.validateStat(num / rawTotal, statType)

    const decimalsMap = this.decimals[classification][position]
    if (decimalsMap.has(label)) {
      decimalsMap.set(label, decimalsMap.get(label) + decimal)
    } else {
      decimalsMap.set(label, decimal)
    }
  }
  get id () {
    return this.clusterId
  }
  get parentId () {
    return this.parentClusterId
  }
}

class AggregateNode extends DataNode {
  constructor (node, clusterNode) {
    super(clusterNode.dataSet)

    this.isRoot = (node.isRoot || node.aggregateId === 1)

    this.aggregateId = node.aggregateId
    this.parentAggregateId = node.parentAggregateId
    this.children = node.children
    this.clusterNode = clusterNode

    this.isBetweenClusters = node.parentAggregateId && !clusterNode.nodeIds.has(node.parentAggregateId)

    this.frames = node.frames.map((frame) => {
      const frameItem = new Frame(frame)
      return {
        formatted: frameItem.format(),
        data: frameItem
      }
    })

    if (!node.mark) node.mark = ['nodecore', null, null]
    // node.mark is always an array of length 3, based on this schema:
    const markKeys = ['party', 'module', 'name']
    // 'party' (as in 'third-party') will be one of 'user', 'external' or 'nodecore'.
    // 'module' and 'name' will be null unless frames met conditions in /analysis/aggregate
    this.mark = new Map(node.mark.map((value, i) => [markKeys[i], value]))
    // for example, 'nodecore.net.onconnection', or 'module.somemodule', or 'user'
    this.mark.string = node.mark.reduce((string, value) => string + (value ? '.' + value : ''))

    // Node's async_hook types - see https://nodejs.org/api/async_hooks.html#async_hooks_type
    // 29 possible values defined in node core, plus other user-defined values can exist
    this.type = node.type
    const [typeCategory, typeSubCategory] = AggregateNode.getAsyncTypeCategories(this.type)
    this.typeCategory = typeCategory
    this.typeSubCategory = typeSubCategory

    this.sources = node.sources.map((source) => new SourceNode(source, this))

    this.dataSet.aggregateNodes.set(this.aggregateId, this)
  }
  applyDecimalsToCluster () {
    const apply = (time, betweenOrWithin) => {
      this.clusterNode.setDecimal(time, 'type', betweenOrWithin, this.type)
      this.clusterNode.setDecimal(time, 'typeCategory', betweenOrWithin, this.typeCategory)
      this.clusterNode.setDecimal(time, 'party', betweenOrWithin, this.mark.get('party'))
    }

    if (this.isBetweenClusters) {
      apply(this.stats.rawTotals.async.between, 'between')
      apply(this.stats.rawTotals.sync, 'within')
    } else {
      apply(this.stats.rawTotals.async.between + this.stats.rawTotals.sync, 'within')
    }
  }
  get id () {
    return this.aggregateId
  }
  get parentId () {
    return this.parentAggregateId
  }
  static getAsyncTypeCategories (typeName) {
  // Combines node's async_hook types into sets of more user-friendly thematic categories
  // Based on https://gist.github.com/mafintosh/e31eb1d61f126de019cc10344bdbb62b
    switch (typeName) {
      case 'FSEVENTWRAP':
      case 'FSREQWRAP':
      case 'STATWATCHER':
        return ['files-streams', 'fs']
      case 'JSSTREAM':
      case 'WRITEWRAP':
      case 'SHUTDOWNWRAP':
        return ['files-streams', 'streams']
      case 'ZLIB':
        return ['files-streams', 'zlib']

      case 'HTTPPARSER':
      case 'PIPECONNECTWRAP':
      case 'PIPEWRAP':
      case 'TCPCONNECTWRAP':
      case 'TCPSERVER':
      case 'TCPWRAP':
      case 'TCPSERVERWRAP':
        return ['networks', 'networking']
      case 'UDPSENDWRAP':
      case 'UDPWRAP':
        return ['networks', 'network']
      case 'GETADDRINFOREQWRAP':
      case 'GETNAMEINFOREQWRAP':
      case 'QUERYWRAP':
        return ['networks', 'dns']

      case 'PBKDF2REQUEST':
      case 'RANDOMBYTESREQUEST':
      case 'TLSWRAP':
      case 'SSLCONNECTION':
        return ['crypto', 'crypto']

      case 'TIMERWRAP':
      case 'Timeout':
      case 'Immediate':
      case 'TickObject':
        return ['timing-promises', 'timers-and-ticks']
      case 'PROMISE':
        return ['timing-promises', 'promises']

      case 'PROCESSWRAP':
      case 'TTYWRAP':
      case 'SIGNALWRAP':
        return ['other', 'process']
      case undefined:
        return ['other', 'root']
      default:
        return ['other', 'user-defined']
    }
  }
}

class SourceNode extends DataNode {
  constructor (source, aggregateNode) {
    super(aggregateNode.dataSet)

    this.asyncId = source.asyncId
    this.parentAsyncId = source.parentAsyncId
    this.triggerAsyncId = source.parentAsyncId
    this.executionAsyncId = source.parentAsyncId

    this.init = source.init
    this.before = source.before
    this.after = source.after
    this.destroy = source.destroy

    this.aggregateNode = aggregateNode

    source.before.forEach((value, callKey) => {
      const callbackEvent = new CallbackEvent(callKey, this)
      this.dataSet.callbackEvents.array.push(callbackEvent)
    })

    this.dataSet.sourceNodes.set(this.asyncId, this)
  }
  get id () {
    return this.asyncId
  }
}

module.exports = {
  ClusterNode,
  AggregateNode,
  SourceNode
}