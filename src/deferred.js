var utils = require('./utils');
/**
 * Deferred 类
 */
function Deferred() {
    var DONE = 'done',
        FAIL = 'fail',
        PENDING = 'pending';
    var state = PENDING;
    var callbacks = {
        'done': [],
        'fail': [],
        'always': []
    };
    var args = [];
    var context;

    function dispatch(cbs) {
        var cb;
        while ((cb = cbs.shift()) || (cb = callbacks.always.shift())) {
            setTimeout((function(fn) {
                return function() {
                    fn.apply(context, args);
                };
            })(cb), 0);
        }
    }
    return {
        done: function(cb) {
            if (state === DONE) {
                setTimeout(function() {
                    cb.apply(context, args);
                }, 0);
            }
            if (state === PENDING) {
                callbacks.done.push(cb);
            }
            return this;
        },
        fail: function(cb) {
            if (state === FAIL) {
                setTimeout(function() {
                    cb.apply(context, args);
                }, 0);
            }
            if (state === PENDING) {
                callbacks.fail.push(cb);
            }
            return this;
        },
        always: function(cb) {
            if (state !== PENDING) {
                setTimeout(function() {
                    cb.apply(context, args);
                }, 0);
                return;
            }
            callbacks.always.push(cb);
            return this;
        },
        then: function(doneFn, failFn) {
            if (utils.isFunction(doneFn)) {
                this.done(doneFn);
            }
            if (utils.isFunction(failFn)) {
                this.fail(failFn);
            }
            return this;
        },
        resolve: function() {
            this.resolveWith({}, arguments);
            return this;
        },
        resolveWith: function(c, a) {
            if (state !== PENDING) {
                return this;
            }
            state = DONE;
            context = c || this;
            args = [].slice.call(a || []);
            dispatch(callbacks.done);
            return this;
        },
        reject: function() {
            this.rejectWith({}, arguments);
            return this;
        },
        rejectWith: function(c, a) {
            if (state !== PENDING) {
                return this;
            }
            state = FAIL;
            context = c || this;
            args = [].slice.call(a || []);
            dispatch(callbacks.fail);
            return this;
        },
        state: function() {
            return state;
        },
        promise: function() {
            var ret = {},
                self = this,
                keys = utils.keys(this);
            utils.each(keys, function(k) {
                if (k === 'resolve' || k === 'reject') {
                    return;
                }
                ret[k] = self[k];
            });
            return ret;
        }
    };
    return this;
};
/**
 * 多个deferred的异步
 * @param  [] defers
 * @return object promise对象
 */
function when(defers) {
    var ret, len, count = 0;
    if (!utils.isArray(defers)) {
        defers = [].slice.call(arguments);
    }
    ret = Deferred();
    len = defers.length;
    if (!len) {
        return ret.resolve().promise();
    }
    utils.each(defers, function(defer) {
        defer.fail(function() {
            ret.reject();
        }).done(function() {
            if (++count === len) {
                ret.resolve();
            }
        });
    });
    return ret.promise();
};

module.exports = {
    when: when,
    Deferred: Deferred
}