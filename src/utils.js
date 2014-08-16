/**
 * utils
 * 
 * @author: xuejia.cxj/6174
 */
var class2type = {},
    rword = /[^, ]+/g,
    hasOwn = Object.prototype.hasOwnProperty;
    serialize = Object.prototype.toString;

"Boolean Number String Function Array Date RegExp Object Error".replace(rword, function(name) {
    class2type["[object " + name + "]"] = name.toLowerCase()
});

/**
 * getypeof A obj
 */
function getType (obj) {
    if (obj == null) {
        return String(obj);
    }
    return typeof obj === "object" || typeof obj === "function" ?
            class2type[serialize.call(obj)] || "object" :
            typeof obj;
}
/**
 * is* Helper
 */
function isType(type) {
    return function(obj) {
        return {}.toString.call(obj) === '[object ' + type + ']';
    }
}
var isString = isType('String');
var isFunction = isType('Function');
var isUndefined = isType('Undefined');
var isArray = Array.isArray || isType('Array');

/**
 * equality judge
 */
function isEqual(v1, v2){
    if (v1 === 0 && v2 === 0) {
        return 1 / v1 === 1 / v2
    } else if (v1 !== v1) {
        return v2 !== v2
    } else {
        return v1 === v2
    }
}

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
        if (hasOwn(s, k)) {
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
    if (!R.isArray(args)) {
        args = [].slice.call(arguments);
    }
    for (i = 0, l = args.length; i < l; i++) {
        R.mix(ret, args[i], true);
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
 
/**
 * 判断对象是否有相应的方法
 * @param {Object} obj
 * @param {String} key
 */
function has(obj, key) {
    return hasOwn.call(obj, key);
}
/**
 * 判断元素在数组中的位置
 * @param {Any} element
 * @param {Array} arr
 * @return {Number} index
 */
function indexOf(element, arr) {
    if (!isArray(arr)) {
        return -1;
    }
    return arr.indexOf(element);
}
/**
 * 继承
 * @param {Object} protoProps 需要继承的原型
 * @param {Object} staticProps 静态的类方法
 */
function extend(protoProps, staticProps) {
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

module.exports = {
    getType: getType,
    isArray: isArray,
    isObject: isObject,
    isString: isString,
    isEqual: isEqual,
    mix: mix,
    merge: merge,
    guid: guid,
    indexOf: indexOf,
    extend: extend,
    hasOwn: hasOwn,
    serialize: serialize,
    each: each,
    hasOwn: hasOwn,
    has: has
}


