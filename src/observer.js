var EventTarget = require('./eventTarget'),
    utils       = require('./utils'),
    config      = require('./config'),
    def         = Object.defineProperty,
    hasProto    = ({}).__proto__;
var ArrayProxy  = Object.create(Array.prototype);
var ObjProxy    = Object.create(Object.prototype);
utils.mix(ArrayProxy, {
    '$set': function set(index, data) {
        return this.splice(index, 1, data)[0]
    },
    '$remove': function remove(index) {
        if (typeof index !== 'number') {
            index = this.indexOf(index)
        }
        if (index > -1) {
            return this.splice(index, 1)[0]
        }
    }
});
utils.mix(ObjProxy, {
    '$add': function add(key, val) {
        if (utils.object.has(this, key)) {
            return;
        }
        this[key] = val;
        convertKey(this, key, true);
    },
    '$delete': function (key) {
    	if (!utils.object.has(this, key)){
    		return;
    	}
    	delete this[key];
    	this.__emitter__.emit('delete', key);
    }
});
/**
 *  INTERCEP A MUTATION EVENT SO WE CAN EMIT THE MUTATION INFO.
 *  WE ALSO ANALYZE WHAT ELEMENTS ARE ADDED/REMOVED AND LINK/UNLINK
 *  THEM WITH THE PARENT ARRAY.
 */
utils.each(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'], function(type) {
    ArrayProxy[type] = function() {
        var args = [].slice.call(arguments),
            result = Array.prototype[method].apply(this, args),
            inserted, removed;
        // determine new / removed elements
        if (method === 'push' || method === 'unshift') {
            inserted = args;
        } else if (method === 'pop' || method === 'shift') {
            removed = [result];
        } else if (method === 'splice') {
            inserted = args.slice(2)
            removed = result;
        }
        // link & unlink
        linkArrayElements(this, inserted)
        unlinkArrayElements(this, removed)
        // emit the mutation event
        this.__emitter__.emit('mutate', '', this, {
            method: method,
            args: args,
            result: result,
            inserted: inserted,
            removed: removed
        });
        return result;
    }
});
/**
 *  Link new elements to an Array, so when they change
 *  and emit events, the owner Array can be notified.
 */
function linkArrayElements(arr, items) {
    if (items) {
        var i = items.length,
            item, owners
        while (i--) {
            item = items[i]
            if (isWatchable(item)) {
                // if object is not converted for observing
                // convert it...
                if (!item.__emitter__) {
                    convert(item)
                    watch(item)
                }
                owners = item.__emitter__.owners
                if (owners.indexOf(arr) < 0) {
                    owners.push(arr)
                }
            }
        }
    }
}
/**
 *  Unlink removed elements from the ex-owner Array.
 */
function unlinkArrayElements(arr, items) {
    if (items) {
        var i = items.length,
            item
        while (i--) {
            item = items[i]
            if (item && item.__emitter__) {
                var owners = item.__emitter__.owners
                if (owners) owners.splice(owners.indexOf(arr))
            }
        }
    }
}
/**
 *  CHECK IF A VALUE IS WATCHABLE
 */
function isWatchable(obj) {
    return typeof obj === 'object' && obj && !obj.$compiler
}
/**
 *  CONVERT AN OBJECT/ARRAY TO GIVE IT A CHANGE EMITTER.
 */
function convert(obj) {
    if (obj.__emitter__) return true
    var emitter = new EventTarget();
    obj['__emitter__'] = emitter;
    emitter.on('set', function(key, val, propagate) {
        if (propagate) propagateChange(obj)
    });
    emitter.on('mutate', function() {
        propagateChange(obj)
    });
    emitter.values = utils.hash();
    emitter.owners = [];
    return false;
}
/**
 *  PROPAGATE AN ARRAY ELEMENT'S CHANGE TO ITS OWNER ARRAYS
 */
function propagateChange(obj) {
    var owners = obj.__emitter__.owners,
        i = owners.length
    while (i--) {
        owners[i].__emitter__.emit('set', '', '', true)
    }
}
/**
 *  WATCH TARGET BASED ON ITS TYPE
 */
function watch(obj) {
    if (utils.isArray(obj)) {
        watchArray(obj)
    } else {
        watchObject(obj)
    }
}
/**
 *  Watch an Object, recursive.
 */
function watchObject(obj) {
    augment(obj, ObjProxy)
    for (var key in obj) {
        convertKey(obj, key)
    }
}
/**
 *  WATCH AN ARRAY, OVERLOAD MUTATION METHODS
 *  AND ADD AUGMENTATIONS BY INTERCEPTING THE PROTOTYPE CHAIN
 */
function watchArray(arr) {
    augment(arr, ArrayProxy);
    linkArrayElements(arr, arr);
}
/**
 *  AUGMENT TARGET OBJECTS WITH MODIFIED
 *  METHODS
 */
function augment(target, src) {
    if (hasProto) {
        target.__proto__ = src
    } else {
    	utils.mix(target, src);
    }
}


/**
 *  DEFINE ACCESSORS FOR A PROPERTY ON AN OBJECT
 *  SO IT EMITS GET/SET EVENTS.
 *  THEN WATCH THE VALUE ITSELF.
 */
