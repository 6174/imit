/**
 * EventTarget module
 * @author: xuejia.cxj/6174
 */
var utils = require('./utils');
function EventTarget(ctx){
    this._ctx = ctx || this;  
}

utils.mix(EventTarget.prototype, {
    on: function(type, callback) {
        var context = this._ctx || this;
        context._callback = context._callback || {};
        context._callback[type] = context._callback[type] || [];
        context._callback[type].push(callback);
        return this;
    },
    once: function(event, fn){
        var context = this._ctx || this;
        context._callback = context._callback || {};
        function on(){
            context.detach(event, on);
            fn.apply(context, arguments);
        }
        on.fn = fn;
        context.on(event, on);
        return this;
    },
    detach: function(type, callback) {
        var context = this._ctx || this;
        context._callback = context._callback || {};
        if (!type) {
            context._callback = {};
        } else if (!callback) {
            context._callback[type] = [];
        } else if (context._callback[type] && context._callback[type].length > 0) {
            var index = utils.indexOf(callback, context._callback[type]);
            if (index != -1) context._callback[type].splice(index, 1);
        }
        return this;
    },
    fire: function(type, data) {
        var context = this._ctx || this;
        if (context._callback) {
            var arr = context._callback[type];
            if (arr && arr.length > 0) {
                data = data || {};
                data.type = type;
                data.target = context;
                for (var i = arr.length - 1; i >= 0; i--) {
                    utils.isFunction(arr[i]) && arr[i].call(context, data);
                }
            }
        }
        return this;
    }
});

utils.mix(EventTarget.prototype, {
    emit: EventTarget.prototype.fire,
    off: EventTarget.prototype.detach
});

module.exports = EventTarget;