var utils    = require('./utils'),
	Batcher  = require('./batcher'),
	Compiler = require('./compiler'),
	watcherBatcher = new Batcher();
/**
 * ViewModel
 * @param {String} options.el: id
 */
function VM(options){
	if(!options){return;}
	this.$init(options);
}

utils.mix(VM.prototype, {
	'$init': function init(options){
		new Compiler(this, options);
	},
	'$get': function get(key){
		var val = utils.object.get(this, key);
		return val === undefined && this.$parent
		        ? this.$parent.$get(key)
		        : val;
	},
	'$set': function set(key, value){
		utils.set(this, key, value);
	},
	'$watch': function watch(key, callback) {
		var id = utils.guid('watcherid-'), 
			self = this;
		function eventResolver(){
			var args = [].slice.call(arguments);
			watcherBatcher.push({
				id: id,
				override: true,
				execute: function(){
					callback.apply(self, args);
				}
			});
		}
		callback._fn = eventResolver;
		this.$compiler.observer.on('change:' + key, eventResolver);
	},
	'$unwatch': function unwatch(key, callback) {
		var args = ['change:' + key];
		this.$compiler.observer.detach(key, callback._fn);
	},
	'$broadcast': function broadcast(){
		var children = this.$compiler.children;
		for(var len = children.length - 1; len--;){
			child = children[len];
			child.emitter.emit.apply(child.emitter, arguments);
			child.vm.$broadcast.apply(child.vm, arguments);
		}
	},
	'$dispatch': function dispatch(){
		var compiler = this.$compiler,
			emitter  = compiler.emitter,
			parent   = compiler.parent;
		emitter.emit.apply(emitter, arguments);
		if(parent){
			parent.vm.$dispatch.apply(parent.vm, arguments);
		}
	},
	'$appendTo': function appendTo(target, cb){
		target = utils.dom.query(target);
		var el = this.$el;
		target.appendChild(el)
        cb && util.nextTick(cb);
	},
	'$remove': function remove(target, cb){
		target = util.dom.query(target);
		var el = this.$el;
		if(el.parentNode){
			el.parentNode.removeChild(el);
		}
		cb && util.nextTick(cb);
	},
	'$before': function before(target, cb){
		target = util.dom.query(target);
		target.parentNode.insertBefore(el, target);
		cb && util.nextTick(cb);
	},
	'$after': function after(target, cb){
		target = util.dom.query(target);
		var el = this.$el;
		if(target.nextSibling) {
			target.parentNode.insertBefore(el, target.nextSibling);
		}else{
			target.parentNode.appendChild(el);
		}
		cb && util.nextTick(cb);
	}
});
/**
 *  delegate on/off/once to the compiler's emitter
 */
utils.each(['emit', 'on', 'off', 'once', 'detach', 'fire'], function (method) {
	VM.prototype['$' + method] = function () {
        var emitter = this.$compiler.emitter;
        emitter[method].apply(emitter, arguments);
    }
});
VM.extend = utils.object.extend;
module.exports = VM;
