/**
 * EventTarget module
 * @author: xuejia.cxj/6174
 */
var utils = require('./utils');
var EventTarget = {
    on: function(type, callback) {
        this._callback = this._callback || {};
        this._callback[type] = this._callback[type] || [];
        this._callback[type].push(callback);
        return this;
    },
    once: function(event, fn){
        var self = this;
        this._callback = this._callback || {};
        function on(){
            self.detach(event, on);
            fn.apply(this, arguments);
        }
        on.fn = fn;
        this.on(event, on);
        return this;
    },
    detach: function(type, callback) {
        this._callback = this._callback || {};
        if (!type) {
            this._callback = {};
        } else if (!callback) {
            this._callback[type] = [];
        } else if (this._callback[type] && this._callback[type].length > 0) {
            var index = utils.indexOf(callback, this._callback[type]);
            if (index != -1) this._callback[type].splice(index, 1);
        }
        return this;
    },
    fire: function(type, data) {
        if (this._callback) {
            var arr = this._callback[type];
            if (arr && arr.length > 0) {
                data = data || {};
                data.type = type;
                data.target = this;
                for (var i = arr.length - 1; i >= 0; i--) {
                    utils.isFunction(arr[i]) && arr[i].call(this, data);
                }
            }
        }
        return this;
    }
};

EventTarget.emit = EventTarget.fire;
EventTarget.off = EventTarget.detach;
module.exports = EventTarget;