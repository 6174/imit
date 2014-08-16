(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
module.exports = {
	name: 'e-----:',
	prefix: 'j'
}
},{}],2:[function(require,module,exports){
var config      = require('./config'),
    ViewModel   = require('./viewmodel'),
    utils       = require('./utils');
model.exports = ViewModel;
},{"./config":1,"./utils":3,"./viewmodel":4}],3:[function(require,module,exports){
/**
 * utils
 *
 * @author: xuejia.cxj/6174
 */
var config = require('./config'),
    class2type = {},
    hasOwn = Object.prototype.hasOwnProperty,
    serialize = Object.prototype.toString,
    defer = win.requestAnimationFrame || win.webkitRequestAnimationFrame || win.setTimeout,
    isString = isType('String'),
    isFunction = isType('Function'),
    isUndefined = isType('Undefined'),
    isArray = Array.isArray || isType('Array'),
    rword = /[^, ]+/g,
    BRACKET_RE_S = /\['([^']+)'\]/g,
    BRACKET_RE_D = /\["([^"]+)"\]/g;

/**
 * getypeof A obj
 */
"Boolean Number String Function Array Date RegExp Object Error".replace(rword, function(name) {
    class2type["[object " + name + "]"] = name.toLowerCase()
});
function getType(obj) {
    if (obj == null) {
        return String(obj);
    }
    return typeof obj === "object" || typeof obj === "function" ? class2type[serialize.call(obj)] || "object" : typeof obj;
}
/**
 * is* Helper
 */
function isType(type) {
    return function(obj) {
        return {}.toString.call(obj) === '[object ' + type + ']';
    }
}
/**
 *  Normalize keypath with possible brackets into dot notations
 */
function normalizeKeypath(key) {
    return key.indexOf('[') < 0 ? key : key.replace(BRACKET_RE_S, '.$1').replace(BRACKET_RE_D, '.$1')
}
/**
 * equality judge
 */
function isEqual(v1, v2) {
    if (v1 === 0 && v2 === 0) {
        return 1 / v1 === 1 / v2
    } else if (v1 !== v1) {
        return v2 !== v2
    } else {
        return v1 === v2
    }
}
/**
 * random guid
 */
function guid(prefix) {
    prefix = prefix || '';
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}
/**
 * 简单地对象合并
 * @param  object r 源对象
 * @param  object s 目标对象
 * @param  bool   o 是否重写（默认为false）
 * @param  bool   d 是否递归（默认为false）
 * @return object
 */
function mix(r, s, o, d) {
    for (var k in s) {
        if (hasOwn.call(s, k)) {
            if (!(k in r)) {
                r[k] = s[k];
            } else if (o) {
                if (d && isObject(r[k]) && isObject(s[k])) {
                    mix(r[k], s[k], o, d);
                } else {
                    r[k] = s[k];
                }
            }
        }
    }
    return r;
}

function merge(args) {
    var ret = {},
        i, l;
    if (!isArray(args)) {
        args = [].slice.call(arguments);
    }
    for (i = 0, l = args.length; i < l; i++) {
        mix(ret, args[i], true);
    }
    return ret;
}
/**
 * 类似于forEach
 * @param  [] | {}  obj 对象或者数组
 * @param  Function fn  迭代函数
 * @return undefined
 */
function each(obj, fn) {
    var i, l, ks;
    if (isArray(obj)) {
        for (i = 0, l = obj.length; i < l; i++) {
            if (fn(obj[i], i, obj) === false) {
                break;
            }
        }
    } else {
        ks = keys(obj);
        for (i = 0, l = ks.length; i < l; i++) {
            if (fn(obj[ks[i]], ks[i], obj) === false) {
                break;
            }
        }
    }
}

function log(msg) {
    if (config.debug && console) {
        console.log(msg)
    }
}