function convertKey (obj, key, propagate){
	var keyPrefix = key.charAt(0);
	if (keyPrefix === '$' || keyPrefix === '_'){
		return;
	}
	var emitter = obj.__emitter__,
		values  = emitter.values;

	init(obj[key], propagate);
	Object.defineProperty(obj, key, {
		enumerable: true,
		configurable: true,
		get: function () {
			var value = values[key];
			if (config.emmitGet) {
				emitter.emit('get', key);
			}
			return value;
		},
		set: function (newValue){
			var oldValue = values[key];
			unobserve(oldValue, key, emitter);
			copyPaths(newValue, oldValue);
			init(newValue, true);
		}
	});
	function init (val, propagate){
		values[key] = val;
		emitter.emit('set', key, val, propagate);
		if (utils.isArray(val)) {
			emitter.emit('set', key + '.length', val.length, propagate);
		}
		observe(val, key, emitter);
	}
}

/**
 *  When a value that is already converted is
 *  observed again by another observer, we can skip
 *  the watch conversion and simply emit set event for
 *  all of its properties.
 */
function emitSet (obj) {
    var emitter = obj && obj.__emitter__;
    if (!emitter) return;
    if (utils.isArray(obj)) {
        emitter.emit('set', 'length', obj.length);
    } else {
        var key, val
        for (key in obj) {
            val = obj[key]
            emitter.emit('set', key, val);
            emitSet(val);
        }
    }
}

/**
 *  Make sure all the paths in an old object exists
 *  in a new object.
 *  So when an object changes, all missing keys will
 *  emit a set event with undefined value.
 */
function copyPaths (newObj, oldObj) {
    if (!isObject(newObj) || !isObject(oldObj)) {
        return
    }
    var path, oldVal, newVal;
    for (path in oldObj) {
        if (!(utils.object.has(newObj, path))) {
            oldVal = oldObj[path]
            if (utils.isArray(oldVal)) {
                newObj[path] = []
            } else if (isObject(oldVal)) {
                newVal = newObj[path] = {}
                copyPaths(newVal, oldVal)
            } else {
                newObj[path] = undefined
            }
        }
    }
}

/**
 *  walk along a path and make sure it can be accessed
 *  and enumerated in that object
 */
function ensurePath (obj, key) {
    var path = key.split('.'), sec
    for (var i = 0, d = path.length - 1; i < d; i++) {
        sec = path[i]
        if (!obj[sec]) {
            obj[sec] = {}
            if (obj.__emitter__) convertKey(obj, sec)
        }
        obj = obj[sec]
    }
    if (utils.isObject(obj)) {
        sec = path[i]
        if (!(hasOwn.call(obj, sec))) {
            obj[sec] = undefined
            if (obj.__emitter__) convertKey(obj, sec)
        }
    }
}

function observe (obj, rawPath, observer) {
	if (!isWatchable(obj)) return;

	var path = rawPath ? rawPath + '.' : '',
		alreadyConverted = convert(obj),
		emitter = obj.__emitter__;

	// setup proxy listeners on the parent observer.
    // we need to keep reference to them so that they
    // can be removed when the object is un-observed.
	observer.proxies = observer.proxies || {};
	var proxies = observer.proxies[path] = {
		get: function(key){
			observer.emit('get', path + key);
		},
		set: function(key, val, propagate){
			if (key) observer.emit('set', path + key, val);
			// also notify observer that the object itself changed
            // but only do so when it's a immediate property. this
            // avoids duplicate event firing.
			if (rawPath && propagate) {
				observer.emit('set', rawPath, obj, true);
			}
		},
		mutate: function (key, val, mutation) {
			// if the Array is a root value
            // the key will be null
			var fixedPath = key ? path + key : rawPath;
			observer.emit('mutate', fixedPath, val, mutation);
			var m = mutaion.method;
			if (m !== 'sort' && m !== 'reverse') {
				observer.emit('set', fixedPath + '.length', val.length);
			}
		}
	};

	// attach the listeners to the child observer.
    // now all the events will propagate upwards.
    emitter
        .on('get', proxies.get)
        .on('set', proxies.set)
        .on('mutate', proxies.mutate);


    if (alreadyConverted) {
        // for objects that have already been converted,
        // emit set events for everything inside
        emitSet(obj)
    } else {
        watch(obj)
    }
}

/**
 *  Cancel observation, turn off the listeners.
 */
function unobserve (obj, path, observer) {

    if (!obj || !obj.__emitter__) return

    path = path ? path + '.' : ''
    var proxies = observer.proxies[path]
    if (!proxies) return

    // turn off listeners
    obj.__emitter__
        .off('get', proxies.get)
        .off('set', proxies.set)
        .off('mutate', proxies.mutate)

    // remove reference
    observer.proxies[path] = null
}

module.exports = {
    observe     : observe,
    unobserve   : unobserve,
    ensurePath  : ensurePath,
    copyPaths   : copyPaths,
    watch       : watch,
    convert     : convert,
    convertKey  : convertKey
}