function warn(msg) {
    if (!config.silent && console) {
        console.warn(msg);
        if (config.debug && console.trace) {
            console.trace();
        }
    }
}
var object = {
    baseKey: function(namespace) {
        return key.indexOf('.') > 0 ? key.split('.')[0] : key;
    },
    hash: function() {
        return Object.create(null)
    },
    bind: function(fn, ctx) {
        return function(arg) {
            return fn.call(ctx, arg)
        }
    },
    has: function(obj, key) {
        return hasOwn.call(obj, key);
    },
    get: function(obj, key) {
        key = normalizeKeypath(key)
        if (key.indexOf('.') < 0) {
            return obj[key]
        }
        var path = key.split('.'),
            d = -1,
            l = path.length
        while (++d < l && obj != null) {
            obj = obj[path[d]]
        }
        return obj
    },
    set: function(obj, key, val) {
        key = normalizeKeypath(key)
        if (key.indexOf('.') < 0) {
            obj[key] = val
            return
        }
        var path = key.split('.'),
            d = -1,
            l = path.length - 1
        while (++d < l) {
            if (obj[path[d]] == null) {
                obj[path[d]] = {}
            }
            obj = obj[path[d]]
        }
        obj[path[d]] = val
    },
    /**
     * 继承
     * @param {Object} protoProps 需要继承的原型
     * @param {Object} staticProps 静态的类方法
     */
    extend: function(protoProps, staticProps) {
        var parent = this;
        var child;
        if (protoProps && has(protoProps, 'constructor')) {
            child = protoProps.constructor;
        } else {
            child = function() {
                return parent.apply(this, arguments);
            }
        }
        mix(child, parent);
        mix(child, staticProps);
        var Surrogate = function() {
            this.constructor = child;
        };
        Surrogate.prototype = parent.prototype;
        child.prototype = new Surrogate;
        if (protoProps) {
            mix(child.prototype, protoProps);
        }
        child.__super__ = parent.prototype;
        return child;
    }
};
var array = {
    indexOf: function(element, arr) {
        if (!isArray(arr)) {
            return -1;
        }
        return arr.indexOf(element);
    }
}
var dom = {
    /**
     *  get an attribute and remove it.
     */
    attr: function(el, type) {
        var attr = config.prefix + '-' + type,
            val = el.getAttribute(attr)
        if (val !== null) {
            el.removeAttribute(attr)
        }
        return val
    }
};
module.exports = {
    object: object,
    array: array,
    dom: dom,
    getType: getType,
    isArray: isArray,
    isObject: isObject,
    isString: isString,
    isEqual: isEqual,
    mix: mix,
    merge: merge,
    guid: guid,
    extend: extend,
    hasOwn: hasOwn,
    serialize: serialize,
    each: each,
    log: log,
    warn: warn
}
},{"./config":1}],4:[function(require,module,exports){
module.exports = {
	name: 'I am vm , so what?'
}
},{}]},{},[2])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9ub2RlX21vZHVsZXMvZ3VscC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2NvbmZpZy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZmFrZV8zNmQzM2FmNS5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvdXRpbHMuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL3ZpZXdtb2RlbC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMVBBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpfXZhciBmPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChmLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGYsZi5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJtb2R1bGUuZXhwb3J0cyA9IHtcblx0bmFtZTogJ2UtLS0tLTonLFxuXHRwcmVmaXg6ICdqJ1xufSIsInZhciBjb25maWcgICAgICA9IHJlcXVpcmUoJy4vY29uZmlnJyksXG4gICAgVmlld01vZGVsICAgPSByZXF1aXJlKCcuL3ZpZXdtb2RlbCcpLFxuICAgIHV0aWxzICAgICAgID0gcmVxdWlyZSgnLi91dGlscycpO1xubW9kZWwuZXhwb3J0cyA9IFZpZXdNb2RlbDsiLCIvKipcbiAqIHV0aWxzXG4gKlxuICogQGF1dGhvcjogeHVlamlhLmN4ai82MTc0XG4gKi9cbnZhciBjb25maWcgPSByZXF1aXJlKCcuL2NvbmZpZycpLFxuICAgIGNsYXNzMnR5cGUgPSB7fSxcbiAgICBoYXNPd24gPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LFxuICAgIHNlcmlhbGl6ZSA9IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcsXG4gICAgZGVmZXIgPSB3aW4ucmVxdWVzdEFuaW1hdGlvbkZyYW1lIHx8IHdpbi53ZWJraXRSZXF1ZXN0QW5pbWF0aW9uRnJhbWUgfHwgd2luLnNldFRpbWVvdXQsXG4gICAgaXNTdHJpbmcgPSBpc1R5cGUoJ1N0cmluZycpLFxuICAgIGlzRnVuY3Rpb24gPSBpc1R5cGUoJ0Z1bmN0aW9uJyksXG4gICAgaXNVbmRlZmluZWQgPSBpc1R5cGUoJ1VuZGVmaW5lZCcpLFxuICAgIGlzQXJyYXkgPSBBcnJheS5pc0FycmF5IHx8IGlzVHlwZSgnQXJyYXknKSxcbiAgICByd29yZCA9IC9bXiwgXSsvZyxcbiAgICBCUkFDS0VUX1JFX1MgPSAvXFxbJyhbXiddKyknXFxdL2csXG4gICAgQlJBQ0tFVF9SRV9EID0gL1xcW1wiKFteXCJdKylcIlxcXS9nO1xuXG4vKipcbiAqIGdldHlwZW9mIEEgb2JqXG4gKi9cblwiQm9vbGVhbiBOdW1iZXIgU3RyaW5nIEZ1bmN0aW9uIEFycmF5IERhdGUgUmVnRXhwIE9iamVjdCBFcnJvclwiLnJlcGxhY2UocndvcmQsIGZ1bmN0aW9uKG5hbWUpIHtcbiAgICBjbGFzczJ0eXBlW1wiW29iamVjdCBcIiArIG5hbWUgKyBcIl1cIl0gPSBuYW1lLnRvTG93ZXJDYXNlKClcbn0pO1xuZnVuY3Rpb24gZ2V0VHlwZShvYmopIHtcbiAgICBpZiAob2JqID09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIFN0cmluZyhvYmopO1xuICAgIH1cbiAgICByZXR1cm4gdHlwZW9mIG9iaiA9PT0gXCJvYmplY3RcIiB8fCB0eXBlb2Ygb2JqID09PSBcImZ1bmN0aW9uXCIgPyBjbGFzczJ0eXBlW3NlcmlhbGl6ZS5jYWxsKG9iaildIHx8IFwib2JqZWN0XCIgOiB0eXBlb2Ygb2JqO1xufVxuLyoqXG4gKiBpcyogSGVscGVyXG4gKi9cbmZ1bmN0aW9uIGlzVHlwZSh0eXBlKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKG9iaikge1xuICAgICAgICByZXR1cm4ge30udG9TdHJpbmcuY2FsbChvYmopID09PSAnW29iamVjdCAnICsgdHlwZSArICddJztcbiAgICB9XG59XG4vKipcbiAqICBOb3JtYWxpemUga2V5cGF0aCB3aXRoIHBvc3NpYmxlIGJyYWNrZXRzIGludG8gZG90IG5vdGF0aW9uc1xuICovXG5mdW5jdGlvbiBub3JtYWxpemVLZXlwYXRoKGtleSkge1xuICAgIHJldHVybiBrZXkuaW5kZXhPZignWycpIDwgMCA/IGtleSA6IGtleS5yZXBsYWNlKEJSQUNLRVRfUkVfUywgJy4kMScpLnJlcGxhY2UoQlJBQ0tFVF9SRV9ELCAnLiQxJylcbn1cbi8qKlxuICogZXF1YWxpdHkganVkZ2VcbiAqL1xuZnVuY3Rpb24gaXNFcXVhbCh2MSwgdjIpIHtcbiAgICBpZiAodjEgPT09IDAgJiYgdjIgPT09IDApIHtcbiAgICAgICAgcmV0dXJuIDEgLyB2MSA9PT0gMSAvIHYyXG4gICAgfSBlbHNlIGlmICh2MSAhPT0gdjEpIHtcbiAgICAgICAgcmV0dXJuIHYyICE9PSB2MlxuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiB2MSA9PT0gdjJcbiAgICB9XG59XG4vKipcbiAqIHJhbmRvbSBndWlkXG4gKi9cbmZ1bmN0aW9uIGd1aWQocHJlZml4KSB7XG4gICAgcHJlZml4ID0gcHJlZml4IHx8ICcnO1xuICAgIHJldHVybiBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoMiwgMTUpICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDIsIDE1KVxufVxuLyoqXG4gKiDnroDljZXlnLDlr7nosaHlkIjlubZcbiAqIEBwYXJhbSAgb2JqZWN0IHIg5rqQ5a+56LGhXG4gKiBAcGFyYW0gIG9iamVjdCBzIOebruagh+WvueixoVxuICogQHBhcmFtICBib29sICAgbyDmmK/lkKbph43lhpnvvIjpu5jorqTkuLpmYWxzZe+8iVxuICogQHBhcmFtICBib29sICAgZCDmmK/lkKbpgJLlvZLvvIjpu5jorqTkuLpmYWxzZe+8iVxuICogQHJldHVybiBvYmplY3RcbiAqL1xuZnVuY3Rpb24gbWl4KHIsIHMsIG8sIGQpIHtcbiAgICBmb3IgKHZhciBrIGluIHMpIHtcbiAgICAgICAgaWYgKGhhc093bi5jYWxsKHMsIGspKSB7XG4gICAgICAgICAgICBpZiAoIShrIGluIHIpKSB7XG4gICAgICAgICAgICAgICAgcltrXSA9IHNba107XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG8pIHtcbiAgICAgICAgICAgICAgICBpZiAoZCAmJiBpc09iamVjdChyW2tdKSAmJiBpc09iamVjdChzW2tdKSkge1xuICAgICAgICAgICAgICAgICAgICBtaXgocltrXSwgc1trXSwgbywgZCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcltrXSA9IHNba107XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiByO1xufVxuXG5mdW5jdGlvbiBtZXJnZShhcmdzKSB7XG4gICAgdmFyIHJldCA9IHt9LFxuICAgICAgICBpLCBsO1xuICAgIGlmICghaXNBcnJheShhcmdzKSkge1xuICAgICAgICBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuICAgIH1cbiAgICBmb3IgKGkgPSAwLCBsID0gYXJncy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgbWl4KHJldCwgYXJnc1tpXSwgdHJ1ZSk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG59XG4vKipcbiAqIOexu+S8vOS6jmZvckVhY2hcbiAqIEBwYXJhbSAgW10gfCB7fSAgb2JqIOWvueixoeaIluiAheaVsOe7hFxuICogQHBhcmFtICBGdW5jdGlvbiBmbiAg6L+t5Luj5Ye95pWwXG4gKiBAcmV0dXJuIHVuZGVmaW5lZFxuICovXG5mdW5jdGlvbiBlYWNoKG9iaiwgZm4pIHtcbiAgICB2YXIgaSwgbCwga3M7XG4gICAgaWYgKGlzQXJyYXkob2JqKSkge1xuICAgICAgICBmb3IgKGkgPSAwLCBsID0gb2JqLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgaWYgKGZuKG9ialtpXSwgaSwgb2JqKSA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGtzID0ga2V5cyhvYmopO1xuICAgICAgICBmb3IgKGkgPSAwLCBsID0ga3MubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBpZiAoZm4ob2JqW2tzW2ldXSwga3NbaV0sIG9iaikgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGxvZyhtc2cpIHtcbiAgICBpZiAoY29uZmlnLmRlYnVnICYmIGNvbnNvbGUpIHtcbiAgICAgICAgY29uc29sZS5sb2cobXNnKVxuICAgIH1cbn1cblxuZnVuY3Rpb24gd2Fybihtc2cpIHtcbiAgICBpZiAoIWNvbmZpZy5zaWxlbnQgJiYgY29uc29sZSkge1xuICAgICAgICBjb25zb2xlLndhcm4obXNnKTtcbiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZyAmJiBjb25zb2xlLnRyYWNlKSB7XG4gICAgICAgICAgICBjb25zb2xlLnRyYWNlKCk7XG4gICAgICAgIH1cbiAgICB9XG59XG52YXIgb2JqZWN0ID0ge1xuICAgIGJhc2VLZXk6IGZ1bmN0aW9uKG5hbWVzcGFjZSkge1xuICAgICAgICByZXR1cm4ga2V5LmluZGV4T2YoJy4nKSA+IDAgPyBrZXkuc3BsaXQoJy4nKVswXSA6IGtleTtcbiAgICB9LFxuICAgIGhhc2g6IGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gT2JqZWN0LmNyZWF0ZShudWxsKVxuICAgIH0sXG4gICAgYmluZDogZnVuY3Rpb24oZm4sIGN0eCkge1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24oYXJnKSB7XG4gICAgICAgICAgICByZXR1cm4gZm4uY2FsbChjdHgsIGFyZylcbiAgICAgICAgfVxuICAgIH0sXG4gICAgaGFzOiBmdW5jdGlvbihvYmosIGtleSkge1xuICAgICAgICByZXR1cm4gaGFzT3duLmNhbGwob2JqLCBrZXkpO1xuICAgIH0sXG4gICAgZ2V0OiBmdW5jdGlvbihvYmosIGtleSkge1xuICAgICAgICBrZXkgPSBub3JtYWxpemVLZXlwYXRoKGtleSlcbiAgICAgICAgaWYgKGtleS5pbmRleE9mKCcuJykgPCAwKSB7XG4gICAgICAgICAgICByZXR1cm4gb2JqW2tleV1cbiAgICAgICAgfVxuICAgICAgICB2YXIgcGF0aCA9IGtleS5zcGxpdCgnLicpLFxuICAgICAgICAgICAgZCA9IC0xLFxuICAgICAgICAgICAgbCA9IHBhdGgubGVuZ3RoXG4gICAgICAgIHdoaWxlICgrK2QgPCBsICYmIG9iaiAhPSBudWxsKSB7XG4gICAgICAgICAgICBvYmogPSBvYmpbcGF0aFtkXV1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gb2JqXG4gICAgfSxcbiAgICBzZXQ6IGZ1bmN0aW9uKG9iaiwga2V5LCB2YWwpIHtcbiAgICAgICAga2V5ID0gbm9ybWFsaXplS2V5cGF0aChrZXkpXG4gICAgICAgIGlmIChrZXkuaW5kZXhPZignLicpIDwgMCkge1xuICAgICAgICAgICAgb2JqW2tleV0gPSB2YWxcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG4gICAgICAgIHZhciBwYXRoID0ga2V5LnNwbGl0KCcuJyksXG4gICAgICAgICAgICBkID0gLTEsXG4gICAgICAgICAgICBsID0gcGF0aC5sZW5ndGggLSAxXG4gICAgICAgIHdoaWxlICgrK2QgPCBsKSB7XG4gICAgICAgICAgICBpZiAob2JqW3BhdGhbZF1dID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICBvYmpbcGF0aFtkXV0gPSB7fVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb2JqID0gb2JqW3BhdGhbZF1dXG4gICAgICAgIH1cbiAgICAgICAgb2JqW3BhdGhbZF1dID0gdmFsXG4gICAgfSxcbiAgICAvKipcbiAgICAgKiDnu6fmib9cbiAgICAgKiBAcGFyYW0ge09iamVjdH0gcHJvdG9Qcm9wcyDpnIDopoHnu6fmib/nmoTljp/lnotcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gc3RhdGljUHJvcHMg6Z2Z5oCB55qE57G75pa55rOVXG4gICAgICovXG4gICAgZXh0ZW5kOiBmdW5jdGlvbihwcm90b1Byb3BzLCBzdGF0aWNQcm9wcykge1xuICAgICAgICB2YXIgcGFyZW50ID0gdGhpcztcbiAgICAgICAgdmFyIGNoaWxkO1xuICAgICAgICBpZiAocHJvdG9Qcm9wcyAmJiBoYXMocHJvdG9Qcm9wcywgJ2NvbnN0cnVjdG9yJykpIHtcbiAgICAgICAgICAgIGNoaWxkID0gcHJvdG9Qcm9wcy5jb25zdHJ1Y3RvcjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNoaWxkID0gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBhcmVudC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIG1peChjaGlsZCwgcGFyZW50KTtcbiAgICAgICAgbWl4KGNoaWxkLCBzdGF0aWNQcm9wcyk7XG4gICAgICAgIHZhciBTdXJyb2dhdGUgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHRoaXMuY29uc3RydWN0b3IgPSBjaGlsZDtcbiAgICAgICAgfTtcbiAgICAgICAgU3Vycm9nYXRlLnByb3RvdHlwZSA9IHBhcmVudC5wcm90b3R5cGU7XG4gICAgICAgIGNoaWxkLnByb3RvdHlwZSA9IG5ldyBTdXJyb2dhdGU7XG4gICAgICAgIGlmIChwcm90b1Byb3BzKSB7XG4gICAgICAgICAgICBtaXgoY2hpbGQucHJvdG90eXBlLCBwcm90b1Byb3BzKTtcbiAgICAgICAgfVxuICAgICAgICBjaGlsZC5fX3N1cGVyX18gPSBwYXJlbnQucHJvdG90eXBlO1xuICAgICAgICByZXR1cm4gY2hpbGQ7XG4gICAgfVxufTtcbnZhciBhcnJheSA9IHtcbiAgICBpbmRleE9mOiBmdW5jdGlvbihlbGVtZW50LCBhcnIpIHtcbiAgICAgICAgaWYgKCFpc0FycmF5KGFycikpIHtcbiAgICAgICAgICAgIHJldHVybiAtMTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYXJyLmluZGV4T2YoZWxlbWVudCk7XG4gICAgfVxufVxudmFyIGRvbSA9IHtcbiAgICAvKipcbiAgICAgKiAgZ2V0IGFuIGF0dHJpYnV0ZSBhbmQgcmVtb3ZlIGl0LlxuICAgICAqL1xuICAgIGF0dHI6IGZ1bmN0aW9uKGVsLCB0eXBlKSB7XG4gICAgICAgIHZhciBhdHRyID0gY29uZmlnLnByZWZpeCArICctJyArIHR5cGUsXG4gICAgICAgICAgICB2YWwgPSBlbC5nZXRBdHRyaWJ1dGUoYXR0cilcbiAgICAgICAgaWYgKHZhbCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgZWwucmVtb3ZlQXR0cmlidXRlKGF0dHIpXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbFxuICAgIH1cbn07XG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBvYmplY3Q6IG9iamVjdCxcbiAgICBhcnJheTogYXJyYXksXG4gICAgZG9tOiBkb20sXG4gICAgZ2V0VHlwZTogZ2V0VHlwZSxcbiAgICBpc0FycmF5OiBpc0FycmF5LFxuICAgIGlzT2JqZWN0OiBpc09iamVjdCxcbiAgICBpc1N0cmluZzogaXNTdHJpbmcsXG4gICAgaXNFcXVhbDogaXNFcXVhbCxcbiAgICBtaXg6IG1peCxcbiAgICBtZXJnZTogbWVyZ2UsXG4gICAgZ3VpZDogZ3VpZCxcbiAgICBleHRlbmQ6IGV4dGVuZCxcbiAgICBoYXNPd246IGhhc093bixcbiAgICBzZXJpYWxpemU6IHNlcmlhbGl6ZSxcbiAgICBlYWNoOiBlYWNoLFxuICAgIGxvZzogbG9nLFxuICAgIHdhcm46IHdhcm5cbn0iLCJtb2R1bGUuZXhwb3J0cyA9IHtcblx0bmFtZTogJ0kgYW0gdm0gLCBzbyB3aGF0Pydcbn0iXX0=
