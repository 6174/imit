(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
var EventTarget  = require('./eventTarget'),
    utils    = require('./utils'),
    Observer = require('./observer'),
    catcher  = new EventTarget();

/**
 *  Auto-extract the dependencies of a computed property
 *  by recording the getters triggered when evaluating it.
 */
function catchDeps (binding) {
    if (binding.isFn) return
    utils.log('\n- ' + binding.key)
    var got = utils.hash()
    binding.deps = []
    catcher.on('get', function (dep) {
        var has = got[dep.key]
        if (
            // avoid duplicate bindings
            (has && has.compiler === dep.compiler) ||
            // avoid repeated items as dependency
            // only when the binding is from self or the parent chain
            (dep.compiler.repeat && !isParentOf(dep.compiler, binding.compiler))
        ) {
            return
        }
        got[dep.key] = dep
        utils.log('  - ' + dep.key)
        binding.deps.push(dep)
        dep.subs.push(binding)
    })
    binding.value.$get()
    catcher.off('get')
}

/**
 *  Test if A is a parent of or equals B
 */
function isParentOf (a, b) {
    while (b) {
        if (a === b) {
            return true
        }
        b = b.parent
    }
}

module.exports = {

    /**
     *  the observer that catches events triggered by getters
     */
    catcher: catcher,

    /**
     *  parse a list of computed property bindings
     */
    parse: function (bindings) {
        utils.log('\nparsing dependencies...')
        Observer.shouldGet = true
        bindings.forEach(catchDeps)
        Observer.shouldGet = false
        utils.log('\ndone.')
    }
    
}
},{"./eventTarget":19,"./observer":23,"./utils":26}],2:[function(require,module,exports){
var utils           = require('./utils'),
    STR_SAVE_RE     = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    STR_RESTORE_RE  = /"(\d+)"/g,
    NEWLINE_RE      = /\n/g,
    CTOR_RE         = new RegExp('constructor'.split('').join('[\'"+, ]*')),
    UNICODE_RE      = /\\u\d\d\d\d/

// Variable extraction scooped from https://github.com/RubyLouvre/avalon

var KEYWORDS =
        // keywords
        'break,case,catch,continue,debugger,default,delete,do,else,false' +
        ',finally,for,function,if,in,instanceof,new,null,return,switch,this' +
        ',throw,true,try,typeof,var,void,while,with,undefined' +
        // reserved
        ',abstract,boolean,byte,char,class,const,double,enum,export,extends' +
        ',final,float,goto,implements,import,int,interface,long,native' +
        ',package,private,protected,public,short,static,super,synchronized' +
        ',throws,transient,volatile' +
        // ECMA 5 - use strict
        ',arguments,let,yield' +
        // allow using Math in expressions
        ',Math',
        
    KEYWORDS_RE = new RegExp(["\\b" + KEYWORDS.replace(/,/g, '\\b|\\b') + "\\b"].join('|'), 'g'),
    REMOVE_RE   = /\/\*(?:.|\n)*?\*\/|\/\/[^\n]*\n|\/\/[^\n]*$|'[^']*'|"[^"]*"|[\s\t\n]*\.[\s\t\n]*[$\w\.]+|[\{,]\s*[\w\$_]+\s*:/g,
    SPLIT_RE    = /[^\w$]+/g,
    NUMBER_RE   = /\b\d[^,]*/g,
    BOUNDARY_RE = /^,+|,+$/g

/**
 *  Strip top level variable names from a snippet of JS expression
 */
function getVariables (code) {
    code = code
        .replace(REMOVE_RE, '')
        .replace(SPLIT_RE, ',')
        .replace(KEYWORDS_RE, '')
        .replace(NUMBER_RE, '')
        .replace(BOUNDARY_RE, '')
    return code
        ? code.split(/,+/)
        : []
}

/**
 *  A given path could potentially exist not on the
 *  current compiler, but up in the parent chain somewhere.
 *  This function generates an access relationship string
 *  that can be used in the getter function by walking up
 *  the parent chain to check for key existence.
 *
 *  It stops at top parent if no vm in the chain has the
 *  key. It then creates any missing bindings on the
 *  final resolved vm.
 */
function traceScope (path, compiler, data) {
    var rel  = '',
        dist = 0,
        self = compiler

    if (data && utils.object.get(data, path) !== undefined) {
        // hack: temporarily attached data
        return '$temp.'
    }

    while (compiler) {
        if (compiler.hasKey(path)) {
            break
        } else {
            compiler = compiler.parent
            dist++
        }
    }
    if (compiler) {
        while (dist--) {
            rel += '$parent.'
        }
        if (!compiler.bindings[path] && path.charAt(0) !== '$') {
            compiler.createBinding(path)
        }
    } else {
        self.createBinding(path)
    }
    return rel
}

/**
 *  Create a function from a string...
 *  this looks like evil magic but since all variables are limited
 *  to the VM's data it's actually properly sandboxed
 */
function makeGetter (exp, raw) {
    var fn
    try {
        fn = new Function(exp)
    } catch (e) {
        utils.warn('Error parsing expression: ' + raw)
    }
    return fn
}

/**
 *  Escape a leading dollar sign for regex construction
 */
function escapeDollar (v) {
    return v.charAt(0) === '$'
        ? '\\' + v
        : v
}

/**
 *  Parse and return an anonymous computed property getter function
 *  from an arbitrary expression, together with a list of paths to be
 *  created as bindings.
 */
exports.parse = function (exp, compiler, data) {
    // unicode and 'constructor' are not allowed for XSS security.
    if (UNICODE_RE.test(exp) || CTOR_RE.test(exp)) {
        utils.warn('Unsafe expression: ' + exp)
        return
    }
    // extract variable names
    var vars = getVariables(exp)
    if (!vars.length) {
        return makeGetter('return ' + exp, exp)
    }
    vars = utils.array.unique(vars);

    var accessors = '',
        has       = utils.hash(),
        strings   = [],
        // construct a regex to extract all valid variable paths
        // ones that begin with "$" are particularly tricky
        // because we can't use \b for them
        pathRE = new RegExp(
            "[^$\\w\\.](" +
            vars.map(escapeDollar).join('|') +
            ")[$\\w\\.]*\\b", 'g'
        ),
        body = (' ' + exp)
            .replace(STR_SAVE_RE, saveStrings)
            .replace(pathRE, replacePath)
            .replace(STR_RESTORE_RE, restoreStrings)

    body = accessors + 'return ' + body

    function saveStrings (str) {
        var i = strings.length
        // escape newlines in strings so the expression
        // can be correctly evaluated
        strings[i] = str.replace(NEWLINE_RE, '\\n')
        return '"' + i + '"'
    }

    function replacePath (path) {
        // keep track of the first char
        var c = path.charAt(0)
        path = path.slice(1)
        var val = 'this.' + traceScope(path, compiler, data) + path
        if (!has[path]) {
            accessors += val + ';'
            has[path] = 1
        }
        // don't forget to put that first char back
        return c + val
    }

    function restoreStrings (str, i) {
        return strings[i]
    }

    return makeGetter(body, exp)
}

/**
 *  Evaluate an expression in the context of a compiler.
 *  Accepts additional data.
 */
exports.eval = function (exp, compiler, data) {
    var getter = exports.parse(exp, compiler, data), res
    if (getter) {
        // hack: temporarily attach the additional data so
        // it can be accessed in the getter
        compiler.vm.$temp = data
        res = getter.call(compiler.vm)
        delete compiler.vm.$temp
    }
    return res
}
},{"./utils":26}],3:[function(require,module,exports){
var utils = require('./utils')

function Batcher () {
    this.reset();
}

var BatcherProto = Batcher.prototype

BatcherProto.push = function (job) {
    if (!job.id || !this.has[job.id]) {
        this.queue.push(job)
        this.has[job.id] = job
        if (!this.waiting) {
            this.waiting = true
            utils.nextTick(utils.object.bind(this.flush, this))
        }
    } else if (job.override) {
        var oldJob = this.has[job.id]
        oldJob.cancelled = true
        this.queue.push(job)
        this.has[job.id] = job
    }
}

BatcherProto.flush = function () {
    // before flush hook
    if (this._preFlush) this._preFlush()
    // do not cache length because more jobs might be pushed
    // as we execute existing jobs
    for (var i = 0; i < this.queue.length; i++) {
        var job = this.queue[i]
        if (!job.cancelled) {
            job.execute()
        }
    }
    this.reset()
}

BatcherProto.reset = function () {
    this.has = utils.object.hash()
    this.queue = []
    this.waiting = false
}

module.exports = Batcher
},{"./utils":26}],4:[function(require,module,exports){
var Batcher        = require('./batcher'),
    bindingBatcher = new Batcher(),
    bindingId      = 1

/**
 *  BINDING CLASS.
 *
 *  EACH PROPERTY ON THE VIEWMODEL HAS ONE CORRESPONDING BINDING OBJECT
 *  WHICH HAS MULTIPLE DIRECTIVE INSTANCES ON THE DOM
 *  AND MULTIPLE COMPUTED PROPERTY DEPENDENTS
 */
function Binding (compiler, key, isExp, isFn) {
    this.id = bindingId++
    this.value = undefined
    this.isExp = !!isExp
    this.isFn = isFn
    this.root = !this.isExp && key.indexOf('.') === -1
    this.compiler = compiler
    this.key = key
    this.dirs = []
    this.subs = []
    this.deps = []
    this.unbound = false
}

var BindingProto = Binding.prototype

/**
 *  UPDATE VALUE AND QUEUE INSTANCE UPDATES.
 */
BindingProto.update = function (value) {
    if (!this.isComputed || this.isFn) {
        this.value = value
    }
    if (this.dirs.length || this.subs.length) {
        var self = this
        bindingBatcher.push({
            id: this.id,
            execute: function () {
                self._update();
            }
        })
    }
}

/**
 *  ACTUALLY UPDATE THE DIRECTIVES.
 */
BindingProto._update = function () {
    var i = this.dirs.length,
        value = this.val()
    while (i--) {
        this.dirs[i].$update(value)
    }
    this.pub()
}

/**
 *  RETURN THE VALUATED VALUE REGARDLESS
 *  OF WHETHER IT IS COMPUTED OR NOT
 */
BindingProto.val = function () {
    return this.isComputed && !this.isFn
        ? this.value.$get()
        : this.value;
}

/**
 *  Notify computed properties that depend on this binding
 *  to update themselves
 */
BindingProto.pub = function () {
    var i = this.subs.length
    while (i--) {
        this.subs[i].update();
    }
}

/**
 *  Unbind the binding, remove itself from all of its dependencies
 */
BindingProto.unbind = function () {
    // Indicate this has been unbound.
    // It's possible this binding will be in
    // the batcher's flush queue when its owner
    // compiler has already been destroyed.
    this.unbound = true
    var i = this.dirs.length
    while (i--) {
        this.dirs[i].$unbind()
    }
    i = this.deps.length
    var subs
    while (i--) {
        subs = this.deps[i].subs
        var j = subs.indexOf(this)
        if (j > -1) subs.splice(j, 1)
    }
}

module.exports = Binding
},{"./batcher":3}],5:[function(require,module,exports){

var EventTarget = require('./eventTarget'),
	utils       = require('./utils'),
	config      = require('./config'),
	Binding     = require('./binding'),
	Parser      = require('./parser'),
	Observer    = require('./observer'),
	Directive   = require('./directive'),
	TextParser  = Parser.TextParser,
	ExpParser   = Parser.ExpParser,
	DepsParser  = Parser.DepsParser,
	ViewModel,
    
    // CACHE METHODS
    slice       = [].slice,
    hasOwn      = ({}).hasOwnProperty,
    def         = Object.defineProperty,

    // HOOKS TO REGISTER
    hooks       = ['created', 'ready', 'beforeDestroy', 'afterDestroy', 'attached', 'detached'],

    // LIST OF PRIORITY DIRECTIVES
    // THAT NEEDS TO BE CHECKED IN SPECIFIC ORDER
    priorityDirectives = ['if', 'repeat', 'view', 'component'];

/**
 *  THE DOM COMPILER
 *  SCANS A DOM NODE AND COMPILE BINDINGS FOR A VIEWMODEL
 */
function Compiler(vm, options){
	this._inited    = true;
	this._destroyed = false;
	utils.mix(this, options.compilerOptions);
	// REPEAT INDICATES THIS IS A V-REPEAT INSTANCE
	this.repeat = this.repeat || false;
    // EXPCACHE WILL BE SHARED BETWEEN V-REPEAT INSTANCES
	this.expCache = this.expCache || {};

	//--INTIALIZATION STUFF
	this.vm = vm;
	this.options = options || {};
	this._initOptions();
 	this._initElement();
	this._initVM();
	this._initData();
	this._startCompile();
}

/**
 * initialization and destroy
 */
utils.mix(Compiler.prototype, {
	_initOptions: function(){
		var options = this.options
		var components = options.components,
            partials   = options.partials,
            template   = options.template,
            filters    = options.filters,
            key;

        if (components) {
            for (key in components) {
                components[key] = ViewModel.extend(components[key]);
            }
        }

        if (partials) {
            for (key in partials) {
                partials[key] = Parser.parserTemplate(partials[key])
            }
        }

        var filter, THIS_RE = /[^\w]this[^\w]/;
        if (filters) {
            for (key in filters) {
            	filter = filters[key];
            	if (THIS_RE.test(filter.toString())) {
		            filter.computed = true;
		        }
            }
        }

        if (template) {
            options.template = Parser.parserTemplate(template)
        }
	},
	_initElement: function(){
		var options = this.options,
			vm      = this.vm,
	    	template = options.template, 
	    	el;

		initEl();
	    resolveTemplate();
	    resolveElementOption();

	    this.el = el; 
		this.el._vm = vm;
		utils.log('new VM instance: ' + el.tagName + '\n');
		
		// CREATE THE NODE FIRST
		function initEl(){
			el = typeof options.el === 'string'
	        ? document.querySelector(options.el)
	        : options.el || document.createElement(options.tagName || 'div');
		}

	    function resolveTemplate(){
	    	var child, replacer, i;
	    	// TEMPLATE IS A FRAGMENT DOCUMENT
		    if(template){
		    	// COLLECT ANYTHING ALREADY IN THERE
		        if (el.hasChildNodes()) {
		            this.rawContent = document.createElement('div')
		            while (child = el.firstChild) {
		                this.rawContent.appendChild(child)
		            }
		        }
		        // REPLACE OPTION: USE THE FIRST NODE IN
		        // THE TEMPLATE DIRECTLY TO REPLACE EL
		        if (options.replace && template.firstChild === template.lastChild) {
		            replacer = template.firstChild.cloneNode(true)
		            if (el.parentNode) {
		                el.parentNode.insertBefore(replacer, el)
		                el.parentNode.removeChild(el)
		            }
		            // COPY OVER ATTRIBUTES
		            if (el.hasAttributes()) {
		                i = el.attributes.length
		                while (i--) {
		                    attr = el.attributes[i]
		                    replacer.setAttribute(attr.name, attr.value)
		                }
		            }
		            // REPLACE
		            el = replacer
		        } else {
		            el.appendChild(template.cloneNode(true))
		        }
		    }
	    }

	    function resolveElementOption(){
	    	var attrs, attr;
			// APPLY ELEMENT OPTIONS
		    if (options.id) el.id = options.id
		    if (options.className) el.className = options.className
		    attrs = options.attributes
		    if (attrs) {
		        for (attr in attrs) {
		            el.setAttribute(attr, attrs[attr])
		        }
		    }
		}
	},
	_initVM: function(){
		var options  = this.options,
			compiler = this;
			vm       = this.vm;

		// COMPILER 
		utils.mix(this, {
			// vm ref
			vm: vm,
			// bindings for all
			bindings: utils.hash(),
			// directives
			dirs: [],
			// property in template but not defined in data
			deferred: [],
			// property need computation by subscribe other property
			computed: [],
			// composite pattern
			children: [],
			// event emitter
			emitter: new EventTarget()
		});

		// COMPILER.VM 
		utils.mix(vm, {
			'$': {},
			'$el': this.el,
			'$options': options,
			'$compiler': compiler,
			'$event': null
		});

		// PARENT VM
		var parentVM = options.parent;
		if (parentVM) {
			this.parent = parentVM.$compiler;
			parentVM.$compiler.children.push(this);
			vm.$parent = parentVM;
			// INHERIT LAZY OPTION
	        if (!('lazy' in options)) {
	            options.lazy = this.parent.options.lazy;
	        }
		}
		vm.$root = getRoot(this).vm;
		function getRoot (compiler) {
		    while (compiler.parent) {
		        compiler = compiler.parent;
		    }
		    return compiler;
		}
	},
	_initData: function(){
		var options  = this.options,
			compiler = this,
			vm       = this.vm;
		// SETUP OBSERVER
	    // THIS IS NECESARRY FOR ALL HOOKS AND DATA OBSERVATION EVENTS
		compiler.setupObserver();
		// CREATE BINDINGS FOR COMPUTED PROPERTIES
	    if (options.methods) {
	        for (key in options.methods) {
	            compiler.createBinding(key);
	        }
	    }

	    // CREATE BINDINGS FOR METHODS
	    if (options.computed) {
	        for (key in options.computed) {
	            compiler.createBinding(key)
	        }
	    }

	    // INITIALIZE DATA
	    var data = compiler.data = options.data || {},
	        defaultData = options.defaultData
	    if (defaultData) {
	        for (key in defaultData) {
	            if (!hasOwn.call(data, key)) {
	                data[key] = defaultData[key]
	            }
	        }
	    }

	    // COPY PARAMATTRIBUTES
	    // var params = options.paramAttributes
	    // if (params) {
	    //     i = params.length
	    //     while (i--) {
	    //         data[params[i]] = utils.checkNumber(
	    //             compiler.eval(
	    //                 el.getAttribute(params[i])
	    //             )
	    //         )
	    //     }
	    // }

	    utils.mix(vm, data);
	    vm.$data = data;

	    // beforeCompile hook
	    compiler.execHook('created');

	    // THE USER MIGHT HAVE SWAPPED THE DATA ...
	    data = compiler.data = vm.$data;
	    // USER MIGHT ALSO SET SOME PROPERTIES ON THE VM
	    // IN WHICH CASE WE SHOULD COPY BACK TO $DATA
	    var vmProp
	    for (key in vm) {
	        vmProp = vm[key]
	        if (
	            key.charAt(0) !== '$' &&
	            data[key] !== vmProp &&
	            typeof vmProp !== 'function'
	        ) {
	            data[key] = vmProp;
	        }
	    }

	    // NOW WE CAN OBSERVE THE DATA.
	    // THIS WILL CONVERT DATA PROPERTIES TO GETTER/SETTERS
	    // AND EMIT THE FIRST BATCH OF SET EVENTS, WHICH WILL
	    // IN TURN CREATE THE CORRESPONDING BINDINGS.
	    compiler.observeData(data)
	},
	_startCompile: function(){
		var options = this.options,
			compiler = this,
			el = this.el;
	    // before compiling, resolve content insertion points
	    if (options.template) {
	        this.resolveContent();
	    }

	    // now parse the DOM and bind directives.
	    // During this stage, we will also create bindings for
	    // encountered keypaths that don't have a binding yet.
	    compiler.compile(el, true)

	    // Any directive that creates child VMs are deferred
	    // so that when they are compiled, all bindings on the
	    // parent VM have been created.

	    var i = compiler.deferred.length;
	    while (i--) {
	        compiler.bindDirective(compiler.deferred[i])
	    }
	    compiler.deferred = null

	    // extract dependencies for computed properties.
	    // this will evaluated all collected computed bindings
	    // and collect get events that are emitted.
	    if (this.computed.length) {
	        DepsParser.parse(this.computed)
	    }

	    // done!
	    compiler.init = false

	    // post compile / ready hook
	    compiler.execHook('ready');
	},
	destroy: function (noRemove) {

	    // avoid being called more than once
	    // this is irreversible!
	    if (this.destroyed) return

	    var compiler = this,
	        i, j, key, dir, dirs, binding,
	        vm          = compiler.vm,
	        el          = compiler.el,
	        directives  = compiler.dirs,
	        computed    = compiler.computed,
	        bindings    = compiler.bindings,
	        children    = compiler.children,
	        parent      = compiler.parent

	    compiler.execHook('beforeDestroy')

	    // unobserve data
	    Observer.unobserve(compiler.data, '', compiler.observer)

	    // destroy all children
	    // do not remove their elements since the parent
	    // may have transitions and the children may not
	    i = children.length
	    while (i--) {
	        children[i].destroy(true)
	    }

	    // unbind all direcitves
	    i = directives.length
	    while (i--) {
	        dir = directives[i]
	        // if this directive is an instance of an external binding
	        // e.g. a directive that refers to a variable on the parent VM
	        // we need to remove it from that binding's directives
	        // * empty and literal bindings do not have binding.
	        if (dir.binding && dir.binding.compiler !== compiler) {
	            dirs = dir.binding.dirs
	            if (dirs) {
	                j = dirs.indexOf(dir)
	                if (j > -1) dirs.splice(j, 1)
	            }
	        }
	        dir.$unbind()
	    }

	    // unbind all computed, anonymous bindings
	    i = computed.length
	    while (i--) {
	        computed[i].unbind()
	    }

	    // unbind all keypath bindings
	    for (key in bindings) {
	        binding = bindings[key]
	        if (binding) {
	            binding.unbind()
	        }
	    }

	    // remove self from parent
	    if (parent) {
	        j = parent.children.indexOf(compiler)
	        if (j > -1) parent.children.splice(j, 1)
	    }

	    // finally remove dom element
	    if (!noRemove) {
	        if (el === document.body) {
	            el.innerHTML = ''
	        } else {
	            vm.$remove()
	        }
	    }
	    el.vue_vm = null

	    compiler.destroyed = true
	    // emit destroy hook
	    compiler.execHook('afterDestroy')

	    // finally, unregister all listeners
	    compiler.observer.off();
	    compiler.emitter.off();
	}
});
/**
 * observation
 */
utils.mix(Compiler.prototype, {
	setupObserver: function(){
		var compiler = this,
	        bindings = compiler.bindings,
	        options  = compiler.options,
	        observer = compiler.observer = new EventTarget(compiler.vm);

	    // A HASH TO HOLD EVENT PROXIES FOR EACH ROOT LEVEL KEY
	    // SO THEY CAN BE REFERENCED AND REMOVED LATER
	    observer.proxies = {};

	    // ADD OWN LISTENERS WHICH TRIGGER BINDING UPDATES
	    observer
	        .on('get', onGet)
	        .on('set', onSet)
	        .on('mutate', onSet);

	    // register hooks setup in options
	    utils.each(hooks, function(hook){
	    	var i, fns;
	        fns = options[hook];
	        if (utils.isArray(fns)) {
	            i = fns.length
	            // since hooks were merged with child at head,
	            // we loop reversely.
	            while (i--) {
	                registerHook(hook, fns[j])
	            }
	        } else if (fns) {
	            registerHook(hook, fns)
	        }
	    });

	    // broadcast attached/detached hooks
	    observer
	        .on('hook:attached', function () {
	            broadcast(1)
	        })
	        .on('hook:detached', function () {
	            broadcast(0)
	        })

	    function onGet (key) {
	        check(key)
	        DepsParser.catcher.emit('get', bindings[key])
	    }

	    function onSet (key, val, mutation) {
	        observer.emit('change:' + key, val, mutation)
	        check(key)
	        bindings[key].update(val)
	    }

	    function registerHook (hook, fn) {
	        observer.on('hook:' + hook, function () {
	            fn.call(compiler.vm)
	        });
	    }

	    function broadcast (event) {
	        var children = compiler.children
	        if (children) {
	            var child, i = children.length
	            while (i--) {
	                child = children[i]
	                if (child.el.parentNode) {
	                    event = 'hook:' + (event ? 'attached' : 'detached')
	                    child.observer.emit(event)
	                    child.emitter.emit(event)
	                }
	            }
	        }
	    }

	    function check (key) {
	        if (!bindings[key]) {
	            compiler.createBinding(key)
	        }
	    }
	},
	observeData: function(data){
		var compiler = this,
			observer = compiler.observer;

		Observer.observe(data, '', observer);
		// also create binding for top level $data
	    // so it can be used in templates too
	    var $dataBinding = compiler.bindings['$data'] = new Binding(compiler, '$data');
	    $dataBinding.update(data);

	    def(compiler.vm, '$data', {
	    	get: function(){
	    		compiler.observer.emit('get', '$data');
	    		return compiler.data;
	    	},
	    	set: function(newData){
	    		var oldData = compiler.data;
	    		Observer.unobserve(oldData, '', observer);
	    		compiler.data = newData;
	    		Observer.copyPaths(newData, oldData);
	    		Observer.observe(newData, '', observer);
	    		update();
	    	}
	    });

	    observer
	    	.on('set', onSet)
	    	.on('mutate', onSet);
	    function onSet (key) {
	    	if (key !=='$data') update();
	    }

	    function update(){
	    	$dataBinding.update(compiler.data);
	    	observer.emit('change:$data', compiler.data);
	    }
	},

	/**
	 *  CREATE BINDING AND ATTACH GETTER/SETTER FOR A KEY TO THE VIEWMODEL OBJECT
	 */
	createBinding: function(key, directive){
		// utils.log('  created binding: ' + key);
		var compiler = this,
	        methods  = compiler.options.methods,
	        isExp    = directive && directive.isExp,
	        isFn     = (directive && directive.isFn) || (methods && methods[key]),
	        bindings = compiler.bindings,
	        computed = compiler.options.computed,
	        binding  = new Binding(compiler, key, isExp, isFn);


	    if (isExp) {
	        // EXPRESSION BINDINGS ARE ANONYMOUS
	        compiler.defineExp(key, binding, directive);
	    } else if (isFn) {
	        bindings[key] = binding;
	        compiler.defineVmProp(key, binding, methods[key]);
	    } else {
	    	bindings[key] = binding;
	        if (binding.root) {
	            // THIS IS A ROOT LEVEL BINDING. WE NEED TO DEFINE GETTER/SETTERS FOR IT.
	            if (computed && computed[key]) {
	                // COMPUTED PROPERTY
	                compiler.defineComputed(key, binding, computed[key])
	            } else if (key.charAt(0) !== '$') {
	                // NORMAL PROPERTY
	                compiler.defineDataProp(key, binding)
	            } else {
	                // PROPERTIES THAT START WITH $ ARE META PROPERTIES
	                // THEY SHOULD BE KEPT ON THE VM BUT NOT IN THE DATA OBJECT.
	                compiler.defineVmProp(key, binding, compiler.data[key])
	                delete compiler.data[key]
	            }
	        } else if (computed && computed[utils.baseKey(key)]) {
	            // NESTED PATH ON COMPUTED PROPERTY
	            compiler.defineExp(key, binding)
	        } else {
	            // ENSURE PATH IN DATA SO THAT COMPUTED PROPERTIES THAT
	            // ACCESS THE PATH DON'T THROW AN ERROR AND CAN COLLECT
	            // DEPENDENCIES
	            Observer.ensurePath(compiler.data, key)
	            var parentKey = key.slice(0, key.lastIndexOf('.'))
	            if (!bindings[parentKey]) {
	                // this is a nested value binding, but the binding for its parent
	                // has not been created yet. We better create that one too.
	                compiler.createBinding(parentKey)
	            }
	        }
	    }
	    return binding;
	}
});

/**
 * content resolve and compile
 */
utils.mix(Compiler.prototype, {
	/**
	 *  DEAL WITH <CONTENT> INSERTION POINTS
	 *  PER THE WEB COMPONENTS SPEC
	 */
	resolveContent: function() {
		var outlets = slice.call(this.el.getElementsByTagName('content')),
			raw = this.rawContent;

		// first pass, collect corresponding content
        // for each outlet.
		utils.each(outlets, function(outlet){
			if (raw) {
				select = outlet.getAttribute('select');
				if (select) {
					outlet.content = slice.call(raw.querySelectorAll(select));
				} else {
					main = outlet;
				}
			} else {
				outlet.content = slice.call(outlet.childNodes);
			}
		});

		// second pass, actually insert the contents
		var i, j, coutlet;
        for (i = 0, j = outlets.length; i < j; i++) {
            outlet = outlets[i]
            if (outlet === main) continue
            insert(outlet, outlet.content)
        }

        function insert (outlet, contents) {
	        var parent = outlet.parentNode,
	            i = 0, j = contents.length
	        for (; i < j; i++) {
	            parent.insertBefore(contents[i], outlet)
	        }
	        parent.removeChild(outlet);
	    }

	    this.rawContent = null
	},
	compile: function(node, root){
		var nodeType = node.nodeType
	    // a normal node
	    if (nodeType === 1 && node.tagName !== 'SCRIPT') { 
	        this.compileElement(node, root);
	    } else if (nodeType === 3) {
	        this.compileTextNode(node);
	    }
	},
	compileElement: function(node, root){
		// textarea is pretty annoying
	    // because its value creates childNodes which
	    // we don't want to compile.
	    if (node.tagName === 'TEXTAREA' && node.value) {
	        node.value = this.eval(node.value);
	    }


	    // only compile if this element has attributes
	    // or its tagName contains a hyphen (which means it could
	    // potentially be a custom element)
	    if (node.hasAttributes() || node.tagName.indexOf('-') > -1) {
		    console.log('\n\n-------------compile: ', node);

	    	// skip anything with v-pre
	        if (utils.dom.attr(node, 'pre') !== null) {
	            return;
	        }

	        var i, l, j, k;

	        // check priority directives.
	        // if any of them are present, it will take over the node with a childVM
	        // so we can skip the rest
	        for (i = 0, l = priorityDirectives.length; i < l; i++) {
	            if (this.checkPriorityDir(priorityDirectives[i], node, root)) {
	            	console.log('present and take over with a child vm');
	                return;
	            }
	        }

		    var prefix = config.prefix + '-',
	            params = this.options.paramAttributes,
	            attr, attrname, isDirective, exp, directives, directive, dirname;

	        // v-with has special priority among the rest
	        // it needs to pull in the value from the parent before
	        // computed properties are evaluated, because at this stage
	        // the computed properties have not set up their dependencies yet.
	        if (root) {
	            var withExp = utils.dom.attr(node, 'with');
	            if (withExp) {
	                directives = this.parseDirective('with', withExp, node, true)
	                for (j = 0, k = directives.length; j < k; j++) {
	                    this.bindDirective(directives[j], this.parent)
	                }
	            }
	        }

	        var attrs = slice.call(node.attributes);
	        for (i = 0, l = attrs.length; i < l; i++) {

	            attr = attrs[i]
	            attrname = attr.name
	            isDirective = false

	            if (attrname.indexOf(prefix) === 0) {

	                // a directive - split, parse and bind it.
	                isDirective = true
	                dirname = attrname.slice(prefix.length)
	                // build with multiple: true
	                directives = this.parseDirective(dirname, attr.value, node, true)
	                // loop through clauses (separated by ",")
	                // inside each attribute
	                for (j = 0, k = directives.length; j < k; j++) {
	                    this.bindDirective(directives[j])
	                }
	            } else {
	                // non directive attribute, check interpolation tags
	                exp = TextParser.parseAttr(attr.value)
	                if (exp) {
		                console.log('interpolation: ', attr.value, exp)
	                    directive = this.parseDirective('attr', exp, node)
	                    directive.arg = attrname
	                    if (params && params.indexOf(attrname) > -1) {
	                        // a param attribute... we should use the parent binding
	                        // to avoid circular updates like size={{size}}
	                        this.bindDirective(directive, this.parent)
	                    } else {
	                        this.bindDirective(directive)
	                    }
	                }
	            }

	            if (isDirective && dirname !== 'cloak') {
	                node.removeAttribute(attrname)
	            }
	        }

	    }
        // recursively compile childNodes
	    if (node.hasChildNodes()) {
	        slice.call(node.childNodes).forEach(this.compile, this);
	    }
	},
	compileTextNode: function (node) {
	    var tokens = TextParser.parse(node.nodeValue)
	    if (!tokens) return;
	    console.log('\n\n------------compile textNode:', node, tokens);
	    var el, token, directive;

	    for (var i = 0, l = tokens.length; i < l; i++) {

	        token = tokens[i];
	        directive = null;

	        if (token.key) { // a binding
	            if (token.key.charAt(0) === '>') { // a partial
	                el = document.createComment('ref');
	                directive = this.parseDirective('partial', token.key.slice(1), el);
	            } else {
	                if (!token.html) { 
	                	// text binding
	                    el = document.createTextNode('');
	                    directive = this.parseDirective('text', token.key, el);
	                } else { // html binding
	                    el = document.createComment(config.prefix + '-html')
	                    directive = this.parseDirective('html', token.key, el);
	                }
	            }
	        } else { 
	        	// a plain string
	            el = document.createTextNode(token)
	        }

	        // insert node
	        node.parentNode.insertBefore(el, node);

	        // bind directive
	        this.bindDirective(directive);

	    }

	    node.parentNode.removeChild(node)
	}
});

/**
 * directive stuff
 */
utils.mix(Compiler.prototype, {
	/**
	 *  Check for a priority directive
	 *  If it is present and valid, return true to skip the rest
	 */
	checkPriorityDir: function(dirname, node, root){
		var expression, directive, Ctor
	    if (
	        dirname === 'component' &&
	        root !== true &&
	        (Ctor = this.resolveComponent(node, undefined, true))
	    ) {
	        directive = this.parseDirective(dirname, '', node)
	        directive.Ctor = Ctor
	    } else {
	        expression = utils.dom.attr(node, dirname)
	        directive = expression && this.parseDirective(dirname, expression, node);
	    }
	    if (directive) {
	        if (root === true) {
	            utils.warn(
	                'Directive v-' + dirname + ' cannot be used on an already instantiated ' +
	                'VM\'s root node. Use it from the parent\'s template instead.'
	            )
	            return
	        }
	        this.deferred.push(directive);
	        return true
	    }
	},
	parseDirective: function (name, value, el, multiple) {
	    var compiler = this,
	        definition = compiler.getOption('directives', name);
	    if (definition) {
	        // parse into AST-like objects
	        var asts = Directive.parse(value)
	        return multiple
	            ? asts.map(build)
	            : build(asts[0])
	    }
	    function build (ast) {
	        return new Directive(name, ast, definition, compiler, el)
	    }
	},
	bindDirective: function (directive, bindingOwner) {

	    if (!directive) return;

	    // keep track of it so we can unbind() later
	    this.dirs.push(directive);

	    // for empty or literal directives, simply call its bind()
	    // and we're done.
	    if (directive.isEmpty || directive.isLiteral) {
	        if (directive.bind) directive.bind()
	        return
	    }
	    // otherwise, we got more work to do...
	    var binding,
	        compiler = bindingOwner || this,
	        key      = directive.key

	    if (directive.isExp) {
	        // expression bindings are always created on current compiler
	        binding = compiler.createBinding(key, directive);
	    } else {
	        // recursively locate which compiler owns the binding
	        while (compiler) {
	            if (compiler.hasKey(key)) {
	                break
	            } else {
	                compiler = compiler.parent
	            }
	        }
	        compiler = compiler || this
	        binding = compiler.bindings[key] || compiler.createBinding(key)
	    }
	    binding.dirs.push(directive)
	    directive.binding = binding

	    var value = binding.val()
	    // invoke bind hook if exists
	    if (directive.bind) {
	        directive.bind(value)
	    }
	    // set initial value
	    directive.$update(value, true)
	}
});

/***
 * define properties
 */
utils.mix(Compiler.prototype, {
	/**
	 *  Define the getter/setter to proxy a root-level
	 *  data property on the VM
	 */
	defineDataProp: function (key, binding) {
	    var compiler = this,
	        data     = compiler.data,
	        ob       = data.__emitter__;

	    // make sure the key is present in data
	    // so it can be observed
	    if (!(hasOwn.call(data, key))) {
	        data[key] = undefined
	    }

	    // if the data object is already observed, but the key
	    // is not observed, we need to add it to the observed keys.
	    if (ob && !(hasOwn.call(ob.values, key))) {
	        Observer.convertKey(data, key)
	    }

	    binding.value = data[key]

	    def(compiler.vm, key, {
	        get: function () {
	            return compiler.data[key]
	        },
	        set: function (val) {
	            compiler.data[key] = val
	        }
	    });
	},
	defineVmProp: function (key, binding, value) {
	    var ob = this.observer
	    binding.value = value
	    def(this.vm, key, {
	        get: function () {
	            if (Observer.shouldGet) ob.emit('get', key)
	            return binding.value
	        },
	        set: function (val) {
	            ob.emit('set', key, val)
	        }
	    })
	},
	defineExp: function (key, binding, directive) {
	    var computedKey = directive && directive.computedKey,
	        exp         = computedKey ? directive.expression : key,
	        getter      = this.expCache[exp]
	    if (!getter) {
	        getter = this.expCache[exp] = ExpParser.parse(computedKey || key, this);
	    }
	    if (getter) {
	        this.markComputed(binding, getter)
	    }
	},
	defineComputed: function (key, binding, value) {
	    this.markComputed(binding, value)
	    def(this.vm, key, {
	        get: binding.value.$get,
	        set: binding.value.$set
	    })
	},
	markComputed: function (binding, value) {
	    binding.isComputed = true
	    // bind the accessors to the vm
	    if (binding.isFn) {
	        binding.value = value
	    } else {
	        if (typeof value === 'function') {
	            value = { $get: value }
	        }
	        binding.value = {
	            $get: utils.object.bind(value.$get, this.vm),
	            $set: value.$set
	                ? utils.object.bind(value.$set, this.vm)
	                : undefined
	        }
	    }
	    // keep track for dep parsing later
	    this.computed.push(binding)
	}
});

/**
 * utility for comipler
 */
utils.mix(Compiler.prototype, {
	execHook: function (event) {
	    event = 'hook:' + event;
	    this.observer.emit(event);
	    this.emitter.emit(event);
	},
	hasKey: function (key) {
	    var baseKey = utils.object.baseKey(key)
	    return hasOwn.call(this.data, baseKey) ||
	        hasOwn.call(this.vm, baseKey)
	},
	/**
	 *  Do a one-time eval of a string that potentially
	 *  includes bindings. It accepts additional raw data
	 *  because we need to dynamically resolve v-component
	 *  before a childVM is even compiled...
	 */
	eval: function (exp, data) {
	    var parsed = TextParser.parseAttr(exp);
	    return parsed
	        ? ExpParser.eval(parsed, this, data)
	        : exp;
	},
	resolveComponent: function(node, data, test){
		// late require to avoid circular deps
	    ViewModel = ViewModel || require('./viewmodel')

	    var exp     = utils.dom.attr(node, 'component'),
	        tagName = node.tagName,
	        id      = this.eval(exp, data),
	        tagId   = (tagName.indexOf('-') > 0 && tagName.toLowerCase()),
	        Ctor    = this.getOption('components', id || tagId, true)

	    if (id && !Ctor) {
	        utils.warn('Unknown component: ' + id)
	    }

	    return test
	        ? exp === ''
	            ? ViewModel
	            : Ctor
	        : Ctor || ViewModel;
	},
	/**
	 *  Retrive an option from the compiler
	 */
	getOption: function(type, id, silent){
		var options = this.options,
	        parent = this.parent,
	        globalAssets = config.globalAssets,
	        res = (options[type] && options[type][id]) || (
	            parent
	                ? parent.getOption(type, id, silent)
	                : globalAssets[type] && globalAssets[type][id]
	        );
	    if (!res && !silent && typeof id === 'string') {
	        utils.warn('Unknown ' + type.slice(0, -1) + ': ' + id)
	    }
	    return res;
	}
});

module.exports = Compiler;
},{"./binding":4,"./config":6,"./directive":8,"./eventTarget":19,"./observer":23,"./parser":24,"./utils":26,"./viewmodel":27}],6:[function(require,module,exports){
module.exports = {
	prefix: 'v',
	debug: true
}
},{}],7:[function(require,module,exports){
var utils = require('./utils');
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
            utils.nextTick((function(fn) {
                return function() {
                    fn.apply(context, args);
                };
            })(cb));
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
                keys = utils.object.keys(this);
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
},{"./utils":26}],8:[function(require,module,exports){
var dirId           = 1,
    ARG_RE          = /^[\w\$-]+$/,
    FILTER_TOKEN_RE = /[^\s'"]+|'[^']+'|"[^"]+"/g,
    NESTING_RE      = /^\$(parent|root)\./,
    SINGLE_VAR_RE   = /^[\w\.$]+$/,
    QUOTE_RE        = /"/g,
    TextParser      = require('./textParser');

/**
 *  Directive class
 *  represents a single directive instance in the DOM
 */
function Directive (name, ast, definition, compiler, el) {

    this.id             = dirId++;
    this.name           = name;
    this.compiler       = compiler;
    this.vm             = compiler.vm;
    this.el             = el;
    this.computeFilters = false;
    this.key            = ast.key;
    this.arg            = ast.arg;
    this.expression     = ast.expression;

    var isEmpty = this.expression === '';

    // mix in properties from the directive definition
    if (typeof definition === 'function') {
        this[isEmpty ? 'bind' : 'update'] = definition
    } else {
        for (var prop in definition) {
            this[prop] = definition[prop]
        }
    }

    // empty expression, we're done.
    if (isEmpty || this.isEmpty) {
        this.isEmpty = true
        return
    }

    if (TextParser.Regex.test(this.key)) {
        this.key = compiler.eval(this.key);
        if (this.isLiteral) {
            this.expression = this.key;
        }
    }

    var filters = ast.filters,
        filter, fn, i, l, computed;
    if (filters) {
        this.filters = []
        for (i = 0, l = filters.length; i < l; i++) {
            filter = filters[i]
            fn = this.compiler.getOption('filters', filter.name)
            if (fn) {
                filter.apply = fn
                this.filters.push(filter)
                if (fn.computed) {
                    computed = true
                }
            }
        }
    }

    if (!this.filters || !this.filters.length) {
        this.filters = null
    }

    if (computed) {
        this.computedKey = Directive.inlineFilters(this.key, this.filters)
        this.filters = null
    }

    this.isExp =
        computed ||
        !SINGLE_VAR_RE.test(this.key) ||
        NESTING_RE.test(this.key)

}

var DirProto = Directive.prototype

/**
 *  called when a new value is set 
 *  for computed properties, this will only be called once
 *  during initialization.
 */
DirProto.$update = function (value, init) {
    if (this.$lock) return
    if (init || value !== this.value || (value && typeof value === 'object')) {
        this.value = value
        if (this.update) {
            this.update(
                this.filters && !this.computeFilters
                    ? this.$applyFilters(value)
                    : value,
                init
            )
        }
    }
}

/**
 *  pipe the value through filters
 */
DirProto.$applyFilters = function (value) {
    var filtered = value, filter
    for (var i = 0, l = this.filters.length; i < l; i++) {
        filter = this.filters[i]
        filtered = filter.apply.apply(this.vm, [filtered].concat(filter.args))
    }
    return filtered
}

/**
 *  Unbind diretive
 */
DirProto.$unbind = function () {
    // this can be called before the el is even assigned...
    if (!this.el || !this.vm) return
    if (this.unbind) this.unbind()
    this.vm = this.el = this.binding = this.compiler = null
}

// Exposed static methods -----------------------------------------------------

/**
 *  Parse a directive string into an Array of
 *  AST-like objects representing directives
 */
Directive.parse = function (str) {

    var inSingle = false,
        inDouble = false,
        curly    = 0,
        square   = 0,
        paren    = 0,
        begin    = 0,
        argIndex = 0,
        dirs     = [],
        dir      = {},
        lastFilterIndex = 0,
        arg

    for (var c, i = 0, l = str.length; i < l; i++) {
        c = str.charAt(i)
        if (inSingle) {
            // check single quote
            if (c === "'") inSingle = !inSingle
        } else if (inDouble) {
            // check double quote
            if (c === '"') inDouble = !inDouble
        } else if (c === ',' && !paren && !curly && !square) {
            // reached the end of a directive
            pushDir()
            // reset & skip the comma
            dir = {}
            begin = argIndex = lastFilterIndex = i + 1
        } else if (c === ':' && !dir.key && !dir.arg) {
            // argument
            arg = str.slice(begin, i).trim()
            if (ARG_RE.test(arg)) {
                argIndex = i + 1
                dir.arg = arg
            }
        } else if (c === '|' && str.charAt(i + 1) !== '|' && str.charAt(i - 1) !== '|') {
            if (dir.key === undefined) {
                // first filter, end of key
                lastFilterIndex = i + 1
                dir.key = str.slice(argIndex, i).trim()
            } else {
                // already has filter
                pushFilter()
            }
        } else if (c === '"') {
            inDouble = true
        } else if (c === "'") {
            inSingle = true
        } else if (c === '(') {
            paren++
        } else if (c === ')') {
            paren--
        } else if (c === '[') {
            square++
        } else if (c === ']') {
            square--
        } else if (c === '{') {
            curly++
        } else if (c === '}') {
            curly--
        }
    }
    if (i === 0 || begin !== i) {
        pushDir()
    }

    function pushDir () {
        dir.expression = str.slice(begin, i).trim()
        if (dir.key === undefined) {
            dir.key = str.slice(argIndex, i).trim()
        } else if (lastFilterIndex !== begin) {
            pushFilter()
        }
        if (i === 0 || dir.key) {
            dirs.push(dir)
        }
    }

    function pushFilter () {
        var exp = str.slice(lastFilterIndex, i).trim(),
            filter
        if (exp) {
            filter = {}
            var tokens = exp.match(FILTER_TOKEN_RE)
            filter.name = tokens[0]
            filter.args = tokens.length > 1 ? tokens.slice(1) : null
        }
        if (filter) {
            (dir.filters = dir.filters || []).push(filter)
        }
        lastFilterIndex = i + 1
    }

    return dirs
}

/**
 *  Inline computed filters so they become part
 *  of the expression
 */
Directive.inlineFilters = function (key, filters) {
    var args, filter
    for (var i = 0, l = filters.length; i < l; i++) {
        filter = filters[i]
        args = filter.args
            ? ',"' + filter.args.map(escapeQuote).join('","') + '"'
            : ''
        key = 'this.$compiler.getOption("filters", "' +
                filter.name +
            '").call(this,' +
                key + args +
            ')'
    }
    return key
}

/**
 *  Convert double quotes to single quotes
 *  so they don't mess up the generated function body
 */
function escapeQuote (v) {
    return v.indexOf('"') > -1
        ? v.replace(QUOTE_RE, '\'')
        : v
}

module.exports = Directive;
},{"./textParser":25}],9:[function(require,module,exports){
var utils = require('../utils'),
    slice = [].slice

/**
 *  Binding for innerHTML
 */
module.exports = {

    bind: function () {
        // a comment node means this is a binding for
        // {{{ inline unescaped html }}}
        if (this.el.nodeType === 8) {
            // hold nodes
            this.nodes = []
        }
    },

    update: function (value) {
        value = utils.guard(value)
        if (this.nodes) {
            this.swap(value)
        } else {
            this.el.innerHTML = value
        }
    },

    swap: function (value) {
        var parent = this.el.parentNode,
            nodes  = this.nodes,
            i      = nodes.length
        // remove old nodes
        while (i--) {
            parent.removeChild(nodes[i])
        }
        // convert new value to a fragment
        var frag = utils.toFragment(value)
        // save a reference to these nodes so we can remove later
        this.nodes = slice.call(frag.childNodes)
        parent.insertBefore(frag, this.el)
    }
}
},{"../utils":26}],10:[function(require,module,exports){
var utils    = require('../utils')

/**
 *  Manages a conditional child VM
 */
module.exports = {

    bind: function () {
        
        this.parent = this.el.parentNode
        this.ref    = document.createComment('vue-if')
        this.Ctor   = this.compiler.resolveComponent(this.el)

        // insert ref
        this.parent.insertBefore(this.ref, this.el)
        this.parent.removeChild(this.el)

        if (utils.attr(this.el, 'view')) {
            utils.warn(
                'Conflict: v-if cannot be used together with v-view. ' +
                'Just set v-view\'s binding value to empty string to empty it.'
            )
        }
        if (utils.attr(this.el, 'repeat')) {
            utils.warn(
                'Conflict: v-if cannot be used together with v-repeat. ' +
                'Use `v-show` or the `filterBy` filter instead.'
            )
        }
    },

    update: function (value) {

        if (!value) {
            this.unbind()
        } else if (!this.childVM) {
            this.childVM = new this.Ctor({
                el: this.el.cloneNode(true),
                parent: this.vm
            })
            if (this.compiler.init) {
                this.parent.insertBefore(this.childVM.$el, this.ref)
            } else {
                this.childVM.$before(this.ref)
            }
        }
        
    },

    unbind: function () {
        if (this.childVM) {
            this.childVM.$destroy()
            this.childVM = null
        }
    }
}
},{"../utils":26}],11:[function(require,module,exports){
var utils      = require('../utils'),
    config     = require('../config'),
    directives = module.exports = utils.hash()

/**
 *  Nest and manage a Child VM
 */
directives.component = {
    isLiteral: true,
    bind: function () {
        if (!this.el._vm) {
            this.childVM = new this.Ctor({
                el: this.el,
                parent: this.vm
            })
        }
    },
    unbind: function () {
        if (this.childVM) {
            this.childVM.$destroy()
        }
    }
}

/**
 *  Binding HTML attributes
 */
directives.attr = {
    bind: function () {
        var params = this.vm.$options.paramAttributes
        this.isParam = params && params.indexOf(this.arg) > -1
    },
    update: function (value) {
        if (value || value === 0) {
            this.el.setAttribute(this.arg, value)
        } else {
            this.el.removeAttribute(this.arg)
        }
        if (this.isParam) {
            this.vm[this.arg] = utils.checkNumber(value)
        }
    }
}

/**
 *  Binding textContent
 */
directives.text = {
    bind: function () {
        this.attr = this.el.nodeType === 3
            ? 'nodeValue'
            : 'textContent'
    },
    update: function (value) {
        this.el[this.attr] = utils.guard(value)
    }
}

/**
 *  Binding CSS display property
 */
directives.show = function (value) {
    var el = this.el,
        target = value ? '' : 'none',
        change = function () {
            el.style.display = target
        }
}

/**
 *  Binding CSS classes
 */
directives['class'] = function (value) {
    if (this.arg) {
        utils[value ? 'addClass' : 'removeClass'](this.el, this.arg)
    } else {
        if (this.lastVal) {
            utils.removeClass(this.el, this.lastVal)
        }
        if (value) {
            utils.addClass(this.el, value)
            this.lastVal = value
        }
    }
}

/**
 *  Only removed after the owner VM is ready
 */
directives.cloak = {
    isEmpty: true,
    bind: function () {
        var el = this.el
        this.compiler.observer.once('hook:ready', function () {
            el.removeAttribute(config.prefix + '-cloak')
        })
    }
}

/**
 *  Store a reference to self in parent VM's $
 */
directives.ref = {
    isLiteral: true,
    bind: function () {
        var id = this.expression
        if (id) {
            this.vm.$parent.$[id] = this.vm
        }
    },
    unbind: function () {
        var id = this.expression
        if (id) {
            delete this.vm.$parent.$[id]
        }
    }
}

directives.on      = require('./on')
directives.repeat  = require('./repeat')
directives.model   = require('./model')
directives['if']   = require('./if')
directives['with'] = require('./with')
directives.html    = require('./html')
directives.style   = require('./style')
directives.partial = require('./partial')
directives.view    = require('./view')
},{"../config":6,"../utils":26,"./html":9,"./if":10,"./model":12,"./on":13,"./partial":14,"./repeat":15,"./style":16,"./view":17,"./with":18}],12:[function(require,module,exports){
var utils = require('../utils'),
    isIE9 = navigator.userAgent.indexOf('MSIE 9.0') > 0,
    filter = [].filter

/**
 *  Returns an array of values from a multiple select
 */
function getMultipleSelectOptions (select) {
    return filter
        .call(select.options, function (option) {
            return option.selected
        })
        .map(function (option) {
            return option.value || option.text
        })
}

/**
 *  Two-way binding for form input elements
 */
module.exports = {

    bind: function () {

        var self = this,
            el   = self.el,
            type = el.type,
            tag  = el.tagName

        self.lock = false
        self.ownerVM = self.binding.compiler.vm

        // determine what event to listen to
        self.event =
            (self.compiler.options.lazy ||
            tag === 'SELECT' ||
            type === 'checkbox' || type === 'radio')
                ? 'change'
                : 'input'

        // determine the attribute to change when updating
        self.attr = type === 'checkbox'
            ? 'checked'
            : (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')
                ? 'value'
                : 'innerHTML'

        // select[multiple] support
        if(tag === 'SELECT' && el.hasAttribute('multiple')) {
            this.multi = true
        }

        var compositionLock = false
        self.cLock = function () {
            compositionLock = true
        }
        self.cUnlock = function () {
            compositionLock = false
        }
        el.addEventListener('compositionstart', this.cLock)
        el.addEventListener('compositionend', this.cUnlock)

        // attach listener
        self.set = self.filters
            ? function () {
                if (compositionLock) return
                // if this directive has filters
                // we need to let the vm.$set trigger
                // update() so filters are applied.
                // therefore we have to record cursor position
                // so that after vm.$set changes the input
                // value we can put the cursor back at where it is
                var cursorPos
                try { cursorPos = el.selectionStart } catch (e) {}

                self._set()

                // since updates are async
                // we need to reset cursor position async too
                utils.nextTick(function () {
                    if (cursorPos !== undefined) {
                        el.setSelectionRange(cursorPos, cursorPos)
                    }
                })
            }
            : function () {
                if (compositionLock) return
                // no filters, don't let it trigger update()
                self.lock = true

                self._set()

                utils.nextTick(function () {
                    self.lock = false
                })
            }
        el.addEventListener(self.event, self.set)

        // fix shit for IE9
        // since it doesn't fire input on backspace / del / cut
        if (isIE9) {
            self.onCut = function () {
                // cut event fires before the value actually changes
                utils.nextTick(function () {
                    self.set()
                })
            }
            self.onDel = function (e) {
                if (e.keyCode === 46 || e.keyCode === 8) {
                    self.set()
                }
            }
            el.addEventListener('cut', self.onCut)
            el.addEventListener('keyup', self.onDel)
        }
    },

    _set: function () {
        this.ownerVM.$set(
            this.key, this.multi
                ? getMultipleSelectOptions(this.el)
                : this.el[this.attr]
        )
    },

    update: function (value, init) {
        /* jshint eqeqeq: false */
        // sync back inline value if initial data is undefined
        if (init && value === undefined) {
            return this._set()
        }
        if (this.lock) return
        var el = this.el
        if (el.tagName === 'SELECT') { // select dropdown
            el.selectedIndex = -1
            if(this.multi && Array.isArray(value)) {
                value.forEach(this.updateSelect, this)
            } else {
                this.updateSelect(value)
            }
        } else if (el.type === 'radio') { // radio button
            el.checked = value == el.value
        } else if (el.type === 'checkbox') { // checkbox
            el.checked = !!value
        } else {
            el[this.attr] = utils.guard(value)
        }
    },

    updateSelect: function (value) {
        /* jshint eqeqeq: false */
        // setting <select>'s value in IE9 doesn't work
        // we have to manually loop through the options
        var options = this.el.options,
            i = options.length
        while (i--) {
            if (options[i].value == value) {
                options[i].selected = true
                break
            }
        }
    },

    unbind: function () {
        var el = this.el
        el.removeEventListener(this.event, this.set)
        el.removeEventListener('compositionstart', this.cLock)
        el.removeEventListener('compositionend', this.cUnlock)
        if (isIE9) {
            el.removeEventListener('cut', this.onCut)
            el.removeEventListener('keyup', this.onDel)
        }
    }
}
},{"../utils":26}],13:[function(require,module,exports){
var utils    = require('../utils')

/**
 *  Binding for event listeners
 */
module.exports = {

    isFn: true,

    bind: function () {
        this.context = this.binding.isExp
            ? this.vm
            : this.binding.compiler.vm
        if (this.el.tagName === 'IFRAME' && this.arg !== 'load') {
            var self = this
            this.iframeBind = function () {
                self.el.contentWindow.addEventListener(self.arg, self.handler)
            }
            this.el.addEventListener('load', this.iframeBind)
        }
    },

    update: function (handler) {
        if (typeof handler !== 'function') {
            utils.warn('Directive "v-on:' + this.expression + '" expects a method.')
            return
        }
        this.reset()
        var vm = this.vm,
            context = this.context
        this.handler = function (e) {
            e.targetVM = vm
            context.$event = e
            var res = handler.call(context, e)
            context.$event = null
            return res
        }
        if (this.iframeBind) {
            this.iframeBind()
        } else {
            this.el.addEventListener(this.arg, this.handler)
        }
    },

    reset: function () {
        var el = this.iframeBind
            ? this.el.contentWindow
            : this.el
        if (this.handler) {
            el.removeEventListener(this.arg, this.handler)
        }
    },

    unbind: function () {
        this.reset()
        this.el.removeEventListener('load', this.iframeBind)
    }
}
},{"../utils":26}],14:[function(require,module,exports){
var utils = require('../utils')

/**
 *  Binding for partials
 */
module.exports = {

    isLiteral: true,

    bind: function () {

        var id = this.expression
        if (!id) return

        var el       = this.el,
            compiler = this.compiler,
            partial  = compiler.getOption('partials', id)

        if (!partial) {
            if (id === 'yield') {
                utils.warn('{{>yield}} syntax has been deprecated. Use <content> tag instead.')
            }
            return
        }

        partial = partial.cloneNode(true)

        // comment ref node means inline partial
        if (el.nodeType === 8) {

            // keep a ref for the partial's content nodes
            var nodes = [].slice.call(partial.childNodes),
                parent = el.parentNode
            parent.insertBefore(partial, el)
            parent.removeChild(el)
            // compile partial after appending, because its children's parentNode
            // will change from the fragment to the correct parentNode.
            // This could affect directives that need access to its element's parentNode.
            nodes.forEach(compiler.compile, compiler)

        } else {

            // just set innerHTML...
            el.innerHTML = ''
            el.appendChild(partial)

        }
    }

}
},{"../utils":26}],15:[function(require,module,exports){
var utils      = require('../utils'),
    config     = require('../config')

/**
 *  Binding that manages VMs based on an Array
 */
module.exports = {

    bind: function () {

        this.identifier = '$r' + this.id

        // a hash to cache the same expressions on repeated instances
        // so they don't have to be compiled for every single instance
        this.expCache = utils.hash()

        var el   = this.el,
            ctn  = this.container = el.parentNode

        // extract child Id, if any
        this.childId = this.compiler.eval(utils.dom.attr(el, 'ref'))

        // create a comment node as a reference node for DOM insertions
        this.ref = document.createComment(config.prefix + '-repeat-' + this.key)
        ctn.insertBefore(this.ref, el)
        ctn.removeChild(el)

        this.collection = null
        this.vms = null

    },

    update: function (collection) {

        if (!Array.isArray(collection)) {
            if (utils.isObject(collection)) {
                collection = utils.objectToArray(collection)
            } else {
                utils.warn('v-repeat only accepts Array or Object values.')
            }
        }

        // keep reference of old data and VMs
        // so we can reuse them if possible
        this.oldVMs = this.vms
        this.oldCollection = this.collection
        collection = this.collection = collection || []

        var isObject = collection[0] && utils.isObject(collection[0])
        this.vms = this.oldCollection
            ? this.diff(collection, isObject)
            : this.init(collection, isObject)

        if (this.childId) {
            this.vm.$[this.childId] = this.vms
        }

    },

    init: function (collection, isObject) {
        var vm, vms = []
        for (var i = 0, l = collection.length; i < l; i++) {
            vm = this.build(collection[i], i, isObject)
            vms.push(vm)
            if (this.compiler.init) {
                this.container.insertBefore(vm.$el, this.ref)
            } else {
                vm.$before(this.ref)
            }
        }
        return vms
    },

    /**
     *  Diff the new array with the old
     *  and determine the minimum amount of DOM manipulations.
     */
    diff: function (newCollection, isObject) {

        var i, l, item, vm,
            oldIndex,
            targetNext,
            currentNext,
            nextEl,
            ctn    = this.container,
            oldVMs = this.oldVMs,
            vms    = []

        vms.length = newCollection.length

        // first pass, collect new reused and new created
        for (i = 0, l = newCollection.length; i < l; i++) {
            item = newCollection[i]
            if (isObject) {
                item.$index = i
                if (item.__emitter__ && item.__emitter__[this.identifier]) {
                    // this piece of data is being reused.
                    // record its final position in reused vms
                    item.$reused = true
                } else {
                    vms[i] = this.build(item, i, isObject)
                }
            } else {
                // we can't attach an identifier to primitive values
                // so have to do an indexOf...
                oldIndex = indexOf(oldVMs, item)
                if (oldIndex > -1) {
                    // record the position on the existing vm
                    oldVMs[oldIndex].$reused = true
                    oldVMs[oldIndex].$data.$index = i
                } else {
                    vms[i] = this.build(item, i, isObject)
                }
            }
        }

        // second pass, collect old reused and destroy unused
        for (i = 0, l = oldVMs.length; i < l; i++) {
            vm = oldVMs[i]
            item = this.arg
                ? vm.$data[this.arg]
                : vm.$data
            if (item.$reused) {
                vm.$reused = true
                delete item.$reused
            }
            if (vm.$reused) {
                // update the index to latest
                vm.$index = item.$index
                // the item could have had a new key
                if (item.$key && item.$key !== vm.$key) {
                    vm.$key = item.$key
                }
                vms[vm.$index] = vm
            } else {
                // this one can be destroyed.
                if (item.__emitter__) {
                    delete item.__emitter__[this.identifier]
                }
                vm.$destroy()
            }
        }

        // final pass, move/insert DOM elements
        i = vms.length
        while (i--) {
            vm = vms[i]
            item = vm.$data
            targetNext = vms[i + 1]
            if (vm.$reused) {
                nextEl = vm.$el.nextSibling
                // destroyed VMs' element might still be in the DOM
                // due to transitions
                while (!nextEl.vue_vm && nextEl !== this.ref) {
                    nextEl = nextEl.nextSibling
                }
                currentNext = nextEl.vue_vm
                if (currentNext !== targetNext) {
                    if (!targetNext) {
                        ctn.insertBefore(vm.$el, this.ref)
                    } else {
                        nextEl = targetNext.$el
                        // new VMs' element might not be in the DOM yet
                        // due to transitions
                        while (!nextEl.parentNode) {
                            targetNext = vms[nextEl.vue_vm.$index + 1]
                            nextEl = targetNext
                                ? targetNext.$el
                                : this.ref
                        }
                        ctn.insertBefore(vm.$el, nextEl)
                    }
                }
                delete vm.$reused
                delete item.$index
                delete item.$key
            } else { // a new vm
                vm.$before(targetNext ? targetNext.$el : this.ref)
            }
        }

        return vms
    },

    build: function (data, index, isObject) {

        // wrap non-object values
        var raw, alias,
            wrap = !isObject || this.arg
        if (wrap) {
            raw = data
            alias = this.arg || '$value'
            data = {}
            data[alias] = raw
        }
        data.$index = index

        var el = this.el.cloneNode(true),
            Ctor = this.compiler.resolveComponent(el, data),
            vm = new Ctor({
                el: el,
                data: data,
                parent: this.vm,
                compilerOptions: {
                    repeat: true,
                    expCache: this.expCache
                }
            })

        if (isObject) {
            // attach an ienumerable identifier to the raw data
            (raw || data).__emitter__[this.identifier] = true
        }

        return vm

    },

    unbind: function () {
        if (this.childId) {
            delete this.vm.$[this.childId]
        }
        if (this.vms) {
            var i = this.vms.length
            while (i--) {
                this.vms[i].$destroy()
            }
        }
    }
}

// Helpers --------------------------------------------------------------------

/**
 *  Find an object or a wrapped data object
 *  from an Array
 */
function indexOf (vms, obj) {
    for (var vm, i = 0, l = vms.length; i < l; i++) {
        vm = vms[i]
        if (!vm.$reused && vm.$value === obj) {
            return i
        }
    }
    return -1
}
},{"../config":6,"../utils":26}],16:[function(require,module,exports){
var prefixes = ['-webkit-', '-moz-', '-ms-']

/**
 *  Binding for CSS styles
 */
module.exports = {

    bind: function () {
        var prop = this.arg
        if (!prop) return
        if (prop.charAt(0) === '$') {
            // properties that start with $ will be auto-prefixed
            prop = prop.slice(1)
            this.prefixed = true
        }
        this.prop = prop
    },

    update: function (value) {
        var prop = this.prop,
            isImportant
        /* jshint eqeqeq: true */
        // cast possible numbers/booleans into strings
        if (value != null) value += ''
        if (prop) {
            if (value) {
                isImportant = value.slice(-10) === '!important'
                    ? 'important'
                    : ''
                if (isImportant) {
                    value = value.slice(0, -10).trim()
                }
            }
            this.el.style.setProperty(prop, value, isImportant)
            if (this.prefixed) {
                var i = prefixes.length
                while (i--) {
                    this.el.style.setProperty(prefixes[i] + prop, value, isImportant)
                }
            }
        } else {
            this.el.style.cssText = value
        }
    }

}
},{}],17:[function(require,module,exports){
/**
 *  Manages a conditional child VM using the
 *  binding's value as the component ID.
 */
module.exports = {

    bind: function () {

        // track position in DOM with a ref node
        var el       = this.raw = this.el,
            parent   = el.parentNode,
            ref      = this.ref = document.createComment('v-view')
        parent.insertBefore(ref, el)
        parent.removeChild(el)

        // cache original content
        /* jshint boss: true */
        var node,
            frag = this.inner = document.createElement('div')
        while (node = el.firstChild) {
            frag.appendChild(node)
        }

    },

    update: function(value) {

        this.unbind()

        var Ctor  = this.compiler.getOption('components', value)
        if (!Ctor) return

        this.childVM = new Ctor({
            el: this.raw.cloneNode(true),
            parent: this.vm,
            compilerOptions: {
                rawContent: this.inner.cloneNode(true)
            }
        })

        this.el = this.childVM.$el
        if (this.compiler.init) {
            this.ref.parentNode.insertBefore(this.el, this.ref)
        } else {
            this.childVM.$before(this.ref)
        }

    },

    unbind: function() {
        if (this.childVM) {
            this.childVM.$destroy()
        }
    }

}
},{}],18:[function(require,module,exports){
var utils = require('../utils')

/**
 *  Binding for inheriting data from parent VMs.
 */
module.exports = {

    bind: function () {

        var self      = this,
            childKey  = self.arg,
            parentKey = self.key,
            compiler  = self.compiler,
            owner     = self.binding.compiler

        if (compiler === owner) {
            this.alone = true
            return
        }

        if (childKey) {
            if (!compiler.bindings[childKey]) {
                compiler.createBinding(childKey)
            }
            // sync changes on child back to parent
            compiler.observer.on('change:' + childKey, function (val) {
                if (compiler.init) return
                if (!self.lock) {
                    self.lock = true
                    utils.nextTick(function () {
                        self.lock = false
                    })
                }
                owner.vm.$set(parentKey, val)
            })
        }
    },

    update: function (value) {
        // sync from parent
        if (!this.alone && !this.lock) {
            if (this.arg) {
                this.vm.$set(this.arg, value)
            } else if (this.vm.$data !== value) {
                this.vm.$data = value
            }
        }
    }

}
},{"../utils":26}],19:[function(require,module,exports){
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
            var index = utils.array.indexOf(callback, context._callback[type]);
            if (index != -1) context._callback[type].splice(index, 1);
        }
        return this;
    },
    fire: function(type, a, b, c, d) {
        var context = this._ctx || this;
        if (context._callback) {
            var arr = context._callback[type];
            if (arr && arr.length > 0) {
                // data = data || {};
                // data.type = type;
                // data.target = context;
                for (var i = arr.length - 1; i >= 0; i--) {
                    utils.isFunction(arr[i]) && arr[i].call(context, a, b, c, d);
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
},{"./utils":26}],20:[function(require,module,exports){
var config      = require('./config'),
    utils       = require('./utils'),
    defer       = require('./deferred'),
    Parser      = require('./parser'),
    makeHash    = utils.hash;
    ViewModel   = require('./viewmodel');


ViewModel.options = config.globalAssets = {
    directives  : require('./directives'),
    filters     : require('./filters'),
    partials    : makeHash(),
    effects     : makeHash(),
    components  : makeHash()
};

utils.each(['directive', 'filter', 'partial', 'effect', 'component'], function(type){
	ViewModel[type] = function(id, value){
		var hash = this.options[type + 's'];
		if(!hash){
			hash = this.options[type + 's'] = utils.hash();
		}
		if(!value){
			return hash[id];
		}
		if (type === 'partial') {
            value = Parser.parseTemplate(value);
        } else if (type === 'component') {
            // value = utils.toConstructor(value)
        } else if (type === 'filter') {
            // utils.checkFilter(value)
        }
        hash[id] = value;
        return this;
	}
});

window.VM = ViewModel;
module.exports = ViewModel;

},{"./config":6,"./deferred":7,"./directives":11,"./filters":21,"./parser":24,"./utils":26,"./viewmodel":27}],21:[function(require,module,exports){
var utils    = require('./utils'),
    get      = utils.object.get,
    slice    = [].slice,
    QUOTE_RE = /^'.*'$/,
    filters  = module.exports = utils.hash()

/**
 *  'abc' => 'Abc'
 */
filters.capitalize = function (value) {
    if (!value && value !== 0) return ''
    value = value.toString()
    return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 *  'abc' => 'ABC'
 */
filters.uppercase = function (value) {
    return (value || value === 0)
        ? value.toString().toUpperCase()
        : ''
}

/**
 *  'AbC' => 'abc'
 */
filters.lowercase = function (value) {
    return (value || value === 0)
        ? value.toString().toLowerCase()
        : ''
}

/**
 *  12345 => $12,345.00
 */
filters.currency = function (value, sign) {
    value = parseFloat(value)
    if (!value && value !== 0) return ''
    sign = sign || '$'
    var s = Math.floor(value).toString(),
        i = s.length % 3,
        h = i > 0 ? (s.slice(0, i) + (s.length > 3 ? ',' : '')) : '',
        f = '.' + value.toFixed(2).slice(-2)
    return sign + h + s.slice(i).replace(/(\d{3})(?=\d)/g, '$1,') + f
}

/**
 *  args: an array of strings corresponding to
 *  the single, double, triple ... forms of the word to
 *  be pluralized. When the number to be pluralized
 *  exceeds the length of the args, it will use the last
 *  entry in the array.
 *
 *  e.g. ['single', 'double', 'triple', 'multiple']
 */
filters.pluralize = function (value) {
    var args = slice.call(arguments, 1)
    return args.length > 1
        ? (args[value - 1] || args[args.length - 1])
        : (args[value - 1] || args[0] + 's')
}

/**
 *  A special filter that takes a handler function,
 *  wraps it so it only gets triggered on specific keypresses.
 *
 *  v-on only
 */

var keyCodes = {
    enter    : 13,
    tab      : 9,
    'delete' : 46,
    up       : 38,
    left     : 37,
    right    : 39,
    down     : 40,
    esc      : 27
}

filters.key = function (handler, key) {
    if (!handler) return
    var code = keyCodes[key]
    if (!code) {
        code = parseInt(key, 10)
    }
    return function (e) {
        if (e.keyCode === code) {
            return handler.call(this, e)
        }
    }
}

/**
 *  Filter filter for v-repeat
 */
filters.filterBy = function (arr, searchKey, delimiter, dataKey) {

    // allow optional `in` delimiter
    // because why not
    if (delimiter && delimiter !== 'in') {
        dataKey = delimiter
    }

    // get the search string
    var search = stripQuotes(searchKey) || this.$get(searchKey)
    if (!search) return arr
    search = search.toLowerCase()

    // get the optional dataKey
    dataKey = dataKey && (stripQuotes(dataKey) || this.$get(dataKey))

    // convert object to array
    if (!Array.isArray(arr)) {
        arr = utils.objectToArray(arr)
    }

    return arr.filter(function (item) {
        return dataKey
            ? contains(get(item, dataKey), search)
            : contains(item, search)
    })

}

filters.filterBy.computed = true

/**
 *  Sort fitler for v-repeat
 */
filters.orderBy = function (arr, sortKey, reverseKey) {

    var key = stripQuotes(sortKey) || this.$get(sortKey)
    if (!key) return arr

    // convert object to array
    if (!Array.isArray(arr)) {
        arr = utils.objectToArray(arr)
    }

    var order = 1
    if (reverseKey) {
        if (reverseKey === '-1') {
            order = -1
        } else if (reverseKey.charAt(0) === '!') {
            reverseKey = reverseKey.slice(1)
            order = this.$get(reverseKey) ? 1 : -1
        } else {
            order = this.$get(reverseKey) ? -1 : 1
        }
    }

    // sort on a copy to avoid mutating original array
    return arr.slice().sort(function (a, b) {
        a = get(a, key)
        b = get(b, key)
        return a === b ? 0 : a > b ? order : -order
    })

}

filters.orderBy.computed = true

// Array filter helpers -------------------------------------------------------

/**
 *  String contain helper
 */
function contains (val, search) {
    /* jshint eqeqeq: false */
    if (utils.isObject(val)) {
        for (var key in val) {
            if (contains(val[key], search)) {
                return true
            }
        }
    } else if (val != null) {
        return val.toString().toLowerCase().indexOf(search) > -1
    }
}

/**
 *  Test whether a string is in quotes,
 *  if yes return stripped string
 */
function stripQuotes (str) {
    if (QUOTE_RE.test(str)) {
        return str.slice(1, -1)
    }
}
},{"./utils":26}],22:[function(require,module,exports){
// string -> DOM conversion
// wrappers originally from jQuery, scooped from component/domify
var map = {
    legend   : [1, '<fieldset>', '</fieldset>'],
    tr       : [2, '<table><tbody>', '</tbody></table>'],
    col      : [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>'],
    _default : [0, '', '']
}

map.td =
map.th = [3, '<table><tbody><tr>', '</tr></tbody></table>']

map.option =
map.optgroup = [1, '<select multiple="multiple">', '</select>']

map.thead =
map.tbody =
map.colgroup =
map.caption =
map.tfoot = [1, '<table>', '</table>']

map.text =
map.circle =
map.ellipse =
map.line =
map.path =
map.polygon =
map.polyline =
map.rect = [1, '<svg xmlns="http://www.w3.org/2000/svg" version="1.1">','</svg>']

var TAG_RE = /<([\w:]+)/

module.exports = function (templateString) {
    var frag = document.createDocumentFragment(),
        m = TAG_RE.exec(templateString)
    // text only
    if (!m) {
        frag.appendChild(document.createTextNode(templateString))
        return frag
    }

    var tag = m[1],
        wrap = map[tag] || map._default,
        depth = wrap[0],
        prefix = wrap[1],
        suffix = wrap[2],
        node = document.createElement('div')

    node.innerHTML = prefix + templateString.trim() + suffix
    while (depth--) node = node.lastChild

    // one element
    if (node.firstChild === node.lastChild) {
        frag.appendChild(node.firstChild)
        return frag
    }

    // multiple nodes, return a fragment
    var child
    /* jshint boss: true */
    while (child = node.firstChild) {
        if (node.nodeType === 1) {
            frag.appendChild(child)
        }
    }
    return frag
}
},{}],23:[function(require,module,exports){
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
},{"./config":6,"./eventTarget":19,"./utils":26}],24:[function(require,module,exports){
var toFragment = require('./fragment')
    TextParser = require('./textParser'),
    ExpParser  = require('./ExpParser'),
    DepsParser = require('./DepsParser');

/**
 * Parses a template string or node and normalizes it into a
 * a node that can be used as a partial of a template option
 *
 * Possible values include
 * id selector: '#some-template-id'
 * template string: '<div><span>my template</span></div>'
 * DocumentFragment object
 * Node object of type Template
 */
function parseTemplate(template) {
    var templateNode;

    if (template instanceof window.DocumentFragment) {
        // if the template is already a document fragment -- do nothing
        return template
    }

    if (typeof template === 'string') {
        // template by ID
        if (template.charAt(0) === '#') {
            templateNode = document.getElementById(template.slice(1))
            if (!templateNode) return
        } else {
            return toFragment(template)
        }
    } else if (template.nodeType) {
        templateNode = template
    } else {
        return
    }

    // if its a template tag and the browser supports it,
    // its content is already a document fragment!
    if (templateNode.tagName === 'TEMPLATE' && templateNode.content) {
        return templateNode.content
    }

    if (templateNode.tagName === 'SCRIPT') {
        return toFragment(templateNode.innerHTML)
    }

    return toFragment(templateNode.outerHTML);
}

module.exports = {
    parseTemplate: parseTemplate,
    TextParser: TextParser,
    ExpParser: ExpParser,
    DepsParser: DepsParser
};
},{"./DepsParser":1,"./ExpParser":2,"./fragment":22,"./textParser":25}],25:[function(require,module,exports){
var openChar        = '{',
    endChar         = '}',
    ESCAPE_RE       = /[-.*+?^${}()|[\]\/\\]/g,
    // lazy require
    Directive

exports.Regex = buildInterpolationRegex()

function buildInterpolationRegex () {
    var open = escapeRegex(openChar),
        end  = escapeRegex(endChar)
    return new RegExp(open + open + open + '?(.+?)' + end + '?' + end + end)
}

function escapeRegex (str) {
    return str.replace(ESCAPE_RE, '\\$&')
}

function setDelimiters (delimiters) {
    openChar = delimiters[0]
    endChar = delimiters[1]
    exports.delimiters = delimiters
    exports.Regex = buildInterpolationRegex()
}

/** 
 *  Parse a piece of text, return an array of tokens
 *  token types:
 *  1. plain string
 *  2. object with key = binding key
 *  3. object with key & html = true
 */
function parse (text) {
    if (!exports.Regex.test(text)) return null
    var m, i, token, match, tokens = []
    /* jshint boss: true */
    while (m = text.match(exports.Regex)) {
        i = m.index
        if (i > 0) tokens.push(text.slice(0, i))
        token = { key: m[1].trim() }
        match = m[0]
        token.html =
            match.charAt(2) === openChar &&
            match.charAt(match.length - 3) === endChar
        tokens.push(token)
        text = text.slice(i + m[0].length)
    }
    if (text.length) tokens.push(text)
    return tokens
}

/**
 *  Parse an attribute value with possible interpolation tags
 *  return a Directive-friendly expression
 *
 *  e.g.  a {{b}} c  =>  "a " + b + " c"
 */
function parseAttr (attr) {
    Directive = Directive || require('./directive')
    var tokens = parse(attr)
    if (!tokens) return null
    if (tokens.length === 1) return tokens[0].key
    var res = [], token
    for (var i = 0, l = tokens.length; i < l; i++) {
        token = tokens[i]
        res.push(
            token.key
                ? inlineFilters(token.key)
                : ('"' + token + '"')
        )
    }
    return res.join('+')
}

/**
 *  Inlines any possible filters in a binding
 *  so that we can combine everything into a huge expression
 */
function inlineFilters (key) {
    if (key.indexOf('|') > -1) {
        var dirs = Directive.parse(key),
            dir = dirs && dirs[0]
        if (dir && dir.filters) {
            key = Directive.inlineFilters(
                dir.key,
                dir.filters
            )
        }
    }
    return '(' + key + ')'
}

exports.parse         = parse
exports.parseAttr     = parseAttr
exports.setDelimiters = setDelimiters
exports.delimiters    = [openChar, endChar]
},{"./directive":8}],26:[function(require,module,exports){
/**
 * utils
 *
 * @author: xuejia.cxj/6174
 */

var win = typeof window !== "undefined" ?  window : {
        setTimeout: setTimeout
    };

var config       = require('./config'),
    class2type   = {},
    rword        = /[^, ]+/g,
    BRACKET_RE_S = /\['([^']+)'\]/g,
    BRACKET_RE_D = /\["([^"]+)"\]/g;
    isString     = isType('String'),
    isFunction   = isType('Function'),
    isUndefined  = isType('Undefined'),
    isObject     = isType('Object'),
    isArray      = Array.isArray || isType('Array'),
    hasOwn       = Object.prototype.hasOwnProperty,
    serialize    = Object.prototype.toString,
    def          = Object.defineProperty,
    defer        = win.requestAnimationFrame || win.webkitRequestAnimationFrame || win.setTimeout,
"Boolean Number String Function Array Date RegExp Object Error".replace(rword, function(name) {
    class2type["[object " + name + "]"] = name.toLowerCase()
});
/**
 * Object utils
 */
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
    keys: function (obj) {
        var _keys = Object.keys,
            ret = [];

        if (isObject(obj)) {
            if (_keys) {
                ret = _keys(obj);
            } else {
                for (var k in obj) {
                    if (hasOwn.call(obj,k)) {
                        ret.push(k);
                    }
                }
            }
        }
        return ret;
    },
    toArray: function(object){
        var res = [], val, data
        for (var key in obj) {
            val = obj[key]
            data = isObject(val)
                ? val
                : { $value: val }
            data.$key = key
            res.push(data)
        }
        return res;
    },
    /**
     *  Define an ienumerable property
     *  This avoids it being included in JSON.stringify
     *  or for...in loops.
     */
    defProtected: function (obj, key, val, enumerable, writable) {
        def(obj, key, {
            value        : val,
            enumerable   : enumerable,
            writable     : writable,
            configurable : true
        })
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
/**
 * array utils
 */
var array = {
    indexOf: function(element, arr) {
        if (!isArray(arr)) {
            return -1;
        }
        return arr.indexOf(element);
    },
    unique: function (arr) {
        var hash = {},
            i = arr.length,
            key, res = []
        while (i--) {
            key = arr[i]
            if (hash[key]) continue;
            hash[key] = 1
            res.push(key)
        }
        return res;
    }
};
/** 
 * dom utils
 */
var dom = {
    attr: function(el, type) {
        var attr = config.prefix + '-' + type,
            val = el.getAttribute(attr)
        if (val !== null) {
            el.removeAttribute(attr)
        }
        return val
    },
    query: function (el) {
        return typeof el === 'string'
            ? document.querySelector(el)
            : el;
    }
};

 /**
 *  Make sure null and undefined output empty string
 */
function guard(value) {
    /* jshint eqeqeq: false, eqnull: true */
    return value == null
        ? ''
        : (typeof value == 'object')
            ? JSON.stringify(value)
            : value;
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
/**
 *  Normalize keypath with possible brackets into dot notations
 */
function normalizeKeypath(key) {
    return key.indexOf('[') < 0 ? key : key.replace(BRACKET_RE_S, '.$1').replace(BRACKET_RE_D, '.$1')
}

function getType(obj) {
    if (obj == null) {
        return String(obj);
    }
    return typeof obj === "object" || typeof obj === "function" ? class2type[serialize.call(obj)] || "object" : typeof obj;
}

function isType(type) {
    return function(obj) {
        return {}.toString.call(obj) === '[object ' + type + ']';
    }
}

function isEqual(v1, v2) {
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

function nextTick(cb) {
    defer(cb, 0)
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
module.exports = {
    object: object,
    array: array,
    dom: dom,
    getType: getType,
    isArray: isArray,
    isObject: isObject,
    isString: isString,
    hash: object.hash,
    isFunction: isFunction,
    isEqual: isEqual,
    mix: mix,
    merge: merge,
    guid: guid,
    hasOwn: hasOwn,
    serialize: serialize,
    each: each,
    log: log,
    warn: warn,
    nextTick: nextTick,
    guard: guard
}
},{"./config":6}],27:[function(require,module,exports){
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
	'$destroy': function destroy(noRemove){
		this.$compiler.destroy(noRemove);
	},
	'$get': function get(key){
		var val = utils.object.get(this, key);
		return val === undefined && this.$parent
		        ? this.$parent.$get(key)
		        : val;
	},
	'$set': function set(key, value){
		utils.object.set(this, key, value);
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
        cb && utils.nextTick(cb);
	},
	'$remove': function remove(target, cb){
		target = utils.dom.query(target);
		var el = this.$el;
		if(el.parentNode){
			el.parentNode.removeChild(el);
		}
		cb && utils.nextTick(cb);
	},
	'$before': function before(target, cb){
		target = utils.dom.query(target);
		var el = this.$el;
		target.parentNode.insertBefore(el, target);
		cb && utils.nextTick(cb);
	},
	'$after': function after(target, cb){
		target = util.dom.query(target);
		var el = this.$el;
		if(target.nextSibling) {
			target.parentNode.insertBefore(el, target.nextSibling);
		}else{
			target.parentNode.appendChild(el);
		}
		cb && utils.nextTick(cb);
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

},{"./batcher":3,"./compiler":5,"./utils":26}]},{},[20])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9ub2RlX21vZHVsZXMvZ3VscC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL0RlcHNQYXJzZXIuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL0V4cFBhcnNlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvYmF0Y2hlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvYmluZGluZy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvY29tcGlsZXIuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2NvbmZpZy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZGVmZXJyZWQuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2RpcmVjdGl2ZS5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZGlyZWN0aXZlcy9odG1sLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL2lmLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL2luZGV4LmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL21vZGVsLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL29uLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL3BhcnRpYWwuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2RpcmVjdGl2ZXMvcmVwZWF0LmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL3N0eWxlLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL3ZpZXcuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2RpcmVjdGl2ZXMvd2l0aC5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZXZlbnRUYXJnZXQuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2Zha2VfOWFiMmVkZDYuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2ZpbHRlcnMuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2ZyYWdtZW50LmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9vYnNlcnZlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvcGFyc2VyLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy90ZXh0UGFyc2VyLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy91dGlscy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvdmlld21vZGVsLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzMvQkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pRQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5SEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4WEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9GQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hVQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpfXZhciBmPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChmLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGYsZi5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJ2YXIgRXZlbnRUYXJnZXQgID0gcmVxdWlyZSgnLi9ldmVudFRhcmdldCcpLFxuICAgIHV0aWxzICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuICAgIE9ic2VydmVyID0gcmVxdWlyZSgnLi9vYnNlcnZlcicpLFxuICAgIGNhdGNoZXIgID0gbmV3IEV2ZW50VGFyZ2V0KCk7XG5cbi8qKlxuICogIEF1dG8tZXh0cmFjdCB0aGUgZGVwZW5kZW5jaWVzIG9mIGEgY29tcHV0ZWQgcHJvcGVydHlcbiAqICBieSByZWNvcmRpbmcgdGhlIGdldHRlcnMgdHJpZ2dlcmVkIHdoZW4gZXZhbHVhdGluZyBpdC5cbiAqL1xuZnVuY3Rpb24gY2F0Y2hEZXBzIChiaW5kaW5nKSB7XG4gICAgaWYgKGJpbmRpbmcuaXNGbikgcmV0dXJuXG4gICAgdXRpbHMubG9nKCdcXG4tICcgKyBiaW5kaW5nLmtleSlcbiAgICB2YXIgZ290ID0gdXRpbHMuaGFzaCgpXG4gICAgYmluZGluZy5kZXBzID0gW11cbiAgICBjYXRjaGVyLm9uKCdnZXQnLCBmdW5jdGlvbiAoZGVwKSB7XG4gICAgICAgIHZhciBoYXMgPSBnb3RbZGVwLmtleV1cbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgLy8gYXZvaWQgZHVwbGljYXRlIGJpbmRpbmdzXG4gICAgICAgICAgICAoaGFzICYmIGhhcy5jb21waWxlciA9PT0gZGVwLmNvbXBpbGVyKSB8fFxuICAgICAgICAgICAgLy8gYXZvaWQgcmVwZWF0ZWQgaXRlbXMgYXMgZGVwZW5kZW5jeVxuICAgICAgICAgICAgLy8gb25seSB3aGVuIHRoZSBiaW5kaW5nIGlzIGZyb20gc2VsZiBvciB0aGUgcGFyZW50IGNoYWluXG4gICAgICAgICAgICAoZGVwLmNvbXBpbGVyLnJlcGVhdCAmJiAhaXNQYXJlbnRPZihkZXAuY29tcGlsZXIsIGJpbmRpbmcuY29tcGlsZXIpKVxuICAgICAgICApIHtcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG4gICAgICAgIGdvdFtkZXAua2V5XSA9IGRlcFxuICAgICAgICB1dGlscy5sb2coJyAgLSAnICsgZGVwLmtleSlcbiAgICAgICAgYmluZGluZy5kZXBzLnB1c2goZGVwKVxuICAgICAgICBkZXAuc3Vicy5wdXNoKGJpbmRpbmcpXG4gICAgfSlcbiAgICBiaW5kaW5nLnZhbHVlLiRnZXQoKVxuICAgIGNhdGNoZXIub2ZmKCdnZXQnKVxufVxuXG4vKipcbiAqICBUZXN0IGlmIEEgaXMgYSBwYXJlbnQgb2Ygb3IgZXF1YWxzIEJcbiAqL1xuZnVuY3Rpb24gaXNQYXJlbnRPZiAoYSwgYikge1xuICAgIHdoaWxlIChiKSB7XG4gICAgICAgIGlmIChhID09PSBiKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICB9XG4gICAgICAgIGIgPSBiLnBhcmVudFxuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICAvKipcbiAgICAgKiAgdGhlIG9ic2VydmVyIHRoYXQgY2F0Y2hlcyBldmVudHMgdHJpZ2dlcmVkIGJ5IGdldHRlcnNcbiAgICAgKi9cbiAgICBjYXRjaGVyOiBjYXRjaGVyLFxuXG4gICAgLyoqXG4gICAgICogIHBhcnNlIGEgbGlzdCBvZiBjb21wdXRlZCBwcm9wZXJ0eSBiaW5kaW5nc1xuICAgICAqL1xuICAgIHBhcnNlOiBmdW5jdGlvbiAoYmluZGluZ3MpIHtcbiAgICAgICAgdXRpbHMubG9nKCdcXG5wYXJzaW5nIGRlcGVuZGVuY2llcy4uLicpXG4gICAgICAgIE9ic2VydmVyLnNob3VsZEdldCA9IHRydWVcbiAgICAgICAgYmluZGluZ3MuZm9yRWFjaChjYXRjaERlcHMpXG4gICAgICAgIE9ic2VydmVyLnNob3VsZEdldCA9IGZhbHNlXG4gICAgICAgIHV0aWxzLmxvZygnXFxuZG9uZS4nKVxuICAgIH1cbiAgICBcbn0iLCJ2YXIgdXRpbHMgICAgICAgICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuICAgIFNUUl9TQVZFX1JFICAgICA9IC9cIig/OlteXCJcXFxcXXxcXFxcLikqXCJ8Jyg/OlteJ1xcXFxdfFxcXFwuKSonL2csXG4gICAgU1RSX1JFU1RPUkVfUkUgID0gL1wiKFxcZCspXCIvZyxcbiAgICBORVdMSU5FX1JFICAgICAgPSAvXFxuL2csXG4gICAgQ1RPUl9SRSAgICAgICAgID0gbmV3IFJlZ0V4cCgnY29uc3RydWN0b3InLnNwbGl0KCcnKS5qb2luKCdbXFwnXCIrLCBdKicpKSxcbiAgICBVTklDT0RFX1JFICAgICAgPSAvXFxcXHVcXGRcXGRcXGRcXGQvXG5cbi8vIFZhcmlhYmxlIGV4dHJhY3Rpb24gc2Nvb3BlZCBmcm9tIGh0dHBzOi8vZ2l0aHViLmNvbS9SdWJ5TG91dnJlL2F2YWxvblxuXG52YXIgS0VZV09SRFMgPVxuICAgICAgICAvLyBrZXl3b3Jkc1xuICAgICAgICAnYnJlYWssY2FzZSxjYXRjaCxjb250aW51ZSxkZWJ1Z2dlcixkZWZhdWx0LGRlbGV0ZSxkbyxlbHNlLGZhbHNlJyArXG4gICAgICAgICcsZmluYWxseSxmb3IsZnVuY3Rpb24saWYsaW4saW5zdGFuY2VvZixuZXcsbnVsbCxyZXR1cm4sc3dpdGNoLHRoaXMnICtcbiAgICAgICAgJyx0aHJvdyx0cnVlLHRyeSx0eXBlb2YsdmFyLHZvaWQsd2hpbGUsd2l0aCx1bmRlZmluZWQnICtcbiAgICAgICAgLy8gcmVzZXJ2ZWRcbiAgICAgICAgJyxhYnN0cmFjdCxib29sZWFuLGJ5dGUsY2hhcixjbGFzcyxjb25zdCxkb3VibGUsZW51bSxleHBvcnQsZXh0ZW5kcycgK1xuICAgICAgICAnLGZpbmFsLGZsb2F0LGdvdG8saW1wbGVtZW50cyxpbXBvcnQsaW50LGludGVyZmFjZSxsb25nLG5hdGl2ZScgK1xuICAgICAgICAnLHBhY2thZ2UscHJpdmF0ZSxwcm90ZWN0ZWQscHVibGljLHNob3J0LHN0YXRpYyxzdXBlcixzeW5jaHJvbml6ZWQnICtcbiAgICAgICAgJyx0aHJvd3MsdHJhbnNpZW50LHZvbGF0aWxlJyArXG4gICAgICAgIC8vIEVDTUEgNSAtIHVzZSBzdHJpY3RcbiAgICAgICAgJyxhcmd1bWVudHMsbGV0LHlpZWxkJyArXG4gICAgICAgIC8vIGFsbG93IHVzaW5nIE1hdGggaW4gZXhwcmVzc2lvbnNcbiAgICAgICAgJyxNYXRoJyxcbiAgICAgICAgXG4gICAgS0VZV09SRFNfUkUgPSBuZXcgUmVnRXhwKFtcIlxcXFxiXCIgKyBLRVlXT1JEUy5yZXBsYWNlKC8sL2csICdcXFxcYnxcXFxcYicpICsgXCJcXFxcYlwiXS5qb2luKCd8JyksICdnJyksXG4gICAgUkVNT1ZFX1JFICAgPSAvXFwvXFwqKD86LnxcXG4pKj9cXCpcXC98XFwvXFwvW15cXG5dKlxcbnxcXC9cXC9bXlxcbl0qJHwnW14nXSonfFwiW15cIl0qXCJ8W1xcc1xcdFxcbl0qXFwuW1xcc1xcdFxcbl0qWyRcXHdcXC5dK3xbXFx7LF1cXHMqW1xcd1xcJF9dK1xccyo6L2csXG4gICAgU1BMSVRfUkUgICAgPSAvW15cXHckXSsvZyxcbiAgICBOVU1CRVJfUkUgICA9IC9cXGJcXGRbXixdKi9nLFxuICAgIEJPVU5EQVJZX1JFID0gL14sK3wsKyQvZ1xuXG4vKipcbiAqICBTdHJpcCB0b3AgbGV2ZWwgdmFyaWFibGUgbmFtZXMgZnJvbSBhIHNuaXBwZXQgb2YgSlMgZXhwcmVzc2lvblxuICovXG5mdW5jdGlvbiBnZXRWYXJpYWJsZXMgKGNvZGUpIHtcbiAgICBjb2RlID0gY29kZVxuICAgICAgICAucmVwbGFjZShSRU1PVkVfUkUsICcnKVxuICAgICAgICAucmVwbGFjZShTUExJVF9SRSwgJywnKVxuICAgICAgICAucmVwbGFjZShLRVlXT1JEU19SRSwgJycpXG4gICAgICAgIC5yZXBsYWNlKE5VTUJFUl9SRSwgJycpXG4gICAgICAgIC5yZXBsYWNlKEJPVU5EQVJZX1JFLCAnJylcbiAgICByZXR1cm4gY29kZVxuICAgICAgICA/IGNvZGUuc3BsaXQoLywrLylcbiAgICAgICAgOiBbXVxufVxuXG4vKipcbiAqICBBIGdpdmVuIHBhdGggY291bGQgcG90ZW50aWFsbHkgZXhpc3Qgbm90IG9uIHRoZVxuICogIGN1cnJlbnQgY29tcGlsZXIsIGJ1dCB1cCBpbiB0aGUgcGFyZW50IGNoYWluIHNvbWV3aGVyZS5cbiAqICBUaGlzIGZ1bmN0aW9uIGdlbmVyYXRlcyBhbiBhY2Nlc3MgcmVsYXRpb25zaGlwIHN0cmluZ1xuICogIHRoYXQgY2FuIGJlIHVzZWQgaW4gdGhlIGdldHRlciBmdW5jdGlvbiBieSB3YWxraW5nIHVwXG4gKiAgdGhlIHBhcmVudCBjaGFpbiB0byBjaGVjayBmb3Iga2V5IGV4aXN0ZW5jZS5cbiAqXG4gKiAgSXQgc3RvcHMgYXQgdG9wIHBhcmVudCBpZiBubyB2bSBpbiB0aGUgY2hhaW4gaGFzIHRoZVxuICogIGtleS4gSXQgdGhlbiBjcmVhdGVzIGFueSBtaXNzaW5nIGJpbmRpbmdzIG9uIHRoZVxuICogIGZpbmFsIHJlc29sdmVkIHZtLlxuICovXG5mdW5jdGlvbiB0cmFjZVNjb3BlIChwYXRoLCBjb21waWxlciwgZGF0YSkge1xuICAgIHZhciByZWwgID0gJycsXG4gICAgICAgIGRpc3QgPSAwLFxuICAgICAgICBzZWxmID0gY29tcGlsZXJcblxuICAgIGlmIChkYXRhICYmIHV0aWxzLm9iamVjdC5nZXQoZGF0YSwgcGF0aCkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBoYWNrOiB0ZW1wb3JhcmlseSBhdHRhY2hlZCBkYXRhXG4gICAgICAgIHJldHVybiAnJHRlbXAuJ1xuICAgIH1cblxuICAgIHdoaWxlIChjb21waWxlcikge1xuICAgICAgICBpZiAoY29tcGlsZXIuaGFzS2V5KHBhdGgpKSB7XG4gICAgICAgICAgICBicmVha1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29tcGlsZXIgPSBjb21waWxlci5wYXJlbnRcbiAgICAgICAgICAgIGRpc3QrK1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChjb21waWxlcikge1xuICAgICAgICB3aGlsZSAoZGlzdC0tKSB7XG4gICAgICAgICAgICByZWwgKz0gJyRwYXJlbnQuJ1xuICAgICAgICB9XG4gICAgICAgIGlmICghY29tcGlsZXIuYmluZGluZ3NbcGF0aF0gJiYgcGF0aC5jaGFyQXQoMCkgIT09ICckJykge1xuICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhwYXRoKVxuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgc2VsZi5jcmVhdGVCaW5kaW5nKHBhdGgpXG4gICAgfVxuICAgIHJldHVybiByZWxcbn1cblxuLyoqXG4gKiAgQ3JlYXRlIGEgZnVuY3Rpb24gZnJvbSBhIHN0cmluZy4uLlxuICogIHRoaXMgbG9va3MgbGlrZSBldmlsIG1hZ2ljIGJ1dCBzaW5jZSBhbGwgdmFyaWFibGVzIGFyZSBsaW1pdGVkXG4gKiAgdG8gdGhlIFZNJ3MgZGF0YSBpdCdzIGFjdHVhbGx5IHByb3Blcmx5IHNhbmRib3hlZFxuICovXG5mdW5jdGlvbiBtYWtlR2V0dGVyIChleHAsIHJhdykge1xuICAgIHZhciBmblxuICAgIHRyeSB7XG4gICAgICAgIGZuID0gbmV3IEZ1bmN0aW9uKGV4cClcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHV0aWxzLndhcm4oJ0Vycm9yIHBhcnNpbmcgZXhwcmVzc2lvbjogJyArIHJhdylcbiAgICB9XG4gICAgcmV0dXJuIGZuXG59XG5cbi8qKlxuICogIEVzY2FwZSBhIGxlYWRpbmcgZG9sbGFyIHNpZ24gZm9yIHJlZ2V4IGNvbnN0cnVjdGlvblxuICovXG5mdW5jdGlvbiBlc2NhcGVEb2xsYXIgKHYpIHtcbiAgICByZXR1cm4gdi5jaGFyQXQoMCkgPT09ICckJ1xuICAgICAgICA/ICdcXFxcJyArIHZcbiAgICAgICAgOiB2XG59XG5cbi8qKlxuICogIFBhcnNlIGFuZCByZXR1cm4gYW4gYW5vbnltb3VzIGNvbXB1dGVkIHByb3BlcnR5IGdldHRlciBmdW5jdGlvblxuICogIGZyb20gYW4gYXJiaXRyYXJ5IGV4cHJlc3Npb24sIHRvZ2V0aGVyIHdpdGggYSBsaXN0IG9mIHBhdGhzIHRvIGJlXG4gKiAgY3JlYXRlZCBhcyBiaW5kaW5ncy5cbiAqL1xuZXhwb3J0cy5wYXJzZSA9IGZ1bmN0aW9uIChleHAsIGNvbXBpbGVyLCBkYXRhKSB7XG4gICAgLy8gdW5pY29kZSBhbmQgJ2NvbnN0cnVjdG9yJyBhcmUgbm90IGFsbG93ZWQgZm9yIFhTUyBzZWN1cml0eS5cbiAgICBpZiAoVU5JQ09ERV9SRS50ZXN0KGV4cCkgfHwgQ1RPUl9SRS50ZXN0KGV4cCkpIHtcbiAgICAgICAgdXRpbHMud2FybignVW5zYWZlIGV4cHJlc3Npb246ICcgKyBleHApXG4gICAgICAgIHJldHVyblxuICAgIH1cbiAgICAvLyBleHRyYWN0IHZhcmlhYmxlIG5hbWVzXG4gICAgdmFyIHZhcnMgPSBnZXRWYXJpYWJsZXMoZXhwKVxuICAgIGlmICghdmFycy5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIG1ha2VHZXR0ZXIoJ3JldHVybiAnICsgZXhwLCBleHApXG4gICAgfVxuICAgIHZhcnMgPSB1dGlscy5hcnJheS51bmlxdWUodmFycyk7XG5cbiAgICB2YXIgYWNjZXNzb3JzID0gJycsXG4gICAgICAgIGhhcyAgICAgICA9IHV0aWxzLmhhc2goKSxcbiAgICAgICAgc3RyaW5ncyAgID0gW10sXG4gICAgICAgIC8vIGNvbnN0cnVjdCBhIHJlZ2V4IHRvIGV4dHJhY3QgYWxsIHZhbGlkIHZhcmlhYmxlIHBhdGhzXG4gICAgICAgIC8vIG9uZXMgdGhhdCBiZWdpbiB3aXRoIFwiJFwiIGFyZSBwYXJ0aWN1bGFybHkgdHJpY2t5XG4gICAgICAgIC8vIGJlY2F1c2Ugd2UgY2FuJ3QgdXNlIFxcYiBmb3IgdGhlbVxuICAgICAgICBwYXRoUkUgPSBuZXcgUmVnRXhwKFxuICAgICAgICAgICAgXCJbXiRcXFxcd1xcXFwuXShcIiArXG4gICAgICAgICAgICB2YXJzLm1hcChlc2NhcGVEb2xsYXIpLmpvaW4oJ3wnKSArXG4gICAgICAgICAgICBcIilbJFxcXFx3XFxcXC5dKlxcXFxiXCIsICdnJ1xuICAgICAgICApLFxuICAgICAgICBib2R5ID0gKCcgJyArIGV4cClcbiAgICAgICAgICAgIC5yZXBsYWNlKFNUUl9TQVZFX1JFLCBzYXZlU3RyaW5ncylcbiAgICAgICAgICAgIC5yZXBsYWNlKHBhdGhSRSwgcmVwbGFjZVBhdGgpXG4gICAgICAgICAgICAucmVwbGFjZShTVFJfUkVTVE9SRV9SRSwgcmVzdG9yZVN0cmluZ3MpXG5cbiAgICBib2R5ID0gYWNjZXNzb3JzICsgJ3JldHVybiAnICsgYm9keVxuXG4gICAgZnVuY3Rpb24gc2F2ZVN0cmluZ3MgKHN0cikge1xuICAgICAgICB2YXIgaSA9IHN0cmluZ3MubGVuZ3RoXG4gICAgICAgIC8vIGVzY2FwZSBuZXdsaW5lcyBpbiBzdHJpbmdzIHNvIHRoZSBleHByZXNzaW9uXG4gICAgICAgIC8vIGNhbiBiZSBjb3JyZWN0bHkgZXZhbHVhdGVkXG4gICAgICAgIHN0cmluZ3NbaV0gPSBzdHIucmVwbGFjZShORVdMSU5FX1JFLCAnXFxcXG4nKVxuICAgICAgICByZXR1cm4gJ1wiJyArIGkgKyAnXCInXG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVwbGFjZVBhdGggKHBhdGgpIHtcbiAgICAgICAgLy8ga2VlcCB0cmFjayBvZiB0aGUgZmlyc3QgY2hhclxuICAgICAgICB2YXIgYyA9IHBhdGguY2hhckF0KDApXG4gICAgICAgIHBhdGggPSBwYXRoLnNsaWNlKDEpXG4gICAgICAgIHZhciB2YWwgPSAndGhpcy4nICsgdHJhY2VTY29wZShwYXRoLCBjb21waWxlciwgZGF0YSkgKyBwYXRoXG4gICAgICAgIGlmICghaGFzW3BhdGhdKSB7XG4gICAgICAgICAgICBhY2Nlc3NvcnMgKz0gdmFsICsgJzsnXG4gICAgICAgICAgICBoYXNbcGF0aF0gPSAxXG4gICAgICAgIH1cbiAgICAgICAgLy8gZG9uJ3QgZm9yZ2V0IHRvIHB1dCB0aGF0IGZpcnN0IGNoYXIgYmFja1xuICAgICAgICByZXR1cm4gYyArIHZhbFxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlc3RvcmVTdHJpbmdzIChzdHIsIGkpIHtcbiAgICAgICAgcmV0dXJuIHN0cmluZ3NbaV1cbiAgICB9XG5cbiAgICByZXR1cm4gbWFrZUdldHRlcihib2R5LCBleHApXG59XG5cbi8qKlxuICogIEV2YWx1YXRlIGFuIGV4cHJlc3Npb24gaW4gdGhlIGNvbnRleHQgb2YgYSBjb21waWxlci5cbiAqICBBY2NlcHRzIGFkZGl0aW9uYWwgZGF0YS5cbiAqL1xuZXhwb3J0cy5ldmFsID0gZnVuY3Rpb24gKGV4cCwgY29tcGlsZXIsIGRhdGEpIHtcbiAgICB2YXIgZ2V0dGVyID0gZXhwb3J0cy5wYXJzZShleHAsIGNvbXBpbGVyLCBkYXRhKSwgcmVzXG4gICAgaWYgKGdldHRlcikge1xuICAgICAgICAvLyBoYWNrOiB0ZW1wb3JhcmlseSBhdHRhY2ggdGhlIGFkZGl0aW9uYWwgZGF0YSBzb1xuICAgICAgICAvLyBpdCBjYW4gYmUgYWNjZXNzZWQgaW4gdGhlIGdldHRlclxuICAgICAgICBjb21waWxlci52bS4kdGVtcCA9IGRhdGFcbiAgICAgICAgcmVzID0gZ2V0dGVyLmNhbGwoY29tcGlsZXIudm0pXG4gICAgICAgIGRlbGV0ZSBjb21waWxlci52bS4kdGVtcFxuICAgIH1cbiAgICByZXR1cm4gcmVzXG59IiwidmFyIHV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpXG5cbmZ1bmN0aW9uIEJhdGNoZXIgKCkge1xuICAgIHRoaXMucmVzZXQoKTtcbn1cblxudmFyIEJhdGNoZXJQcm90byA9IEJhdGNoZXIucHJvdG90eXBlXG5cbkJhdGNoZXJQcm90by5wdXNoID0gZnVuY3Rpb24gKGpvYikge1xuICAgIGlmICgham9iLmlkIHx8ICF0aGlzLmhhc1tqb2IuaWRdKSB7XG4gICAgICAgIHRoaXMucXVldWUucHVzaChqb2IpXG4gICAgICAgIHRoaXMuaGFzW2pvYi5pZF0gPSBqb2JcbiAgICAgICAgaWYgKCF0aGlzLndhaXRpbmcpIHtcbiAgICAgICAgICAgIHRoaXMud2FpdGluZyA9IHRydWVcbiAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKHV0aWxzLm9iamVjdC5iaW5kKHRoaXMuZmx1c2gsIHRoaXMpKVxuICAgICAgICB9XG4gICAgfSBlbHNlIGlmIChqb2Iub3ZlcnJpZGUpIHtcbiAgICAgICAgdmFyIG9sZEpvYiA9IHRoaXMuaGFzW2pvYi5pZF1cbiAgICAgICAgb2xkSm9iLmNhbmNlbGxlZCA9IHRydWVcbiAgICAgICAgdGhpcy5xdWV1ZS5wdXNoKGpvYilcbiAgICAgICAgdGhpcy5oYXNbam9iLmlkXSA9IGpvYlxuICAgIH1cbn1cblxuQmF0Y2hlclByb3RvLmZsdXNoID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIGJlZm9yZSBmbHVzaCBob29rXG4gICAgaWYgKHRoaXMuX3ByZUZsdXNoKSB0aGlzLl9wcmVGbHVzaCgpXG4gICAgLy8gZG8gbm90IGNhY2hlIGxlbmd0aCBiZWNhdXNlIG1vcmUgam9icyBtaWdodCBiZSBwdXNoZWRcbiAgICAvLyBhcyB3ZSBleGVjdXRlIGV4aXN0aW5nIGpvYnNcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIGpvYiA9IHRoaXMucXVldWVbaV1cbiAgICAgICAgaWYgKCFqb2IuY2FuY2VsbGVkKSB7XG4gICAgICAgICAgICBqb2IuZXhlY3V0ZSgpXG4gICAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5yZXNldCgpXG59XG5cbkJhdGNoZXJQcm90by5yZXNldCA9IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLmhhcyA9IHV0aWxzLm9iamVjdC5oYXNoKClcbiAgICB0aGlzLnF1ZXVlID0gW11cbiAgICB0aGlzLndhaXRpbmcgPSBmYWxzZVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEJhdGNoZXIiLCJ2YXIgQmF0Y2hlciAgICAgICAgPSByZXF1aXJlKCcuL2JhdGNoZXInKSxcbiAgICBiaW5kaW5nQmF0Y2hlciA9IG5ldyBCYXRjaGVyKCksXG4gICAgYmluZGluZ0lkICAgICAgPSAxXG5cbi8qKlxuICogIEJJTkRJTkcgQ0xBU1MuXG4gKlxuICogIEVBQ0ggUFJPUEVSVFkgT04gVEhFIFZJRVdNT0RFTCBIQVMgT05FIENPUlJFU1BPTkRJTkcgQklORElORyBPQkpFQ1RcbiAqICBXSElDSCBIQVMgTVVMVElQTEUgRElSRUNUSVZFIElOU1RBTkNFUyBPTiBUSEUgRE9NXG4gKiAgQU5EIE1VTFRJUExFIENPTVBVVEVEIFBST1BFUlRZIERFUEVOREVOVFNcbiAqL1xuZnVuY3Rpb24gQmluZGluZyAoY29tcGlsZXIsIGtleSwgaXNFeHAsIGlzRm4pIHtcbiAgICB0aGlzLmlkID0gYmluZGluZ0lkKytcbiAgICB0aGlzLnZhbHVlID0gdW5kZWZpbmVkXG4gICAgdGhpcy5pc0V4cCA9ICEhaXNFeHBcbiAgICB0aGlzLmlzRm4gPSBpc0ZuXG4gICAgdGhpcy5yb290ID0gIXRoaXMuaXNFeHAgJiYga2V5LmluZGV4T2YoJy4nKSA9PT0gLTFcbiAgICB0aGlzLmNvbXBpbGVyID0gY29tcGlsZXJcbiAgICB0aGlzLmtleSA9IGtleVxuICAgIHRoaXMuZGlycyA9IFtdXG4gICAgdGhpcy5zdWJzID0gW11cbiAgICB0aGlzLmRlcHMgPSBbXVxuICAgIHRoaXMudW5ib3VuZCA9IGZhbHNlXG59XG5cbnZhciBCaW5kaW5nUHJvdG8gPSBCaW5kaW5nLnByb3RvdHlwZVxuXG4vKipcbiAqICBVUERBVEUgVkFMVUUgQU5EIFFVRVVFIElOU1RBTkNFIFVQREFURVMuXG4gKi9cbkJpbmRpbmdQcm90by51cGRhdGUgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICBpZiAoIXRoaXMuaXNDb21wdXRlZCB8fCB0aGlzLmlzRm4pIHtcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlXG4gICAgfVxuICAgIGlmICh0aGlzLmRpcnMubGVuZ3RoIHx8IHRoaXMuc3Vicy5sZW5ndGgpIHtcbiAgICAgICAgdmFyIHNlbGYgPSB0aGlzXG4gICAgICAgIGJpbmRpbmdCYXRjaGVyLnB1c2goe1xuICAgICAgICAgICAgaWQ6IHRoaXMuaWQsXG4gICAgICAgICAgICBleGVjdXRlOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgc2VsZi5fdXBkYXRlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgfVxufVxuXG4vKipcbiAqICBBQ1RVQUxMWSBVUERBVEUgVEhFIERJUkVDVElWRVMuXG4gKi9cbkJpbmRpbmdQcm90by5fdXBkYXRlID0gZnVuY3Rpb24gKCkge1xuICAgIHZhciBpID0gdGhpcy5kaXJzLmxlbmd0aCxcbiAgICAgICAgdmFsdWUgPSB0aGlzLnZhbCgpXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICB0aGlzLmRpcnNbaV0uJHVwZGF0ZSh2YWx1ZSlcbiAgICB9XG4gICAgdGhpcy5wdWIoKVxufVxuXG4vKipcbiAqICBSRVRVUk4gVEhFIFZBTFVBVEVEIFZBTFVFIFJFR0FSRExFU1NcbiAqICBPRiBXSEVUSEVSIElUIElTIENPTVBVVEVEIE9SIE5PVFxuICovXG5CaW5kaW5nUHJvdG8udmFsID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmlzQ29tcHV0ZWQgJiYgIXRoaXMuaXNGblxuICAgICAgICA/IHRoaXMudmFsdWUuJGdldCgpXG4gICAgICAgIDogdGhpcy52YWx1ZTtcbn1cblxuLyoqXG4gKiAgTm90aWZ5IGNvbXB1dGVkIHByb3BlcnRpZXMgdGhhdCBkZXBlbmQgb24gdGhpcyBiaW5kaW5nXG4gKiAgdG8gdXBkYXRlIHRoZW1zZWx2ZXNcbiAqL1xuQmluZGluZ1Byb3RvLnB1YiA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgaSA9IHRoaXMuc3Vicy5sZW5ndGhcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIHRoaXMuc3Vic1tpXS51cGRhdGUoKTtcbiAgICB9XG59XG5cbi8qKlxuICogIFVuYmluZCB0aGUgYmluZGluZywgcmVtb3ZlIGl0c2VsZiBmcm9tIGFsbCBvZiBpdHMgZGVwZW5kZW5jaWVzXG4gKi9cbkJpbmRpbmdQcm90by51bmJpbmQgPSBmdW5jdGlvbiAoKSB7XG4gICAgLy8gSW5kaWNhdGUgdGhpcyBoYXMgYmVlbiB1bmJvdW5kLlxuICAgIC8vIEl0J3MgcG9zc2libGUgdGhpcyBiaW5kaW5nIHdpbGwgYmUgaW5cbiAgICAvLyB0aGUgYmF0Y2hlcidzIGZsdXNoIHF1ZXVlIHdoZW4gaXRzIG93bmVyXG4gICAgLy8gY29tcGlsZXIgaGFzIGFscmVhZHkgYmVlbiBkZXN0cm95ZWQuXG4gICAgdGhpcy51bmJvdW5kID0gdHJ1ZVxuICAgIHZhciBpID0gdGhpcy5kaXJzLmxlbmd0aFxuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgdGhpcy5kaXJzW2ldLiR1bmJpbmQoKVxuICAgIH1cbiAgICBpID0gdGhpcy5kZXBzLmxlbmd0aFxuICAgIHZhciBzdWJzXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICBzdWJzID0gdGhpcy5kZXBzW2ldLnN1YnNcbiAgICAgICAgdmFyIGogPSBzdWJzLmluZGV4T2YodGhpcylcbiAgICAgICAgaWYgKGogPiAtMSkgc3Vicy5zcGxpY2UoaiwgMSlcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gQmluZGluZyIsIlxudmFyIEV2ZW50VGFyZ2V0ID0gcmVxdWlyZSgnLi9ldmVudFRhcmdldCcpLFxuXHR1dGlscyAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcblx0Y29uZmlnICAgICAgPSByZXF1aXJlKCcuL2NvbmZpZycpLFxuXHRCaW5kaW5nICAgICA9IHJlcXVpcmUoJy4vYmluZGluZycpLFxuXHRQYXJzZXIgICAgICA9IHJlcXVpcmUoJy4vcGFyc2VyJyksXG5cdE9ic2VydmVyICAgID0gcmVxdWlyZSgnLi9vYnNlcnZlcicpLFxuXHREaXJlY3RpdmUgICA9IHJlcXVpcmUoJy4vZGlyZWN0aXZlJyksXG5cdFRleHRQYXJzZXIgID0gUGFyc2VyLlRleHRQYXJzZXIsXG5cdEV4cFBhcnNlciAgID0gUGFyc2VyLkV4cFBhcnNlcixcblx0RGVwc1BhcnNlciAgPSBQYXJzZXIuRGVwc1BhcnNlcixcblx0Vmlld01vZGVsLFxuICAgIFxuICAgIC8vIENBQ0hFIE1FVEhPRFNcbiAgICBzbGljZSAgICAgICA9IFtdLnNsaWNlLFxuICAgIGhhc093biAgICAgID0gKHt9KS5oYXNPd25Qcm9wZXJ0eSxcbiAgICBkZWYgICAgICAgICA9IE9iamVjdC5kZWZpbmVQcm9wZXJ0eSxcblxuICAgIC8vIEhPT0tTIFRPIFJFR0lTVEVSXG4gICAgaG9va3MgICAgICAgPSBbJ2NyZWF0ZWQnLCAncmVhZHknLCAnYmVmb3JlRGVzdHJveScsICdhZnRlckRlc3Ryb3knLCAnYXR0YWNoZWQnLCAnZGV0YWNoZWQnXSxcblxuICAgIC8vIExJU1QgT0YgUFJJT1JJVFkgRElSRUNUSVZFU1xuICAgIC8vIFRIQVQgTkVFRFMgVE8gQkUgQ0hFQ0tFRCBJTiBTUEVDSUZJQyBPUkRFUlxuICAgIHByaW9yaXR5RGlyZWN0aXZlcyA9IFsnaWYnLCAncmVwZWF0JywgJ3ZpZXcnLCAnY29tcG9uZW50J107XG5cbi8qKlxuICogIFRIRSBET00gQ09NUElMRVJcbiAqICBTQ0FOUyBBIERPTSBOT0RFIEFORCBDT01QSUxFIEJJTkRJTkdTIEZPUiBBIFZJRVdNT0RFTFxuICovXG5mdW5jdGlvbiBDb21waWxlcih2bSwgb3B0aW9ucyl7XG5cdHRoaXMuX2luaXRlZCAgICA9IHRydWU7XG5cdHRoaXMuX2Rlc3Ryb3llZCA9IGZhbHNlO1xuXHR1dGlscy5taXgodGhpcywgb3B0aW9ucy5jb21waWxlck9wdGlvbnMpO1xuXHQvLyBSRVBFQVQgSU5ESUNBVEVTIFRISVMgSVMgQSBWLVJFUEVBVCBJTlNUQU5DRVxuXHR0aGlzLnJlcGVhdCA9IHRoaXMucmVwZWF0IHx8IGZhbHNlO1xuICAgIC8vIEVYUENBQ0hFIFdJTEwgQkUgU0hBUkVEIEJFVFdFRU4gVi1SRVBFQVQgSU5TVEFOQ0VTXG5cdHRoaXMuZXhwQ2FjaGUgPSB0aGlzLmV4cENhY2hlIHx8IHt9O1xuXG5cdC8vLS1JTlRJQUxJWkFUSU9OIFNUVUZGXG5cdHRoaXMudm0gPSB2bTtcblx0dGhpcy5vcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblx0dGhpcy5faW5pdE9wdGlvbnMoKTtcbiBcdHRoaXMuX2luaXRFbGVtZW50KCk7XG5cdHRoaXMuX2luaXRWTSgpO1xuXHR0aGlzLl9pbml0RGF0YSgpO1xuXHR0aGlzLl9zdGFydENvbXBpbGUoKTtcbn1cblxuLyoqXG4gKiBpbml0aWFsaXphdGlvbiBhbmQgZGVzdHJveVxuICovXG51dGlscy5taXgoQ29tcGlsZXIucHJvdG90eXBlLCB7XG5cdF9pbml0T3B0aW9uczogZnVuY3Rpb24oKXtcblx0XHR2YXIgb3B0aW9ucyA9IHRoaXMub3B0aW9uc1xuXHRcdHZhciBjb21wb25lbnRzID0gb3B0aW9ucy5jb21wb25lbnRzLFxuICAgICAgICAgICAgcGFydGlhbHMgICA9IG9wdGlvbnMucGFydGlhbHMsXG4gICAgICAgICAgICB0ZW1wbGF0ZSAgID0gb3B0aW9ucy50ZW1wbGF0ZSxcbiAgICAgICAgICAgIGZpbHRlcnMgICAgPSBvcHRpb25zLmZpbHRlcnMsXG4gICAgICAgICAgICBrZXk7XG5cbiAgICAgICAgaWYgKGNvbXBvbmVudHMpIHtcbiAgICAgICAgICAgIGZvciAoa2V5IGluIGNvbXBvbmVudHMpIHtcbiAgICAgICAgICAgICAgICBjb21wb25lbnRzW2tleV0gPSBWaWV3TW9kZWwuZXh0ZW5kKGNvbXBvbmVudHNba2V5XSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocGFydGlhbHMpIHtcbiAgICAgICAgICAgIGZvciAoa2V5IGluIHBhcnRpYWxzKSB7XG4gICAgICAgICAgICAgICAgcGFydGlhbHNba2V5XSA9IFBhcnNlci5wYXJzZXJUZW1wbGF0ZShwYXJ0aWFsc1trZXldKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdmFyIGZpbHRlciwgVEhJU19SRSA9IC9bXlxcd110aGlzW15cXHddLztcbiAgICAgICAgaWYgKGZpbHRlcnMpIHtcbiAgICAgICAgICAgIGZvciAoa2V5IGluIGZpbHRlcnMpIHtcbiAgICAgICAgICAgIFx0ZmlsdGVyID0gZmlsdGVyc1trZXldO1xuICAgICAgICAgICAgXHRpZiAoVEhJU19SRS50ZXN0KGZpbHRlci50b1N0cmluZygpKSkge1xuXHRcdCAgICAgICAgICAgIGZpbHRlci5jb21wdXRlZCA9IHRydWU7XG5cdFx0ICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGVtcGxhdGUpIHtcbiAgICAgICAgICAgIG9wdGlvbnMudGVtcGxhdGUgPSBQYXJzZXIucGFyc2VyVGVtcGxhdGUodGVtcGxhdGUpXG4gICAgICAgIH1cblx0fSxcblx0X2luaXRFbGVtZW50OiBmdW5jdGlvbigpe1xuXHRcdHZhciBvcHRpb25zID0gdGhpcy5vcHRpb25zLFxuXHRcdFx0dm0gICAgICA9IHRoaXMudm0sXG5cdCAgICBcdHRlbXBsYXRlID0gb3B0aW9ucy50ZW1wbGF0ZSwgXG5cdCAgICBcdGVsO1xuXG5cdFx0aW5pdEVsKCk7XG5cdCAgICByZXNvbHZlVGVtcGxhdGUoKTtcblx0ICAgIHJlc29sdmVFbGVtZW50T3B0aW9uKCk7XG5cblx0ICAgIHRoaXMuZWwgPSBlbDsgXG5cdFx0dGhpcy5lbC5fdm0gPSB2bTtcblx0XHR1dGlscy5sb2coJ25ldyBWTSBpbnN0YW5jZTogJyArIGVsLnRhZ05hbWUgKyAnXFxuJyk7XG5cdFx0XG5cdFx0Ly8gQ1JFQVRFIFRIRSBOT0RFIEZJUlNUXG5cdFx0ZnVuY3Rpb24gaW5pdEVsKCl7XG5cdFx0XHRlbCA9IHR5cGVvZiBvcHRpb25zLmVsID09PSAnc3RyaW5nJ1xuXHQgICAgICAgID8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihvcHRpb25zLmVsKVxuXHQgICAgICAgIDogb3B0aW9ucy5lbCB8fCBkb2N1bWVudC5jcmVhdGVFbGVtZW50KG9wdGlvbnMudGFnTmFtZSB8fCAnZGl2Jyk7XG5cdFx0fVxuXG5cdCAgICBmdW5jdGlvbiByZXNvbHZlVGVtcGxhdGUoKXtcblx0ICAgIFx0dmFyIGNoaWxkLCByZXBsYWNlciwgaTtcblx0ICAgIFx0Ly8gVEVNUExBVEUgSVMgQSBGUkFHTUVOVCBET0NVTUVOVFxuXHRcdCAgICBpZih0ZW1wbGF0ZSl7XG5cdFx0ICAgIFx0Ly8gQ09MTEVDVCBBTllUSElORyBBTFJFQURZIElOIFRIRVJFXG5cdFx0ICAgICAgICBpZiAoZWwuaGFzQ2hpbGROb2RlcygpKSB7XG5cdFx0ICAgICAgICAgICAgdGhpcy5yYXdDb250ZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jylcblx0XHQgICAgICAgICAgICB3aGlsZSAoY2hpbGQgPSBlbC5maXJzdENoaWxkKSB7XG5cdFx0ICAgICAgICAgICAgICAgIHRoaXMucmF3Q29udGVudC5hcHBlbmRDaGlsZChjaGlsZClcblx0XHQgICAgICAgICAgICB9XG5cdFx0ICAgICAgICB9XG5cdFx0ICAgICAgICAvLyBSRVBMQUNFIE9QVElPTjogVVNFIFRIRSBGSVJTVCBOT0RFIElOXG5cdFx0ICAgICAgICAvLyBUSEUgVEVNUExBVEUgRElSRUNUTFkgVE8gUkVQTEFDRSBFTFxuXHRcdCAgICAgICAgaWYgKG9wdGlvbnMucmVwbGFjZSAmJiB0ZW1wbGF0ZS5maXJzdENoaWxkID09PSB0ZW1wbGF0ZS5sYXN0Q2hpbGQpIHtcblx0XHQgICAgICAgICAgICByZXBsYWNlciA9IHRlbXBsYXRlLmZpcnN0Q2hpbGQuY2xvbmVOb2RlKHRydWUpXG5cdFx0ICAgICAgICAgICAgaWYgKGVsLnBhcmVudE5vZGUpIHtcblx0XHQgICAgICAgICAgICAgICAgZWwucGFyZW50Tm9kZS5pbnNlcnRCZWZvcmUocmVwbGFjZXIsIGVsKVxuXHRcdCAgICAgICAgICAgICAgICBlbC5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKGVsKVxuXHRcdCAgICAgICAgICAgIH1cblx0XHQgICAgICAgICAgICAvLyBDT1BZIE9WRVIgQVRUUklCVVRFU1xuXHRcdCAgICAgICAgICAgIGlmIChlbC5oYXNBdHRyaWJ1dGVzKCkpIHtcblx0XHQgICAgICAgICAgICAgICAgaSA9IGVsLmF0dHJpYnV0ZXMubGVuZ3RoXG5cdFx0ICAgICAgICAgICAgICAgIHdoaWxlIChpLS0pIHtcblx0XHQgICAgICAgICAgICAgICAgICAgIGF0dHIgPSBlbC5hdHRyaWJ1dGVzW2ldXG5cdFx0ICAgICAgICAgICAgICAgICAgICByZXBsYWNlci5zZXRBdHRyaWJ1dGUoYXR0ci5uYW1lLCBhdHRyLnZhbHVlKVxuXHRcdCAgICAgICAgICAgICAgICB9XG5cdFx0ICAgICAgICAgICAgfVxuXHRcdCAgICAgICAgICAgIC8vIFJFUExBQ0Vcblx0XHQgICAgICAgICAgICBlbCA9IHJlcGxhY2VyXG5cdFx0ICAgICAgICB9IGVsc2Uge1xuXHRcdCAgICAgICAgICAgIGVsLmFwcGVuZENoaWxkKHRlbXBsYXRlLmNsb25lTm9kZSh0cnVlKSlcblx0XHQgICAgICAgIH1cblx0XHQgICAgfVxuXHQgICAgfVxuXG5cdCAgICBmdW5jdGlvbiByZXNvbHZlRWxlbWVudE9wdGlvbigpe1xuXHQgICAgXHR2YXIgYXR0cnMsIGF0dHI7XG5cdFx0XHQvLyBBUFBMWSBFTEVNRU5UIE9QVElPTlNcblx0XHQgICAgaWYgKG9wdGlvbnMuaWQpIGVsLmlkID0gb3B0aW9ucy5pZFxuXHRcdCAgICBpZiAob3B0aW9ucy5jbGFzc05hbWUpIGVsLmNsYXNzTmFtZSA9IG9wdGlvbnMuY2xhc3NOYW1lXG5cdFx0ICAgIGF0dHJzID0gb3B0aW9ucy5hdHRyaWJ1dGVzXG5cdFx0ICAgIGlmIChhdHRycykge1xuXHRcdCAgICAgICAgZm9yIChhdHRyIGluIGF0dHJzKSB7XG5cdFx0ICAgICAgICAgICAgZWwuc2V0QXR0cmlidXRlKGF0dHIsIGF0dHJzW2F0dHJdKVxuXHRcdCAgICAgICAgfVxuXHRcdCAgICB9XG5cdFx0fVxuXHR9LFxuXHRfaW5pdFZNOiBmdW5jdGlvbigpe1xuXHRcdHZhciBvcHRpb25zICA9IHRoaXMub3B0aW9ucyxcblx0XHRcdGNvbXBpbGVyID0gdGhpcztcblx0XHRcdHZtICAgICAgID0gdGhpcy52bTtcblxuXHRcdC8vIENPTVBJTEVSIFxuXHRcdHV0aWxzLm1peCh0aGlzLCB7XG5cdFx0XHQvLyB2bSByZWZcblx0XHRcdHZtOiB2bSxcblx0XHRcdC8vIGJpbmRpbmdzIGZvciBhbGxcblx0XHRcdGJpbmRpbmdzOiB1dGlscy5oYXNoKCksXG5cdFx0XHQvLyBkaXJlY3RpdmVzXG5cdFx0XHRkaXJzOiBbXSxcblx0XHRcdC8vIHByb3BlcnR5IGluIHRlbXBsYXRlIGJ1dCBub3QgZGVmaW5lZCBpbiBkYXRhXG5cdFx0XHRkZWZlcnJlZDogW10sXG5cdFx0XHQvLyBwcm9wZXJ0eSBuZWVkIGNvbXB1dGF0aW9uIGJ5IHN1YnNjcmliZSBvdGhlciBwcm9wZXJ0eVxuXHRcdFx0Y29tcHV0ZWQ6IFtdLFxuXHRcdFx0Ly8gY29tcG9zaXRlIHBhdHRlcm5cblx0XHRcdGNoaWxkcmVuOiBbXSxcblx0XHRcdC8vIGV2ZW50IGVtaXR0ZXJcblx0XHRcdGVtaXR0ZXI6IG5ldyBFdmVudFRhcmdldCgpXG5cdFx0fSk7XG5cblx0XHQvLyBDT01QSUxFUi5WTSBcblx0XHR1dGlscy5taXgodm0sIHtcblx0XHRcdCckJzoge30sXG5cdFx0XHQnJGVsJzogdGhpcy5lbCxcblx0XHRcdCckb3B0aW9ucyc6IG9wdGlvbnMsXG5cdFx0XHQnJGNvbXBpbGVyJzogY29tcGlsZXIsXG5cdFx0XHQnJGV2ZW50JzogbnVsbFxuXHRcdH0pO1xuXG5cdFx0Ly8gUEFSRU5UIFZNXG5cdFx0dmFyIHBhcmVudFZNID0gb3B0aW9ucy5wYXJlbnQ7XG5cdFx0aWYgKHBhcmVudFZNKSB7XG5cdFx0XHR0aGlzLnBhcmVudCA9IHBhcmVudFZNLiRjb21waWxlcjtcblx0XHRcdHBhcmVudFZNLiRjb21waWxlci5jaGlsZHJlbi5wdXNoKHRoaXMpO1xuXHRcdFx0dm0uJHBhcmVudCA9IHBhcmVudFZNO1xuXHRcdFx0Ly8gSU5IRVJJVCBMQVpZIE9QVElPTlxuXHQgICAgICAgIGlmICghKCdsYXp5JyBpbiBvcHRpb25zKSkge1xuXHQgICAgICAgICAgICBvcHRpb25zLmxhenkgPSB0aGlzLnBhcmVudC5vcHRpb25zLmxhenk7XG5cdCAgICAgICAgfVxuXHRcdH1cblx0XHR2bS4kcm9vdCA9IGdldFJvb3QodGhpcykudm07XG5cdFx0ZnVuY3Rpb24gZ2V0Um9vdCAoY29tcGlsZXIpIHtcblx0XHQgICAgd2hpbGUgKGNvbXBpbGVyLnBhcmVudCkge1xuXHRcdCAgICAgICAgY29tcGlsZXIgPSBjb21waWxlci5wYXJlbnQ7XG5cdFx0ICAgIH1cblx0XHQgICAgcmV0dXJuIGNvbXBpbGVyO1xuXHRcdH1cblx0fSxcblx0X2luaXREYXRhOiBmdW5jdGlvbigpe1xuXHRcdHZhciBvcHRpb25zICA9IHRoaXMub3B0aW9ucyxcblx0XHRcdGNvbXBpbGVyID0gdGhpcyxcblx0XHRcdHZtICAgICAgID0gdGhpcy52bTtcblx0XHQvLyBTRVRVUCBPQlNFUlZFUlxuXHQgICAgLy8gVEhJUyBJUyBORUNFU0FSUlkgRk9SIEFMTCBIT09LUyBBTkQgREFUQSBPQlNFUlZBVElPTiBFVkVOVFNcblx0XHRjb21waWxlci5zZXR1cE9ic2VydmVyKCk7XG5cdFx0Ly8gQ1JFQVRFIEJJTkRJTkdTIEZPUiBDT01QVVRFRCBQUk9QRVJUSUVTXG5cdCAgICBpZiAob3B0aW9ucy5tZXRob2RzKSB7XG5cdCAgICAgICAgZm9yIChrZXkgaW4gb3B0aW9ucy5tZXRob2RzKSB7XG5cdCAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcoa2V5KTtcblx0ICAgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIC8vIENSRUFURSBCSU5ESU5HUyBGT1IgTUVUSE9EU1xuXHQgICAgaWYgKG9wdGlvbnMuY29tcHV0ZWQpIHtcblx0ICAgICAgICBmb3IgKGtleSBpbiBvcHRpb25zLmNvbXB1dGVkKSB7XG5cdCAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcoa2V5KVxuXHQgICAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgLy8gSU5JVElBTElaRSBEQVRBXG5cdCAgICB2YXIgZGF0YSA9IGNvbXBpbGVyLmRhdGEgPSBvcHRpb25zLmRhdGEgfHwge30sXG5cdCAgICAgICAgZGVmYXVsdERhdGEgPSBvcHRpb25zLmRlZmF1bHREYXRhXG5cdCAgICBpZiAoZGVmYXVsdERhdGEpIHtcblx0ICAgICAgICBmb3IgKGtleSBpbiBkZWZhdWx0RGF0YSkge1xuXHQgICAgICAgICAgICBpZiAoIWhhc093bi5jYWxsKGRhdGEsIGtleSkpIHtcblx0ICAgICAgICAgICAgICAgIGRhdGFba2V5XSA9IGRlZmF1bHREYXRhW2tleV1cblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgLy8gQ09QWSBQQVJBTUFUVFJJQlVURVNcblx0ICAgIC8vIHZhciBwYXJhbXMgPSBvcHRpb25zLnBhcmFtQXR0cmlidXRlc1xuXHQgICAgLy8gaWYgKHBhcmFtcykge1xuXHQgICAgLy8gICAgIGkgPSBwYXJhbXMubGVuZ3RoXG5cdCAgICAvLyAgICAgd2hpbGUgKGktLSkge1xuXHQgICAgLy8gICAgICAgICBkYXRhW3BhcmFtc1tpXV0gPSB1dGlscy5jaGVja051bWJlcihcblx0ICAgIC8vICAgICAgICAgICAgIGNvbXBpbGVyLmV2YWwoXG5cdCAgICAvLyAgICAgICAgICAgICAgICAgZWwuZ2V0QXR0cmlidXRlKHBhcmFtc1tpXSlcblx0ICAgIC8vICAgICAgICAgICAgIClcblx0ICAgIC8vICAgICAgICAgKVxuXHQgICAgLy8gICAgIH1cblx0ICAgIC8vIH1cblxuXHQgICAgdXRpbHMubWl4KHZtLCBkYXRhKTtcblx0ICAgIHZtLiRkYXRhID0gZGF0YTtcblxuXHQgICAgLy8gYmVmb3JlQ29tcGlsZSBob29rXG5cdCAgICBjb21waWxlci5leGVjSG9vaygnY3JlYXRlZCcpO1xuXG5cdCAgICAvLyBUSEUgVVNFUiBNSUdIVCBIQVZFIFNXQVBQRUQgVEhFIERBVEEgLi4uXG5cdCAgICBkYXRhID0gY29tcGlsZXIuZGF0YSA9IHZtLiRkYXRhO1xuXHQgICAgLy8gVVNFUiBNSUdIVCBBTFNPIFNFVCBTT01FIFBST1BFUlRJRVMgT04gVEhFIFZNXG5cdCAgICAvLyBJTiBXSElDSCBDQVNFIFdFIFNIT1VMRCBDT1BZIEJBQ0sgVE8gJERBVEFcblx0ICAgIHZhciB2bVByb3Bcblx0ICAgIGZvciAoa2V5IGluIHZtKSB7XG5cdCAgICAgICAgdm1Qcm9wID0gdm1ba2V5XVxuXHQgICAgICAgIGlmIChcblx0ICAgICAgICAgICAga2V5LmNoYXJBdCgwKSAhPT0gJyQnICYmXG5cdCAgICAgICAgICAgIGRhdGFba2V5XSAhPT0gdm1Qcm9wICYmXG5cdCAgICAgICAgICAgIHR5cGVvZiB2bVByb3AgIT09ICdmdW5jdGlvbidcblx0ICAgICAgICApIHtcblx0ICAgICAgICAgICAgZGF0YVtrZXldID0gdm1Qcm9wO1xuXHQgICAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgLy8gTk9XIFdFIENBTiBPQlNFUlZFIFRIRSBEQVRBLlxuXHQgICAgLy8gVEhJUyBXSUxMIENPTlZFUlQgREFUQSBQUk9QRVJUSUVTIFRPIEdFVFRFUi9TRVRURVJTXG5cdCAgICAvLyBBTkQgRU1JVCBUSEUgRklSU1QgQkFUQ0ggT0YgU0VUIEVWRU5UUywgV0hJQ0ggV0lMTFxuXHQgICAgLy8gSU4gVFVSTiBDUkVBVEUgVEhFIENPUlJFU1BPTkRJTkcgQklORElOR1MuXG5cdCAgICBjb21waWxlci5vYnNlcnZlRGF0YShkYXRhKVxuXHR9LFxuXHRfc3RhcnRDb21waWxlOiBmdW5jdGlvbigpe1xuXHRcdHZhciBvcHRpb25zID0gdGhpcy5vcHRpb25zLFxuXHRcdFx0Y29tcGlsZXIgPSB0aGlzLFxuXHRcdFx0ZWwgPSB0aGlzLmVsO1xuXHQgICAgLy8gYmVmb3JlIGNvbXBpbGluZywgcmVzb2x2ZSBjb250ZW50IGluc2VydGlvbiBwb2ludHNcblx0ICAgIGlmIChvcHRpb25zLnRlbXBsYXRlKSB7XG5cdCAgICAgICAgdGhpcy5yZXNvbHZlQ29udGVudCgpO1xuXHQgICAgfVxuXG5cdCAgICAvLyBub3cgcGFyc2UgdGhlIERPTSBhbmQgYmluZCBkaXJlY3RpdmVzLlxuXHQgICAgLy8gRHVyaW5nIHRoaXMgc3RhZ2UsIHdlIHdpbGwgYWxzbyBjcmVhdGUgYmluZGluZ3MgZm9yXG5cdCAgICAvLyBlbmNvdW50ZXJlZCBrZXlwYXRocyB0aGF0IGRvbid0IGhhdmUgYSBiaW5kaW5nIHlldC5cblx0ICAgIGNvbXBpbGVyLmNvbXBpbGUoZWwsIHRydWUpXG5cblx0ICAgIC8vIEFueSBkaXJlY3RpdmUgdGhhdCBjcmVhdGVzIGNoaWxkIFZNcyBhcmUgZGVmZXJyZWRcblx0ICAgIC8vIHNvIHRoYXQgd2hlbiB0aGV5IGFyZSBjb21waWxlZCwgYWxsIGJpbmRpbmdzIG9uIHRoZVxuXHQgICAgLy8gcGFyZW50IFZNIGhhdmUgYmVlbiBjcmVhdGVkLlxuXG5cdCAgICB2YXIgaSA9IGNvbXBpbGVyLmRlZmVycmVkLmxlbmd0aDtcblx0ICAgIHdoaWxlIChpLS0pIHtcblx0ICAgICAgICBjb21waWxlci5iaW5kRGlyZWN0aXZlKGNvbXBpbGVyLmRlZmVycmVkW2ldKVxuXHQgICAgfVxuXHQgICAgY29tcGlsZXIuZGVmZXJyZWQgPSBudWxsXG5cblx0ICAgIC8vIGV4dHJhY3QgZGVwZW5kZW5jaWVzIGZvciBjb21wdXRlZCBwcm9wZXJ0aWVzLlxuXHQgICAgLy8gdGhpcyB3aWxsIGV2YWx1YXRlZCBhbGwgY29sbGVjdGVkIGNvbXB1dGVkIGJpbmRpbmdzXG5cdCAgICAvLyBhbmQgY29sbGVjdCBnZXQgZXZlbnRzIHRoYXQgYXJlIGVtaXR0ZWQuXG5cdCAgICBpZiAodGhpcy5jb21wdXRlZC5sZW5ndGgpIHtcblx0ICAgICAgICBEZXBzUGFyc2VyLnBhcnNlKHRoaXMuY29tcHV0ZWQpXG5cdCAgICB9XG5cblx0ICAgIC8vIGRvbmUhXG5cdCAgICBjb21waWxlci5pbml0ID0gZmFsc2VcblxuXHQgICAgLy8gcG9zdCBjb21waWxlIC8gcmVhZHkgaG9va1xuXHQgICAgY29tcGlsZXIuZXhlY0hvb2soJ3JlYWR5Jyk7XG5cdH0sXG5cdGRlc3Ryb3k6IGZ1bmN0aW9uIChub1JlbW92ZSkge1xuXG5cdCAgICAvLyBhdm9pZCBiZWluZyBjYWxsZWQgbW9yZSB0aGFuIG9uY2Vcblx0ICAgIC8vIHRoaXMgaXMgaXJyZXZlcnNpYmxlIVxuXHQgICAgaWYgKHRoaXMuZGVzdHJveWVkKSByZXR1cm5cblxuXHQgICAgdmFyIGNvbXBpbGVyID0gdGhpcyxcblx0ICAgICAgICBpLCBqLCBrZXksIGRpciwgZGlycywgYmluZGluZyxcblx0ICAgICAgICB2bSAgICAgICAgICA9IGNvbXBpbGVyLnZtLFxuXHQgICAgICAgIGVsICAgICAgICAgID0gY29tcGlsZXIuZWwsXG5cdCAgICAgICAgZGlyZWN0aXZlcyAgPSBjb21waWxlci5kaXJzLFxuXHQgICAgICAgIGNvbXB1dGVkICAgID0gY29tcGlsZXIuY29tcHV0ZWQsXG5cdCAgICAgICAgYmluZGluZ3MgICAgPSBjb21waWxlci5iaW5kaW5ncyxcblx0ICAgICAgICBjaGlsZHJlbiAgICA9IGNvbXBpbGVyLmNoaWxkcmVuLFxuXHQgICAgICAgIHBhcmVudCAgICAgID0gY29tcGlsZXIucGFyZW50XG5cblx0ICAgIGNvbXBpbGVyLmV4ZWNIb29rKCdiZWZvcmVEZXN0cm95JylcblxuXHQgICAgLy8gdW5vYnNlcnZlIGRhdGFcblx0ICAgIE9ic2VydmVyLnVub2JzZXJ2ZShjb21waWxlci5kYXRhLCAnJywgY29tcGlsZXIub2JzZXJ2ZXIpXG5cblx0ICAgIC8vIGRlc3Ryb3kgYWxsIGNoaWxkcmVuXG5cdCAgICAvLyBkbyBub3QgcmVtb3ZlIHRoZWlyIGVsZW1lbnRzIHNpbmNlIHRoZSBwYXJlbnRcblx0ICAgIC8vIG1heSBoYXZlIHRyYW5zaXRpb25zIGFuZCB0aGUgY2hpbGRyZW4gbWF5IG5vdFxuXHQgICAgaSA9IGNoaWxkcmVuLmxlbmd0aFxuXHQgICAgd2hpbGUgKGktLSkge1xuXHQgICAgICAgIGNoaWxkcmVuW2ldLmRlc3Ryb3kodHJ1ZSlcblx0ICAgIH1cblxuXHQgICAgLy8gdW5iaW5kIGFsbCBkaXJlY2l0dmVzXG5cdCAgICBpID0gZGlyZWN0aXZlcy5sZW5ndGhcblx0ICAgIHdoaWxlIChpLS0pIHtcblx0ICAgICAgICBkaXIgPSBkaXJlY3RpdmVzW2ldXG5cdCAgICAgICAgLy8gaWYgdGhpcyBkaXJlY3RpdmUgaXMgYW4gaW5zdGFuY2Ugb2YgYW4gZXh0ZXJuYWwgYmluZGluZ1xuXHQgICAgICAgIC8vIGUuZy4gYSBkaXJlY3RpdmUgdGhhdCByZWZlcnMgdG8gYSB2YXJpYWJsZSBvbiB0aGUgcGFyZW50IFZNXG5cdCAgICAgICAgLy8gd2UgbmVlZCB0byByZW1vdmUgaXQgZnJvbSB0aGF0IGJpbmRpbmcncyBkaXJlY3RpdmVzXG5cdCAgICAgICAgLy8gKiBlbXB0eSBhbmQgbGl0ZXJhbCBiaW5kaW5ncyBkbyBub3QgaGF2ZSBiaW5kaW5nLlxuXHQgICAgICAgIGlmIChkaXIuYmluZGluZyAmJiBkaXIuYmluZGluZy5jb21waWxlciAhPT0gY29tcGlsZXIpIHtcblx0ICAgICAgICAgICAgZGlycyA9IGRpci5iaW5kaW5nLmRpcnNcblx0ICAgICAgICAgICAgaWYgKGRpcnMpIHtcblx0ICAgICAgICAgICAgICAgIGogPSBkaXJzLmluZGV4T2YoZGlyKVxuXHQgICAgICAgICAgICAgICAgaWYgKGogPiAtMSkgZGlycy5zcGxpY2UoaiwgMSlcblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblx0ICAgICAgICBkaXIuJHVuYmluZCgpXG5cdCAgICB9XG5cblx0ICAgIC8vIHVuYmluZCBhbGwgY29tcHV0ZWQsIGFub255bW91cyBiaW5kaW5nc1xuXHQgICAgaSA9IGNvbXB1dGVkLmxlbmd0aFxuXHQgICAgd2hpbGUgKGktLSkge1xuXHQgICAgICAgIGNvbXB1dGVkW2ldLnVuYmluZCgpXG5cdCAgICB9XG5cblx0ICAgIC8vIHVuYmluZCBhbGwga2V5cGF0aCBiaW5kaW5nc1xuXHQgICAgZm9yIChrZXkgaW4gYmluZGluZ3MpIHtcblx0ICAgICAgICBiaW5kaW5nID0gYmluZGluZ3Nba2V5XVxuXHQgICAgICAgIGlmIChiaW5kaW5nKSB7XG5cdCAgICAgICAgICAgIGJpbmRpbmcudW5iaW5kKClcblx0ICAgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIC8vIHJlbW92ZSBzZWxmIGZyb20gcGFyZW50XG5cdCAgICBpZiAocGFyZW50KSB7XG5cdCAgICAgICAgaiA9IHBhcmVudC5jaGlsZHJlbi5pbmRleE9mKGNvbXBpbGVyKVxuXHQgICAgICAgIGlmIChqID4gLTEpIHBhcmVudC5jaGlsZHJlbi5zcGxpY2UoaiwgMSlcblx0ICAgIH1cblxuXHQgICAgLy8gZmluYWxseSByZW1vdmUgZG9tIGVsZW1lbnRcblx0ICAgIGlmICghbm9SZW1vdmUpIHtcblx0ICAgICAgICBpZiAoZWwgPT09IGRvY3VtZW50LmJvZHkpIHtcblx0ICAgICAgICAgICAgZWwuaW5uZXJIVE1MID0gJydcblx0ICAgICAgICB9IGVsc2Uge1xuXHQgICAgICAgICAgICB2bS4kcmVtb3ZlKClcblx0ICAgICAgICB9XG5cdCAgICB9XG5cdCAgICBlbC52dWVfdm0gPSBudWxsXG5cblx0ICAgIGNvbXBpbGVyLmRlc3Ryb3llZCA9IHRydWVcblx0ICAgIC8vIGVtaXQgZGVzdHJveSBob29rXG5cdCAgICBjb21waWxlci5leGVjSG9vaygnYWZ0ZXJEZXN0cm95JylcblxuXHQgICAgLy8gZmluYWxseSwgdW5yZWdpc3RlciBhbGwgbGlzdGVuZXJzXG5cdCAgICBjb21waWxlci5vYnNlcnZlci5vZmYoKTtcblx0ICAgIGNvbXBpbGVyLmVtaXR0ZXIub2ZmKCk7XG5cdH1cbn0pO1xuLyoqXG4gKiBvYnNlcnZhdGlvblxuICovXG51dGlscy5taXgoQ29tcGlsZXIucHJvdG90eXBlLCB7XG5cdHNldHVwT2JzZXJ2ZXI6IGZ1bmN0aW9uKCl7XG5cdFx0dmFyIGNvbXBpbGVyID0gdGhpcyxcblx0ICAgICAgICBiaW5kaW5ncyA9IGNvbXBpbGVyLmJpbmRpbmdzLFxuXHQgICAgICAgIG9wdGlvbnMgID0gY29tcGlsZXIub3B0aW9ucyxcblx0ICAgICAgICBvYnNlcnZlciA9IGNvbXBpbGVyLm9ic2VydmVyID0gbmV3IEV2ZW50VGFyZ2V0KGNvbXBpbGVyLnZtKTtcblxuXHQgICAgLy8gQSBIQVNIIFRPIEhPTEQgRVZFTlQgUFJPWElFUyBGT1IgRUFDSCBST09UIExFVkVMIEtFWVxuXHQgICAgLy8gU08gVEhFWSBDQU4gQkUgUkVGRVJFTkNFRCBBTkQgUkVNT1ZFRCBMQVRFUlxuXHQgICAgb2JzZXJ2ZXIucHJveGllcyA9IHt9O1xuXG5cdCAgICAvLyBBREQgT1dOIExJU1RFTkVSUyBXSElDSCBUUklHR0VSIEJJTkRJTkcgVVBEQVRFU1xuXHQgICAgb2JzZXJ2ZXJcblx0ICAgICAgICAub24oJ2dldCcsIG9uR2V0KVxuXHQgICAgICAgIC5vbignc2V0Jywgb25TZXQpXG5cdCAgICAgICAgLm9uKCdtdXRhdGUnLCBvblNldCk7XG5cblx0ICAgIC8vIHJlZ2lzdGVyIGhvb2tzIHNldHVwIGluIG9wdGlvbnNcblx0ICAgIHV0aWxzLmVhY2goaG9va3MsIGZ1bmN0aW9uKGhvb2spe1xuXHQgICAgXHR2YXIgaSwgZm5zO1xuXHQgICAgICAgIGZucyA9IG9wdGlvbnNbaG9va107XG5cdCAgICAgICAgaWYgKHV0aWxzLmlzQXJyYXkoZm5zKSkge1xuXHQgICAgICAgICAgICBpID0gZm5zLmxlbmd0aFxuXHQgICAgICAgICAgICAvLyBzaW5jZSBob29rcyB3ZXJlIG1lcmdlZCB3aXRoIGNoaWxkIGF0IGhlYWQsXG5cdCAgICAgICAgICAgIC8vIHdlIGxvb3AgcmV2ZXJzZWx5LlxuXHQgICAgICAgICAgICB3aGlsZSAoaS0tKSB7XG5cdCAgICAgICAgICAgICAgICByZWdpc3Rlckhvb2soaG9vaywgZm5zW2pdKVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfSBlbHNlIGlmIChmbnMpIHtcblx0ICAgICAgICAgICAgcmVnaXN0ZXJIb29rKGhvb2ssIGZucylcblx0ICAgICAgICB9XG5cdCAgICB9KTtcblxuXHQgICAgLy8gYnJvYWRjYXN0IGF0dGFjaGVkL2RldGFjaGVkIGhvb2tzXG5cdCAgICBvYnNlcnZlclxuXHQgICAgICAgIC5vbignaG9vazphdHRhY2hlZCcsIGZ1bmN0aW9uICgpIHtcblx0ICAgICAgICAgICAgYnJvYWRjYXN0KDEpXG5cdCAgICAgICAgfSlcblx0ICAgICAgICAub24oJ2hvb2s6ZGV0YWNoZWQnLCBmdW5jdGlvbiAoKSB7XG5cdCAgICAgICAgICAgIGJyb2FkY2FzdCgwKVxuXHQgICAgICAgIH0pXG5cblx0ICAgIGZ1bmN0aW9uIG9uR2V0IChrZXkpIHtcblx0ICAgICAgICBjaGVjayhrZXkpXG5cdCAgICAgICAgRGVwc1BhcnNlci5jYXRjaGVyLmVtaXQoJ2dldCcsIGJpbmRpbmdzW2tleV0pXG5cdCAgICB9XG5cblx0ICAgIGZ1bmN0aW9uIG9uU2V0IChrZXksIHZhbCwgbXV0YXRpb24pIHtcblx0ICAgICAgICBvYnNlcnZlci5lbWl0KCdjaGFuZ2U6JyArIGtleSwgdmFsLCBtdXRhdGlvbilcblx0ICAgICAgICBjaGVjayhrZXkpXG5cdCAgICAgICAgYmluZGluZ3Nba2V5XS51cGRhdGUodmFsKVxuXHQgICAgfVxuXG5cdCAgICBmdW5jdGlvbiByZWdpc3Rlckhvb2sgKGhvb2ssIGZuKSB7XG5cdCAgICAgICAgb2JzZXJ2ZXIub24oJ2hvb2s6JyArIGhvb2ssIGZ1bmN0aW9uICgpIHtcblx0ICAgICAgICAgICAgZm4uY2FsbChjb21waWxlci52bSlcblx0ICAgICAgICB9KTtcblx0ICAgIH1cblxuXHQgICAgZnVuY3Rpb24gYnJvYWRjYXN0IChldmVudCkge1xuXHQgICAgICAgIHZhciBjaGlsZHJlbiA9IGNvbXBpbGVyLmNoaWxkcmVuXG5cdCAgICAgICAgaWYgKGNoaWxkcmVuKSB7XG5cdCAgICAgICAgICAgIHZhciBjaGlsZCwgaSA9IGNoaWxkcmVuLmxlbmd0aFxuXHQgICAgICAgICAgICB3aGlsZSAoaS0tKSB7XG5cdCAgICAgICAgICAgICAgICBjaGlsZCA9IGNoaWxkcmVuW2ldXG5cdCAgICAgICAgICAgICAgICBpZiAoY2hpbGQuZWwucGFyZW50Tm9kZSkge1xuXHQgICAgICAgICAgICAgICAgICAgIGV2ZW50ID0gJ2hvb2s6JyArIChldmVudCA/ICdhdHRhY2hlZCcgOiAnZGV0YWNoZWQnKVxuXHQgICAgICAgICAgICAgICAgICAgIGNoaWxkLm9ic2VydmVyLmVtaXQoZXZlbnQpXG5cdCAgICAgICAgICAgICAgICAgICAgY2hpbGQuZW1pdHRlci5lbWl0KGV2ZW50KVxuXHQgICAgICAgICAgICAgICAgfVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICBmdW5jdGlvbiBjaGVjayAoa2V5KSB7XG5cdCAgICAgICAgaWYgKCFiaW5kaW5nc1trZXldKSB7XG5cdCAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcoa2V5KVxuXHQgICAgICAgIH1cblx0ICAgIH1cblx0fSxcblx0b2JzZXJ2ZURhdGE6IGZ1bmN0aW9uKGRhdGEpe1xuXHRcdHZhciBjb21waWxlciA9IHRoaXMsXG5cdFx0XHRvYnNlcnZlciA9IGNvbXBpbGVyLm9ic2VydmVyO1xuXG5cdFx0T2JzZXJ2ZXIub2JzZXJ2ZShkYXRhLCAnJywgb2JzZXJ2ZXIpO1xuXHRcdC8vIGFsc28gY3JlYXRlIGJpbmRpbmcgZm9yIHRvcCBsZXZlbCAkZGF0YVxuXHQgICAgLy8gc28gaXQgY2FuIGJlIHVzZWQgaW4gdGVtcGxhdGVzIHRvb1xuXHQgICAgdmFyICRkYXRhQmluZGluZyA9IGNvbXBpbGVyLmJpbmRpbmdzWyckZGF0YSddID0gbmV3IEJpbmRpbmcoY29tcGlsZXIsICckZGF0YScpO1xuXHQgICAgJGRhdGFCaW5kaW5nLnVwZGF0ZShkYXRhKTtcblxuXHQgICAgZGVmKGNvbXBpbGVyLnZtLCAnJGRhdGEnLCB7XG5cdCAgICBcdGdldDogZnVuY3Rpb24oKXtcblx0ICAgIFx0XHRjb21waWxlci5vYnNlcnZlci5lbWl0KCdnZXQnLCAnJGRhdGEnKTtcblx0ICAgIFx0XHRyZXR1cm4gY29tcGlsZXIuZGF0YTtcblx0ICAgIFx0fSxcblx0ICAgIFx0c2V0OiBmdW5jdGlvbihuZXdEYXRhKXtcblx0ICAgIFx0XHR2YXIgb2xkRGF0YSA9IGNvbXBpbGVyLmRhdGE7XG5cdCAgICBcdFx0T2JzZXJ2ZXIudW5vYnNlcnZlKG9sZERhdGEsICcnLCBvYnNlcnZlcik7XG5cdCAgICBcdFx0Y29tcGlsZXIuZGF0YSA9IG5ld0RhdGE7XG5cdCAgICBcdFx0T2JzZXJ2ZXIuY29weVBhdGhzKG5ld0RhdGEsIG9sZERhdGEpO1xuXHQgICAgXHRcdE9ic2VydmVyLm9ic2VydmUobmV3RGF0YSwgJycsIG9ic2VydmVyKTtcblx0ICAgIFx0XHR1cGRhdGUoKTtcblx0ICAgIFx0fVxuXHQgICAgfSk7XG5cblx0ICAgIG9ic2VydmVyXG5cdCAgICBcdC5vbignc2V0Jywgb25TZXQpXG5cdCAgICBcdC5vbignbXV0YXRlJywgb25TZXQpO1xuXHQgICAgZnVuY3Rpb24gb25TZXQgKGtleSkge1xuXHQgICAgXHRpZiAoa2V5ICE9PSckZGF0YScpIHVwZGF0ZSgpO1xuXHQgICAgfVxuXG5cdCAgICBmdW5jdGlvbiB1cGRhdGUoKXtcblx0ICAgIFx0JGRhdGFCaW5kaW5nLnVwZGF0ZShjb21waWxlci5kYXRhKTtcblx0ICAgIFx0b2JzZXJ2ZXIuZW1pdCgnY2hhbmdlOiRkYXRhJywgY29tcGlsZXIuZGF0YSk7XG5cdCAgICB9XG5cdH0sXG5cblx0LyoqXG5cdCAqICBDUkVBVEUgQklORElORyBBTkQgQVRUQUNIIEdFVFRFUi9TRVRURVIgRk9SIEEgS0VZIFRPIFRIRSBWSUVXTU9ERUwgT0JKRUNUXG5cdCAqL1xuXHRjcmVhdGVCaW5kaW5nOiBmdW5jdGlvbihrZXksIGRpcmVjdGl2ZSl7XG5cdFx0Ly8gdXRpbHMubG9nKCcgIGNyZWF0ZWQgYmluZGluZzogJyArIGtleSk7XG5cdFx0dmFyIGNvbXBpbGVyID0gdGhpcyxcblx0ICAgICAgICBtZXRob2RzICA9IGNvbXBpbGVyLm9wdGlvbnMubWV0aG9kcyxcblx0ICAgICAgICBpc0V4cCAgICA9IGRpcmVjdGl2ZSAmJiBkaXJlY3RpdmUuaXNFeHAsXG5cdCAgICAgICAgaXNGbiAgICAgPSAoZGlyZWN0aXZlICYmIGRpcmVjdGl2ZS5pc0ZuKSB8fCAobWV0aG9kcyAmJiBtZXRob2RzW2tleV0pLFxuXHQgICAgICAgIGJpbmRpbmdzID0gY29tcGlsZXIuYmluZGluZ3MsXG5cdCAgICAgICAgY29tcHV0ZWQgPSBjb21waWxlci5vcHRpb25zLmNvbXB1dGVkLFxuXHQgICAgICAgIGJpbmRpbmcgID0gbmV3IEJpbmRpbmcoY29tcGlsZXIsIGtleSwgaXNFeHAsIGlzRm4pO1xuXG5cblx0ICAgIGlmIChpc0V4cCkge1xuXHQgICAgICAgIC8vIEVYUFJFU1NJT04gQklORElOR1MgQVJFIEFOT05ZTU9VU1xuXHQgICAgICAgIGNvbXBpbGVyLmRlZmluZUV4cChrZXksIGJpbmRpbmcsIGRpcmVjdGl2ZSk7XG5cdCAgICB9IGVsc2UgaWYgKGlzRm4pIHtcblx0ICAgICAgICBiaW5kaW5nc1trZXldID0gYmluZGluZztcblx0ICAgICAgICBjb21waWxlci5kZWZpbmVWbVByb3Aoa2V5LCBiaW5kaW5nLCBtZXRob2RzW2tleV0pO1xuXHQgICAgfSBlbHNlIHtcblx0ICAgIFx0YmluZGluZ3Nba2V5XSA9IGJpbmRpbmc7XG5cdCAgICAgICAgaWYgKGJpbmRpbmcucm9vdCkge1xuXHQgICAgICAgICAgICAvLyBUSElTIElTIEEgUk9PVCBMRVZFTCBCSU5ESU5HLiBXRSBORUVEIFRPIERFRklORSBHRVRURVIvU0VUVEVSUyBGT1IgSVQuXG5cdCAgICAgICAgICAgIGlmIChjb21wdXRlZCAmJiBjb21wdXRlZFtrZXldKSB7XG5cdCAgICAgICAgICAgICAgICAvLyBDT01QVVRFRCBQUk9QRVJUWVxuXHQgICAgICAgICAgICAgICAgY29tcGlsZXIuZGVmaW5lQ29tcHV0ZWQoa2V5LCBiaW5kaW5nLCBjb21wdXRlZFtrZXldKVxuXHQgICAgICAgICAgICB9IGVsc2UgaWYgKGtleS5jaGFyQXQoMCkgIT09ICckJykge1xuXHQgICAgICAgICAgICAgICAgLy8gTk9STUFMIFBST1BFUlRZXG5cdCAgICAgICAgICAgICAgICBjb21waWxlci5kZWZpbmVEYXRhUHJvcChrZXksIGJpbmRpbmcpXG5cdCAgICAgICAgICAgIH0gZWxzZSB7XG5cdCAgICAgICAgICAgICAgICAvLyBQUk9QRVJUSUVTIFRIQVQgU1RBUlQgV0lUSCAkIEFSRSBNRVRBIFBST1BFUlRJRVNcblx0ICAgICAgICAgICAgICAgIC8vIFRIRVkgU0hPVUxEIEJFIEtFUFQgT04gVEhFIFZNIEJVVCBOT1QgSU4gVEhFIERBVEEgT0JKRUNULlxuXHQgICAgICAgICAgICAgICAgY29tcGlsZXIuZGVmaW5lVm1Qcm9wKGtleSwgYmluZGluZywgY29tcGlsZXIuZGF0YVtrZXldKVxuXHQgICAgICAgICAgICAgICAgZGVsZXRlIGNvbXBpbGVyLmRhdGFba2V5XVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfSBlbHNlIGlmIChjb21wdXRlZCAmJiBjb21wdXRlZFt1dGlscy5iYXNlS2V5KGtleSldKSB7XG5cdCAgICAgICAgICAgIC8vIE5FU1RFRCBQQVRIIE9OIENPTVBVVEVEIFBST1BFUlRZXG5cdCAgICAgICAgICAgIGNvbXBpbGVyLmRlZmluZUV4cChrZXksIGJpbmRpbmcpXG5cdCAgICAgICAgfSBlbHNlIHtcblx0ICAgICAgICAgICAgLy8gRU5TVVJFIFBBVEggSU4gREFUQSBTTyBUSEFUIENPTVBVVEVEIFBST1BFUlRJRVMgVEhBVFxuXHQgICAgICAgICAgICAvLyBBQ0NFU1MgVEhFIFBBVEggRE9OJ1QgVEhST1cgQU4gRVJST1IgQU5EIENBTiBDT0xMRUNUXG5cdCAgICAgICAgICAgIC8vIERFUEVOREVOQ0lFU1xuXHQgICAgICAgICAgICBPYnNlcnZlci5lbnN1cmVQYXRoKGNvbXBpbGVyLmRhdGEsIGtleSlcblx0ICAgICAgICAgICAgdmFyIHBhcmVudEtleSA9IGtleS5zbGljZSgwLCBrZXkubGFzdEluZGV4T2YoJy4nKSlcblx0ICAgICAgICAgICAgaWYgKCFiaW5kaW5nc1twYXJlbnRLZXldKSB7XG5cdCAgICAgICAgICAgICAgICAvLyB0aGlzIGlzIGEgbmVzdGVkIHZhbHVlIGJpbmRpbmcsIGJ1dCB0aGUgYmluZGluZyBmb3IgaXRzIHBhcmVudFxuXHQgICAgICAgICAgICAgICAgLy8gaGFzIG5vdCBiZWVuIGNyZWF0ZWQgeWV0LiBXZSBiZXR0ZXIgY3JlYXRlIHRoYXQgb25lIHRvby5cblx0ICAgICAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcocGFyZW50S2V5KVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfVxuXHQgICAgfVxuXHQgICAgcmV0dXJuIGJpbmRpbmc7XG5cdH1cbn0pO1xuXG4vKipcbiAqIGNvbnRlbnQgcmVzb2x2ZSBhbmQgY29tcGlsZVxuICovXG51dGlscy5taXgoQ29tcGlsZXIucHJvdG90eXBlLCB7XG5cdC8qKlxuXHQgKiAgREVBTCBXSVRIIDxDT05URU5UPiBJTlNFUlRJT04gUE9JTlRTXG5cdCAqICBQRVIgVEhFIFdFQiBDT01QT05FTlRTIFNQRUNcblx0ICovXG5cdHJlc29sdmVDb250ZW50OiBmdW5jdGlvbigpIHtcblx0XHR2YXIgb3V0bGV0cyA9IHNsaWNlLmNhbGwodGhpcy5lbC5nZXRFbGVtZW50c0J5VGFnTmFtZSgnY29udGVudCcpKSxcblx0XHRcdHJhdyA9IHRoaXMucmF3Q29udGVudDtcblxuXHRcdC8vIGZpcnN0IHBhc3MsIGNvbGxlY3QgY29ycmVzcG9uZGluZyBjb250ZW50XG4gICAgICAgIC8vIGZvciBlYWNoIG91dGxldC5cblx0XHR1dGlscy5lYWNoKG91dGxldHMsIGZ1bmN0aW9uKG91dGxldCl7XG5cdFx0XHRpZiAocmF3KSB7XG5cdFx0XHRcdHNlbGVjdCA9IG91dGxldC5nZXRBdHRyaWJ1dGUoJ3NlbGVjdCcpO1xuXHRcdFx0XHRpZiAoc2VsZWN0KSB7XG5cdFx0XHRcdFx0b3V0bGV0LmNvbnRlbnQgPSBzbGljZS5jYWxsKHJhdy5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdCkpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdG1haW4gPSBvdXRsZXQ7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdG91dGxldC5jb250ZW50ID0gc2xpY2UuY2FsbChvdXRsZXQuY2hpbGROb2Rlcyk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHQvLyBzZWNvbmQgcGFzcywgYWN0dWFsbHkgaW5zZXJ0IHRoZSBjb250ZW50c1xuXHRcdHZhciBpLCBqLCBjb3V0bGV0O1xuICAgICAgICBmb3IgKGkgPSAwLCBqID0gb3V0bGV0cy5sZW5ndGg7IGkgPCBqOyBpKyspIHtcbiAgICAgICAgICAgIG91dGxldCA9IG91dGxldHNbaV1cbiAgICAgICAgICAgIGlmIChvdXRsZXQgPT09IG1haW4pIGNvbnRpbnVlXG4gICAgICAgICAgICBpbnNlcnQob3V0bGV0LCBvdXRsZXQuY29udGVudClcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGluc2VydCAob3V0bGV0LCBjb250ZW50cykge1xuXHQgICAgICAgIHZhciBwYXJlbnQgPSBvdXRsZXQucGFyZW50Tm9kZSxcblx0ICAgICAgICAgICAgaSA9IDAsIGogPSBjb250ZW50cy5sZW5ndGhcblx0ICAgICAgICBmb3IgKDsgaSA8IGo7IGkrKykge1xuXHQgICAgICAgICAgICBwYXJlbnQuaW5zZXJ0QmVmb3JlKGNvbnRlbnRzW2ldLCBvdXRsZXQpXG5cdCAgICAgICAgfVxuXHQgICAgICAgIHBhcmVudC5yZW1vdmVDaGlsZChvdXRsZXQpO1xuXHQgICAgfVxuXG5cdCAgICB0aGlzLnJhd0NvbnRlbnQgPSBudWxsXG5cdH0sXG5cdGNvbXBpbGU6IGZ1bmN0aW9uKG5vZGUsIHJvb3Qpe1xuXHRcdHZhciBub2RlVHlwZSA9IG5vZGUubm9kZVR5cGVcblx0ICAgIC8vIGEgbm9ybWFsIG5vZGVcblx0ICAgIGlmIChub2RlVHlwZSA9PT0gMSAmJiBub2RlLnRhZ05hbWUgIT09ICdTQ1JJUFQnKSB7IFxuXHQgICAgICAgIHRoaXMuY29tcGlsZUVsZW1lbnQobm9kZSwgcm9vdCk7XG5cdCAgICB9IGVsc2UgaWYgKG5vZGVUeXBlID09PSAzKSB7XG5cdCAgICAgICAgdGhpcy5jb21waWxlVGV4dE5vZGUobm9kZSk7XG5cdCAgICB9XG5cdH0sXG5cdGNvbXBpbGVFbGVtZW50OiBmdW5jdGlvbihub2RlLCByb290KXtcblx0XHQvLyB0ZXh0YXJlYSBpcyBwcmV0dHkgYW5ub3lpbmdcblx0ICAgIC8vIGJlY2F1c2UgaXRzIHZhbHVlIGNyZWF0ZXMgY2hpbGROb2RlcyB3aGljaFxuXHQgICAgLy8gd2UgZG9uJ3Qgd2FudCB0byBjb21waWxlLlxuXHQgICAgaWYgKG5vZGUudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyAmJiBub2RlLnZhbHVlKSB7XG5cdCAgICAgICAgbm9kZS52YWx1ZSA9IHRoaXMuZXZhbChub2RlLnZhbHVlKTtcblx0ICAgIH1cblxuXG5cdCAgICAvLyBvbmx5IGNvbXBpbGUgaWYgdGhpcyBlbGVtZW50IGhhcyBhdHRyaWJ1dGVzXG5cdCAgICAvLyBvciBpdHMgdGFnTmFtZSBjb250YWlucyBhIGh5cGhlbiAod2hpY2ggbWVhbnMgaXQgY291bGRcblx0ICAgIC8vIHBvdGVudGlhbGx5IGJlIGEgY3VzdG9tIGVsZW1lbnQpXG5cdCAgICBpZiAobm9kZS5oYXNBdHRyaWJ1dGVzKCkgfHwgbm9kZS50YWdOYW1lLmluZGV4T2YoJy0nKSA+IC0xKSB7XG5cdFx0ICAgIGNvbnNvbGUubG9nKCdcXG5cXG4tLS0tLS0tLS0tLS0tY29tcGlsZTogJywgbm9kZSk7XG5cblx0ICAgIFx0Ly8gc2tpcCBhbnl0aGluZyB3aXRoIHYtcHJlXG5cdCAgICAgICAgaWYgKHV0aWxzLmRvbS5hdHRyKG5vZGUsICdwcmUnKSAhPT0gbnVsbCkge1xuXHQgICAgICAgICAgICByZXR1cm47XG5cdCAgICAgICAgfVxuXG5cdCAgICAgICAgdmFyIGksIGwsIGosIGs7XG5cblx0ICAgICAgICAvLyBjaGVjayBwcmlvcml0eSBkaXJlY3RpdmVzLlxuXHQgICAgICAgIC8vIGlmIGFueSBvZiB0aGVtIGFyZSBwcmVzZW50LCBpdCB3aWxsIHRha2Ugb3ZlciB0aGUgbm9kZSB3aXRoIGEgY2hpbGRWTVxuXHQgICAgICAgIC8vIHNvIHdlIGNhbiBza2lwIHRoZSByZXN0XG5cdCAgICAgICAgZm9yIChpID0gMCwgbCA9IHByaW9yaXR5RGlyZWN0aXZlcy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcblx0ICAgICAgICAgICAgaWYgKHRoaXMuY2hlY2tQcmlvcml0eURpcihwcmlvcml0eURpcmVjdGl2ZXNbaV0sIG5vZGUsIHJvb3QpKSB7XG5cdCAgICAgICAgICAgIFx0Y29uc29sZS5sb2coJ3ByZXNlbnQgYW5kIHRha2Ugb3ZlciB3aXRoIGEgY2hpbGQgdm0nKTtcblx0ICAgICAgICAgICAgICAgIHJldHVybjtcblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblxuXHRcdCAgICB2YXIgcHJlZml4ID0gY29uZmlnLnByZWZpeCArICctJyxcblx0ICAgICAgICAgICAgcGFyYW1zID0gdGhpcy5vcHRpb25zLnBhcmFtQXR0cmlidXRlcyxcblx0ICAgICAgICAgICAgYXR0ciwgYXR0cm5hbWUsIGlzRGlyZWN0aXZlLCBleHAsIGRpcmVjdGl2ZXMsIGRpcmVjdGl2ZSwgZGlybmFtZTtcblxuXHQgICAgICAgIC8vIHYtd2l0aCBoYXMgc3BlY2lhbCBwcmlvcml0eSBhbW9uZyB0aGUgcmVzdFxuXHQgICAgICAgIC8vIGl0IG5lZWRzIHRvIHB1bGwgaW4gdGhlIHZhbHVlIGZyb20gdGhlIHBhcmVudCBiZWZvcmVcblx0ICAgICAgICAvLyBjb21wdXRlZCBwcm9wZXJ0aWVzIGFyZSBldmFsdWF0ZWQsIGJlY2F1c2UgYXQgdGhpcyBzdGFnZVxuXHQgICAgICAgIC8vIHRoZSBjb21wdXRlZCBwcm9wZXJ0aWVzIGhhdmUgbm90IHNldCB1cCB0aGVpciBkZXBlbmRlbmNpZXMgeWV0LlxuXHQgICAgICAgIGlmIChyb290KSB7XG5cdCAgICAgICAgICAgIHZhciB3aXRoRXhwID0gdXRpbHMuZG9tLmF0dHIobm9kZSwgJ3dpdGgnKTtcblx0ICAgICAgICAgICAgaWYgKHdpdGhFeHApIHtcblx0ICAgICAgICAgICAgICAgIGRpcmVjdGl2ZXMgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCd3aXRoJywgd2l0aEV4cCwgbm9kZSwgdHJ1ZSlcblx0ICAgICAgICAgICAgICAgIGZvciAoaiA9IDAsIGsgPSBkaXJlY3RpdmVzLmxlbmd0aDsgaiA8IGs7IGorKykge1xuXHQgICAgICAgICAgICAgICAgICAgIHRoaXMuYmluZERpcmVjdGl2ZShkaXJlY3RpdmVzW2pdLCB0aGlzLnBhcmVudClcblx0ICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblxuXHQgICAgICAgIHZhciBhdHRycyA9IHNsaWNlLmNhbGwobm9kZS5hdHRyaWJ1dGVzKTtcblx0ICAgICAgICBmb3IgKGkgPSAwLCBsID0gYXR0cnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG5cblx0ICAgICAgICAgICAgYXR0ciA9IGF0dHJzW2ldXG5cdCAgICAgICAgICAgIGF0dHJuYW1lID0gYXR0ci5uYW1lXG5cdCAgICAgICAgICAgIGlzRGlyZWN0aXZlID0gZmFsc2VcblxuXHQgICAgICAgICAgICBpZiAoYXR0cm5hbWUuaW5kZXhPZihwcmVmaXgpID09PSAwKSB7XG5cblx0ICAgICAgICAgICAgICAgIC8vIGEgZGlyZWN0aXZlIC0gc3BsaXQsIHBhcnNlIGFuZCBiaW5kIGl0LlxuXHQgICAgICAgICAgICAgICAgaXNEaXJlY3RpdmUgPSB0cnVlXG5cdCAgICAgICAgICAgICAgICBkaXJuYW1lID0gYXR0cm5hbWUuc2xpY2UocHJlZml4Lmxlbmd0aClcblx0ICAgICAgICAgICAgICAgIC8vIGJ1aWxkIHdpdGggbXVsdGlwbGU6IHRydWVcblx0ICAgICAgICAgICAgICAgIGRpcmVjdGl2ZXMgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKGRpcm5hbWUsIGF0dHIudmFsdWUsIG5vZGUsIHRydWUpXG5cdCAgICAgICAgICAgICAgICAvLyBsb29wIHRocm91Z2ggY2xhdXNlcyAoc2VwYXJhdGVkIGJ5IFwiLFwiKVxuXHQgICAgICAgICAgICAgICAgLy8gaW5zaWRlIGVhY2ggYXR0cmlidXRlXG5cdCAgICAgICAgICAgICAgICBmb3IgKGogPSAwLCBrID0gZGlyZWN0aXZlcy5sZW5ndGg7IGogPCBrOyBqKyspIHtcblx0ICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlc1tqXSlcblx0ICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgfSBlbHNlIHtcblx0ICAgICAgICAgICAgICAgIC8vIG5vbiBkaXJlY3RpdmUgYXR0cmlidXRlLCBjaGVjayBpbnRlcnBvbGF0aW9uIHRhZ3Ncblx0ICAgICAgICAgICAgICAgIGV4cCA9IFRleHRQYXJzZXIucGFyc2VBdHRyKGF0dHIudmFsdWUpXG5cdCAgICAgICAgICAgICAgICBpZiAoZXhwKSB7XG5cdFx0ICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdpbnRlcnBvbGF0aW9uOiAnLCBhdHRyLnZhbHVlLCBleHApXG5cdCAgICAgICAgICAgICAgICAgICAgZGlyZWN0aXZlID0gdGhpcy5wYXJzZURpcmVjdGl2ZSgnYXR0cicsIGV4cCwgbm9kZSlcblx0ICAgICAgICAgICAgICAgICAgICBkaXJlY3RpdmUuYXJnID0gYXR0cm5hbWVcblx0ICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIHBhcmFtcy5pbmRleE9mKGF0dHJuYW1lKSA+IC0xKSB7XG5cdCAgICAgICAgICAgICAgICAgICAgICAgIC8vIGEgcGFyYW0gYXR0cmlidXRlLi4uIHdlIHNob3VsZCB1c2UgdGhlIHBhcmVudCBiaW5kaW5nXG5cdCAgICAgICAgICAgICAgICAgICAgICAgIC8vIHRvIGF2b2lkIGNpcmN1bGFyIHVwZGF0ZXMgbGlrZSBzaXplPXt7c2l6ZX19XG5cdCAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuYmluZERpcmVjdGl2ZShkaXJlY3RpdmUsIHRoaXMucGFyZW50KVxuXHQgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG5cdCAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuYmluZERpcmVjdGl2ZShkaXJlY3RpdmUpXG5cdCAgICAgICAgICAgICAgICAgICAgfVxuXHQgICAgICAgICAgICAgICAgfVxuXHQgICAgICAgICAgICB9XG5cblx0ICAgICAgICAgICAgaWYgKGlzRGlyZWN0aXZlICYmIGRpcm5hbWUgIT09ICdjbG9haycpIHtcblx0ICAgICAgICAgICAgICAgIG5vZGUucmVtb3ZlQXR0cmlidXRlKGF0dHJuYW1lKVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfVxuXG5cdCAgICB9XG4gICAgICAgIC8vIHJlY3Vyc2l2ZWx5IGNvbXBpbGUgY2hpbGROb2Rlc1xuXHQgICAgaWYgKG5vZGUuaGFzQ2hpbGROb2RlcygpKSB7XG5cdCAgICAgICAgc2xpY2UuY2FsbChub2RlLmNoaWxkTm9kZXMpLmZvckVhY2godGhpcy5jb21waWxlLCB0aGlzKTtcblx0ICAgIH1cblx0fSxcblx0Y29tcGlsZVRleHROb2RlOiBmdW5jdGlvbiAobm9kZSkge1xuXHQgICAgdmFyIHRva2VucyA9IFRleHRQYXJzZXIucGFyc2Uobm9kZS5ub2RlVmFsdWUpXG5cdCAgICBpZiAoIXRva2VucykgcmV0dXJuO1xuXHQgICAgY29uc29sZS5sb2coJ1xcblxcbi0tLS0tLS0tLS0tLWNvbXBpbGUgdGV4dE5vZGU6Jywgbm9kZSwgdG9rZW5zKTtcblx0ICAgIHZhciBlbCwgdG9rZW4sIGRpcmVjdGl2ZTtcblxuXHQgICAgZm9yICh2YXIgaSA9IDAsIGwgPSB0b2tlbnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG5cblx0ICAgICAgICB0b2tlbiA9IHRva2Vuc1tpXTtcblx0ICAgICAgICBkaXJlY3RpdmUgPSBudWxsO1xuXG5cdCAgICAgICAgaWYgKHRva2VuLmtleSkgeyAvLyBhIGJpbmRpbmdcblx0ICAgICAgICAgICAgaWYgKHRva2VuLmtleS5jaGFyQXQoMCkgPT09ICc+JykgeyAvLyBhIHBhcnRpYWxcblx0ICAgICAgICAgICAgICAgIGVsID0gZG9jdW1lbnQuY3JlYXRlQ29tbWVudCgncmVmJyk7XG5cdCAgICAgICAgICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCdwYXJ0aWFsJywgdG9rZW4ua2V5LnNsaWNlKDEpLCBlbCk7XG5cdCAgICAgICAgICAgIH0gZWxzZSB7XG5cdCAgICAgICAgICAgICAgICBpZiAoIXRva2VuLmh0bWwpIHsgXG5cdCAgICAgICAgICAgICAgICBcdC8vIHRleHQgYmluZGluZ1xuXHQgICAgICAgICAgICAgICAgICAgIGVsID0gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoJycpO1xuXHQgICAgICAgICAgICAgICAgICAgIGRpcmVjdGl2ZSA9IHRoaXMucGFyc2VEaXJlY3RpdmUoJ3RleHQnLCB0b2tlbi5rZXksIGVsKTtcblx0ICAgICAgICAgICAgICAgIH0gZWxzZSB7IC8vIGh0bWwgYmluZGluZ1xuXHQgICAgICAgICAgICAgICAgICAgIGVsID0gZG9jdW1lbnQuY3JlYXRlQ29tbWVudChjb25maWcucHJlZml4ICsgJy1odG1sJylcblx0ICAgICAgICAgICAgICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCdodG1sJywgdG9rZW4ua2V5LCBlbCk7XG5cdCAgICAgICAgICAgICAgICB9XG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9IGVsc2UgeyBcblx0ICAgICAgICBcdC8vIGEgcGxhaW4gc3RyaW5nXG5cdCAgICAgICAgICAgIGVsID0gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodG9rZW4pXG5cdCAgICAgICAgfVxuXG5cdCAgICAgICAgLy8gaW5zZXJ0IG5vZGVcblx0ICAgICAgICBub2RlLnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKGVsLCBub2RlKTtcblxuXHQgICAgICAgIC8vIGJpbmQgZGlyZWN0aXZlXG5cdCAgICAgICAgdGhpcy5iaW5kRGlyZWN0aXZlKGRpcmVjdGl2ZSk7XG5cblx0ICAgIH1cblxuXHQgICAgbm9kZS5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKG5vZGUpXG5cdH1cbn0pO1xuXG4vKipcbiAqIGRpcmVjdGl2ZSBzdHVmZlxuICovXG51dGlscy5taXgoQ29tcGlsZXIucHJvdG90eXBlLCB7XG5cdC8qKlxuXHQgKiAgQ2hlY2sgZm9yIGEgcHJpb3JpdHkgZGlyZWN0aXZlXG5cdCAqICBJZiBpdCBpcyBwcmVzZW50IGFuZCB2YWxpZCwgcmV0dXJuIHRydWUgdG8gc2tpcCB0aGUgcmVzdFxuXHQgKi9cblx0Y2hlY2tQcmlvcml0eURpcjogZnVuY3Rpb24oZGlybmFtZSwgbm9kZSwgcm9vdCl7XG5cdFx0dmFyIGV4cHJlc3Npb24sIGRpcmVjdGl2ZSwgQ3RvclxuXHQgICAgaWYgKFxuXHQgICAgICAgIGRpcm5hbWUgPT09ICdjb21wb25lbnQnICYmXG5cdCAgICAgICAgcm9vdCAhPT0gdHJ1ZSAmJlxuXHQgICAgICAgIChDdG9yID0gdGhpcy5yZXNvbHZlQ29tcG9uZW50KG5vZGUsIHVuZGVmaW5lZCwgdHJ1ZSkpXG5cdCAgICApIHtcblx0ICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKGRpcm5hbWUsICcnLCBub2RlKVxuXHQgICAgICAgIGRpcmVjdGl2ZS5DdG9yID0gQ3RvclxuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgICBleHByZXNzaW9uID0gdXRpbHMuZG9tLmF0dHIobm9kZSwgZGlybmFtZSlcblx0ICAgICAgICBkaXJlY3RpdmUgPSBleHByZXNzaW9uICYmIHRoaXMucGFyc2VEaXJlY3RpdmUoZGlybmFtZSwgZXhwcmVzc2lvbiwgbm9kZSk7XG5cdCAgICB9XG5cdCAgICBpZiAoZGlyZWN0aXZlKSB7XG5cdCAgICAgICAgaWYgKHJvb3QgPT09IHRydWUpIHtcblx0ICAgICAgICAgICAgdXRpbHMud2Fybihcblx0ICAgICAgICAgICAgICAgICdEaXJlY3RpdmUgdi0nICsgZGlybmFtZSArICcgY2Fubm90IGJlIHVzZWQgb24gYW4gYWxyZWFkeSBpbnN0YW50aWF0ZWQgJyArXG5cdCAgICAgICAgICAgICAgICAnVk1cXCdzIHJvb3Qgbm9kZS4gVXNlIGl0IGZyb20gdGhlIHBhcmVudFxcJ3MgdGVtcGxhdGUgaW5zdGVhZC4nXG5cdCAgICAgICAgICAgIClcblx0ICAgICAgICAgICAgcmV0dXJuXG5cdCAgICAgICAgfVxuXHQgICAgICAgIHRoaXMuZGVmZXJyZWQucHVzaChkaXJlY3RpdmUpO1xuXHQgICAgICAgIHJldHVybiB0cnVlXG5cdCAgICB9XG5cdH0sXG5cdHBhcnNlRGlyZWN0aXZlOiBmdW5jdGlvbiAobmFtZSwgdmFsdWUsIGVsLCBtdWx0aXBsZSkge1xuXHQgICAgdmFyIGNvbXBpbGVyID0gdGhpcyxcblx0ICAgICAgICBkZWZpbml0aW9uID0gY29tcGlsZXIuZ2V0T3B0aW9uKCdkaXJlY3RpdmVzJywgbmFtZSk7XG5cdCAgICBpZiAoZGVmaW5pdGlvbikge1xuXHQgICAgICAgIC8vIHBhcnNlIGludG8gQVNULWxpa2Ugb2JqZWN0c1xuXHQgICAgICAgIHZhciBhc3RzID0gRGlyZWN0aXZlLnBhcnNlKHZhbHVlKVxuXHQgICAgICAgIHJldHVybiBtdWx0aXBsZVxuXHQgICAgICAgICAgICA/IGFzdHMubWFwKGJ1aWxkKVxuXHQgICAgICAgICAgICA6IGJ1aWxkKGFzdHNbMF0pXG5cdCAgICB9XG5cdCAgICBmdW5jdGlvbiBidWlsZCAoYXN0KSB7XG5cdCAgICAgICAgcmV0dXJuIG5ldyBEaXJlY3RpdmUobmFtZSwgYXN0LCBkZWZpbml0aW9uLCBjb21waWxlciwgZWwpXG5cdCAgICB9XG5cdH0sXG5cdGJpbmREaXJlY3RpdmU6IGZ1bmN0aW9uIChkaXJlY3RpdmUsIGJpbmRpbmdPd25lcikge1xuXG5cdCAgICBpZiAoIWRpcmVjdGl2ZSkgcmV0dXJuO1xuXG5cdCAgICAvLyBrZWVwIHRyYWNrIG9mIGl0IHNvIHdlIGNhbiB1bmJpbmQoKSBsYXRlclxuXHQgICAgdGhpcy5kaXJzLnB1c2goZGlyZWN0aXZlKTtcblxuXHQgICAgLy8gZm9yIGVtcHR5IG9yIGxpdGVyYWwgZGlyZWN0aXZlcywgc2ltcGx5IGNhbGwgaXRzIGJpbmQoKVxuXHQgICAgLy8gYW5kIHdlJ3JlIGRvbmUuXG5cdCAgICBpZiAoZGlyZWN0aXZlLmlzRW1wdHkgfHwgZGlyZWN0aXZlLmlzTGl0ZXJhbCkge1xuXHQgICAgICAgIGlmIChkaXJlY3RpdmUuYmluZCkgZGlyZWN0aXZlLmJpbmQoKVxuXHQgICAgICAgIHJldHVyblxuXHQgICAgfVxuXHQgICAgLy8gb3RoZXJ3aXNlLCB3ZSBnb3QgbW9yZSB3b3JrIHRvIGRvLi4uXG5cdCAgICB2YXIgYmluZGluZyxcblx0ICAgICAgICBjb21waWxlciA9IGJpbmRpbmdPd25lciB8fCB0aGlzLFxuXHQgICAgICAgIGtleSAgICAgID0gZGlyZWN0aXZlLmtleVxuXG5cdCAgICBpZiAoZGlyZWN0aXZlLmlzRXhwKSB7XG5cdCAgICAgICAgLy8gZXhwcmVzc2lvbiBiaW5kaW5ncyBhcmUgYWx3YXlzIGNyZWF0ZWQgb24gY3VycmVudCBjb21waWxlclxuXHQgICAgICAgIGJpbmRpbmcgPSBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSwgZGlyZWN0aXZlKTtcblx0ICAgIH0gZWxzZSB7XG5cdCAgICAgICAgLy8gcmVjdXJzaXZlbHkgbG9jYXRlIHdoaWNoIGNvbXBpbGVyIG93bnMgdGhlIGJpbmRpbmdcblx0ICAgICAgICB3aGlsZSAoY29tcGlsZXIpIHtcblx0ICAgICAgICAgICAgaWYgKGNvbXBpbGVyLmhhc0tleShrZXkpKSB7XG5cdCAgICAgICAgICAgICAgICBicmVha1xuXHQgICAgICAgICAgICB9IGVsc2Uge1xuXHQgICAgICAgICAgICAgICAgY29tcGlsZXIgPSBjb21waWxlci5wYXJlbnRcblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblx0ICAgICAgICBjb21waWxlciA9IGNvbXBpbGVyIHx8IHRoaXNcblx0ICAgICAgICBiaW5kaW5nID0gY29tcGlsZXIuYmluZGluZ3Nba2V5XSB8fCBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSlcblx0ICAgIH1cblx0ICAgIGJpbmRpbmcuZGlycy5wdXNoKGRpcmVjdGl2ZSlcblx0ICAgIGRpcmVjdGl2ZS5iaW5kaW5nID0gYmluZGluZ1xuXG5cdCAgICB2YXIgdmFsdWUgPSBiaW5kaW5nLnZhbCgpXG5cdCAgICAvLyBpbnZva2UgYmluZCBob29rIGlmIGV4aXN0c1xuXHQgICAgaWYgKGRpcmVjdGl2ZS5iaW5kKSB7XG5cdCAgICAgICAgZGlyZWN0aXZlLmJpbmQodmFsdWUpXG5cdCAgICB9XG5cdCAgICAvLyBzZXQgaW5pdGlhbCB2YWx1ZVxuXHQgICAgZGlyZWN0aXZlLiR1cGRhdGUodmFsdWUsIHRydWUpXG5cdH1cbn0pO1xuXG4vKioqXG4gKiBkZWZpbmUgcHJvcGVydGllc1xuICovXG51dGlscy5taXgoQ29tcGlsZXIucHJvdG90eXBlLCB7XG5cdC8qKlxuXHQgKiAgRGVmaW5lIHRoZSBnZXR0ZXIvc2V0dGVyIHRvIHByb3h5IGEgcm9vdC1sZXZlbFxuXHQgKiAgZGF0YSBwcm9wZXJ0eSBvbiB0aGUgVk1cblx0ICovXG5cdGRlZmluZURhdGFQcm9wOiBmdW5jdGlvbiAoa2V5LCBiaW5kaW5nKSB7XG5cdCAgICB2YXIgY29tcGlsZXIgPSB0aGlzLFxuXHQgICAgICAgIGRhdGEgICAgID0gY29tcGlsZXIuZGF0YSxcblx0ICAgICAgICBvYiAgICAgICA9IGRhdGEuX19lbWl0dGVyX187XG5cblx0ICAgIC8vIG1ha2Ugc3VyZSB0aGUga2V5IGlzIHByZXNlbnQgaW4gZGF0YVxuXHQgICAgLy8gc28gaXQgY2FuIGJlIG9ic2VydmVkXG5cdCAgICBpZiAoIShoYXNPd24uY2FsbChkYXRhLCBrZXkpKSkge1xuXHQgICAgICAgIGRhdGFba2V5XSA9IHVuZGVmaW5lZFxuXHQgICAgfVxuXG5cdCAgICAvLyBpZiB0aGUgZGF0YSBvYmplY3QgaXMgYWxyZWFkeSBvYnNlcnZlZCwgYnV0IHRoZSBrZXlcblx0ICAgIC8vIGlzIG5vdCBvYnNlcnZlZCwgd2UgbmVlZCB0byBhZGQgaXQgdG8gdGhlIG9ic2VydmVkIGtleXMuXG5cdCAgICBpZiAob2IgJiYgIShoYXNPd24uY2FsbChvYi52YWx1ZXMsIGtleSkpKSB7XG5cdCAgICAgICAgT2JzZXJ2ZXIuY29udmVydEtleShkYXRhLCBrZXkpXG5cdCAgICB9XG5cblx0ICAgIGJpbmRpbmcudmFsdWUgPSBkYXRhW2tleV1cblxuXHQgICAgZGVmKGNvbXBpbGVyLnZtLCBrZXksIHtcblx0ICAgICAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcblx0ICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVyLmRhdGFba2V5XVxuXHQgICAgICAgIH0sXG5cdCAgICAgICAgc2V0OiBmdW5jdGlvbiAodmFsKSB7XG5cdCAgICAgICAgICAgIGNvbXBpbGVyLmRhdGFba2V5XSA9IHZhbFxuXHQgICAgICAgIH1cblx0ICAgIH0pO1xuXHR9LFxuXHRkZWZpbmVWbVByb3A6IGZ1bmN0aW9uIChrZXksIGJpbmRpbmcsIHZhbHVlKSB7XG5cdCAgICB2YXIgb2IgPSB0aGlzLm9ic2VydmVyXG5cdCAgICBiaW5kaW5nLnZhbHVlID0gdmFsdWVcblx0ICAgIGRlZih0aGlzLnZtLCBrZXksIHtcblx0ICAgICAgICBnZXQ6IGZ1bmN0aW9uICgpIHtcblx0ICAgICAgICAgICAgaWYgKE9ic2VydmVyLnNob3VsZEdldCkgb2IuZW1pdCgnZ2V0Jywga2V5KVxuXHQgICAgICAgICAgICByZXR1cm4gYmluZGluZy52YWx1ZVxuXHQgICAgICAgIH0sXG5cdCAgICAgICAgc2V0OiBmdW5jdGlvbiAodmFsKSB7XG5cdCAgICAgICAgICAgIG9iLmVtaXQoJ3NldCcsIGtleSwgdmFsKVxuXHQgICAgICAgIH1cblx0ICAgIH0pXG5cdH0sXG5cdGRlZmluZUV4cDogZnVuY3Rpb24gKGtleSwgYmluZGluZywgZGlyZWN0aXZlKSB7XG5cdCAgICB2YXIgY29tcHV0ZWRLZXkgPSBkaXJlY3RpdmUgJiYgZGlyZWN0aXZlLmNvbXB1dGVkS2V5LFxuXHQgICAgICAgIGV4cCAgICAgICAgID0gY29tcHV0ZWRLZXkgPyBkaXJlY3RpdmUuZXhwcmVzc2lvbiA6IGtleSxcblx0ICAgICAgICBnZXR0ZXIgICAgICA9IHRoaXMuZXhwQ2FjaGVbZXhwXVxuXHQgICAgaWYgKCFnZXR0ZXIpIHtcblx0ICAgICAgICBnZXR0ZXIgPSB0aGlzLmV4cENhY2hlW2V4cF0gPSBFeHBQYXJzZXIucGFyc2UoY29tcHV0ZWRLZXkgfHwga2V5LCB0aGlzKTtcblx0ICAgIH1cblx0ICAgIGlmIChnZXR0ZXIpIHtcblx0ICAgICAgICB0aGlzLm1hcmtDb21wdXRlZChiaW5kaW5nLCBnZXR0ZXIpXG5cdCAgICB9XG5cdH0sXG5cdGRlZmluZUNvbXB1dGVkOiBmdW5jdGlvbiAoa2V5LCBiaW5kaW5nLCB2YWx1ZSkge1xuXHQgICAgdGhpcy5tYXJrQ29tcHV0ZWQoYmluZGluZywgdmFsdWUpXG5cdCAgICBkZWYodGhpcy52bSwga2V5LCB7XG5cdCAgICAgICAgZ2V0OiBiaW5kaW5nLnZhbHVlLiRnZXQsXG5cdCAgICAgICAgc2V0OiBiaW5kaW5nLnZhbHVlLiRzZXRcblx0ICAgIH0pXG5cdH0sXG5cdG1hcmtDb21wdXRlZDogZnVuY3Rpb24gKGJpbmRpbmcsIHZhbHVlKSB7XG5cdCAgICBiaW5kaW5nLmlzQ29tcHV0ZWQgPSB0cnVlXG5cdCAgICAvLyBiaW5kIHRoZSBhY2Nlc3NvcnMgdG8gdGhlIHZtXG5cdCAgICBpZiAoYmluZGluZy5pc0ZuKSB7XG5cdCAgICAgICAgYmluZGluZy52YWx1ZSA9IHZhbHVlXG5cdCAgICB9IGVsc2Uge1xuXHQgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdmdW5jdGlvbicpIHtcblx0ICAgICAgICAgICAgdmFsdWUgPSB7ICRnZXQ6IHZhbHVlIH1cblx0ICAgICAgICB9XG5cdCAgICAgICAgYmluZGluZy52YWx1ZSA9IHtcblx0ICAgICAgICAgICAgJGdldDogdXRpbHMub2JqZWN0LmJpbmQodmFsdWUuJGdldCwgdGhpcy52bSksXG5cdCAgICAgICAgICAgICRzZXQ6IHZhbHVlLiRzZXRcblx0ICAgICAgICAgICAgICAgID8gdXRpbHMub2JqZWN0LmJpbmQodmFsdWUuJHNldCwgdGhpcy52bSlcblx0ICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkXG5cdCAgICAgICAgfVxuXHQgICAgfVxuXHQgICAgLy8ga2VlcCB0cmFjayBmb3IgZGVwIHBhcnNpbmcgbGF0ZXJcblx0ICAgIHRoaXMuY29tcHV0ZWQucHVzaChiaW5kaW5nKVxuXHR9XG59KTtcblxuLyoqXG4gKiB1dGlsaXR5IGZvciBjb21pcGxlclxuICovXG51dGlscy5taXgoQ29tcGlsZXIucHJvdG90eXBlLCB7XG5cdGV4ZWNIb29rOiBmdW5jdGlvbiAoZXZlbnQpIHtcblx0ICAgIGV2ZW50ID0gJ2hvb2s6JyArIGV2ZW50O1xuXHQgICAgdGhpcy5vYnNlcnZlci5lbWl0KGV2ZW50KTtcblx0ICAgIHRoaXMuZW1pdHRlci5lbWl0KGV2ZW50KTtcblx0fSxcblx0aGFzS2V5OiBmdW5jdGlvbiAoa2V5KSB7XG5cdCAgICB2YXIgYmFzZUtleSA9IHV0aWxzLm9iamVjdC5iYXNlS2V5KGtleSlcblx0ICAgIHJldHVybiBoYXNPd24uY2FsbCh0aGlzLmRhdGEsIGJhc2VLZXkpIHx8XG5cdCAgICAgICAgaGFzT3duLmNhbGwodGhpcy52bSwgYmFzZUtleSlcblx0fSxcblx0LyoqXG5cdCAqICBEbyBhIG9uZS10aW1lIGV2YWwgb2YgYSBzdHJpbmcgdGhhdCBwb3RlbnRpYWxseVxuXHQgKiAgaW5jbHVkZXMgYmluZGluZ3MuIEl0IGFjY2VwdHMgYWRkaXRpb25hbCByYXcgZGF0YVxuXHQgKiAgYmVjYXVzZSB3ZSBuZWVkIHRvIGR5bmFtaWNhbGx5IHJlc29sdmUgdi1jb21wb25lbnRcblx0ICogIGJlZm9yZSBhIGNoaWxkVk0gaXMgZXZlbiBjb21waWxlZC4uLlxuXHQgKi9cblx0ZXZhbDogZnVuY3Rpb24gKGV4cCwgZGF0YSkge1xuXHQgICAgdmFyIHBhcnNlZCA9IFRleHRQYXJzZXIucGFyc2VBdHRyKGV4cCk7XG5cdCAgICByZXR1cm4gcGFyc2VkXG5cdCAgICAgICAgPyBFeHBQYXJzZXIuZXZhbChwYXJzZWQsIHRoaXMsIGRhdGEpXG5cdCAgICAgICAgOiBleHA7XG5cdH0sXG5cdHJlc29sdmVDb21wb25lbnQ6IGZ1bmN0aW9uKG5vZGUsIGRhdGEsIHRlc3Qpe1xuXHRcdC8vIGxhdGUgcmVxdWlyZSB0byBhdm9pZCBjaXJjdWxhciBkZXBzXG5cdCAgICBWaWV3TW9kZWwgPSBWaWV3TW9kZWwgfHwgcmVxdWlyZSgnLi92aWV3bW9kZWwnKVxuXG5cdCAgICB2YXIgZXhwICAgICA9IHV0aWxzLmRvbS5hdHRyKG5vZGUsICdjb21wb25lbnQnKSxcblx0ICAgICAgICB0YWdOYW1lID0gbm9kZS50YWdOYW1lLFxuXHQgICAgICAgIGlkICAgICAgPSB0aGlzLmV2YWwoZXhwLCBkYXRhKSxcblx0ICAgICAgICB0YWdJZCAgID0gKHRhZ05hbWUuaW5kZXhPZignLScpID4gMCAmJiB0YWdOYW1lLnRvTG93ZXJDYXNlKCkpLFxuXHQgICAgICAgIEN0b3IgICAgPSB0aGlzLmdldE9wdGlvbignY29tcG9uZW50cycsIGlkIHx8IHRhZ0lkLCB0cnVlKVxuXG5cdCAgICBpZiAoaWQgJiYgIUN0b3IpIHtcblx0ICAgICAgICB1dGlscy53YXJuKCdVbmtub3duIGNvbXBvbmVudDogJyArIGlkKVxuXHQgICAgfVxuXG5cdCAgICByZXR1cm4gdGVzdFxuXHQgICAgICAgID8gZXhwID09PSAnJ1xuXHQgICAgICAgICAgICA/IFZpZXdNb2RlbFxuXHQgICAgICAgICAgICA6IEN0b3Jcblx0ICAgICAgICA6IEN0b3IgfHwgVmlld01vZGVsO1xuXHR9LFxuXHQvKipcblx0ICogIFJldHJpdmUgYW4gb3B0aW9uIGZyb20gdGhlIGNvbXBpbGVyXG5cdCAqL1xuXHRnZXRPcHRpb246IGZ1bmN0aW9uKHR5cGUsIGlkLCBzaWxlbnQpe1xuXHRcdHZhciBvcHRpb25zID0gdGhpcy5vcHRpb25zLFxuXHQgICAgICAgIHBhcmVudCA9IHRoaXMucGFyZW50LFxuXHQgICAgICAgIGdsb2JhbEFzc2V0cyA9IGNvbmZpZy5nbG9iYWxBc3NldHMsXG5cdCAgICAgICAgcmVzID0gKG9wdGlvbnNbdHlwZV0gJiYgb3B0aW9uc1t0eXBlXVtpZF0pIHx8IChcblx0ICAgICAgICAgICAgcGFyZW50XG5cdCAgICAgICAgICAgICAgICA/IHBhcmVudC5nZXRPcHRpb24odHlwZSwgaWQsIHNpbGVudClcblx0ICAgICAgICAgICAgICAgIDogZ2xvYmFsQXNzZXRzW3R5cGVdICYmIGdsb2JhbEFzc2V0c1t0eXBlXVtpZF1cblx0ICAgICAgICApO1xuXHQgICAgaWYgKCFyZXMgJiYgIXNpbGVudCAmJiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnKSB7XG5cdCAgICAgICAgdXRpbHMud2FybignVW5rbm93biAnICsgdHlwZS5zbGljZSgwLCAtMSkgKyAnOiAnICsgaWQpXG5cdCAgICB9XG5cdCAgICByZXR1cm4gcmVzO1xuXHR9XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBDb21waWxlcjsiLCJtb2R1bGUuZXhwb3J0cyA9IHtcblx0cHJlZml4OiAndicsXG5cdGRlYnVnOiB0cnVlXG59IiwidmFyIHV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpO1xuZnVuY3Rpb24gRGVmZXJyZWQoKSB7XG4gICAgdmFyIERPTkUgPSAnZG9uZScsXG4gICAgICAgIEZBSUwgPSAnZmFpbCcsXG4gICAgICAgIFBFTkRJTkcgPSAncGVuZGluZyc7XG4gICAgdmFyIHN0YXRlID0gUEVORElORztcbiAgICB2YXIgY2FsbGJhY2tzID0ge1xuICAgICAgICAnZG9uZSc6IFtdLFxuICAgICAgICAnZmFpbCc6IFtdLFxuICAgICAgICAnYWx3YXlzJzogW11cbiAgICB9O1xuICAgIHZhciBhcmdzID0gW107XG4gICAgdmFyIGNvbnRleHQ7XG5cbiAgICBmdW5jdGlvbiBkaXNwYXRjaChjYnMpIHtcbiAgICAgICAgdmFyIGNiO1xuICAgICAgICB3aGlsZSAoKGNiID0gY2JzLnNoaWZ0KCkpIHx8IChjYiA9IGNhbGxiYWNrcy5hbHdheXMuc2hpZnQoKSkpIHtcbiAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKChmdW5jdGlvbihmbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgZm4uYXBwbHkoY29udGV4dCwgYXJncyk7XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0pKGNiKSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZG9uZTogZnVuY3Rpb24oY2IpIHtcbiAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gRE9ORSkge1xuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIGNiLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH0sIDApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHN0YXRlID09PSBQRU5ESU5HKSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2tzLmRvbmUucHVzaChjYik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgZmFpbDogZnVuY3Rpb24oY2IpIHtcbiAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gRkFJTCkge1xuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIGNiLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH0sIDApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHN0YXRlID09PSBQRU5ESU5HKSB7XG4gICAgICAgICAgICAgICAgY2FsbGJhY2tzLmZhaWwucHVzaChjYik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgYWx3YXlzOiBmdW5jdGlvbihjYikge1xuICAgICAgICAgICAgaWYgKHN0YXRlICE9PSBQRU5ESU5HKSB7XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgY2IuYXBwbHkoY29udGV4dCwgYXJncyk7XG4gICAgICAgICAgICAgICAgfSwgMCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FsbGJhY2tzLmFsd2F5cy5wdXNoKGNiKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICB0aGVuOiBmdW5jdGlvbihkb25lRm4sIGZhaWxGbikge1xuICAgICAgICAgICAgaWYgKHV0aWxzLmlzRnVuY3Rpb24oZG9uZUZuKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuZG9uZShkb25lRm4pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHV0aWxzLmlzRnVuY3Rpb24oZmFpbEZuKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuZmFpbChmYWlsRm4pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIHJlc29sdmU6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdGhpcy5yZXNvbHZlV2l0aCh7fSwgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICByZXNvbHZlV2l0aDogZnVuY3Rpb24oYywgYSkge1xuICAgICAgICAgICAgaWYgKHN0YXRlICE9PSBQRU5ESU5HKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzdGF0ZSA9IERPTkU7XG4gICAgICAgICAgICBjb250ZXh0ID0gYyB8fCB0aGlzO1xuICAgICAgICAgICAgYXJncyA9IFtdLnNsaWNlLmNhbGwoYSB8fCBbXSk7XG4gICAgICAgICAgICBkaXNwYXRjaChjYWxsYmFja3MuZG9uZSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgcmVqZWN0OiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHRoaXMucmVqZWN0V2l0aCh7fSwgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICByZWplY3RXaXRoOiBmdW5jdGlvbihjLCBhKSB7XG4gICAgICAgICAgICBpZiAoc3RhdGUgIT09IFBFTkRJTkcpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN0YXRlID0gRkFJTDtcbiAgICAgICAgICAgIGNvbnRleHQgPSBjIHx8IHRoaXM7XG4gICAgICAgICAgICBhcmdzID0gW10uc2xpY2UuY2FsbChhIHx8IFtdKTtcbiAgICAgICAgICAgIGRpc3BhdGNoKGNhbGxiYWNrcy5mYWlsKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICBzdGF0ZTogZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICByZXR1cm4gc3RhdGU7XG4gICAgICAgIH0sXG4gICAgICAgIHByb21pc2U6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdmFyIHJldCA9IHt9LFxuICAgICAgICAgICAgICAgIHNlbGYgPSB0aGlzLFxuICAgICAgICAgICAgICAgIGtleXMgPSB1dGlscy5vYmplY3Qua2V5cyh0aGlzKTtcbiAgICAgICAgICAgIHV0aWxzLmVhY2goa2V5cywgZnVuY3Rpb24oaykge1xuICAgICAgICAgICAgICAgIGlmIChrID09PSAncmVzb2x2ZScgfHwgayA9PT0gJ3JlamVjdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXRba10gPSBzZWxmW2tdO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG4gICAgfTtcbiAgICByZXR1cm4gdGhpcztcbn07XG4vKipcbiAqIOWkmuS4qmRlZmVycmVk55qE5byC5q2lXG4gKiBAcGFyYW0gIFtdIGRlZmVyc1xuICogQHJldHVybiBvYmplY3QgcHJvbWlzZeWvueixoVxuICovXG5mdW5jdGlvbiB3aGVuKGRlZmVycykge1xuICAgIHZhciByZXQsIGxlbiwgY291bnQgPSAwO1xuICAgIGlmICghdXRpbHMuaXNBcnJheShkZWZlcnMpKSB7XG4gICAgICAgIGRlZmVycyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICB9XG4gICAgcmV0ID0gRGVmZXJyZWQoKTtcbiAgICBsZW4gPSBkZWZlcnMubGVuZ3RoO1xuICAgIGlmICghbGVuKSB7XG4gICAgICAgIHJldHVybiByZXQucmVzb2x2ZSgpLnByb21pc2UoKTtcbiAgICB9XG4gICAgdXRpbHMuZWFjaChkZWZlcnMsIGZ1bmN0aW9uKGRlZmVyKSB7XG4gICAgICAgIGRlZmVyLmZhaWwoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICByZXQucmVqZWN0KCk7XG4gICAgICAgIH0pLmRvbmUoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBpZiAoKytjb3VudCA9PT0gbGVuKSB7XG4gICAgICAgICAgICAgICAgcmV0LnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJldC5wcm9taXNlKCk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICB3aGVuOiB3aGVuLFxuICAgIERlZmVycmVkOiBEZWZlcnJlZFxufSIsInZhciBkaXJJZCAgICAgICAgICAgPSAxLFxuICAgIEFSR19SRSAgICAgICAgICA9IC9eW1xcd1xcJC1dKyQvLFxuICAgIEZJTFRFUl9UT0tFTl9SRSA9IC9bXlxccydcIl0rfCdbXiddKyd8XCJbXlwiXStcIi9nLFxuICAgIE5FU1RJTkdfUkUgICAgICA9IC9eXFwkKHBhcmVudHxyb290KVxcLi8sXG4gICAgU0lOR0xFX1ZBUl9SRSAgID0gL15bXFx3XFwuJF0rJC8sXG4gICAgUVVPVEVfUkUgICAgICAgID0gL1wiL2csXG4gICAgVGV4dFBhcnNlciAgICAgID0gcmVxdWlyZSgnLi90ZXh0UGFyc2VyJyk7XG5cbi8qKlxuICogIERpcmVjdGl2ZSBjbGFzc1xuICogIHJlcHJlc2VudHMgYSBzaW5nbGUgZGlyZWN0aXZlIGluc3RhbmNlIGluIHRoZSBET01cbiAqL1xuZnVuY3Rpb24gRGlyZWN0aXZlIChuYW1lLCBhc3QsIGRlZmluaXRpb24sIGNvbXBpbGVyLCBlbCkge1xuXG4gICAgdGhpcy5pZCAgICAgICAgICAgICA9IGRpcklkKys7XG4gICAgdGhpcy5uYW1lICAgICAgICAgICA9IG5hbWU7XG4gICAgdGhpcy5jb21waWxlciAgICAgICA9IGNvbXBpbGVyO1xuICAgIHRoaXMudm0gICAgICAgICAgICAgPSBjb21waWxlci52bTtcbiAgICB0aGlzLmVsICAgICAgICAgICAgID0gZWw7XG4gICAgdGhpcy5jb21wdXRlRmlsdGVycyA9IGZhbHNlO1xuICAgIHRoaXMua2V5ICAgICAgICAgICAgPSBhc3Qua2V5O1xuICAgIHRoaXMuYXJnICAgICAgICAgICAgPSBhc3QuYXJnO1xuICAgIHRoaXMuZXhwcmVzc2lvbiAgICAgPSBhc3QuZXhwcmVzc2lvbjtcblxuICAgIHZhciBpc0VtcHR5ID0gdGhpcy5leHByZXNzaW9uID09PSAnJztcblxuICAgIC8vIG1peCBpbiBwcm9wZXJ0aWVzIGZyb20gdGhlIGRpcmVjdGl2ZSBkZWZpbml0aW9uXG4gICAgaWYgKHR5cGVvZiBkZWZpbml0aW9uID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRoaXNbaXNFbXB0eSA/ICdiaW5kJyA6ICd1cGRhdGUnXSA9IGRlZmluaXRpb25cbiAgICB9IGVsc2Uge1xuICAgICAgICBmb3IgKHZhciBwcm9wIGluIGRlZmluaXRpb24pIHtcbiAgICAgICAgICAgIHRoaXNbcHJvcF0gPSBkZWZpbml0aW9uW3Byb3BdXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBlbXB0eSBleHByZXNzaW9uLCB3ZSdyZSBkb25lLlxuICAgIGlmIChpc0VtcHR5IHx8IHRoaXMuaXNFbXB0eSkge1xuICAgICAgICB0aGlzLmlzRW1wdHkgPSB0cnVlXG4gICAgICAgIHJldHVyblxuICAgIH1cblxuICAgIGlmIChUZXh0UGFyc2VyLlJlZ2V4LnRlc3QodGhpcy5rZXkpKSB7XG4gICAgICAgIHRoaXMua2V5ID0gY29tcGlsZXIuZXZhbCh0aGlzLmtleSk7XG4gICAgICAgIGlmICh0aGlzLmlzTGl0ZXJhbCkge1xuICAgICAgICAgICAgdGhpcy5leHByZXNzaW9uID0gdGhpcy5rZXk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgZmlsdGVycyA9IGFzdC5maWx0ZXJzLFxuICAgICAgICBmaWx0ZXIsIGZuLCBpLCBsLCBjb21wdXRlZDtcbiAgICBpZiAoZmlsdGVycykge1xuICAgICAgICB0aGlzLmZpbHRlcnMgPSBbXVxuICAgICAgICBmb3IgKGkgPSAwLCBsID0gZmlsdGVycy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgICAgIGZpbHRlciA9IGZpbHRlcnNbaV1cbiAgICAgICAgICAgIGZuID0gdGhpcy5jb21waWxlci5nZXRPcHRpb24oJ2ZpbHRlcnMnLCBmaWx0ZXIubmFtZSlcbiAgICAgICAgICAgIGlmIChmbikge1xuICAgICAgICAgICAgICAgIGZpbHRlci5hcHBseSA9IGZuXG4gICAgICAgICAgICAgICAgdGhpcy5maWx0ZXJzLnB1c2goZmlsdGVyKVxuICAgICAgICAgICAgICAgIGlmIChmbi5jb21wdXRlZCkge1xuICAgICAgICAgICAgICAgICAgICBjb21wdXRlZCA9IHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuZmlsdGVycyB8fCAhdGhpcy5maWx0ZXJzLmxlbmd0aCkge1xuICAgICAgICB0aGlzLmZpbHRlcnMgPSBudWxsXG4gICAgfVxuXG4gICAgaWYgKGNvbXB1dGVkKSB7XG4gICAgICAgIHRoaXMuY29tcHV0ZWRLZXkgPSBEaXJlY3RpdmUuaW5saW5lRmlsdGVycyh0aGlzLmtleSwgdGhpcy5maWx0ZXJzKVxuICAgICAgICB0aGlzLmZpbHRlcnMgPSBudWxsXG4gICAgfVxuXG4gICAgdGhpcy5pc0V4cCA9XG4gICAgICAgIGNvbXB1dGVkIHx8XG4gICAgICAgICFTSU5HTEVfVkFSX1JFLnRlc3QodGhpcy5rZXkpIHx8XG4gICAgICAgIE5FU1RJTkdfUkUudGVzdCh0aGlzLmtleSlcblxufVxuXG52YXIgRGlyUHJvdG8gPSBEaXJlY3RpdmUucHJvdG90eXBlXG5cbi8qKlxuICogIGNhbGxlZCB3aGVuIGEgbmV3IHZhbHVlIGlzIHNldCBcbiAqICBmb3IgY29tcHV0ZWQgcHJvcGVydGllcywgdGhpcyB3aWxsIG9ubHkgYmUgY2FsbGVkIG9uY2VcbiAqICBkdXJpbmcgaW5pdGlhbGl6YXRpb24uXG4gKi9cbkRpclByb3RvLiR1cGRhdGUgPSBmdW5jdGlvbiAodmFsdWUsIGluaXQpIHtcbiAgICBpZiAodGhpcy4kbG9jaykgcmV0dXJuXG4gICAgaWYgKGluaXQgfHwgdmFsdWUgIT09IHRoaXMudmFsdWUgfHwgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpKSB7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZVxuICAgICAgICBpZiAodGhpcy51cGRhdGUpIHtcbiAgICAgICAgICAgIHRoaXMudXBkYXRlKFxuICAgICAgICAgICAgICAgIHRoaXMuZmlsdGVycyAmJiAhdGhpcy5jb21wdXRlRmlsdGVyc1xuICAgICAgICAgICAgICAgICAgICA/IHRoaXMuJGFwcGx5RmlsdGVycyh2YWx1ZSlcbiAgICAgICAgICAgICAgICAgICAgOiB2YWx1ZSxcbiAgICAgICAgICAgICAgICBpbml0XG4gICAgICAgICAgICApXG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKlxuICogIHBpcGUgdGhlIHZhbHVlIHRocm91Z2ggZmlsdGVyc1xuICovXG5EaXJQcm90by4kYXBwbHlGaWx0ZXJzID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgdmFyIGZpbHRlcmVkID0gdmFsdWUsIGZpbHRlclxuICAgIGZvciAodmFyIGkgPSAwLCBsID0gdGhpcy5maWx0ZXJzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICBmaWx0ZXIgPSB0aGlzLmZpbHRlcnNbaV1cbiAgICAgICAgZmlsdGVyZWQgPSBmaWx0ZXIuYXBwbHkuYXBwbHkodGhpcy52bSwgW2ZpbHRlcmVkXS5jb25jYXQoZmlsdGVyLmFyZ3MpKVxuICAgIH1cbiAgICByZXR1cm4gZmlsdGVyZWRcbn1cblxuLyoqXG4gKiAgVW5iaW5kIGRpcmV0aXZlXG4gKi9cbkRpclByb3RvLiR1bmJpbmQgPSBmdW5jdGlvbiAoKSB7XG4gICAgLy8gdGhpcyBjYW4gYmUgY2FsbGVkIGJlZm9yZSB0aGUgZWwgaXMgZXZlbiBhc3NpZ25lZC4uLlxuICAgIGlmICghdGhpcy5lbCB8fCAhdGhpcy52bSkgcmV0dXJuXG4gICAgaWYgKHRoaXMudW5iaW5kKSB0aGlzLnVuYmluZCgpXG4gICAgdGhpcy52bSA9IHRoaXMuZWwgPSB0aGlzLmJpbmRpbmcgPSB0aGlzLmNvbXBpbGVyID0gbnVsbFxufVxuXG4vLyBFeHBvc2VkIHN0YXRpYyBtZXRob2RzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogIFBhcnNlIGEgZGlyZWN0aXZlIHN0cmluZyBpbnRvIGFuIEFycmF5IG9mXG4gKiAgQVNULWxpa2Ugb2JqZWN0cyByZXByZXNlbnRpbmcgZGlyZWN0aXZlc1xuICovXG5EaXJlY3RpdmUucGFyc2UgPSBmdW5jdGlvbiAoc3RyKSB7XG5cbiAgICB2YXIgaW5TaW5nbGUgPSBmYWxzZSxcbiAgICAgICAgaW5Eb3VibGUgPSBmYWxzZSxcbiAgICAgICAgY3VybHkgICAgPSAwLFxuICAgICAgICBzcXVhcmUgICA9IDAsXG4gICAgICAgIHBhcmVuICAgID0gMCxcbiAgICAgICAgYmVnaW4gICAgPSAwLFxuICAgICAgICBhcmdJbmRleCA9IDAsXG4gICAgICAgIGRpcnMgICAgID0gW10sXG4gICAgICAgIGRpciAgICAgID0ge30sXG4gICAgICAgIGxhc3RGaWx0ZXJJbmRleCA9IDAsXG4gICAgICAgIGFyZ1xuXG4gICAgZm9yICh2YXIgYywgaSA9IDAsIGwgPSBzdHIubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGMgPSBzdHIuY2hhckF0KGkpXG4gICAgICAgIGlmIChpblNpbmdsZSkge1xuICAgICAgICAgICAgLy8gY2hlY2sgc2luZ2xlIHF1b3RlXG4gICAgICAgICAgICBpZiAoYyA9PT0gXCInXCIpIGluU2luZ2xlID0gIWluU2luZ2xlXG4gICAgICAgIH0gZWxzZSBpZiAoaW5Eb3VibGUpIHtcbiAgICAgICAgICAgIC8vIGNoZWNrIGRvdWJsZSBxdW90ZVxuICAgICAgICAgICAgaWYgKGMgPT09ICdcIicpIGluRG91YmxlID0gIWluRG91YmxlXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJywnICYmICFwYXJlbiAmJiAhY3VybHkgJiYgIXNxdWFyZSkge1xuICAgICAgICAgICAgLy8gcmVhY2hlZCB0aGUgZW5kIG9mIGEgZGlyZWN0aXZlXG4gICAgICAgICAgICBwdXNoRGlyKClcbiAgICAgICAgICAgIC8vIHJlc2V0ICYgc2tpcCB0aGUgY29tbWFcbiAgICAgICAgICAgIGRpciA9IHt9XG4gICAgICAgICAgICBiZWdpbiA9IGFyZ0luZGV4ID0gbGFzdEZpbHRlckluZGV4ID0gaSArIDFcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnOicgJiYgIWRpci5rZXkgJiYgIWRpci5hcmcpIHtcbiAgICAgICAgICAgIC8vIGFyZ3VtZW50XG4gICAgICAgICAgICBhcmcgPSBzdHIuc2xpY2UoYmVnaW4sIGkpLnRyaW0oKVxuICAgICAgICAgICAgaWYgKEFSR19SRS50ZXN0KGFyZykpIHtcbiAgICAgICAgICAgICAgICBhcmdJbmRleCA9IGkgKyAxXG4gICAgICAgICAgICAgICAgZGlyLmFyZyA9IGFyZ1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICd8JyAmJiBzdHIuY2hhckF0KGkgKyAxKSAhPT0gJ3wnICYmIHN0ci5jaGFyQXQoaSAtIDEpICE9PSAnfCcpIHtcbiAgICAgICAgICAgIGlmIChkaXIua2V5ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICAvLyBmaXJzdCBmaWx0ZXIsIGVuZCBvZiBrZXlcbiAgICAgICAgICAgICAgICBsYXN0RmlsdGVySW5kZXggPSBpICsgMVxuICAgICAgICAgICAgICAgIGRpci5rZXkgPSBzdHIuc2xpY2UoYXJnSW5kZXgsIGkpLnRyaW0oKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBhbHJlYWR5IGhhcyBmaWx0ZXJcbiAgICAgICAgICAgICAgICBwdXNoRmlsdGVyKClcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnXCInKSB7XG4gICAgICAgICAgICBpbkRvdWJsZSA9IHRydWVcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSBcIidcIikge1xuICAgICAgICAgICAgaW5TaW5nbGUgPSB0cnVlXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJygnKSB7XG4gICAgICAgICAgICBwYXJlbisrXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJyknKSB7XG4gICAgICAgICAgICBwYXJlbi0tXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ1snKSB7XG4gICAgICAgICAgICBzcXVhcmUrK1xuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICddJykge1xuICAgICAgICAgICAgc3F1YXJlLS1cbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAneycpIHtcbiAgICAgICAgICAgIGN1cmx5KytcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnfScpIHtcbiAgICAgICAgICAgIGN1cmx5LS1cbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoaSA9PT0gMCB8fCBiZWdpbiAhPT0gaSkge1xuICAgICAgICBwdXNoRGlyKClcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBwdXNoRGlyICgpIHtcbiAgICAgICAgZGlyLmV4cHJlc3Npb24gPSBzdHIuc2xpY2UoYmVnaW4sIGkpLnRyaW0oKVxuICAgICAgICBpZiAoZGlyLmtleSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBkaXIua2V5ID0gc3RyLnNsaWNlKGFyZ0luZGV4LCBpKS50cmltKClcbiAgICAgICAgfSBlbHNlIGlmIChsYXN0RmlsdGVySW5kZXggIT09IGJlZ2luKSB7XG4gICAgICAgICAgICBwdXNoRmlsdGVyKClcbiAgICAgICAgfVxuICAgICAgICBpZiAoaSA9PT0gMCB8fCBkaXIua2V5KSB7XG4gICAgICAgICAgICBkaXJzLnB1c2goZGlyKVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcHVzaEZpbHRlciAoKSB7XG4gICAgICAgIHZhciBleHAgPSBzdHIuc2xpY2UobGFzdEZpbHRlckluZGV4LCBpKS50cmltKCksXG4gICAgICAgICAgICBmaWx0ZXJcbiAgICAgICAgaWYgKGV4cCkge1xuICAgICAgICAgICAgZmlsdGVyID0ge31cbiAgICAgICAgICAgIHZhciB0b2tlbnMgPSBleHAubWF0Y2goRklMVEVSX1RPS0VOX1JFKVxuICAgICAgICAgICAgZmlsdGVyLm5hbWUgPSB0b2tlbnNbMF1cbiAgICAgICAgICAgIGZpbHRlci5hcmdzID0gdG9rZW5zLmxlbmd0aCA+IDEgPyB0b2tlbnMuc2xpY2UoMSkgOiBudWxsXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZpbHRlcikge1xuICAgICAgICAgICAgKGRpci5maWx0ZXJzID0gZGlyLmZpbHRlcnMgfHwgW10pLnB1c2goZmlsdGVyKVxuICAgICAgICB9XG4gICAgICAgIGxhc3RGaWx0ZXJJbmRleCA9IGkgKyAxXG4gICAgfVxuXG4gICAgcmV0dXJuIGRpcnNcbn1cblxuLyoqXG4gKiAgSW5saW5lIGNvbXB1dGVkIGZpbHRlcnMgc28gdGhleSBiZWNvbWUgcGFydFxuICogIG9mIHRoZSBleHByZXNzaW9uXG4gKi9cbkRpcmVjdGl2ZS5pbmxpbmVGaWx0ZXJzID0gZnVuY3Rpb24gKGtleSwgZmlsdGVycykge1xuICAgIHZhciBhcmdzLCBmaWx0ZXJcbiAgICBmb3IgKHZhciBpID0gMCwgbCA9IGZpbHRlcnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGZpbHRlciA9IGZpbHRlcnNbaV1cbiAgICAgICAgYXJncyA9IGZpbHRlci5hcmdzXG4gICAgICAgICAgICA/ICcsXCInICsgZmlsdGVyLmFyZ3MubWFwKGVzY2FwZVF1b3RlKS5qb2luKCdcIixcIicpICsgJ1wiJ1xuICAgICAgICAgICAgOiAnJ1xuICAgICAgICBrZXkgPSAndGhpcy4kY29tcGlsZXIuZ2V0T3B0aW9uKFwiZmlsdGVyc1wiLCBcIicgK1xuICAgICAgICAgICAgICAgIGZpbHRlci5uYW1lICtcbiAgICAgICAgICAgICdcIikuY2FsbCh0aGlzLCcgK1xuICAgICAgICAgICAgICAgIGtleSArIGFyZ3MgK1xuICAgICAgICAgICAgJyknXG4gICAgfVxuICAgIHJldHVybiBrZXlcbn1cblxuLyoqXG4gKiAgQ29udmVydCBkb3VibGUgcXVvdGVzIHRvIHNpbmdsZSBxdW90ZXNcbiAqICBzbyB0aGV5IGRvbid0IG1lc3MgdXAgdGhlIGdlbmVyYXRlZCBmdW5jdGlvbiBib2R5XG4gKi9cbmZ1bmN0aW9uIGVzY2FwZVF1b3RlICh2KSB7XG4gICAgcmV0dXJuIHYuaW5kZXhPZignXCInKSA+IC0xXG4gICAgICAgID8gdi5yZXBsYWNlKFFVT1RFX1JFLCAnXFwnJylcbiAgICAgICAgOiB2XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRGlyZWN0aXZlOyIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJyksXG4gICAgc2xpY2UgPSBbXS5zbGljZVxuXG4vKipcbiAqICBCaW5kaW5nIGZvciBpbm5lckhUTUxcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIC8vIGEgY29tbWVudCBub2RlIG1lYW5zIHRoaXMgaXMgYSBiaW5kaW5nIGZvclxuICAgICAgICAvLyB7e3sgaW5saW5lIHVuZXNjYXBlZCBodG1sIH19fVxuICAgICAgICBpZiAodGhpcy5lbC5ub2RlVHlwZSA9PT0gOCkge1xuICAgICAgICAgICAgLy8gaG9sZCBub2Rlc1xuICAgICAgICAgICAgdGhpcy5ub2RlcyA9IFtdXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgdmFsdWUgPSB1dGlscy5ndWFyZCh2YWx1ZSlcbiAgICAgICAgaWYgKHRoaXMubm9kZXMpIHtcbiAgICAgICAgICAgIHRoaXMuc3dhcCh2YWx1ZSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZWwuaW5uZXJIVE1MID0gdmFsdWVcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICBzd2FwOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgdmFyIHBhcmVudCA9IHRoaXMuZWwucGFyZW50Tm9kZSxcbiAgICAgICAgICAgIG5vZGVzICA9IHRoaXMubm9kZXMsXG4gICAgICAgICAgICBpICAgICAgPSBub2Rlcy5sZW5ndGhcbiAgICAgICAgLy8gcmVtb3ZlIG9sZCBub2Rlc1xuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBwYXJlbnQucmVtb3ZlQ2hpbGQobm9kZXNbaV0pXG4gICAgICAgIH1cbiAgICAgICAgLy8gY29udmVydCBuZXcgdmFsdWUgdG8gYSBmcmFnbWVudFxuICAgICAgICB2YXIgZnJhZyA9IHV0aWxzLnRvRnJhZ21lbnQodmFsdWUpXG4gICAgICAgIC8vIHNhdmUgYSByZWZlcmVuY2UgdG8gdGhlc2Ugbm9kZXMgc28gd2UgY2FuIHJlbW92ZSBsYXRlclxuICAgICAgICB0aGlzLm5vZGVzID0gc2xpY2UuY2FsbChmcmFnLmNoaWxkTm9kZXMpXG4gICAgICAgIHBhcmVudC5pbnNlcnRCZWZvcmUoZnJhZywgdGhpcy5lbClcbiAgICB9XG59IiwidmFyIHV0aWxzICAgID0gcmVxdWlyZSgnLi4vdXRpbHMnKVxuXG4vKipcbiAqICBNYW5hZ2VzIGEgY29uZGl0aW9uYWwgY2hpbGQgVk1cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIFxuICAgICAgICB0aGlzLnBhcmVudCA9IHRoaXMuZWwucGFyZW50Tm9kZVxuICAgICAgICB0aGlzLnJlZiAgICA9IGRvY3VtZW50LmNyZWF0ZUNvbW1lbnQoJ3Z1ZS1pZicpXG4gICAgICAgIHRoaXMuQ3RvciAgID0gdGhpcy5jb21waWxlci5yZXNvbHZlQ29tcG9uZW50KHRoaXMuZWwpXG5cbiAgICAgICAgLy8gaW5zZXJ0IHJlZlxuICAgICAgICB0aGlzLnBhcmVudC5pbnNlcnRCZWZvcmUodGhpcy5yZWYsIHRoaXMuZWwpXG4gICAgICAgIHRoaXMucGFyZW50LnJlbW92ZUNoaWxkKHRoaXMuZWwpXG5cbiAgICAgICAgaWYgKHV0aWxzLmF0dHIodGhpcy5lbCwgJ3ZpZXcnKSkge1xuICAgICAgICAgICAgdXRpbHMud2FybihcbiAgICAgICAgICAgICAgICAnQ29uZmxpY3Q6IHYtaWYgY2Fubm90IGJlIHVzZWQgdG9nZXRoZXIgd2l0aCB2LXZpZXcuICcgK1xuICAgICAgICAgICAgICAgICdKdXN0IHNldCB2LXZpZXdcXCdzIGJpbmRpbmcgdmFsdWUgdG8gZW1wdHkgc3RyaW5nIHRvIGVtcHR5IGl0LidcbiAgICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgICBpZiAodXRpbHMuYXR0cih0aGlzLmVsLCAncmVwZWF0JykpIHtcbiAgICAgICAgICAgIHV0aWxzLndhcm4oXG4gICAgICAgICAgICAgICAgJ0NvbmZsaWN0OiB2LWlmIGNhbm5vdCBiZSB1c2VkIHRvZ2V0aGVyIHdpdGggdi1yZXBlYXQuICcgK1xuICAgICAgICAgICAgICAgICdVc2UgYHYtc2hvd2Agb3IgdGhlIGBmaWx0ZXJCeWAgZmlsdGVyIGluc3RlYWQuJ1xuICAgICAgICAgICAgKVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKHZhbHVlKSB7XG5cbiAgICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICAgICAgdGhpcy51bmJpbmQoKVxuICAgICAgICB9IGVsc2UgaWYgKCF0aGlzLmNoaWxkVk0pIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTSA9IG5ldyB0aGlzLkN0b3Ioe1xuICAgICAgICAgICAgICAgIGVsOiB0aGlzLmVsLmNsb25lTm9kZSh0cnVlKSxcbiAgICAgICAgICAgICAgICBwYXJlbnQ6IHRoaXMudm1cbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBpZiAodGhpcy5jb21waWxlci5pbml0KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5wYXJlbnQuaW5zZXJ0QmVmb3JlKHRoaXMuY2hpbGRWTS4kZWwsIHRoaXMucmVmKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLmNoaWxkVk0uJGJlZm9yZSh0aGlzLnJlZilcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICB9LFxuXG4gICAgdW5iaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmICh0aGlzLmNoaWxkVk0pIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTS4kZGVzdHJveSgpXG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0gPSBudWxsXG4gICAgICAgIH1cbiAgICB9XG59IiwidmFyIHV0aWxzICAgICAgPSByZXF1aXJlKCcuLi91dGlscycpLFxuICAgIGNvbmZpZyAgICAgPSByZXF1aXJlKCcuLi9jb25maWcnKSxcbiAgICBkaXJlY3RpdmVzID0gbW9kdWxlLmV4cG9ydHMgPSB1dGlscy5oYXNoKClcblxuLyoqXG4gKiAgTmVzdCBhbmQgbWFuYWdlIGEgQ2hpbGQgVk1cbiAqL1xuZGlyZWN0aXZlcy5jb21wb25lbnQgPSB7XG4gICAgaXNMaXRlcmFsOiB0cnVlLFxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgaWYgKCF0aGlzLmVsLl92bSkge1xuICAgICAgICAgICAgdGhpcy5jaGlsZFZNID0gbmV3IHRoaXMuQ3Rvcih7XG4gICAgICAgICAgICAgICAgZWw6IHRoaXMuZWwsXG4gICAgICAgICAgICAgICAgcGFyZW50OiB0aGlzLnZtXG4gICAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgfSxcbiAgICB1bmJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgaWYgKHRoaXMuY2hpbGRWTSkge1xuICAgICAgICAgICAgdGhpcy5jaGlsZFZNLiRkZXN0cm95KClcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgQmluZGluZyBIVE1MIGF0dHJpYnV0ZXNcbiAqL1xuZGlyZWN0aXZlcy5hdHRyID0ge1xuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIHBhcmFtcyA9IHRoaXMudm0uJG9wdGlvbnMucGFyYW1BdHRyaWJ1dGVzXG4gICAgICAgIHRoaXMuaXNQYXJhbSA9IHBhcmFtcyAmJiBwYXJhbXMuaW5kZXhPZih0aGlzLmFyZykgPiAtMVxuICAgIH0sXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgaWYgKHZhbHVlIHx8IHZhbHVlID09PSAwKSB7XG4gICAgICAgICAgICB0aGlzLmVsLnNldEF0dHJpYnV0ZSh0aGlzLmFyZywgdmFsdWUpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmVsLnJlbW92ZUF0dHJpYnV0ZSh0aGlzLmFyZylcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5pc1BhcmFtKSB7XG4gICAgICAgICAgICB0aGlzLnZtW3RoaXMuYXJnXSA9IHV0aWxzLmNoZWNrTnVtYmVyKHZhbHVlKVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBCaW5kaW5nIHRleHRDb250ZW50XG4gKi9cbmRpcmVjdGl2ZXMudGV4dCA9IHtcbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHRoaXMuYXR0ciA9IHRoaXMuZWwubm9kZVR5cGUgPT09IDNcbiAgICAgICAgICAgID8gJ25vZGVWYWx1ZSdcbiAgICAgICAgICAgIDogJ3RleHRDb250ZW50J1xuICAgIH0sXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgdGhpcy5lbFt0aGlzLmF0dHJdID0gdXRpbHMuZ3VhcmQodmFsdWUpXG4gICAgfVxufVxuXG4vKipcbiAqICBCaW5kaW5nIENTUyBkaXNwbGF5IHByb3BlcnR5XG4gKi9cbmRpcmVjdGl2ZXMuc2hvdyA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHZhciBlbCA9IHRoaXMuZWwsXG4gICAgICAgIHRhcmdldCA9IHZhbHVlID8gJycgOiAnbm9uZScsXG4gICAgICAgIGNoYW5nZSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGVsLnN0eWxlLmRpc3BsYXkgPSB0YXJnZXRcbiAgICAgICAgfVxufVxuXG4vKipcbiAqICBCaW5kaW5nIENTUyBjbGFzc2VzXG4gKi9cbmRpcmVjdGl2ZXNbJ2NsYXNzJ10gPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICBpZiAodGhpcy5hcmcpIHtcbiAgICAgICAgdXRpbHNbdmFsdWUgPyAnYWRkQ2xhc3MnIDogJ3JlbW92ZUNsYXNzJ10odGhpcy5lbCwgdGhpcy5hcmcpXG4gICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKHRoaXMubGFzdFZhbCkge1xuICAgICAgICAgICAgdXRpbHMucmVtb3ZlQ2xhc3ModGhpcy5lbCwgdGhpcy5sYXN0VmFsKVxuICAgICAgICB9XG4gICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgdXRpbHMuYWRkQ2xhc3ModGhpcy5lbCwgdmFsdWUpXG4gICAgICAgICAgICB0aGlzLmxhc3RWYWwgPSB2YWx1ZVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBPbmx5IHJlbW92ZWQgYWZ0ZXIgdGhlIG93bmVyIFZNIGlzIHJlYWR5XG4gKi9cbmRpcmVjdGl2ZXMuY2xvYWsgPSB7XG4gICAgaXNFbXB0eTogdHJ1ZSxcbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBlbCA9IHRoaXMuZWxcbiAgICAgICAgdGhpcy5jb21waWxlci5vYnNlcnZlci5vbmNlKCdob29rOnJlYWR5JywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgZWwucmVtb3ZlQXR0cmlidXRlKGNvbmZpZy5wcmVmaXggKyAnLWNsb2FrJylcbiAgICAgICAgfSlcbiAgICB9XG59XG5cbi8qKlxuICogIFN0b3JlIGEgcmVmZXJlbmNlIHRvIHNlbGYgaW4gcGFyZW50IFZNJ3MgJFxuICovXG5kaXJlY3RpdmVzLnJlZiA9IHtcbiAgICBpc0xpdGVyYWw6IHRydWUsXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgaWQgPSB0aGlzLmV4cHJlc3Npb25cbiAgICAgICAgaWYgKGlkKSB7XG4gICAgICAgICAgICB0aGlzLnZtLiRwYXJlbnQuJFtpZF0gPSB0aGlzLnZtXG4gICAgICAgIH1cbiAgICB9LFxuICAgIHVuYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgaWQgPSB0aGlzLmV4cHJlc3Npb25cbiAgICAgICAgaWYgKGlkKSB7XG4gICAgICAgICAgICBkZWxldGUgdGhpcy52bS4kcGFyZW50LiRbaWRdXG4gICAgICAgIH1cbiAgICB9XG59XG5cbmRpcmVjdGl2ZXMub24gICAgICA9IHJlcXVpcmUoJy4vb24nKVxuZGlyZWN0aXZlcy5yZXBlYXQgID0gcmVxdWlyZSgnLi9yZXBlYXQnKVxuZGlyZWN0aXZlcy5tb2RlbCAgID0gcmVxdWlyZSgnLi9tb2RlbCcpXG5kaXJlY3RpdmVzWydpZiddICAgPSByZXF1aXJlKCcuL2lmJylcbmRpcmVjdGl2ZXNbJ3dpdGgnXSA9IHJlcXVpcmUoJy4vd2l0aCcpXG5kaXJlY3RpdmVzLmh0bWwgICAgPSByZXF1aXJlKCcuL2h0bWwnKVxuZGlyZWN0aXZlcy5zdHlsZSAgID0gcmVxdWlyZSgnLi9zdHlsZScpXG5kaXJlY3RpdmVzLnBhcnRpYWwgPSByZXF1aXJlKCcuL3BhcnRpYWwnKVxuZGlyZWN0aXZlcy52aWV3ICAgID0gcmVxdWlyZSgnLi92aWV3JykiLCJ2YXIgdXRpbHMgPSByZXF1aXJlKCcuLi91dGlscycpLFxuICAgIGlzSUU5ID0gbmF2aWdhdG9yLnVzZXJBZ2VudC5pbmRleE9mKCdNU0lFIDkuMCcpID4gMCxcbiAgICBmaWx0ZXIgPSBbXS5maWx0ZXJcblxuLyoqXG4gKiAgUmV0dXJucyBhbiBhcnJheSBvZiB2YWx1ZXMgZnJvbSBhIG11bHRpcGxlIHNlbGVjdFxuICovXG5mdW5jdGlvbiBnZXRNdWx0aXBsZVNlbGVjdE9wdGlvbnMgKHNlbGVjdCkge1xuICAgIHJldHVybiBmaWx0ZXJcbiAgICAgICAgLmNhbGwoc2VsZWN0Lm9wdGlvbnMsIGZ1bmN0aW9uIChvcHRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBvcHRpb24uc2VsZWN0ZWRcbiAgICAgICAgfSlcbiAgICAgICAgLm1hcChmdW5jdGlvbiAob3B0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gb3B0aW9uLnZhbHVlIHx8IG9wdGlvbi50ZXh0XG4gICAgICAgIH0pXG59XG5cbi8qKlxuICogIFR3by13YXkgYmluZGluZyBmb3IgZm9ybSBpbnB1dCBlbGVtZW50c1xuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcblxuICAgICAgICB2YXIgc2VsZiA9IHRoaXMsXG4gICAgICAgICAgICBlbCAgID0gc2VsZi5lbCxcbiAgICAgICAgICAgIHR5cGUgPSBlbC50eXBlLFxuICAgICAgICAgICAgdGFnICA9IGVsLnRhZ05hbWVcblxuICAgICAgICBzZWxmLmxvY2sgPSBmYWxzZVxuICAgICAgICBzZWxmLm93bmVyVk0gPSBzZWxmLmJpbmRpbmcuY29tcGlsZXIudm1cblxuICAgICAgICAvLyBkZXRlcm1pbmUgd2hhdCBldmVudCB0byBsaXN0ZW4gdG9cbiAgICAgICAgc2VsZi5ldmVudCA9XG4gICAgICAgICAgICAoc2VsZi5jb21waWxlci5vcHRpb25zLmxhenkgfHxcbiAgICAgICAgICAgIHRhZyA9PT0gJ1NFTEVDVCcgfHxcbiAgICAgICAgICAgIHR5cGUgPT09ICdjaGVja2JveCcgfHwgdHlwZSA9PT0gJ3JhZGlvJylcbiAgICAgICAgICAgICAgICA/ICdjaGFuZ2UnXG4gICAgICAgICAgICAgICAgOiAnaW5wdXQnXG5cbiAgICAgICAgLy8gZGV0ZXJtaW5lIHRoZSBhdHRyaWJ1dGUgdG8gY2hhbmdlIHdoZW4gdXBkYXRpbmdcbiAgICAgICAgc2VsZi5hdHRyID0gdHlwZSA9PT0gJ2NoZWNrYm94J1xuICAgICAgICAgICAgPyAnY2hlY2tlZCdcbiAgICAgICAgICAgIDogKHRhZyA9PT0gJ0lOUFVUJyB8fCB0YWcgPT09ICdTRUxFQ1QnIHx8IHRhZyA9PT0gJ1RFWFRBUkVBJylcbiAgICAgICAgICAgICAgICA/ICd2YWx1ZSdcbiAgICAgICAgICAgICAgICA6ICdpbm5lckhUTUwnXG5cbiAgICAgICAgLy8gc2VsZWN0W211bHRpcGxlXSBzdXBwb3J0XG4gICAgICAgIGlmKHRhZyA9PT0gJ1NFTEVDVCcgJiYgZWwuaGFzQXR0cmlidXRlKCdtdWx0aXBsZScpKSB7XG4gICAgICAgICAgICB0aGlzLm11bHRpID0gdHJ1ZVxuICAgICAgICB9XG5cbiAgICAgICAgdmFyIGNvbXBvc2l0aW9uTG9jayA9IGZhbHNlXG4gICAgICAgIHNlbGYuY0xvY2sgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBjb21wb3NpdGlvbkxvY2sgPSB0cnVlXG4gICAgICAgIH1cbiAgICAgICAgc2VsZi5jVW5sb2NrID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgY29tcG9zaXRpb25Mb2NrID0gZmFsc2VcbiAgICAgICAgfVxuICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdjb21wb3NpdGlvbnN0YXJ0JywgdGhpcy5jTG9jaylcbiAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignY29tcG9zaXRpb25lbmQnLCB0aGlzLmNVbmxvY2spXG5cbiAgICAgICAgLy8gYXR0YWNoIGxpc3RlbmVyXG4gICAgICAgIHNlbGYuc2V0ID0gc2VsZi5maWx0ZXJzXG4gICAgICAgICAgICA/IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29tcG9zaXRpb25Mb2NrKSByZXR1cm5cbiAgICAgICAgICAgICAgICAvLyBpZiB0aGlzIGRpcmVjdGl2ZSBoYXMgZmlsdGVyc1xuICAgICAgICAgICAgICAgIC8vIHdlIG5lZWQgdG8gbGV0IHRoZSB2bS4kc2V0IHRyaWdnZXJcbiAgICAgICAgICAgICAgICAvLyB1cGRhdGUoKSBzbyBmaWx0ZXJzIGFyZSBhcHBsaWVkLlxuICAgICAgICAgICAgICAgIC8vIHRoZXJlZm9yZSB3ZSBoYXZlIHRvIHJlY29yZCBjdXJzb3IgcG9zaXRpb25cbiAgICAgICAgICAgICAgICAvLyBzbyB0aGF0IGFmdGVyIHZtLiRzZXQgY2hhbmdlcyB0aGUgaW5wdXRcbiAgICAgICAgICAgICAgICAvLyB2YWx1ZSB3ZSBjYW4gcHV0IHRoZSBjdXJzb3IgYmFjayBhdCB3aGVyZSBpdCBpc1xuICAgICAgICAgICAgICAgIHZhciBjdXJzb3JQb3NcbiAgICAgICAgICAgICAgICB0cnkgeyBjdXJzb3JQb3MgPSBlbC5zZWxlY3Rpb25TdGFydCB9IGNhdGNoIChlKSB7fVxuXG4gICAgICAgICAgICAgICAgc2VsZi5fc2V0KClcblxuICAgICAgICAgICAgICAgIC8vIHNpbmNlIHVwZGF0ZXMgYXJlIGFzeW5jXG4gICAgICAgICAgICAgICAgLy8gd2UgbmVlZCB0byByZXNldCBjdXJzb3IgcG9zaXRpb24gYXN5bmMgdG9vXG4gICAgICAgICAgICAgICAgdXRpbHMubmV4dFRpY2soZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoY3Vyc29yUG9zICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVsLnNldFNlbGVjdGlvblJhbmdlKGN1cnNvclBvcywgY3Vyc29yUG9zKVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGlmIChjb21wb3NpdGlvbkxvY2spIHJldHVyblxuICAgICAgICAgICAgICAgIC8vIG5vIGZpbHRlcnMsIGRvbid0IGxldCBpdCB0cmlnZ2VyIHVwZGF0ZSgpXG4gICAgICAgICAgICAgICAgc2VsZi5sb2NrID0gdHJ1ZVxuXG4gICAgICAgICAgICAgICAgc2VsZi5fc2V0KClcblxuICAgICAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5sb2NrID0gZmFsc2VcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfVxuICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKHNlbGYuZXZlbnQsIHNlbGYuc2V0KVxuXG4gICAgICAgIC8vIGZpeCBzaGl0IGZvciBJRTlcbiAgICAgICAgLy8gc2luY2UgaXQgZG9lc24ndCBmaXJlIGlucHV0IG9uIGJhY2tzcGFjZSAvIGRlbCAvIGN1dFxuICAgICAgICBpZiAoaXNJRTkpIHtcbiAgICAgICAgICAgIHNlbGYub25DdXQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgLy8gY3V0IGV2ZW50IGZpcmVzIGJlZm9yZSB0aGUgdmFsdWUgYWN0dWFsbHkgY2hhbmdlc1xuICAgICAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5zZXQoKVxuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZWxmLm9uRGVsID0gZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZS5rZXlDb2RlID09PSA0NiB8fCBlLmtleUNvZGUgPT09IDgpIHtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5zZXQoKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2N1dCcsIHNlbGYub25DdXQpXG4gICAgICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdrZXl1cCcsIHNlbGYub25EZWwpXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgX3NldDogZnVuY3Rpb24gKCkge1xuICAgICAgICB0aGlzLm93bmVyVk0uJHNldChcbiAgICAgICAgICAgIHRoaXMua2V5LCB0aGlzLm11bHRpXG4gICAgICAgICAgICAgICAgPyBnZXRNdWx0aXBsZVNlbGVjdE9wdGlvbnModGhpcy5lbClcbiAgICAgICAgICAgICAgICA6IHRoaXMuZWxbdGhpcy5hdHRyXVxuICAgICAgICApXG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKHZhbHVlLCBpbml0KSB7XG4gICAgICAgIC8qIGpzaGludCBlcWVxZXE6IGZhbHNlICovXG4gICAgICAgIC8vIHN5bmMgYmFjayBpbmxpbmUgdmFsdWUgaWYgaW5pdGlhbCBkYXRhIGlzIHVuZGVmaW5lZFxuICAgICAgICBpZiAoaW5pdCAmJiB2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2V0KClcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5sb2NrKSByZXR1cm5cbiAgICAgICAgdmFyIGVsID0gdGhpcy5lbFxuICAgICAgICBpZiAoZWwudGFnTmFtZSA9PT0gJ1NFTEVDVCcpIHsgLy8gc2VsZWN0IGRyb3Bkb3duXG4gICAgICAgICAgICBlbC5zZWxlY3RlZEluZGV4ID0gLTFcbiAgICAgICAgICAgIGlmKHRoaXMubXVsdGkgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZS5mb3JFYWNoKHRoaXMudXBkYXRlU2VsZWN0LCB0aGlzKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLnVwZGF0ZVNlbGVjdCh2YWx1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChlbC50eXBlID09PSAncmFkaW8nKSB7IC8vIHJhZGlvIGJ1dHRvblxuICAgICAgICAgICAgZWwuY2hlY2tlZCA9IHZhbHVlID09IGVsLnZhbHVlXG4gICAgICAgIH0gZWxzZSBpZiAoZWwudHlwZSA9PT0gJ2NoZWNrYm94JykgeyAvLyBjaGVja2JveFxuICAgICAgICAgICAgZWwuY2hlY2tlZCA9ICEhdmFsdWVcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGVsW3RoaXMuYXR0cl0gPSB1dGlscy5ndWFyZCh2YWx1ZSlcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICB1cGRhdGVTZWxlY3Q6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICAvKiBqc2hpbnQgZXFlcWVxOiBmYWxzZSAqL1xuICAgICAgICAvLyBzZXR0aW5nIDxzZWxlY3Q+J3MgdmFsdWUgaW4gSUU5IGRvZXNuJ3Qgd29ya1xuICAgICAgICAvLyB3ZSBoYXZlIHRvIG1hbnVhbGx5IGxvb3AgdGhyb3VnaCB0aGUgb3B0aW9uc1xuICAgICAgICB2YXIgb3B0aW9ucyA9IHRoaXMuZWwub3B0aW9ucyxcbiAgICAgICAgICAgIGkgPSBvcHRpb25zLmxlbmd0aFxuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBpZiAob3B0aW9uc1tpXS52YWx1ZSA9PSB2YWx1ZSkge1xuICAgICAgICAgICAgICAgIG9wdGlvbnNbaV0uc2VsZWN0ZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICB1bmJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGVsID0gdGhpcy5lbFxuICAgICAgICBlbC5yZW1vdmVFdmVudExpc3RlbmVyKHRoaXMuZXZlbnQsIHRoaXMuc2V0KVxuICAgICAgICBlbC5yZW1vdmVFdmVudExpc3RlbmVyKCdjb21wb3NpdGlvbnN0YXJ0JywgdGhpcy5jTG9jaylcbiAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignY29tcG9zaXRpb25lbmQnLCB0aGlzLmNVbmxvY2spXG4gICAgICAgIGlmIChpc0lFOSkge1xuICAgICAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignY3V0JywgdGhpcy5vbkN1dClcbiAgICAgICAgICAgIGVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleXVwJywgdGhpcy5vbkRlbClcbiAgICAgICAgfVxuICAgIH1cbn0iLCJ2YXIgdXRpbHMgICAgPSByZXF1aXJlKCcuLi91dGlscycpXG5cbi8qKlxuICogIEJpbmRpbmcgZm9yIGV2ZW50IGxpc3RlbmVyc1xuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGlzRm46IHRydWUsXG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHRoaXMuY29udGV4dCA9IHRoaXMuYmluZGluZy5pc0V4cFxuICAgICAgICAgICAgPyB0aGlzLnZtXG4gICAgICAgICAgICA6IHRoaXMuYmluZGluZy5jb21waWxlci52bVxuICAgICAgICBpZiAodGhpcy5lbC50YWdOYW1lID09PSAnSUZSQU1FJyAmJiB0aGlzLmFyZyAhPT0gJ2xvYWQnKSB7XG4gICAgICAgICAgICB2YXIgc2VsZiA9IHRoaXNcbiAgICAgICAgICAgIHRoaXMuaWZyYW1lQmluZCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBzZWxmLmVsLmNvbnRlbnRXaW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihzZWxmLmFyZywgc2VsZi5oYW5kbGVyKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5lbC5hZGRFdmVudExpc3RlbmVyKCdsb2FkJywgdGhpcy5pZnJhbWVCaW5kKVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKGhhbmRsZXIpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBoYW5kbGVyICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICB1dGlscy53YXJuKCdEaXJlY3RpdmUgXCJ2LW9uOicgKyB0aGlzLmV4cHJlc3Npb24gKyAnXCIgZXhwZWN0cyBhIG1ldGhvZC4nKVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5yZXNldCgpXG4gICAgICAgIHZhciB2bSA9IHRoaXMudm0sXG4gICAgICAgICAgICBjb250ZXh0ID0gdGhpcy5jb250ZXh0XG4gICAgICAgIHRoaXMuaGFuZGxlciA9IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICBlLnRhcmdldFZNID0gdm1cbiAgICAgICAgICAgIGNvbnRleHQuJGV2ZW50ID0gZVxuICAgICAgICAgICAgdmFyIHJlcyA9IGhhbmRsZXIuY2FsbChjb250ZXh0LCBlKVxuICAgICAgICAgICAgY29udGV4dC4kZXZlbnQgPSBudWxsXG4gICAgICAgICAgICByZXR1cm4gcmVzXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuaWZyYW1lQmluZCkge1xuICAgICAgICAgICAgdGhpcy5pZnJhbWVCaW5kKClcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZWwuYWRkRXZlbnRMaXN0ZW5lcih0aGlzLmFyZywgdGhpcy5oYW5kbGVyKVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHJlc2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBlbCA9IHRoaXMuaWZyYW1lQmluZFxuICAgICAgICAgICAgPyB0aGlzLmVsLmNvbnRlbnRXaW5kb3dcbiAgICAgICAgICAgIDogdGhpcy5lbFxuICAgICAgICBpZiAodGhpcy5oYW5kbGVyKSB7XG4gICAgICAgICAgICBlbC5yZW1vdmVFdmVudExpc3RlbmVyKHRoaXMuYXJnLCB0aGlzLmhhbmRsZXIpXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdW5iaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHRoaXMucmVzZXQoKVxuICAgICAgICB0aGlzLmVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2xvYWQnLCB0aGlzLmlmcmFtZUJpbmQpXG4gICAgfVxufSIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJylcblxuLyoqXG4gKiAgQmluZGluZyBmb3IgcGFydGlhbHNcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBpc0xpdGVyYWw6IHRydWUsXG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG5cbiAgICAgICAgdmFyIGlkID0gdGhpcy5leHByZXNzaW9uXG4gICAgICAgIGlmICghaWQpIHJldHVyblxuXG4gICAgICAgIHZhciBlbCAgICAgICA9IHRoaXMuZWwsXG4gICAgICAgICAgICBjb21waWxlciA9IHRoaXMuY29tcGlsZXIsXG4gICAgICAgICAgICBwYXJ0aWFsICA9IGNvbXBpbGVyLmdldE9wdGlvbigncGFydGlhbHMnLCBpZClcblxuICAgICAgICBpZiAoIXBhcnRpYWwpIHtcbiAgICAgICAgICAgIGlmIChpZCA9PT0gJ3lpZWxkJykge1xuICAgICAgICAgICAgICAgIHV0aWxzLndhcm4oJ3t7PnlpZWxkfX0gc3ludGF4IGhhcyBiZWVuIGRlcHJlY2F0ZWQuIFVzZSA8Y29udGVudD4gdGFnIGluc3RlYWQuJylcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG5cbiAgICAgICAgcGFydGlhbCA9IHBhcnRpYWwuY2xvbmVOb2RlKHRydWUpXG5cbiAgICAgICAgLy8gY29tbWVudCByZWYgbm9kZSBtZWFucyBpbmxpbmUgcGFydGlhbFxuICAgICAgICBpZiAoZWwubm9kZVR5cGUgPT09IDgpIHtcblxuICAgICAgICAgICAgLy8ga2VlcCBhIHJlZiBmb3IgdGhlIHBhcnRpYWwncyBjb250ZW50IG5vZGVzXG4gICAgICAgICAgICB2YXIgbm9kZXMgPSBbXS5zbGljZS5jYWxsKHBhcnRpYWwuY2hpbGROb2RlcyksXG4gICAgICAgICAgICAgICAgcGFyZW50ID0gZWwucGFyZW50Tm9kZVxuICAgICAgICAgICAgcGFyZW50Lmluc2VydEJlZm9yZShwYXJ0aWFsLCBlbClcbiAgICAgICAgICAgIHBhcmVudC5yZW1vdmVDaGlsZChlbClcbiAgICAgICAgICAgIC8vIGNvbXBpbGUgcGFydGlhbCBhZnRlciBhcHBlbmRpbmcsIGJlY2F1c2UgaXRzIGNoaWxkcmVuJ3MgcGFyZW50Tm9kZVxuICAgICAgICAgICAgLy8gd2lsbCBjaGFuZ2UgZnJvbSB0aGUgZnJhZ21lbnQgdG8gdGhlIGNvcnJlY3QgcGFyZW50Tm9kZS5cbiAgICAgICAgICAgIC8vIFRoaXMgY291bGQgYWZmZWN0IGRpcmVjdGl2ZXMgdGhhdCBuZWVkIGFjY2VzcyB0byBpdHMgZWxlbWVudCdzIHBhcmVudE5vZGUuXG4gICAgICAgICAgICBub2Rlcy5mb3JFYWNoKGNvbXBpbGVyLmNvbXBpbGUsIGNvbXBpbGVyKVxuXG4gICAgICAgIH0gZWxzZSB7XG5cbiAgICAgICAgICAgIC8vIGp1c3Qgc2V0IGlubmVySFRNTC4uLlxuICAgICAgICAgICAgZWwuaW5uZXJIVE1MID0gJydcbiAgICAgICAgICAgIGVsLmFwcGVuZENoaWxkKHBhcnRpYWwpXG5cbiAgICAgICAgfVxuICAgIH1cblxufSIsInZhciB1dGlscyAgICAgID0gcmVxdWlyZSgnLi4vdXRpbHMnKSxcbiAgICBjb25maWcgICAgID0gcmVxdWlyZSgnLi4vY29uZmlnJylcblxuLyoqXG4gKiAgQmluZGluZyB0aGF0IG1hbmFnZXMgVk1zIGJhc2VkIG9uIGFuIEFycmF5XG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuXG4gICAgICAgIHRoaXMuaWRlbnRpZmllciA9ICckcicgKyB0aGlzLmlkXG5cbiAgICAgICAgLy8gYSBoYXNoIHRvIGNhY2hlIHRoZSBzYW1lIGV4cHJlc3Npb25zIG9uIHJlcGVhdGVkIGluc3RhbmNlc1xuICAgICAgICAvLyBzbyB0aGV5IGRvbid0IGhhdmUgdG8gYmUgY29tcGlsZWQgZm9yIGV2ZXJ5IHNpbmdsZSBpbnN0YW5jZVxuICAgICAgICB0aGlzLmV4cENhY2hlID0gdXRpbHMuaGFzaCgpXG5cbiAgICAgICAgdmFyIGVsICAgPSB0aGlzLmVsLFxuICAgICAgICAgICAgY3RuICA9IHRoaXMuY29udGFpbmVyID0gZWwucGFyZW50Tm9kZVxuXG4gICAgICAgIC8vIGV4dHJhY3QgY2hpbGQgSWQsIGlmIGFueVxuICAgICAgICB0aGlzLmNoaWxkSWQgPSB0aGlzLmNvbXBpbGVyLmV2YWwodXRpbHMuZG9tLmF0dHIoZWwsICdyZWYnKSlcblxuICAgICAgICAvLyBjcmVhdGUgYSBjb21tZW50IG5vZGUgYXMgYSByZWZlcmVuY2Ugbm9kZSBmb3IgRE9NIGluc2VydGlvbnNcbiAgICAgICAgdGhpcy5yZWYgPSBkb2N1bWVudC5jcmVhdGVDb21tZW50KGNvbmZpZy5wcmVmaXggKyAnLXJlcGVhdC0nICsgdGhpcy5rZXkpXG4gICAgICAgIGN0bi5pbnNlcnRCZWZvcmUodGhpcy5yZWYsIGVsKVxuICAgICAgICBjdG4ucmVtb3ZlQ2hpbGQoZWwpXG5cbiAgICAgICAgdGhpcy5jb2xsZWN0aW9uID0gbnVsbFxuICAgICAgICB0aGlzLnZtcyA9IG51bGxcblxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uIChjb2xsZWN0aW9uKSB7XG5cbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGNvbGxlY3Rpb24pKSB7XG4gICAgICAgICAgICBpZiAodXRpbHMuaXNPYmplY3QoY29sbGVjdGlvbikpIHtcbiAgICAgICAgICAgICAgICBjb2xsZWN0aW9uID0gdXRpbHMub2JqZWN0VG9BcnJheShjb2xsZWN0aW9uKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1dGlscy53YXJuKCd2LXJlcGVhdCBvbmx5IGFjY2VwdHMgQXJyYXkgb3IgT2JqZWN0IHZhbHVlcy4nKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8ga2VlcCByZWZlcmVuY2Ugb2Ygb2xkIGRhdGEgYW5kIFZNc1xuICAgICAgICAvLyBzbyB3ZSBjYW4gcmV1c2UgdGhlbSBpZiBwb3NzaWJsZVxuICAgICAgICB0aGlzLm9sZFZNcyA9IHRoaXMudm1zXG4gICAgICAgIHRoaXMub2xkQ29sbGVjdGlvbiA9IHRoaXMuY29sbGVjdGlvblxuICAgICAgICBjb2xsZWN0aW9uID0gdGhpcy5jb2xsZWN0aW9uID0gY29sbGVjdGlvbiB8fCBbXVxuXG4gICAgICAgIHZhciBpc09iamVjdCA9IGNvbGxlY3Rpb25bMF0gJiYgdXRpbHMuaXNPYmplY3QoY29sbGVjdGlvblswXSlcbiAgICAgICAgdGhpcy52bXMgPSB0aGlzLm9sZENvbGxlY3Rpb25cbiAgICAgICAgICAgID8gdGhpcy5kaWZmKGNvbGxlY3Rpb24sIGlzT2JqZWN0KVxuICAgICAgICAgICAgOiB0aGlzLmluaXQoY29sbGVjdGlvbiwgaXNPYmplY3QpXG5cbiAgICAgICAgaWYgKHRoaXMuY2hpbGRJZCkge1xuICAgICAgICAgICAgdGhpcy52bS4kW3RoaXMuY2hpbGRJZF0gPSB0aGlzLnZtc1xuICAgICAgICB9XG5cbiAgICB9LFxuXG4gICAgaW5pdDogZnVuY3Rpb24gKGNvbGxlY3Rpb24sIGlzT2JqZWN0KSB7XG4gICAgICAgIHZhciB2bSwgdm1zID0gW11cbiAgICAgICAgZm9yICh2YXIgaSA9IDAsIGwgPSBjb2xsZWN0aW9uLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgdm0gPSB0aGlzLmJ1aWxkKGNvbGxlY3Rpb25baV0sIGksIGlzT2JqZWN0KVxuICAgICAgICAgICAgdm1zLnB1c2godm0pXG4gICAgICAgICAgICBpZiAodGhpcy5jb21waWxlci5pbml0KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5jb250YWluZXIuaW5zZXJ0QmVmb3JlKHZtLiRlbCwgdGhpcy5yZWYpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHZtLiRiZWZvcmUodGhpcy5yZWYpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZtc1xuICAgIH0sXG5cbiAgICAvKipcbiAgICAgKiAgRGlmZiB0aGUgbmV3IGFycmF5IHdpdGggdGhlIG9sZFxuICAgICAqICBhbmQgZGV0ZXJtaW5lIHRoZSBtaW5pbXVtIGFtb3VudCBvZiBET00gbWFuaXB1bGF0aW9ucy5cbiAgICAgKi9cbiAgICBkaWZmOiBmdW5jdGlvbiAobmV3Q29sbGVjdGlvbiwgaXNPYmplY3QpIHtcblxuICAgICAgICB2YXIgaSwgbCwgaXRlbSwgdm0sXG4gICAgICAgICAgICBvbGRJbmRleCxcbiAgICAgICAgICAgIHRhcmdldE5leHQsXG4gICAgICAgICAgICBjdXJyZW50TmV4dCxcbiAgICAgICAgICAgIG5leHRFbCxcbiAgICAgICAgICAgIGN0biAgICA9IHRoaXMuY29udGFpbmVyLFxuICAgICAgICAgICAgb2xkVk1zID0gdGhpcy5vbGRWTXMsXG4gICAgICAgICAgICB2bXMgICAgPSBbXVxuXG4gICAgICAgIHZtcy5sZW5ndGggPSBuZXdDb2xsZWN0aW9uLmxlbmd0aFxuXG4gICAgICAgIC8vIGZpcnN0IHBhc3MsIGNvbGxlY3QgbmV3IHJldXNlZCBhbmQgbmV3IGNyZWF0ZWRcbiAgICAgICAgZm9yIChpID0gMCwgbCA9IG5ld0NvbGxlY3Rpb24ubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBpdGVtID0gbmV3Q29sbGVjdGlvbltpXVxuICAgICAgICAgICAgaWYgKGlzT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgaXRlbS4kaW5kZXggPSBpXG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0uX19lbWl0dGVyX18gJiYgaXRlbS5fX2VtaXR0ZXJfX1t0aGlzLmlkZW50aWZpZXJdKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHRoaXMgcGllY2Ugb2YgZGF0YSBpcyBiZWluZyByZXVzZWQuXG4gICAgICAgICAgICAgICAgICAgIC8vIHJlY29yZCBpdHMgZmluYWwgcG9zaXRpb24gaW4gcmV1c2VkIHZtc1xuICAgICAgICAgICAgICAgICAgICBpdGVtLiRyZXVzZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdm1zW2ldID0gdGhpcy5idWlsZChpdGVtLCBpLCBpc09iamVjdClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIHdlIGNhbid0IGF0dGFjaCBhbiBpZGVudGlmaWVyIHRvIHByaW1pdGl2ZSB2YWx1ZXNcbiAgICAgICAgICAgICAgICAvLyBzbyBoYXZlIHRvIGRvIGFuIGluZGV4T2YuLi5cbiAgICAgICAgICAgICAgICBvbGRJbmRleCA9IGluZGV4T2Yob2xkVk1zLCBpdGVtKVxuICAgICAgICAgICAgICAgIGlmIChvbGRJbmRleCA+IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHJlY29yZCB0aGUgcG9zaXRpb24gb24gdGhlIGV4aXN0aW5nIHZtXG4gICAgICAgICAgICAgICAgICAgIG9sZFZNc1tvbGRJbmRleF0uJHJldXNlZCA9IHRydWVcbiAgICAgICAgICAgICAgICAgICAgb2xkVk1zW29sZEluZGV4XS4kZGF0YS4kaW5kZXggPSBpXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdm1zW2ldID0gdGhpcy5idWlsZChpdGVtLCBpLCBpc09iamVjdClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBzZWNvbmQgcGFzcywgY29sbGVjdCBvbGQgcmV1c2VkIGFuZCBkZXN0cm95IHVudXNlZFxuICAgICAgICBmb3IgKGkgPSAwLCBsID0gb2xkVk1zLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgdm0gPSBvbGRWTXNbaV1cbiAgICAgICAgICAgIGl0ZW0gPSB0aGlzLmFyZ1xuICAgICAgICAgICAgICAgID8gdm0uJGRhdGFbdGhpcy5hcmddXG4gICAgICAgICAgICAgICAgOiB2bS4kZGF0YVxuICAgICAgICAgICAgaWYgKGl0ZW0uJHJldXNlZCkge1xuICAgICAgICAgICAgICAgIHZtLiRyZXVzZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgZGVsZXRlIGl0ZW0uJHJldXNlZFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHZtLiRyZXVzZWQpIHtcbiAgICAgICAgICAgICAgICAvLyB1cGRhdGUgdGhlIGluZGV4IHRvIGxhdGVzdFxuICAgICAgICAgICAgICAgIHZtLiRpbmRleCA9IGl0ZW0uJGluZGV4XG4gICAgICAgICAgICAgICAgLy8gdGhlIGl0ZW0gY291bGQgaGF2ZSBoYWQgYSBuZXcga2V5XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0uJGtleSAmJiBpdGVtLiRrZXkgIT09IHZtLiRrZXkpIHtcbiAgICAgICAgICAgICAgICAgICAgdm0uJGtleSA9IGl0ZW0uJGtleVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2bXNbdm0uJGluZGV4XSA9IHZtXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIHRoaXMgb25lIGNhbiBiZSBkZXN0cm95ZWQuXG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0uX19lbWl0dGVyX18pIHtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGl0ZW0uX19lbWl0dGVyX19bdGhpcy5pZGVudGlmaWVyXVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2bS4kZGVzdHJveSgpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBmaW5hbCBwYXNzLCBtb3ZlL2luc2VydCBET00gZWxlbWVudHNcbiAgICAgICAgaSA9IHZtcy5sZW5ndGhcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgdm0gPSB2bXNbaV1cbiAgICAgICAgICAgIGl0ZW0gPSB2bS4kZGF0YVxuICAgICAgICAgICAgdGFyZ2V0TmV4dCA9IHZtc1tpICsgMV1cbiAgICAgICAgICAgIGlmICh2bS4kcmV1c2VkKSB7XG4gICAgICAgICAgICAgICAgbmV4dEVsID0gdm0uJGVsLm5leHRTaWJsaW5nXG4gICAgICAgICAgICAgICAgLy8gZGVzdHJveWVkIFZNcycgZWxlbWVudCBtaWdodCBzdGlsbCBiZSBpbiB0aGUgRE9NXG4gICAgICAgICAgICAgICAgLy8gZHVlIHRvIHRyYW5zaXRpb25zXG4gICAgICAgICAgICAgICAgd2hpbGUgKCFuZXh0RWwudnVlX3ZtICYmIG5leHRFbCAhPT0gdGhpcy5yZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgbmV4dEVsID0gbmV4dEVsLm5leHRTaWJsaW5nXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGN1cnJlbnROZXh0ID0gbmV4dEVsLnZ1ZV92bVxuICAgICAgICAgICAgICAgIGlmIChjdXJyZW50TmV4dCAhPT0gdGFyZ2V0TmV4dCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXRhcmdldE5leHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGN0bi5pbnNlcnRCZWZvcmUodm0uJGVsLCB0aGlzLnJlZilcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5leHRFbCA9IHRhcmdldE5leHQuJGVsXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBuZXcgVk1zJyBlbGVtZW50IG1pZ2h0IG5vdCBiZSBpbiB0aGUgRE9NIHlldFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gZHVlIHRvIHRyYW5zaXRpb25zXG4gICAgICAgICAgICAgICAgICAgICAgICB3aGlsZSAoIW5leHRFbC5wYXJlbnROb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0TmV4dCA9IHZtc1tuZXh0RWwudnVlX3ZtLiRpbmRleCArIDFdXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbmV4dEVsID0gdGFyZ2V0TmV4dFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHRhcmdldE5leHQuJGVsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogdGhpcy5yZWZcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGN0bi5pbnNlcnRCZWZvcmUodm0uJGVsLCBuZXh0RWwpXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVsZXRlIHZtLiRyZXVzZWRcbiAgICAgICAgICAgICAgICBkZWxldGUgaXRlbS4kaW5kZXhcbiAgICAgICAgICAgICAgICBkZWxldGUgaXRlbS4ka2V5XG4gICAgICAgICAgICB9IGVsc2UgeyAvLyBhIG5ldyB2bVxuICAgICAgICAgICAgICAgIHZtLiRiZWZvcmUodGFyZ2V0TmV4dCA/IHRhcmdldE5leHQuJGVsIDogdGhpcy5yZWYpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdm1zXG4gICAgfSxcblxuICAgIGJ1aWxkOiBmdW5jdGlvbiAoZGF0YSwgaW5kZXgsIGlzT2JqZWN0KSB7XG5cbiAgICAgICAgLy8gd3JhcCBub24tb2JqZWN0IHZhbHVlc1xuICAgICAgICB2YXIgcmF3LCBhbGlhcyxcbiAgICAgICAgICAgIHdyYXAgPSAhaXNPYmplY3QgfHwgdGhpcy5hcmdcbiAgICAgICAgaWYgKHdyYXApIHtcbiAgICAgICAgICAgIHJhdyA9IGRhdGFcbiAgICAgICAgICAgIGFsaWFzID0gdGhpcy5hcmcgfHwgJyR2YWx1ZSdcbiAgICAgICAgICAgIGRhdGEgPSB7fVxuICAgICAgICAgICAgZGF0YVthbGlhc10gPSByYXdcbiAgICAgICAgfVxuICAgICAgICBkYXRhLiRpbmRleCA9IGluZGV4XG5cbiAgICAgICAgdmFyIGVsID0gdGhpcy5lbC5jbG9uZU5vZGUodHJ1ZSksXG4gICAgICAgICAgICBDdG9yID0gdGhpcy5jb21waWxlci5yZXNvbHZlQ29tcG9uZW50KGVsLCBkYXRhKSxcbiAgICAgICAgICAgIHZtID0gbmV3IEN0b3Ioe1xuICAgICAgICAgICAgICAgIGVsOiBlbCxcbiAgICAgICAgICAgICAgICBkYXRhOiBkYXRhLFxuICAgICAgICAgICAgICAgIHBhcmVudDogdGhpcy52bSxcbiAgICAgICAgICAgICAgICBjb21waWxlck9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgICAgICAgcmVwZWF0OiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBleHBDYWNoZTogdGhpcy5leHBDYWNoZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgaWYgKGlzT2JqZWN0KSB7XG4gICAgICAgICAgICAvLyBhdHRhY2ggYW4gaWVudW1lcmFibGUgaWRlbnRpZmllciB0byB0aGUgcmF3IGRhdGFcbiAgICAgICAgICAgIChyYXcgfHwgZGF0YSkuX19lbWl0dGVyX19bdGhpcy5pZGVudGlmaWVyXSA9IHRydWVcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2bVxuXG4gICAgfSxcblxuICAgIHVuYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAodGhpcy5jaGlsZElkKSB7XG4gICAgICAgICAgICBkZWxldGUgdGhpcy52bS4kW3RoaXMuY2hpbGRJZF1cbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy52bXMpIHtcbiAgICAgICAgICAgIHZhciBpID0gdGhpcy52bXMubGVuZ3RoXG4gICAgICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICAgICAgdGhpcy52bXNbaV0uJGRlc3Ryb3koKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vLyBIZWxwZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogIEZpbmQgYW4gb2JqZWN0IG9yIGEgd3JhcHBlZCBkYXRhIG9iamVjdFxuICogIGZyb20gYW4gQXJyYXlcbiAqL1xuZnVuY3Rpb24gaW5kZXhPZiAodm1zLCBvYmopIHtcbiAgICBmb3IgKHZhciB2bSwgaSA9IDAsIGwgPSB2bXMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIHZtID0gdm1zW2ldXG4gICAgICAgIGlmICghdm0uJHJldXNlZCAmJiB2bS4kdmFsdWUgPT09IG9iaikge1xuICAgICAgICAgICAgcmV0dXJuIGlcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gLTFcbn0iLCJ2YXIgcHJlZml4ZXMgPSBbJy13ZWJraXQtJywgJy1tb3otJywgJy1tcy0nXVxuXG4vKipcbiAqICBCaW5kaW5nIGZvciBDU1Mgc3R5bGVzXG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgcHJvcCA9IHRoaXMuYXJnXG4gICAgICAgIGlmICghcHJvcCkgcmV0dXJuXG4gICAgICAgIGlmIChwcm9wLmNoYXJBdCgwKSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAvLyBwcm9wZXJ0aWVzIHRoYXQgc3RhcnQgd2l0aCAkIHdpbGwgYmUgYXV0by1wcmVmaXhlZFxuICAgICAgICAgICAgcHJvcCA9IHByb3Auc2xpY2UoMSlcbiAgICAgICAgICAgIHRoaXMucHJlZml4ZWQgPSB0cnVlXG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wcm9wID0gcHJvcFxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICB2YXIgcHJvcCA9IHRoaXMucHJvcCxcbiAgICAgICAgICAgIGlzSW1wb3J0YW50XG4gICAgICAgIC8qIGpzaGludCBlcWVxZXE6IHRydWUgKi9cbiAgICAgICAgLy8gY2FzdCBwb3NzaWJsZSBudW1iZXJzL2Jvb2xlYW5zIGludG8gc3RyaW5nc1xuICAgICAgICBpZiAodmFsdWUgIT0gbnVsbCkgdmFsdWUgKz0gJydcbiAgICAgICAgaWYgKHByb3ApIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIGlzSW1wb3J0YW50ID0gdmFsdWUuc2xpY2UoLTEwKSA9PT0gJyFpbXBvcnRhbnQnXG4gICAgICAgICAgICAgICAgICAgID8gJ2ltcG9ydGFudCdcbiAgICAgICAgICAgICAgICAgICAgOiAnJ1xuICAgICAgICAgICAgICAgIGlmIChpc0ltcG9ydGFudCkge1xuICAgICAgICAgICAgICAgICAgICB2YWx1ZSA9IHZhbHVlLnNsaWNlKDAsIC0xMCkudHJpbSgpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5lbC5zdHlsZS5zZXRQcm9wZXJ0eShwcm9wLCB2YWx1ZSwgaXNJbXBvcnRhbnQpXG4gICAgICAgICAgICBpZiAodGhpcy5wcmVmaXhlZCkge1xuICAgICAgICAgICAgICAgIHZhciBpID0gcHJlZml4ZXMubGVuZ3RoXG4gICAgICAgICAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmVsLnN0eWxlLnNldFByb3BlcnR5KHByZWZpeGVzW2ldICsgcHJvcCwgdmFsdWUsIGlzSW1wb3J0YW50KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuZWwuc3R5bGUuY3NzVGV4dCA9IHZhbHVlXG4gICAgICAgIH1cbiAgICB9XG5cbn0iLCIvKipcbiAqICBNYW5hZ2VzIGEgY29uZGl0aW9uYWwgY2hpbGQgVk0gdXNpbmcgdGhlXG4gKiAgYmluZGluZydzIHZhbHVlIGFzIHRoZSBjb21wb25lbnQgSUQuXG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuXG4gICAgICAgIC8vIHRyYWNrIHBvc2l0aW9uIGluIERPTSB3aXRoIGEgcmVmIG5vZGVcbiAgICAgICAgdmFyIGVsICAgICAgID0gdGhpcy5yYXcgPSB0aGlzLmVsLFxuICAgICAgICAgICAgcGFyZW50ICAgPSBlbC5wYXJlbnROb2RlLFxuICAgICAgICAgICAgcmVmICAgICAgPSB0aGlzLnJlZiA9IGRvY3VtZW50LmNyZWF0ZUNvbW1lbnQoJ3YtdmlldycpXG4gICAgICAgIHBhcmVudC5pbnNlcnRCZWZvcmUocmVmLCBlbClcbiAgICAgICAgcGFyZW50LnJlbW92ZUNoaWxkKGVsKVxuXG4gICAgICAgIC8vIGNhY2hlIG9yaWdpbmFsIGNvbnRlbnRcbiAgICAgICAgLyoganNoaW50IGJvc3M6IHRydWUgKi9cbiAgICAgICAgdmFyIG5vZGUsXG4gICAgICAgICAgICBmcmFnID0gdGhpcy5pbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpXG4gICAgICAgIHdoaWxlIChub2RlID0gZWwuZmlyc3RDaGlsZCkge1xuICAgICAgICAgICAgZnJhZy5hcHBlbmRDaGlsZChub2RlKVxuICAgICAgICB9XG5cbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbih2YWx1ZSkge1xuXG4gICAgICAgIHRoaXMudW5iaW5kKClcblxuICAgICAgICB2YXIgQ3RvciAgPSB0aGlzLmNvbXBpbGVyLmdldE9wdGlvbignY29tcG9uZW50cycsIHZhbHVlKVxuICAgICAgICBpZiAoIUN0b3IpIHJldHVyblxuXG4gICAgICAgIHRoaXMuY2hpbGRWTSA9IG5ldyBDdG9yKHtcbiAgICAgICAgICAgIGVsOiB0aGlzLnJhdy5jbG9uZU5vZGUodHJ1ZSksXG4gICAgICAgICAgICBwYXJlbnQ6IHRoaXMudm0sXG4gICAgICAgICAgICBjb21waWxlck9wdGlvbnM6IHtcbiAgICAgICAgICAgICAgICByYXdDb250ZW50OiB0aGlzLmlubmVyLmNsb25lTm9kZSh0cnVlKVxuICAgICAgICAgICAgfVxuICAgICAgICB9KVxuXG4gICAgICAgIHRoaXMuZWwgPSB0aGlzLmNoaWxkVk0uJGVsXG4gICAgICAgIGlmICh0aGlzLmNvbXBpbGVyLmluaXQpIHtcbiAgICAgICAgICAgIHRoaXMucmVmLnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKHRoaXMuZWwsIHRoaXMucmVmKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5jaGlsZFZNLiRiZWZvcmUodGhpcy5yZWYpXG4gICAgICAgIH1cblxuICAgIH0sXG5cbiAgICB1bmJpbmQ6IGZ1bmN0aW9uKCkge1xuICAgICAgICBpZiAodGhpcy5jaGlsZFZNKSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0uJGRlc3Ryb3koKVxuICAgICAgICB9XG4gICAgfVxuXG59IiwidmFyIHV0aWxzID0gcmVxdWlyZSgnLi4vdXRpbHMnKVxuXG4vKipcbiAqICBCaW5kaW5nIGZvciBpbmhlcml0aW5nIGRhdGEgZnJvbSBwYXJlbnQgVk1zLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcblxuICAgICAgICB2YXIgc2VsZiAgICAgID0gdGhpcyxcbiAgICAgICAgICAgIGNoaWxkS2V5ICA9IHNlbGYuYXJnLFxuICAgICAgICAgICAgcGFyZW50S2V5ID0gc2VsZi5rZXksXG4gICAgICAgICAgICBjb21waWxlciAgPSBzZWxmLmNvbXBpbGVyLFxuICAgICAgICAgICAgb3duZXIgICAgID0gc2VsZi5iaW5kaW5nLmNvbXBpbGVyXG5cbiAgICAgICAgaWYgKGNvbXBpbGVyID09PSBvd25lcikge1xuICAgICAgICAgICAgdGhpcy5hbG9uZSA9IHRydWVcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNoaWxkS2V5KSB7XG4gICAgICAgICAgICBpZiAoIWNvbXBpbGVyLmJpbmRpbmdzW2NoaWxkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcoY2hpbGRLZXkpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBzeW5jIGNoYW5nZXMgb24gY2hpbGQgYmFjayB0byBwYXJlbnRcbiAgICAgICAgICAgIGNvbXBpbGVyLm9ic2VydmVyLm9uKCdjaGFuZ2U6JyArIGNoaWxkS2V5LCBmdW5jdGlvbiAodmFsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbXBpbGVyLmluaXQpIHJldHVyblxuICAgICAgICAgICAgICAgIGlmICghc2VsZi5sb2NrKSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYubG9jayA9IHRydWVcbiAgICAgICAgICAgICAgICAgICAgdXRpbHMubmV4dFRpY2soZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5sb2NrID0gZmFsc2VcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgb3duZXIudm0uJHNldChwYXJlbnRLZXksIHZhbClcbiAgICAgICAgICAgIH0pXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgLy8gc3luYyBmcm9tIHBhcmVudFxuICAgICAgICBpZiAoIXRoaXMuYWxvbmUgJiYgIXRoaXMubG9jaykge1xuICAgICAgICAgICAgaWYgKHRoaXMuYXJnKSB7XG4gICAgICAgICAgICAgICAgdGhpcy52bS4kc2V0KHRoaXMuYXJnLCB2YWx1ZSlcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy52bS4kZGF0YSAhPT0gdmFsdWUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLnZtLiRkYXRhID0gdmFsdWVcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxufSIsIi8qKlxuICogRXZlbnRUYXJnZXQgbW9kdWxlXG4gKiBAYXV0aG9yOiB4dWVqaWEuY3hqLzYxNzRcbiAqL1xudmFyIHV0aWxzID0gcmVxdWlyZSgnLi91dGlscycpO1xuZnVuY3Rpb24gRXZlbnRUYXJnZXQoY3R4KXtcbiAgICB0aGlzLl9jdHggPSBjdHggfHwgdGhpczsgIFxufVxuXG51dGlscy5taXgoRXZlbnRUYXJnZXQucHJvdG90eXBlLCB7XG4gICAgb246IGZ1bmN0aW9uKHR5cGUsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciBjb250ZXh0ID0gdGhpcy5fY3R4IHx8IHRoaXM7XG4gICAgICAgIGNvbnRleHQuX2NhbGxiYWNrID0gY29udGV4dC5fY2FsbGJhY2sgfHwge307XG4gICAgICAgIGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdID0gY29udGV4dC5fY2FsbGJhY2tbdHlwZV0gfHwgW107XG4gICAgICAgIGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdLnB1c2goY2FsbGJhY2spO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9LFxuICAgIG9uY2U6IGZ1bmN0aW9uKGV2ZW50LCBmbil7XG4gICAgICAgIHZhciBjb250ZXh0ID0gdGhpcy5fY3R4IHx8IHRoaXM7XG4gICAgICAgIGNvbnRleHQuX2NhbGxiYWNrID0gY29udGV4dC5fY2FsbGJhY2sgfHwge307XG4gICAgICAgIGZ1bmN0aW9uIG9uKCl7XG4gICAgICAgICAgICBjb250ZXh0LmRldGFjaChldmVudCwgb24pO1xuICAgICAgICAgICAgZm4uYXBwbHkoY29udGV4dCwgYXJndW1lbnRzKTtcbiAgICAgICAgfVxuICAgICAgICBvbi5mbiA9IGZuO1xuICAgICAgICBjb250ZXh0Lm9uKGV2ZW50LCBvbik7XG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH0sXG4gICAgZGV0YWNoOiBmdW5jdGlvbih0eXBlLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgY29udGV4dCA9IHRoaXMuX2N0eCB8fCB0aGlzO1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFjayA9IGNvbnRleHQuX2NhbGxiYWNrIHx8IHt9O1xuICAgICAgICBpZiAoIXR5cGUpIHtcbiAgICAgICAgICAgIGNvbnRleHQuX2NhbGxiYWNrID0ge307XG4gICAgICAgIH0gZWxzZSBpZiAoIWNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXSA9IFtdO1xuICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdICYmIGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHZhciBpbmRleCA9IHV0aWxzLmFycmF5LmluZGV4T2YoY2FsbGJhY2ssIGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdKTtcbiAgICAgICAgICAgIGlmIChpbmRleCAhPSAtMSkgY29udGV4dC5fY2FsbGJhY2tbdHlwZV0uc3BsaWNlKGluZGV4LCAxKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9LFxuICAgIGZpcmU6IGZ1bmN0aW9uKHR5cGUsIGEsIGIsIGMsIGQpIHtcbiAgICAgICAgdmFyIGNvbnRleHQgPSB0aGlzLl9jdHggfHwgdGhpcztcbiAgICAgICAgaWYgKGNvbnRleHQuX2NhbGxiYWNrKSB7XG4gICAgICAgICAgICB2YXIgYXJyID0gY29udGV4dC5fY2FsbGJhY2tbdHlwZV07XG4gICAgICAgICAgICBpZiAoYXJyICYmIGFyci5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgLy8gZGF0YSA9IGRhdGEgfHwge307XG4gICAgICAgICAgICAgICAgLy8gZGF0YS50eXBlID0gdHlwZTtcbiAgICAgICAgICAgICAgICAvLyBkYXRhLnRhcmdldCA9IGNvbnRleHQ7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IGFyci5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICAgICAgICAgICAgICB1dGlscy5pc0Z1bmN0aW9uKGFycltpXSkgJiYgYXJyW2ldLmNhbGwoY29udGV4dCwgYSwgYiwgYywgZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cbn0pO1xuXG51dGlscy5taXgoRXZlbnRUYXJnZXQucHJvdG90eXBlLCB7XG4gICAgZW1pdDogRXZlbnRUYXJnZXQucHJvdG90eXBlLmZpcmUsXG4gICAgb2ZmOiBFdmVudFRhcmdldC5wcm90b3R5cGUuZGV0YWNoXG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBFdmVudFRhcmdldDsiLCJ2YXIgY29uZmlnICAgICAgPSByZXF1aXJlKCcuL2NvbmZpZycpLFxuICAgIHV0aWxzICAgICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuICAgIGRlZmVyICAgICAgID0gcmVxdWlyZSgnLi9kZWZlcnJlZCcpLFxuICAgIFBhcnNlciAgICAgID0gcmVxdWlyZSgnLi9wYXJzZXInKSxcbiAgICBtYWtlSGFzaCAgICA9IHV0aWxzLmhhc2g7XG4gICAgVmlld01vZGVsICAgPSByZXF1aXJlKCcuL3ZpZXdtb2RlbCcpO1xuXG5cblZpZXdNb2RlbC5vcHRpb25zID0gY29uZmlnLmdsb2JhbEFzc2V0cyA9IHtcbiAgICBkaXJlY3RpdmVzICA6IHJlcXVpcmUoJy4vZGlyZWN0aXZlcycpLFxuICAgIGZpbHRlcnMgICAgIDogcmVxdWlyZSgnLi9maWx0ZXJzJyksXG4gICAgcGFydGlhbHMgICAgOiBtYWtlSGFzaCgpLFxuICAgIGVmZmVjdHMgICAgIDogbWFrZUhhc2goKSxcbiAgICBjb21wb25lbnRzICA6IG1ha2VIYXNoKClcbn07XG5cbnV0aWxzLmVhY2goWydkaXJlY3RpdmUnLCAnZmlsdGVyJywgJ3BhcnRpYWwnLCAnZWZmZWN0JywgJ2NvbXBvbmVudCddLCBmdW5jdGlvbih0eXBlKXtcblx0Vmlld01vZGVsW3R5cGVdID0gZnVuY3Rpb24oaWQsIHZhbHVlKXtcblx0XHR2YXIgaGFzaCA9IHRoaXMub3B0aW9uc1t0eXBlICsgJ3MnXTtcblx0XHRpZighaGFzaCl7XG5cdFx0XHRoYXNoID0gdGhpcy5vcHRpb25zW3R5cGUgKyAncyddID0gdXRpbHMuaGFzaCgpO1xuXHRcdH1cblx0XHRpZighdmFsdWUpe1xuXHRcdFx0cmV0dXJuIGhhc2hbaWRdO1xuXHRcdH1cblx0XHRpZiAodHlwZSA9PT0gJ3BhcnRpYWwnKSB7XG4gICAgICAgICAgICB2YWx1ZSA9IFBhcnNlci5wYXJzZVRlbXBsYXRlKHZhbHVlKTtcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnY29tcG9uZW50Jykge1xuICAgICAgICAgICAgLy8gdmFsdWUgPSB1dGlscy50b0NvbnN0cnVjdG9yKHZhbHVlKVxuICAgICAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdmaWx0ZXInKSB7XG4gICAgICAgICAgICAvLyB1dGlscy5jaGVja0ZpbHRlcih2YWx1ZSlcbiAgICAgICAgfVxuICAgICAgICBoYXNoW2lkXSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdGhpcztcblx0fVxufSk7XG5cbndpbmRvdy5WTSA9IFZpZXdNb2RlbDtcbm1vZHVsZS5leHBvcnRzID0gVmlld01vZGVsO1xuIiwidmFyIHV0aWxzICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuICAgIGdldCAgICAgID0gdXRpbHMub2JqZWN0LmdldCxcbiAgICBzbGljZSAgICA9IFtdLnNsaWNlLFxuICAgIFFVT1RFX1JFID0gL14nLionJC8sXG4gICAgZmlsdGVycyAgPSBtb2R1bGUuZXhwb3J0cyA9IHV0aWxzLmhhc2goKVxuXG4vKipcbiAqICAnYWJjJyA9PiAnQWJjJ1xuICovXG5maWx0ZXJzLmNhcGl0YWxpemUgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICBpZiAoIXZhbHVlICYmIHZhbHVlICE9PSAwKSByZXR1cm4gJydcbiAgICB2YWx1ZSA9IHZhbHVlLnRvU3RyaW5nKClcbiAgICByZXR1cm4gdmFsdWUuY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyB2YWx1ZS5zbGljZSgxKVxufVxuXG4vKipcbiAqICAnYWJjJyA9PiAnQUJDJ1xuICovXG5maWx0ZXJzLnVwcGVyY2FzZSA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHJldHVybiAodmFsdWUgfHwgdmFsdWUgPT09IDApXG4gICAgICAgID8gdmFsdWUudG9TdHJpbmcoKS50b1VwcGVyQ2FzZSgpXG4gICAgICAgIDogJydcbn1cblxuLyoqXG4gKiAgJ0FiQycgPT4gJ2FiYydcbiAqL1xuZmlsdGVycy5sb3dlcmNhc2UgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICByZXR1cm4gKHZhbHVlIHx8IHZhbHVlID09PSAwKVxuICAgICAgICA/IHZhbHVlLnRvU3RyaW5nKCkudG9Mb3dlckNhc2UoKVxuICAgICAgICA6ICcnXG59XG5cbi8qKlxuICogIDEyMzQ1ID0+ICQxMiwzNDUuMDBcbiAqL1xuZmlsdGVycy5jdXJyZW5jeSA9IGZ1bmN0aW9uICh2YWx1ZSwgc2lnbikge1xuICAgIHZhbHVlID0gcGFyc2VGbG9hdCh2YWx1ZSlcbiAgICBpZiAoIXZhbHVlICYmIHZhbHVlICE9PSAwKSByZXR1cm4gJydcbiAgICBzaWduID0gc2lnbiB8fCAnJCdcbiAgICB2YXIgcyA9IE1hdGguZmxvb3IodmFsdWUpLnRvU3RyaW5nKCksXG4gICAgICAgIGkgPSBzLmxlbmd0aCAlIDMsXG4gICAgICAgIGggPSBpID4gMCA/IChzLnNsaWNlKDAsIGkpICsgKHMubGVuZ3RoID4gMyA/ICcsJyA6ICcnKSkgOiAnJyxcbiAgICAgICAgZiA9ICcuJyArIHZhbHVlLnRvRml4ZWQoMikuc2xpY2UoLTIpXG4gICAgcmV0dXJuIHNpZ24gKyBoICsgcy5zbGljZShpKS5yZXBsYWNlKC8oXFxkezN9KSg/PVxcZCkvZywgJyQxLCcpICsgZlxufVxuXG4vKipcbiAqICBhcmdzOiBhbiBhcnJheSBvZiBzdHJpbmdzIGNvcnJlc3BvbmRpbmcgdG9cbiAqICB0aGUgc2luZ2xlLCBkb3VibGUsIHRyaXBsZSAuLi4gZm9ybXMgb2YgdGhlIHdvcmQgdG9cbiAqICBiZSBwbHVyYWxpemVkLiBXaGVuIHRoZSBudW1iZXIgdG8gYmUgcGx1cmFsaXplZFxuICogIGV4Y2VlZHMgdGhlIGxlbmd0aCBvZiB0aGUgYXJncywgaXQgd2lsbCB1c2UgdGhlIGxhc3RcbiAqICBlbnRyeSBpbiB0aGUgYXJyYXkuXG4gKlxuICogIGUuZy4gWydzaW5nbGUnLCAnZG91YmxlJywgJ3RyaXBsZScsICdtdWx0aXBsZSddXG4gKi9cbmZpbHRlcnMucGx1cmFsaXplID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgdmFyIGFyZ3MgPSBzbGljZS5jYWxsKGFyZ3VtZW50cywgMSlcbiAgICByZXR1cm4gYXJncy5sZW5ndGggPiAxXG4gICAgICAgID8gKGFyZ3NbdmFsdWUgLSAxXSB8fCBhcmdzW2FyZ3MubGVuZ3RoIC0gMV0pXG4gICAgICAgIDogKGFyZ3NbdmFsdWUgLSAxXSB8fCBhcmdzWzBdICsgJ3MnKVxufVxuXG4vKipcbiAqICBBIHNwZWNpYWwgZmlsdGVyIHRoYXQgdGFrZXMgYSBoYW5kbGVyIGZ1bmN0aW9uLFxuICogIHdyYXBzIGl0IHNvIGl0IG9ubHkgZ2V0cyB0cmlnZ2VyZWQgb24gc3BlY2lmaWMga2V5cHJlc3Nlcy5cbiAqXG4gKiAgdi1vbiBvbmx5XG4gKi9cblxudmFyIGtleUNvZGVzID0ge1xuICAgIGVudGVyICAgIDogMTMsXG4gICAgdGFiICAgICAgOiA5LFxuICAgICdkZWxldGUnIDogNDYsXG4gICAgdXAgICAgICAgOiAzOCxcbiAgICBsZWZ0ICAgICA6IDM3LFxuICAgIHJpZ2h0ICAgIDogMzksXG4gICAgZG93biAgICAgOiA0MCxcbiAgICBlc2MgICAgICA6IDI3XG59XG5cbmZpbHRlcnMua2V5ID0gZnVuY3Rpb24gKGhhbmRsZXIsIGtleSkge1xuICAgIGlmICghaGFuZGxlcikgcmV0dXJuXG4gICAgdmFyIGNvZGUgPSBrZXlDb2Rlc1trZXldXG4gICAgaWYgKCFjb2RlKSB7XG4gICAgICAgIGNvZGUgPSBwYXJzZUludChrZXksIDEwKVxuICAgIH1cbiAgICByZXR1cm4gZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgaWYgKGUua2V5Q29kZSA9PT0gY29kZSkge1xuICAgICAgICAgICAgcmV0dXJuIGhhbmRsZXIuY2FsbCh0aGlzLCBlKVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBGaWx0ZXIgZmlsdGVyIGZvciB2LXJlcGVhdFxuICovXG5maWx0ZXJzLmZpbHRlckJ5ID0gZnVuY3Rpb24gKGFyciwgc2VhcmNoS2V5LCBkZWxpbWl0ZXIsIGRhdGFLZXkpIHtcblxuICAgIC8vIGFsbG93IG9wdGlvbmFsIGBpbmAgZGVsaW1pdGVyXG4gICAgLy8gYmVjYXVzZSB3aHkgbm90XG4gICAgaWYgKGRlbGltaXRlciAmJiBkZWxpbWl0ZXIgIT09ICdpbicpIHtcbiAgICAgICAgZGF0YUtleSA9IGRlbGltaXRlclxuICAgIH1cblxuICAgIC8vIGdldCB0aGUgc2VhcmNoIHN0cmluZ1xuICAgIHZhciBzZWFyY2ggPSBzdHJpcFF1b3RlcyhzZWFyY2hLZXkpIHx8IHRoaXMuJGdldChzZWFyY2hLZXkpXG4gICAgaWYgKCFzZWFyY2gpIHJldHVybiBhcnJcbiAgICBzZWFyY2ggPSBzZWFyY2gudG9Mb3dlckNhc2UoKVxuXG4gICAgLy8gZ2V0IHRoZSBvcHRpb25hbCBkYXRhS2V5XG4gICAgZGF0YUtleSA9IGRhdGFLZXkgJiYgKHN0cmlwUXVvdGVzKGRhdGFLZXkpIHx8IHRoaXMuJGdldChkYXRhS2V5KSlcblxuICAgIC8vIGNvbnZlcnQgb2JqZWN0IHRvIGFycmF5XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGFycikpIHtcbiAgICAgICAgYXJyID0gdXRpbHMub2JqZWN0VG9BcnJheShhcnIpXG4gICAgfVxuXG4gICAgcmV0dXJuIGFyci5maWx0ZXIoZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgICAgcmV0dXJuIGRhdGFLZXlcbiAgICAgICAgICAgID8gY29udGFpbnMoZ2V0KGl0ZW0sIGRhdGFLZXkpLCBzZWFyY2gpXG4gICAgICAgICAgICA6IGNvbnRhaW5zKGl0ZW0sIHNlYXJjaClcbiAgICB9KVxuXG59XG5cbmZpbHRlcnMuZmlsdGVyQnkuY29tcHV0ZWQgPSB0cnVlXG5cbi8qKlxuICogIFNvcnQgZml0bGVyIGZvciB2LXJlcGVhdFxuICovXG5maWx0ZXJzLm9yZGVyQnkgPSBmdW5jdGlvbiAoYXJyLCBzb3J0S2V5LCByZXZlcnNlS2V5KSB7XG5cbiAgICB2YXIga2V5ID0gc3RyaXBRdW90ZXMoc29ydEtleSkgfHwgdGhpcy4kZ2V0KHNvcnRLZXkpXG4gICAgaWYgKCFrZXkpIHJldHVybiBhcnJcblxuICAgIC8vIGNvbnZlcnQgb2JqZWN0IHRvIGFycmF5XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGFycikpIHtcbiAgICAgICAgYXJyID0gdXRpbHMub2JqZWN0VG9BcnJheShhcnIpXG4gICAgfVxuXG4gICAgdmFyIG9yZGVyID0gMVxuICAgIGlmIChyZXZlcnNlS2V5KSB7XG4gICAgICAgIGlmIChyZXZlcnNlS2V5ID09PSAnLTEnKSB7XG4gICAgICAgICAgICBvcmRlciA9IC0xXG4gICAgICAgIH0gZWxzZSBpZiAocmV2ZXJzZUtleS5jaGFyQXQoMCkgPT09ICchJykge1xuICAgICAgICAgICAgcmV2ZXJzZUtleSA9IHJldmVyc2VLZXkuc2xpY2UoMSlcbiAgICAgICAgICAgIG9yZGVyID0gdGhpcy4kZ2V0KHJldmVyc2VLZXkpID8gMSA6IC0xXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvcmRlciA9IHRoaXMuJGdldChyZXZlcnNlS2V5KSA/IC0xIDogMVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gc29ydCBvbiBhIGNvcHkgdG8gYXZvaWQgbXV0YXRpbmcgb3JpZ2luYWwgYXJyYXlcbiAgICByZXR1cm4gYXJyLnNsaWNlKCkuc29ydChmdW5jdGlvbiAoYSwgYikge1xuICAgICAgICBhID0gZ2V0KGEsIGtleSlcbiAgICAgICAgYiA9IGdldChiLCBrZXkpXG4gICAgICAgIHJldHVybiBhID09PSBiID8gMCA6IGEgPiBiID8gb3JkZXIgOiAtb3JkZXJcbiAgICB9KVxuXG59XG5cbmZpbHRlcnMub3JkZXJCeS5jb21wdXRlZCA9IHRydWVcblxuLy8gQXJyYXkgZmlsdGVyIGhlbHBlcnMgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqICBTdHJpbmcgY29udGFpbiBoZWxwZXJcbiAqL1xuZnVuY3Rpb24gY29udGFpbnMgKHZhbCwgc2VhcmNoKSB7XG4gICAgLyoganNoaW50IGVxZXFlcTogZmFsc2UgKi9cbiAgICBpZiAodXRpbHMuaXNPYmplY3QodmFsKSkge1xuICAgICAgICBmb3IgKHZhciBrZXkgaW4gdmFsKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnModmFsW2tleV0sIHNlYXJjaCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBlbHNlIGlmICh2YWwgIT0gbnVsbCkge1xuICAgICAgICByZXR1cm4gdmFsLnRvU3RyaW5nKCkudG9Mb3dlckNhc2UoKS5pbmRleE9mKHNlYXJjaCkgPiAtMVxuICAgIH1cbn1cblxuLyoqXG4gKiAgVGVzdCB3aGV0aGVyIGEgc3RyaW5nIGlzIGluIHF1b3RlcyxcbiAqICBpZiB5ZXMgcmV0dXJuIHN0cmlwcGVkIHN0cmluZ1xuICovXG5mdW5jdGlvbiBzdHJpcFF1b3RlcyAoc3RyKSB7XG4gICAgaWYgKFFVT1RFX1JFLnRlc3Qoc3RyKSkge1xuICAgICAgICByZXR1cm4gc3RyLnNsaWNlKDEsIC0xKVxuICAgIH1cbn0iLCIvLyBzdHJpbmcgLT4gRE9NIGNvbnZlcnNpb25cbi8vIHdyYXBwZXJzIG9yaWdpbmFsbHkgZnJvbSBqUXVlcnksIHNjb29wZWQgZnJvbSBjb21wb25lbnQvZG9taWZ5XG52YXIgbWFwID0ge1xuICAgIGxlZ2VuZCAgIDogWzEsICc8ZmllbGRzZXQ+JywgJzwvZmllbGRzZXQ+J10sXG4gICAgdHIgICAgICAgOiBbMiwgJzx0YWJsZT48dGJvZHk+JywgJzwvdGJvZHk+PC90YWJsZT4nXSxcbiAgICBjb2wgICAgICA6IFsyLCAnPHRhYmxlPjx0Ym9keT48L3Rib2R5Pjxjb2xncm91cD4nLCAnPC9jb2xncm91cD48L3RhYmxlPiddLFxuICAgIF9kZWZhdWx0IDogWzAsICcnLCAnJ11cbn1cblxubWFwLnRkID1cbm1hcC50aCA9IFszLCAnPHRhYmxlPjx0Ym9keT48dHI+JywgJzwvdHI+PC90Ym9keT48L3RhYmxlPiddXG5cbm1hcC5vcHRpb24gPVxubWFwLm9wdGdyb3VwID0gWzEsICc8c2VsZWN0IG11bHRpcGxlPVwibXVsdGlwbGVcIj4nLCAnPC9zZWxlY3Q+J11cblxubWFwLnRoZWFkID1cbm1hcC50Ym9keSA9XG5tYXAuY29sZ3JvdXAgPVxubWFwLmNhcHRpb24gPVxubWFwLnRmb290ID0gWzEsICc8dGFibGU+JywgJzwvdGFibGU+J11cblxubWFwLnRleHQgPVxubWFwLmNpcmNsZSA9XG5tYXAuZWxsaXBzZSA9XG5tYXAubGluZSA9XG5tYXAucGF0aCA9XG5tYXAucG9seWdvbiA9XG5tYXAucG9seWxpbmUgPVxubWFwLnJlY3QgPSBbMSwgJzxzdmcgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIHZlcnNpb249XCIxLjFcIj4nLCc8L3N2Zz4nXVxuXG52YXIgVEFHX1JFID0gLzwoW1xcdzpdKykvXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHRlbXBsYXRlU3RyaW5nKSB7XG4gICAgdmFyIGZyYWcgPSBkb2N1bWVudC5jcmVhdGVEb2N1bWVudEZyYWdtZW50KCksXG4gICAgICAgIG0gPSBUQUdfUkUuZXhlYyh0ZW1wbGF0ZVN0cmluZylcbiAgICAvLyB0ZXh0IG9ubHlcbiAgICBpZiAoIW0pIHtcbiAgICAgICAgZnJhZy5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZW1wbGF0ZVN0cmluZykpXG4gICAgICAgIHJldHVybiBmcmFnXG4gICAgfVxuXG4gICAgdmFyIHRhZyA9IG1bMV0sXG4gICAgICAgIHdyYXAgPSBtYXBbdGFnXSB8fCBtYXAuX2RlZmF1bHQsXG4gICAgICAgIGRlcHRoID0gd3JhcFswXSxcbiAgICAgICAgcHJlZml4ID0gd3JhcFsxXSxcbiAgICAgICAgc3VmZml4ID0gd3JhcFsyXSxcbiAgICAgICAgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpXG5cbiAgICBub2RlLmlubmVySFRNTCA9IHByZWZpeCArIHRlbXBsYXRlU3RyaW5nLnRyaW0oKSArIHN1ZmZpeFxuICAgIHdoaWxlIChkZXB0aC0tKSBub2RlID0gbm9kZS5sYXN0Q2hpbGRcblxuICAgIC8vIG9uZSBlbGVtZW50XG4gICAgaWYgKG5vZGUuZmlyc3RDaGlsZCA9PT0gbm9kZS5sYXN0Q2hpbGQpIHtcbiAgICAgICAgZnJhZy5hcHBlbmRDaGlsZChub2RlLmZpcnN0Q2hpbGQpXG4gICAgICAgIHJldHVybiBmcmFnXG4gICAgfVxuXG4gICAgLy8gbXVsdGlwbGUgbm9kZXMsIHJldHVybiBhIGZyYWdtZW50XG4gICAgdmFyIGNoaWxkXG4gICAgLyoganNoaW50IGJvc3M6IHRydWUgKi9cbiAgICB3aGlsZSAoY2hpbGQgPSBub2RlLmZpcnN0Q2hpbGQpIHtcbiAgICAgICAgaWYgKG5vZGUubm9kZVR5cGUgPT09IDEpIHtcbiAgICAgICAgICAgIGZyYWcuYXBwZW5kQ2hpbGQoY2hpbGQpXG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZyYWdcbn0iLCJ2YXIgRXZlbnRUYXJnZXQgPSByZXF1aXJlKCcuL2V2ZW50VGFyZ2V0JyksXG4gICAgdXRpbHMgICAgICAgPSByZXF1aXJlKCcuL3V0aWxzJyksXG4gICAgY29uZmlnICAgICAgPSByZXF1aXJlKCcuL2NvbmZpZycpLFxuICAgIGRlZiAgICAgICAgID0gT2JqZWN0LmRlZmluZVByb3BlcnR5LFxuICAgIGhhc1Byb3RvICAgID0gKHt9KS5fX3Byb3RvX187XG52YXIgQXJyYXlQcm94eSAgPSBPYmplY3QuY3JlYXRlKEFycmF5LnByb3RvdHlwZSk7XG52YXIgT2JqUHJveHkgICAgPSBPYmplY3QuY3JlYXRlKE9iamVjdC5wcm90b3R5cGUpO1xudXRpbHMubWl4KEFycmF5UHJveHksIHtcbiAgICAnJHNldCc6IGZ1bmN0aW9uIHNldChpbmRleCwgZGF0YSkge1xuICAgICAgICByZXR1cm4gdGhpcy5zcGxpY2UoaW5kZXgsIDEsIGRhdGEpWzBdXG4gICAgfSxcbiAgICAnJHJlbW92ZSc6IGZ1bmN0aW9uIHJlbW92ZShpbmRleCkge1xuICAgICAgICBpZiAodHlwZW9mIGluZGV4ICE9PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgaW5kZXggPSB0aGlzLmluZGV4T2YoaW5kZXgpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGluZGV4ID4gLTEpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnNwbGljZShpbmRleCwgMSlbMF1cbiAgICAgICAgfVxuICAgIH1cbn0pO1xudXRpbHMubWl4KE9ialByb3h5LCB7XG4gICAgJyRhZGQnOiBmdW5jdGlvbiBhZGQoa2V5LCB2YWwpIHtcbiAgICAgICAgaWYgKHV0aWxzLm9iamVjdC5oYXModGhpcywga2V5KSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRoaXNba2V5XSA9IHZhbDtcbiAgICAgICAgY29udmVydEtleSh0aGlzLCBrZXksIHRydWUpO1xuICAgIH0sXG4gICAgJyRkZWxldGUnOiBmdW5jdGlvbiAoa2V5KSB7XG4gICAgXHRpZiAoIXV0aWxzLm9iamVjdC5oYXModGhpcywga2V5KSl7XG4gICAgXHRcdHJldHVybjtcbiAgICBcdH1cbiAgICBcdGRlbGV0ZSB0aGlzW2tleV07XG4gICAgXHR0aGlzLl9fZW1pdHRlcl9fLmVtaXQoJ2RlbGV0ZScsIGtleSk7XG4gICAgfVxufSk7XG4vKipcbiAqICBJTlRFUkNFUCBBIE1VVEFUSU9OIEVWRU5UIFNPIFdFIENBTiBFTUlUIFRIRSBNVVRBVElPTiBJTkZPLlxuICogIFdFIEFMU08gQU5BTFlaRSBXSEFUIEVMRU1FTlRTIEFSRSBBRERFRC9SRU1PVkVEIEFORCBMSU5LL1VOTElOS1xuICogIFRIRU0gV0lUSCBUSEUgUEFSRU5UIEFSUkFZLlxuICovXG51dGlscy5lYWNoKFsncHVzaCcsICdwb3AnLCAnc2hpZnQnLCAndW5zaGlmdCcsICdzcGxpY2UnLCAnc29ydCcsICdyZXZlcnNlJ10sIGZ1bmN0aW9uKHR5cGUpIHtcbiAgICBBcnJheVByb3h5W3R5cGVdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpLFxuICAgICAgICAgICAgcmVzdWx0ID0gQXJyYXkucHJvdG90eXBlW21ldGhvZF0uYXBwbHkodGhpcywgYXJncyksXG4gICAgICAgICAgICBpbnNlcnRlZCwgcmVtb3ZlZDtcbiAgICAgICAgLy8gZGV0ZXJtaW5lIG5ldyAvIHJlbW92ZWQgZWxlbWVudHNcbiAgICAgICAgaWYgKG1ldGhvZCA9PT0gJ3B1c2gnIHx8IG1ldGhvZCA9PT0gJ3Vuc2hpZnQnKSB7XG4gICAgICAgICAgICBpbnNlcnRlZCA9IGFyZ3M7XG4gICAgICAgIH0gZWxzZSBpZiAobWV0aG9kID09PSAncG9wJyB8fCBtZXRob2QgPT09ICdzaGlmdCcpIHtcbiAgICAgICAgICAgIHJlbW92ZWQgPSBbcmVzdWx0XTtcbiAgICAgICAgfSBlbHNlIGlmIChtZXRob2QgPT09ICdzcGxpY2UnKSB7XG4gICAgICAgICAgICBpbnNlcnRlZCA9IGFyZ3Muc2xpY2UoMilcbiAgICAgICAgICAgIHJlbW92ZWQgPSByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgLy8gbGluayAmIHVubGlua1xuICAgICAgICBsaW5rQXJyYXlFbGVtZW50cyh0aGlzLCBpbnNlcnRlZClcbiAgICAgICAgdW5saW5rQXJyYXlFbGVtZW50cyh0aGlzLCByZW1vdmVkKVxuICAgICAgICAvLyBlbWl0IHRoZSBtdXRhdGlvbiBldmVudFxuICAgICAgICB0aGlzLl9fZW1pdHRlcl9fLmVtaXQoJ211dGF0ZScsICcnLCB0aGlzLCB7XG4gICAgICAgICAgICBtZXRob2Q6IG1ldGhvZCxcbiAgICAgICAgICAgIGFyZ3M6IGFyZ3MsXG4gICAgICAgICAgICByZXN1bHQ6IHJlc3VsdCxcbiAgICAgICAgICAgIGluc2VydGVkOiBpbnNlcnRlZCxcbiAgICAgICAgICAgIHJlbW92ZWQ6IHJlbW92ZWRcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxufSk7XG4vKipcbiAqICBMaW5rIG5ldyBlbGVtZW50cyB0byBhbiBBcnJheSwgc28gd2hlbiB0aGV5IGNoYW5nZVxuICogIGFuZCBlbWl0IGV2ZW50cywgdGhlIG93bmVyIEFycmF5IGNhbiBiZSBub3RpZmllZC5cbiAqL1xuZnVuY3Rpb24gbGlua0FycmF5RWxlbWVudHMoYXJyLCBpdGVtcykge1xuICAgIGlmIChpdGVtcykge1xuICAgICAgICB2YXIgaSA9IGl0ZW1zLmxlbmd0aCxcbiAgICAgICAgICAgIGl0ZW0sIG93bmVyc1xuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBpdGVtID0gaXRlbXNbaV1cbiAgICAgICAgICAgIGlmIChpc1dhdGNoYWJsZShpdGVtKSkge1xuICAgICAgICAgICAgICAgIC8vIGlmIG9iamVjdCBpcyBub3QgY29udmVydGVkIGZvciBvYnNlcnZpbmdcbiAgICAgICAgICAgICAgICAvLyBjb252ZXJ0IGl0Li4uXG4gICAgICAgICAgICAgICAgaWYgKCFpdGVtLl9fZW1pdHRlcl9fKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnZlcnQoaXRlbSlcbiAgICAgICAgICAgICAgICAgICAgd2F0Y2goaXRlbSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgb3duZXJzID0gaXRlbS5fX2VtaXR0ZXJfXy5vd25lcnNcbiAgICAgICAgICAgICAgICBpZiAob3duZXJzLmluZGV4T2YoYXJyKSA8IDApIHtcbiAgICAgICAgICAgICAgICAgICAgb3duZXJzLnB1c2goYXJyKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cbi8qKlxuICogIFVubGluayByZW1vdmVkIGVsZW1lbnRzIGZyb20gdGhlIGV4LW93bmVyIEFycmF5LlxuICovXG5mdW5jdGlvbiB1bmxpbmtBcnJheUVsZW1lbnRzKGFyciwgaXRlbXMpIHtcbiAgICBpZiAoaXRlbXMpIHtcbiAgICAgICAgdmFyIGkgPSBpdGVtcy5sZW5ndGgsXG4gICAgICAgICAgICBpdGVtXG4gICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgIGl0ZW0gPSBpdGVtc1tpXVxuICAgICAgICAgICAgaWYgKGl0ZW0gJiYgaXRlbS5fX2VtaXR0ZXJfXykge1xuICAgICAgICAgICAgICAgIHZhciBvd25lcnMgPSBpdGVtLl9fZW1pdHRlcl9fLm93bmVyc1xuICAgICAgICAgICAgICAgIGlmIChvd25lcnMpIG93bmVycy5zcGxpY2Uob3duZXJzLmluZGV4T2YoYXJyKSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cbi8qKlxuICogIENIRUNLIElGIEEgVkFMVUUgSVMgV0FUQ0hBQkxFXG4gKi9cbmZ1bmN0aW9uIGlzV2F0Y2hhYmxlKG9iaikge1xuICAgIHJldHVybiB0eXBlb2Ygb2JqID09PSAnb2JqZWN0JyAmJiBvYmogJiYgIW9iai4kY29tcGlsZXJcbn1cbi8qKlxuICogIENPTlZFUlQgQU4gT0JKRUNUL0FSUkFZIFRPIEdJVkUgSVQgQSBDSEFOR0UgRU1JVFRFUi5cbiAqL1xuZnVuY3Rpb24gY29udmVydChvYmopIHtcbiAgICBpZiAob2JqLl9fZW1pdHRlcl9fKSByZXR1cm4gdHJ1ZVxuICAgIHZhciBlbWl0dGVyID0gbmV3IEV2ZW50VGFyZ2V0KCk7XG4gICAgb2JqWydfX2VtaXR0ZXJfXyddID0gZW1pdHRlcjtcbiAgICBlbWl0dGVyLm9uKCdzZXQnLCBmdW5jdGlvbihrZXksIHZhbCwgcHJvcGFnYXRlKSB7XG4gICAgICAgIGlmIChwcm9wYWdhdGUpIHByb3BhZ2F0ZUNoYW5nZShvYmopXG4gICAgfSk7XG4gICAgZW1pdHRlci5vbignbXV0YXRlJywgZnVuY3Rpb24oKSB7XG4gICAgICAgIHByb3BhZ2F0ZUNoYW5nZShvYmopXG4gICAgfSk7XG4gICAgZW1pdHRlci52YWx1ZXMgPSB1dGlscy5oYXNoKCk7XG4gICAgZW1pdHRlci5vd25lcnMgPSBbXTtcbiAgICByZXR1cm4gZmFsc2U7XG59XG4vKipcbiAqICBQUk9QQUdBVEUgQU4gQVJSQVkgRUxFTUVOVCdTIENIQU5HRSBUTyBJVFMgT1dORVIgQVJSQVlTXG4gKi9cbmZ1bmN0aW9uIHByb3BhZ2F0ZUNoYW5nZShvYmopIHtcbiAgICB2YXIgb3duZXJzID0gb2JqLl9fZW1pdHRlcl9fLm93bmVycyxcbiAgICAgICAgaSA9IG93bmVycy5sZW5ndGhcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIG93bmVyc1tpXS5fX2VtaXR0ZXJfXy5lbWl0KCdzZXQnLCAnJywgJycsIHRydWUpXG4gICAgfVxufVxuLyoqXG4gKiAgV0FUQ0ggVEFSR0VUIEJBU0VEIE9OIElUUyBUWVBFXG4gKi9cbmZ1bmN0aW9uIHdhdGNoKG9iaikge1xuICAgIGlmICh1dGlscy5pc0FycmF5KG9iaikpIHtcbiAgICAgICAgd2F0Y2hBcnJheShvYmopXG4gICAgfSBlbHNlIHtcbiAgICAgICAgd2F0Y2hPYmplY3Qob2JqKVxuICAgIH1cbn1cbi8qKlxuICogIFdhdGNoIGFuIE9iamVjdCwgcmVjdXJzaXZlLlxuICovXG5mdW5jdGlvbiB3YXRjaE9iamVjdChvYmopIHtcbiAgICBhdWdtZW50KG9iaiwgT2JqUHJveHkpXG4gICAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgICAgICBjb252ZXJ0S2V5KG9iaiwga2V5KVxuICAgIH1cbn1cbi8qKlxuICogIFdBVENIIEFOIEFSUkFZLCBPVkVSTE9BRCBNVVRBVElPTiBNRVRIT0RTXG4gKiAgQU5EIEFERCBBVUdNRU5UQVRJT05TIEJZIElOVEVSQ0VQVElORyBUSEUgUFJPVE9UWVBFIENIQUlOXG4gKi9cbmZ1bmN0aW9uIHdhdGNoQXJyYXkoYXJyKSB7XG4gICAgYXVnbWVudChhcnIsIEFycmF5UHJveHkpO1xuICAgIGxpbmtBcnJheUVsZW1lbnRzKGFyciwgYXJyKTtcbn1cbi8qKlxuICogIEFVR01FTlQgVEFSR0VUIE9CSkVDVFMgV0lUSCBNT0RJRklFRFxuICogIE1FVEhPRFNcbiAqL1xuZnVuY3Rpb24gYXVnbWVudCh0YXJnZXQsIHNyYykge1xuICAgIGlmIChoYXNQcm90bykge1xuICAgICAgICB0YXJnZXQuX19wcm90b19fID0gc3JjXG4gICAgfSBlbHNlIHtcbiAgICBcdHV0aWxzLm1peCh0YXJnZXQsIHNyYyk7XG4gICAgfVxufVxuXG5cbi8qKlxuICogIERFRklORSBBQ0NFU1NPUlMgRk9SIEEgUFJPUEVSVFkgT04gQU4gT0JKRUNUXG4gKiAgU08gSVQgRU1JVFMgR0VUL1NFVCBFVkVOVFMuXG4gKiAgVEhFTiBXQVRDSCBUSEUgVkFMVUUgSVRTRUxGLlxuICovXG5mdW5jdGlvbiBjb252ZXJ0S2V5IChvYmosIGtleSwgcHJvcGFnYXRlKXtcblx0dmFyIGtleVByZWZpeCA9IGtleS5jaGFyQXQoMCk7XG5cdGlmIChrZXlQcmVmaXggPT09ICckJyB8fCBrZXlQcmVmaXggPT09ICdfJyl7XG5cdFx0cmV0dXJuO1xuXHR9XG5cdHZhciBlbWl0dGVyID0gb2JqLl9fZW1pdHRlcl9fLFxuXHRcdHZhbHVlcyAgPSBlbWl0dGVyLnZhbHVlcztcblxuXHRpbml0KG9ialtrZXldLCBwcm9wYWdhdGUpO1xuXHRPYmplY3QuZGVmaW5lUHJvcGVydHkob2JqLCBrZXksIHtcblx0XHRlbnVtZXJhYmxlOiB0cnVlLFxuXHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZSxcblx0XHRnZXQ6IGZ1bmN0aW9uICgpIHtcblx0XHRcdHZhciB2YWx1ZSA9IHZhbHVlc1trZXldO1xuXHRcdFx0aWYgKGNvbmZpZy5lbW1pdEdldCkge1xuXHRcdFx0XHRlbWl0dGVyLmVtaXQoJ2dldCcsIGtleSk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gdmFsdWU7XG5cdFx0fSxcblx0XHRzZXQ6IGZ1bmN0aW9uIChuZXdWYWx1ZSl7XG5cdFx0XHR2YXIgb2xkVmFsdWUgPSB2YWx1ZXNba2V5XTtcblx0XHRcdHVub2JzZXJ2ZShvbGRWYWx1ZSwga2V5LCBlbWl0dGVyKTtcblx0XHRcdGNvcHlQYXRocyhuZXdWYWx1ZSwgb2xkVmFsdWUpO1xuXHRcdFx0aW5pdChuZXdWYWx1ZSwgdHJ1ZSk7XG5cdFx0fVxuXHR9KTtcblx0ZnVuY3Rpb24gaW5pdCAodmFsLCBwcm9wYWdhdGUpe1xuXHRcdHZhbHVlc1trZXldID0gdmFsO1xuXHRcdGVtaXR0ZXIuZW1pdCgnc2V0Jywga2V5LCB2YWwsIHByb3BhZ2F0ZSk7XG5cdFx0aWYgKHV0aWxzLmlzQXJyYXkodmFsKSkge1xuXHRcdFx0ZW1pdHRlci5lbWl0KCdzZXQnLCBrZXkgKyAnLmxlbmd0aCcsIHZhbC5sZW5ndGgsIHByb3BhZ2F0ZSk7XG5cdFx0fVxuXHRcdG9ic2VydmUodmFsLCBrZXksIGVtaXR0ZXIpO1xuXHR9XG59XG5cbi8qKlxuICogIFdoZW4gYSB2YWx1ZSB0aGF0IGlzIGFscmVhZHkgY29udmVydGVkIGlzXG4gKiAgb2JzZXJ2ZWQgYWdhaW4gYnkgYW5vdGhlciBvYnNlcnZlciwgd2UgY2FuIHNraXBcbiAqICB0aGUgd2F0Y2ggY29udmVyc2lvbiBhbmQgc2ltcGx5IGVtaXQgc2V0IGV2ZW50IGZvclxuICogIGFsbCBvZiBpdHMgcHJvcGVydGllcy5cbiAqL1xuZnVuY3Rpb24gZW1pdFNldCAob2JqKSB7XG4gICAgdmFyIGVtaXR0ZXIgPSBvYmogJiYgb2JqLl9fZW1pdHRlcl9fO1xuICAgIGlmICghZW1pdHRlcikgcmV0dXJuO1xuICAgIGlmICh1dGlscy5pc0FycmF5KG9iaikpIHtcbiAgICAgICAgZW1pdHRlci5lbWl0KCdzZXQnLCAnbGVuZ3RoJywgb2JqLmxlbmd0aCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGtleSwgdmFsXG4gICAgICAgIGZvciAoa2V5IGluIG9iaikge1xuICAgICAgICAgICAgdmFsID0gb2JqW2tleV1cbiAgICAgICAgICAgIGVtaXR0ZXIuZW1pdCgnc2V0Jywga2V5LCB2YWwpO1xuICAgICAgICAgICAgZW1pdFNldCh2YWwpO1xuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBNYWtlIHN1cmUgYWxsIHRoZSBwYXRocyBpbiBhbiBvbGQgb2JqZWN0IGV4aXN0c1xuICogIGluIGEgbmV3IG9iamVjdC5cbiAqICBTbyB3aGVuIGFuIG9iamVjdCBjaGFuZ2VzLCBhbGwgbWlzc2luZyBrZXlzIHdpbGxcbiAqICBlbWl0IGEgc2V0IGV2ZW50IHdpdGggdW5kZWZpbmVkIHZhbHVlLlxuICovXG5mdW5jdGlvbiBjb3B5UGF0aHMgKG5ld09iaiwgb2xkT2JqKSB7XG4gICAgaWYgKCFpc09iamVjdChuZXdPYmopIHx8ICFpc09iamVjdChvbGRPYmopKSB7XG4gICAgICAgIHJldHVyblxuICAgIH1cbiAgICB2YXIgcGF0aCwgb2xkVmFsLCBuZXdWYWw7XG4gICAgZm9yIChwYXRoIGluIG9sZE9iaikge1xuICAgICAgICBpZiAoISh1dGlscy5vYmplY3QuaGFzKG5ld09iaiwgcGF0aCkpKSB7XG4gICAgICAgICAgICBvbGRWYWwgPSBvbGRPYmpbcGF0aF1cbiAgICAgICAgICAgIGlmICh1dGlscy5pc0FycmF5KG9sZFZhbCkpIHtcbiAgICAgICAgICAgICAgICBuZXdPYmpbcGF0aF0gPSBbXVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpc09iamVjdChvbGRWYWwpKSB7XG4gICAgICAgICAgICAgICAgbmV3VmFsID0gbmV3T2JqW3BhdGhdID0ge31cbiAgICAgICAgICAgICAgICBjb3B5UGF0aHMobmV3VmFsLCBvbGRWYWwpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG5ld09ialtwYXRoXSA9IHVuZGVmaW5lZFxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICB3YWxrIGFsb25nIGEgcGF0aCBhbmQgbWFrZSBzdXJlIGl0IGNhbiBiZSBhY2Nlc3NlZFxuICogIGFuZCBlbnVtZXJhdGVkIGluIHRoYXQgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIGVuc3VyZVBhdGggKG9iaiwga2V5KSB7XG4gICAgdmFyIHBhdGggPSBrZXkuc3BsaXQoJy4nKSwgc2VjXG4gICAgZm9yICh2YXIgaSA9IDAsIGQgPSBwYXRoLmxlbmd0aCAtIDE7IGkgPCBkOyBpKyspIHtcbiAgICAgICAgc2VjID0gcGF0aFtpXVxuICAgICAgICBpZiAoIW9ialtzZWNdKSB7XG4gICAgICAgICAgICBvYmpbc2VjXSA9IHt9XG4gICAgICAgICAgICBpZiAob2JqLl9fZW1pdHRlcl9fKSBjb252ZXJ0S2V5KG9iaiwgc2VjKVxuICAgICAgICB9XG4gICAgICAgIG9iaiA9IG9ialtzZWNdXG4gICAgfVxuICAgIGlmICh1dGlscy5pc09iamVjdChvYmopKSB7XG4gICAgICAgIHNlYyA9IHBhdGhbaV1cbiAgICAgICAgaWYgKCEoaGFzT3duLmNhbGwob2JqLCBzZWMpKSkge1xuICAgICAgICAgICAgb2JqW3NlY10gPSB1bmRlZmluZWRcbiAgICAgICAgICAgIGlmIChvYmouX19lbWl0dGVyX18pIGNvbnZlcnRLZXkob2JqLCBzZWMpXG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIG9ic2VydmUgKG9iaiwgcmF3UGF0aCwgb2JzZXJ2ZXIpIHtcblx0aWYgKCFpc1dhdGNoYWJsZShvYmopKSByZXR1cm47XG5cblx0dmFyIHBhdGggPSByYXdQYXRoID8gcmF3UGF0aCArICcuJyA6ICcnLFxuXHRcdGFscmVhZHlDb252ZXJ0ZWQgPSBjb252ZXJ0KG9iaiksXG5cdFx0ZW1pdHRlciA9IG9iai5fX2VtaXR0ZXJfXztcblxuXHQvLyBzZXR1cCBwcm94eSBsaXN0ZW5lcnMgb24gdGhlIHBhcmVudCBvYnNlcnZlci5cbiAgICAvLyB3ZSBuZWVkIHRvIGtlZXAgcmVmZXJlbmNlIHRvIHRoZW0gc28gdGhhdCB0aGV5XG4gICAgLy8gY2FuIGJlIHJlbW92ZWQgd2hlbiB0aGUgb2JqZWN0IGlzIHVuLW9ic2VydmVkLlxuXHRvYnNlcnZlci5wcm94aWVzID0gb2JzZXJ2ZXIucHJveGllcyB8fCB7fTtcblx0dmFyIHByb3hpZXMgPSBvYnNlcnZlci5wcm94aWVzW3BhdGhdID0ge1xuXHRcdGdldDogZnVuY3Rpb24oa2V5KXtcblx0XHRcdG9ic2VydmVyLmVtaXQoJ2dldCcsIHBhdGggKyBrZXkpO1xuXHRcdH0sXG5cdFx0c2V0OiBmdW5jdGlvbihrZXksIHZhbCwgcHJvcGFnYXRlKXtcblx0XHRcdGlmIChrZXkpIG9ic2VydmVyLmVtaXQoJ3NldCcsIHBhdGggKyBrZXksIHZhbCk7XG5cdFx0XHQvLyBhbHNvIG5vdGlmeSBvYnNlcnZlciB0aGF0IHRoZSBvYmplY3QgaXRzZWxmIGNoYW5nZWRcbiAgICAgICAgICAgIC8vIGJ1dCBvbmx5IGRvIHNvIHdoZW4gaXQncyBhIGltbWVkaWF0ZSBwcm9wZXJ0eS4gdGhpc1xuICAgICAgICAgICAgLy8gYXZvaWRzIGR1cGxpY2F0ZSBldmVudCBmaXJpbmcuXG5cdFx0XHRpZiAocmF3UGF0aCAmJiBwcm9wYWdhdGUpIHtcblx0XHRcdFx0b2JzZXJ2ZXIuZW1pdCgnc2V0JywgcmF3UGF0aCwgb2JqLCB0cnVlKTtcblx0XHRcdH1cblx0XHR9LFxuXHRcdG11dGF0ZTogZnVuY3Rpb24gKGtleSwgdmFsLCBtdXRhdGlvbikge1xuXHRcdFx0Ly8gaWYgdGhlIEFycmF5IGlzIGEgcm9vdCB2YWx1ZVxuICAgICAgICAgICAgLy8gdGhlIGtleSB3aWxsIGJlIG51bGxcblx0XHRcdHZhciBmaXhlZFBhdGggPSBrZXkgPyBwYXRoICsga2V5IDogcmF3UGF0aDtcblx0XHRcdG9ic2VydmVyLmVtaXQoJ211dGF0ZScsIGZpeGVkUGF0aCwgdmFsLCBtdXRhdGlvbik7XG5cdFx0XHR2YXIgbSA9IG11dGFpb24ubWV0aG9kO1xuXHRcdFx0aWYgKG0gIT09ICdzb3J0JyAmJiBtICE9PSAncmV2ZXJzZScpIHtcblx0XHRcdFx0b2JzZXJ2ZXIuZW1pdCgnc2V0JywgZml4ZWRQYXRoICsgJy5sZW5ndGgnLCB2YWwubGVuZ3RoKTtcblx0XHRcdH1cblx0XHR9XG5cdH07XG5cblx0Ly8gYXR0YWNoIHRoZSBsaXN0ZW5lcnMgdG8gdGhlIGNoaWxkIG9ic2VydmVyLlxuICAgIC8vIG5vdyBhbGwgdGhlIGV2ZW50cyB3aWxsIHByb3BhZ2F0ZSB1cHdhcmRzLlxuICAgIGVtaXR0ZXJcbiAgICAgICAgLm9uKCdnZXQnLCBwcm94aWVzLmdldClcbiAgICAgICAgLm9uKCdzZXQnLCBwcm94aWVzLnNldClcbiAgICAgICAgLm9uKCdtdXRhdGUnLCBwcm94aWVzLm11dGF0ZSk7XG5cblxuICAgIGlmIChhbHJlYWR5Q29udmVydGVkKSB7XG4gICAgICAgIC8vIGZvciBvYmplY3RzIHRoYXQgaGF2ZSBhbHJlYWR5IGJlZW4gY29udmVydGVkLFxuICAgICAgICAvLyBlbWl0IHNldCBldmVudHMgZm9yIGV2ZXJ5dGhpbmcgaW5zaWRlXG4gICAgICAgIGVtaXRTZXQob2JqKVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHdhdGNoKG9iailcbiAgICB9XG59XG5cbi8qKlxuICogIENhbmNlbCBvYnNlcnZhdGlvbiwgdHVybiBvZmYgdGhlIGxpc3RlbmVycy5cbiAqL1xuZnVuY3Rpb24gdW5vYnNlcnZlIChvYmosIHBhdGgsIG9ic2VydmVyKSB7XG5cbiAgICBpZiAoIW9iaiB8fCAhb2JqLl9fZW1pdHRlcl9fKSByZXR1cm5cblxuICAgIHBhdGggPSBwYXRoID8gcGF0aCArICcuJyA6ICcnXG4gICAgdmFyIHByb3hpZXMgPSBvYnNlcnZlci5wcm94aWVzW3BhdGhdXG4gICAgaWYgKCFwcm94aWVzKSByZXR1cm5cblxuICAgIC8vIHR1cm4gb2ZmIGxpc3RlbmVyc1xuICAgIG9iai5fX2VtaXR0ZXJfX1xuICAgICAgICAub2ZmKCdnZXQnLCBwcm94aWVzLmdldClcbiAgICAgICAgLm9mZignc2V0JywgcHJveGllcy5zZXQpXG4gICAgICAgIC5vZmYoJ211dGF0ZScsIHByb3hpZXMubXV0YXRlKVxuXG4gICAgLy8gcmVtb3ZlIHJlZmVyZW5jZVxuICAgIG9ic2VydmVyLnByb3hpZXNbcGF0aF0gPSBudWxsXG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIG9ic2VydmUgICAgIDogb2JzZXJ2ZSxcbiAgICB1bm9ic2VydmUgICA6IHVub2JzZXJ2ZSxcbiAgICBlbnN1cmVQYXRoICA6IGVuc3VyZVBhdGgsXG4gICAgY29weVBhdGhzICAgOiBjb3B5UGF0aHMsXG4gICAgd2F0Y2ggICAgICAgOiB3YXRjaCxcbiAgICBjb252ZXJ0ICAgICA6IGNvbnZlcnQsXG4gICAgY29udmVydEtleSAgOiBjb252ZXJ0S2V5XG59IiwidmFyIHRvRnJhZ21lbnQgPSByZXF1aXJlKCcuL2ZyYWdtZW50JylcbiAgICBUZXh0UGFyc2VyID0gcmVxdWlyZSgnLi90ZXh0UGFyc2VyJyksXG4gICAgRXhwUGFyc2VyICA9IHJlcXVpcmUoJy4vRXhwUGFyc2VyJyksXG4gICAgRGVwc1BhcnNlciA9IHJlcXVpcmUoJy4vRGVwc1BhcnNlcicpO1xuXG4vKipcbiAqIFBhcnNlcyBhIHRlbXBsYXRlIHN0cmluZyBvciBub2RlIGFuZCBub3JtYWxpemVzIGl0IGludG8gYVxuICogYSBub2RlIHRoYXQgY2FuIGJlIHVzZWQgYXMgYSBwYXJ0aWFsIG9mIGEgdGVtcGxhdGUgb3B0aW9uXG4gKlxuICogUG9zc2libGUgdmFsdWVzIGluY2x1ZGVcbiAqIGlkIHNlbGVjdG9yOiAnI3NvbWUtdGVtcGxhdGUtaWQnXG4gKiB0ZW1wbGF0ZSBzdHJpbmc6ICc8ZGl2PjxzcGFuPm15IHRlbXBsYXRlPC9zcGFuPjwvZGl2PidcbiAqIERvY3VtZW50RnJhZ21lbnQgb2JqZWN0XG4gKiBOb2RlIG9iamVjdCBvZiB0eXBlIFRlbXBsYXRlXG4gKi9cbmZ1bmN0aW9uIHBhcnNlVGVtcGxhdGUodGVtcGxhdGUpIHtcbiAgICB2YXIgdGVtcGxhdGVOb2RlO1xuXG4gICAgaWYgKHRlbXBsYXRlIGluc3RhbmNlb2Ygd2luZG93LkRvY3VtZW50RnJhZ21lbnQpIHtcbiAgICAgICAgLy8gaWYgdGhlIHRlbXBsYXRlIGlzIGFscmVhZHkgYSBkb2N1bWVudCBmcmFnbWVudCAtLSBkbyBub3RoaW5nXG4gICAgICAgIHJldHVybiB0ZW1wbGF0ZVxuICAgIH1cblxuICAgIGlmICh0eXBlb2YgdGVtcGxhdGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIC8vIHRlbXBsYXRlIGJ5IElEXG4gICAgICAgIGlmICh0ZW1wbGF0ZS5jaGFyQXQoMCkgPT09ICcjJykge1xuICAgICAgICAgICAgdGVtcGxhdGVOb2RlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQodGVtcGxhdGUuc2xpY2UoMSkpXG4gICAgICAgICAgICBpZiAoIXRlbXBsYXRlTm9kZSkgcmV0dXJuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gdG9GcmFnbWVudCh0ZW1wbGF0ZSlcbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAodGVtcGxhdGUubm9kZVR5cGUpIHtcbiAgICAgICAgdGVtcGxhdGVOb2RlID0gdGVtcGxhdGVcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBpZiBpdHMgYSB0ZW1wbGF0ZSB0YWcgYW5kIHRoZSBicm93c2VyIHN1cHBvcnRzIGl0LFxuICAgIC8vIGl0cyBjb250ZW50IGlzIGFscmVhZHkgYSBkb2N1bWVudCBmcmFnbWVudCFcbiAgICBpZiAodGVtcGxhdGVOb2RlLnRhZ05hbWUgPT09ICdURU1QTEFURScgJiYgdGVtcGxhdGVOb2RlLmNvbnRlbnQpIHtcbiAgICAgICAgcmV0dXJuIHRlbXBsYXRlTm9kZS5jb250ZW50XG4gICAgfVxuXG4gICAgaWYgKHRlbXBsYXRlTm9kZS50YWdOYW1lID09PSAnU0NSSVBUJykge1xuICAgICAgICByZXR1cm4gdG9GcmFnbWVudCh0ZW1wbGF0ZU5vZGUuaW5uZXJIVE1MKVxuICAgIH1cblxuICAgIHJldHVybiB0b0ZyYWdtZW50KHRlbXBsYXRlTm9kZS5vdXRlckhUTUwpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBwYXJzZVRlbXBsYXRlOiBwYXJzZVRlbXBsYXRlLFxuICAgIFRleHRQYXJzZXI6IFRleHRQYXJzZXIsXG4gICAgRXhwUGFyc2VyOiBFeHBQYXJzZXIsXG4gICAgRGVwc1BhcnNlcjogRGVwc1BhcnNlclxufTsiLCJ2YXIgb3BlbkNoYXIgICAgICAgID0gJ3snLFxuICAgIGVuZENoYXIgICAgICAgICA9ICd9JyxcbiAgICBFU0NBUEVfUkUgICAgICAgPSAvWy0uKis/XiR7fSgpfFtcXF1cXC9cXFxcXS9nLFxuICAgIC8vIGxhenkgcmVxdWlyZVxuICAgIERpcmVjdGl2ZVxuXG5leHBvcnRzLlJlZ2V4ID0gYnVpbGRJbnRlcnBvbGF0aW9uUmVnZXgoKVxuXG5mdW5jdGlvbiBidWlsZEludGVycG9sYXRpb25SZWdleCAoKSB7XG4gICAgdmFyIG9wZW4gPSBlc2NhcGVSZWdleChvcGVuQ2hhciksXG4gICAgICAgIGVuZCAgPSBlc2NhcGVSZWdleChlbmRDaGFyKVxuICAgIHJldHVybiBuZXcgUmVnRXhwKG9wZW4gKyBvcGVuICsgb3BlbiArICc/KC4rPyknICsgZW5kICsgJz8nICsgZW5kICsgZW5kKVxufVxuXG5mdW5jdGlvbiBlc2NhcGVSZWdleCAoc3RyKSB7XG4gICAgcmV0dXJuIHN0ci5yZXBsYWNlKEVTQ0FQRV9SRSwgJ1xcXFwkJicpXG59XG5cbmZ1bmN0aW9uIHNldERlbGltaXRlcnMgKGRlbGltaXRlcnMpIHtcbiAgICBvcGVuQ2hhciA9IGRlbGltaXRlcnNbMF1cbiAgICBlbmRDaGFyID0gZGVsaW1pdGVyc1sxXVxuICAgIGV4cG9ydHMuZGVsaW1pdGVycyA9IGRlbGltaXRlcnNcbiAgICBleHBvcnRzLlJlZ2V4ID0gYnVpbGRJbnRlcnBvbGF0aW9uUmVnZXgoKVxufVxuXG4vKiogXG4gKiAgUGFyc2UgYSBwaWVjZSBvZiB0ZXh0LCByZXR1cm4gYW4gYXJyYXkgb2YgdG9rZW5zXG4gKiAgdG9rZW4gdHlwZXM6XG4gKiAgMS4gcGxhaW4gc3RyaW5nXG4gKiAgMi4gb2JqZWN0IHdpdGgga2V5ID0gYmluZGluZyBrZXlcbiAqICAzLiBvYmplY3Qgd2l0aCBrZXkgJiBodG1sID0gdHJ1ZVxuICovXG5mdW5jdGlvbiBwYXJzZSAodGV4dCkge1xuICAgIGlmICghZXhwb3J0cy5SZWdleC50ZXN0KHRleHQpKSByZXR1cm4gbnVsbFxuICAgIHZhciBtLCBpLCB0b2tlbiwgbWF0Y2gsIHRva2VucyA9IFtdXG4gICAgLyoganNoaW50IGJvc3M6IHRydWUgKi9cbiAgICB3aGlsZSAobSA9IHRleHQubWF0Y2goZXhwb3J0cy5SZWdleCkpIHtcbiAgICAgICAgaSA9IG0uaW5kZXhcbiAgICAgICAgaWYgKGkgPiAwKSB0b2tlbnMucHVzaCh0ZXh0LnNsaWNlKDAsIGkpKVxuICAgICAgICB0b2tlbiA9IHsga2V5OiBtWzFdLnRyaW0oKSB9XG4gICAgICAgIG1hdGNoID0gbVswXVxuICAgICAgICB0b2tlbi5odG1sID1cbiAgICAgICAgICAgIG1hdGNoLmNoYXJBdCgyKSA9PT0gb3BlbkNoYXIgJiZcbiAgICAgICAgICAgIG1hdGNoLmNoYXJBdChtYXRjaC5sZW5ndGggLSAzKSA9PT0gZW5kQ2hhclxuICAgICAgICB0b2tlbnMucHVzaCh0b2tlbilcbiAgICAgICAgdGV4dCA9IHRleHQuc2xpY2UoaSArIG1bMF0ubGVuZ3RoKVxuICAgIH1cbiAgICBpZiAodGV4dC5sZW5ndGgpIHRva2Vucy5wdXNoKHRleHQpXG4gICAgcmV0dXJuIHRva2Vuc1xufVxuXG4vKipcbiAqICBQYXJzZSBhbiBhdHRyaWJ1dGUgdmFsdWUgd2l0aCBwb3NzaWJsZSBpbnRlcnBvbGF0aW9uIHRhZ3NcbiAqICByZXR1cm4gYSBEaXJlY3RpdmUtZnJpZW5kbHkgZXhwcmVzc2lvblxuICpcbiAqICBlLmcuICBhIHt7Yn19IGMgID0+ICBcImEgXCIgKyBiICsgXCIgY1wiXG4gKi9cbmZ1bmN0aW9uIHBhcnNlQXR0ciAoYXR0cikge1xuICAgIERpcmVjdGl2ZSA9IERpcmVjdGl2ZSB8fCByZXF1aXJlKCcuL2RpcmVjdGl2ZScpXG4gICAgdmFyIHRva2VucyA9IHBhcnNlKGF0dHIpXG4gICAgaWYgKCF0b2tlbnMpIHJldHVybiBudWxsXG4gICAgaWYgKHRva2Vucy5sZW5ndGggPT09IDEpIHJldHVybiB0b2tlbnNbMF0ua2V5XG4gICAgdmFyIHJlcyA9IFtdLCB0b2tlblxuICAgIGZvciAodmFyIGkgPSAwLCBsID0gdG9rZW5zLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICB0b2tlbiA9IHRva2Vuc1tpXVxuICAgICAgICByZXMucHVzaChcbiAgICAgICAgICAgIHRva2VuLmtleVxuICAgICAgICAgICAgICAgID8gaW5saW5lRmlsdGVycyh0b2tlbi5rZXkpXG4gICAgICAgICAgICAgICAgOiAoJ1wiJyArIHRva2VuICsgJ1wiJylcbiAgICAgICAgKVxuICAgIH1cbiAgICByZXR1cm4gcmVzLmpvaW4oJysnKVxufVxuXG4vKipcbiAqICBJbmxpbmVzIGFueSBwb3NzaWJsZSBmaWx0ZXJzIGluIGEgYmluZGluZ1xuICogIHNvIHRoYXQgd2UgY2FuIGNvbWJpbmUgZXZlcnl0aGluZyBpbnRvIGEgaHVnZSBleHByZXNzaW9uXG4gKi9cbmZ1bmN0aW9uIGlubGluZUZpbHRlcnMgKGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignfCcpID4gLTEpIHtcbiAgICAgICAgdmFyIGRpcnMgPSBEaXJlY3RpdmUucGFyc2Uoa2V5KSxcbiAgICAgICAgICAgIGRpciA9IGRpcnMgJiYgZGlyc1swXVxuICAgICAgICBpZiAoZGlyICYmIGRpci5maWx0ZXJzKSB7XG4gICAgICAgICAgICBrZXkgPSBEaXJlY3RpdmUuaW5saW5lRmlsdGVycyhcbiAgICAgICAgICAgICAgICBkaXIua2V5LFxuICAgICAgICAgICAgICAgIGRpci5maWx0ZXJzXG4gICAgICAgICAgICApXG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuICcoJyArIGtleSArICcpJ1xufVxuXG5leHBvcnRzLnBhcnNlICAgICAgICAgPSBwYXJzZVxuZXhwb3J0cy5wYXJzZUF0dHIgICAgID0gcGFyc2VBdHRyXG5leHBvcnRzLnNldERlbGltaXRlcnMgPSBzZXREZWxpbWl0ZXJzXG5leHBvcnRzLmRlbGltaXRlcnMgICAgPSBbb3BlbkNoYXIsIGVuZENoYXJdIiwiLyoqXG4gKiB1dGlsc1xuICpcbiAqIEBhdXRob3I6IHh1ZWppYS5jeGovNjE3NFxuICovXG5cbnZhciB3aW4gPSB0eXBlb2Ygd2luZG93ICE9PSBcInVuZGVmaW5lZFwiID8gIHdpbmRvdyA6IHtcbiAgICAgICAgc2V0VGltZW91dDogc2V0VGltZW91dFxuICAgIH07XG5cbnZhciBjb25maWcgICAgICAgPSByZXF1aXJlKCcuL2NvbmZpZycpLFxuICAgIGNsYXNzMnR5cGUgICA9IHt9LFxuICAgIHJ3b3JkICAgICAgICA9IC9bXiwgXSsvZyxcbiAgICBCUkFDS0VUX1JFX1MgPSAvXFxbJyhbXiddKyknXFxdL2csXG4gICAgQlJBQ0tFVF9SRV9EID0gL1xcW1wiKFteXCJdKylcIlxcXS9nO1xuICAgIGlzU3RyaW5nICAgICA9IGlzVHlwZSgnU3RyaW5nJyksXG4gICAgaXNGdW5jdGlvbiAgID0gaXNUeXBlKCdGdW5jdGlvbicpLFxuICAgIGlzVW5kZWZpbmVkICA9IGlzVHlwZSgnVW5kZWZpbmVkJyksXG4gICAgaXNPYmplY3QgICAgID0gaXNUeXBlKCdPYmplY3QnKSxcbiAgICBpc0FycmF5ICAgICAgPSBBcnJheS5pc0FycmF5IHx8IGlzVHlwZSgnQXJyYXknKSxcbiAgICBoYXNPd24gICAgICAgPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LFxuICAgIHNlcmlhbGl6ZSAgICA9IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcsXG4gICAgZGVmICAgICAgICAgID0gT2JqZWN0LmRlZmluZVByb3BlcnR5LFxuICAgIGRlZmVyICAgICAgICA9IHdpbi5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUgfHwgd2luLndlYmtpdFJlcXVlc3RBbmltYXRpb25GcmFtZSB8fCB3aW4uc2V0VGltZW91dCxcblwiQm9vbGVhbiBOdW1iZXIgU3RyaW5nIEZ1bmN0aW9uIEFycmF5IERhdGUgUmVnRXhwIE9iamVjdCBFcnJvclwiLnJlcGxhY2UocndvcmQsIGZ1bmN0aW9uKG5hbWUpIHtcbiAgICBjbGFzczJ0eXBlW1wiW29iamVjdCBcIiArIG5hbWUgKyBcIl1cIl0gPSBuYW1lLnRvTG93ZXJDYXNlKClcbn0pO1xuLyoqXG4gKiBPYmplY3QgdXRpbHNcbiAqL1xudmFyIG9iamVjdCA9IHtcbiAgICBiYXNlS2V5OiBmdW5jdGlvbihuYW1lc3BhY2UpIHtcbiAgICAgICAgcmV0dXJuIGtleS5pbmRleE9mKCcuJykgPiAwID8ga2V5LnNwbGl0KCcuJylbMF0gOiBrZXk7XG4gICAgfSxcbiAgICBoYXNoOiBmdW5jdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIE9iamVjdC5jcmVhdGUobnVsbClcbiAgICB9LFxuICAgIGJpbmQ6IGZ1bmN0aW9uKGZuLCBjdHgpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKGFyZykge1xuICAgICAgICAgICAgcmV0dXJuIGZuLmNhbGwoY3R4LCBhcmcpXG4gICAgICAgIH1cbiAgICB9LFxuICAgIGhhczogZnVuY3Rpb24ob2JqLCBrZXkpIHtcbiAgICAgICAgcmV0dXJuIGhhc093bi5jYWxsKG9iaiwga2V5KTtcbiAgICB9LFxuICAgIGdldDogZnVuY3Rpb24ob2JqLCBrZXkpIHtcbiAgICAgICAga2V5ID0gbm9ybWFsaXplS2V5cGF0aChrZXkpXG4gICAgICAgIGlmIChrZXkuaW5kZXhPZignLicpIDwgMCkge1xuICAgICAgICAgICAgcmV0dXJuIG9ialtrZXldXG4gICAgICAgIH1cbiAgICAgICAgdmFyIHBhdGggPSBrZXkuc3BsaXQoJy4nKSxcbiAgICAgICAgICAgIGQgPSAtMSxcbiAgICAgICAgICAgIGwgPSBwYXRoLmxlbmd0aFxuICAgICAgICB3aGlsZSAoKytkIDwgbCAmJiBvYmogIT0gbnVsbCkge1xuICAgICAgICAgICAgb2JqID0gb2JqW3BhdGhbZF1dXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG9ialxuICAgIH0sXG4gICAgc2V0OiBmdW5jdGlvbihvYmosIGtleSwgdmFsKSB7XG4gICAgICAgIGtleSA9IG5vcm1hbGl6ZUtleXBhdGgoa2V5KVxuICAgICAgICBpZiAoa2V5LmluZGV4T2YoJy4nKSA8IDApIHtcbiAgICAgICAgICAgIG9ialtrZXldID0gdmFsXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuICAgICAgICB2YXIgcGF0aCA9IGtleS5zcGxpdCgnLicpLFxuICAgICAgICAgICAgZCA9IC0xLFxuICAgICAgICAgICAgbCA9IHBhdGgubGVuZ3RoIC0gMVxuICAgICAgICB3aGlsZSAoKytkIDwgbCkge1xuICAgICAgICAgICAgaWYgKG9ialtwYXRoW2RdXSA9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgb2JqW3BhdGhbZF1dID0ge31cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG9iaiA9IG9ialtwYXRoW2RdXVxuICAgICAgICB9XG4gICAgICAgIG9ialtwYXRoW2RdXSA9IHZhbFxuICAgIH0sXG4gICAga2V5czogZnVuY3Rpb24gKG9iaikge1xuICAgICAgICB2YXIgX2tleXMgPSBPYmplY3Qua2V5cyxcbiAgICAgICAgICAgIHJldCA9IFtdO1xuXG4gICAgICAgIGlmIChpc09iamVjdChvYmopKSB7XG4gICAgICAgICAgICBpZiAoX2tleXMpIHtcbiAgICAgICAgICAgICAgICByZXQgPSBfa2V5cyhvYmopO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBrIGluIG9iaikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoaGFzT3duLmNhbGwob2JqLGspKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXQucHVzaChrKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH0sXG4gICAgdG9BcnJheTogZnVuY3Rpb24ob2JqZWN0KXtcbiAgICAgICAgdmFyIHJlcyA9IFtdLCB2YWwsIGRhdGFcbiAgICAgICAgZm9yICh2YXIga2V5IGluIG9iaikge1xuICAgICAgICAgICAgdmFsID0gb2JqW2tleV1cbiAgICAgICAgICAgIGRhdGEgPSBpc09iamVjdCh2YWwpXG4gICAgICAgICAgICAgICAgPyB2YWxcbiAgICAgICAgICAgICAgICA6IHsgJHZhbHVlOiB2YWwgfVxuICAgICAgICAgICAgZGF0YS4ka2V5ID0ga2V5XG4gICAgICAgICAgICByZXMucHVzaChkYXRhKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXM7XG4gICAgfSxcbiAgICAvKipcbiAgICAgKiAgRGVmaW5lIGFuIGllbnVtZXJhYmxlIHByb3BlcnR5XG4gICAgICogIFRoaXMgYXZvaWRzIGl0IGJlaW5nIGluY2x1ZGVkIGluIEpTT04uc3RyaW5naWZ5XG4gICAgICogIG9yIGZvci4uLmluIGxvb3BzLlxuICAgICAqL1xuICAgIGRlZlByb3RlY3RlZDogZnVuY3Rpb24gKG9iaiwga2V5LCB2YWwsIGVudW1lcmFibGUsIHdyaXRhYmxlKSB7XG4gICAgICAgIGRlZihvYmosIGtleSwge1xuICAgICAgICAgICAgdmFsdWUgICAgICAgIDogdmFsLFxuICAgICAgICAgICAgZW51bWVyYWJsZSAgIDogZW51bWVyYWJsZSxcbiAgICAgICAgICAgIHdyaXRhYmxlICAgICA6IHdyaXRhYmxlLFxuICAgICAgICAgICAgY29uZmlndXJhYmxlIDogdHJ1ZVxuICAgICAgICB9KVxuICAgIH0sXG4gICAgLyoqXG4gICAgICog57un5om/XG4gICAgICogQHBhcmFtIHtPYmplY3R9IHByb3RvUHJvcHMg6ZyA6KaB57un5om/55qE5Y6f5Z6LXG4gICAgICogQHBhcmFtIHtPYmplY3R9IHN0YXRpY1Byb3BzIOmdmeaAgeeahOexu+aWueazlVxuICAgICAqL1xuICAgIGV4dGVuZDogZnVuY3Rpb24ocHJvdG9Qcm9wcywgc3RhdGljUHJvcHMpIHtcbiAgICAgICAgdmFyIHBhcmVudCA9IHRoaXM7XG4gICAgICAgIHZhciBjaGlsZDtcbiAgICAgICAgaWYgKHByb3RvUHJvcHMgJiYgaGFzKHByb3RvUHJvcHMsICdjb25zdHJ1Y3RvcicpKSB7XG4gICAgICAgICAgICBjaGlsZCA9IHByb3RvUHJvcHMuY29uc3RydWN0b3I7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjaGlsZCA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBwYXJlbnQuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBtaXgoY2hpbGQsIHBhcmVudCk7XG4gICAgICAgIG1peChjaGlsZCwgc3RhdGljUHJvcHMpO1xuICAgICAgICB2YXIgU3Vycm9nYXRlID0gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB0aGlzLmNvbnN0cnVjdG9yID0gY2hpbGQ7XG4gICAgICAgIH07XG4gICAgICAgIFN1cnJvZ2F0ZS5wcm90b3R5cGUgPSBwYXJlbnQucHJvdG90eXBlO1xuICAgICAgICBjaGlsZC5wcm90b3R5cGUgPSBuZXcgU3Vycm9nYXRlO1xuICAgICAgICBpZiAocHJvdG9Qcm9wcykge1xuICAgICAgICAgICAgbWl4KGNoaWxkLnByb3RvdHlwZSwgcHJvdG9Qcm9wcyk7XG4gICAgICAgIH1cbiAgICAgICAgY2hpbGQuX19zdXBlcl9fID0gcGFyZW50LnByb3RvdHlwZTtcbiAgICAgICAgcmV0dXJuIGNoaWxkO1xuICAgIH1cbn07XG4vKipcbiAqIGFycmF5IHV0aWxzXG4gKi9cbnZhciBhcnJheSA9IHtcbiAgICBpbmRleE9mOiBmdW5jdGlvbihlbGVtZW50LCBhcnIpIHtcbiAgICAgICAgaWYgKCFpc0FycmF5KGFycikpIHtcbiAgICAgICAgICAgIHJldHVybiAtMTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYXJyLmluZGV4T2YoZWxlbWVudCk7XG4gICAgfSxcbiAgICB1bmlxdWU6IGZ1bmN0aW9uIChhcnIpIHtcbiAgICAgICAgdmFyIGhhc2ggPSB7fSxcbiAgICAgICAgICAgIGkgPSBhcnIubGVuZ3RoLFxuICAgICAgICAgICAga2V5LCByZXMgPSBbXVxuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBrZXkgPSBhcnJbaV1cbiAgICAgICAgICAgIGlmIChoYXNoW2tleV0pIGNvbnRpbnVlO1xuICAgICAgICAgICAgaGFzaFtrZXldID0gMVxuICAgICAgICAgICAgcmVzLnB1c2goa2V5KVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXM7XG4gICAgfVxufTtcbi8qKiBcbiAqIGRvbSB1dGlsc1xuICovXG52YXIgZG9tID0ge1xuICAgIGF0dHI6IGZ1bmN0aW9uKGVsLCB0eXBlKSB7XG4gICAgICAgIHZhciBhdHRyID0gY29uZmlnLnByZWZpeCArICctJyArIHR5cGUsXG4gICAgICAgICAgICB2YWwgPSBlbC5nZXRBdHRyaWJ1dGUoYXR0cilcbiAgICAgICAgaWYgKHZhbCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgZWwucmVtb3ZlQXR0cmlidXRlKGF0dHIpXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbFxuICAgIH0sXG4gICAgcXVlcnk6IGZ1bmN0aW9uIChlbCkge1xuICAgICAgICByZXR1cm4gdHlwZW9mIGVsID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgPyBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKGVsKVxuICAgICAgICAgICAgOiBlbDtcbiAgICB9XG59O1xuXG4gLyoqXG4gKiAgTWFrZSBzdXJlIG51bGwgYW5kIHVuZGVmaW5lZCBvdXRwdXQgZW1wdHkgc3RyaW5nXG4gKi9cbmZ1bmN0aW9uIGd1YXJkKHZhbHVlKSB7XG4gICAgLyoganNoaW50IGVxZXFlcTogZmFsc2UsIGVxbnVsbDogdHJ1ZSAqL1xuICAgIHJldHVybiB2YWx1ZSA9PSBudWxsXG4gICAgICAgID8gJydcbiAgICAgICAgOiAodHlwZW9mIHZhbHVlID09ICdvYmplY3QnKVxuICAgICAgICAgICAgPyBKU09OLnN0cmluZ2lmeSh2YWx1ZSlcbiAgICAgICAgICAgIDogdmFsdWU7XG59XG5cbi8qKlxuICog566A5Y2V5Zyw5a+56LGh5ZCI5bm2XG4gKiBAcGFyYW0gIG9iamVjdCByIOa6kOWvueixoVxuICogQHBhcmFtICBvYmplY3QgcyDnm67moIflr7nosaFcbiAqIEBwYXJhbSAgYm9vbCAgIG8g5piv5ZCm6YeN5YaZ77yI6buY6K6k5Li6ZmFsc2XvvIlcbiAqIEBwYXJhbSAgYm9vbCAgIGQg5piv5ZCm6YCS5b2S77yI6buY6K6k5Li6ZmFsc2XvvIlcbiAqIEByZXR1cm4gb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIG1peChyLCBzLCBvLCBkKSB7XG4gICAgZm9yICh2YXIgayBpbiBzKSB7XG4gICAgICAgIGlmIChoYXNPd24uY2FsbChzLCBrKSkge1xuICAgICAgICAgICAgaWYgKCEoayBpbiByKSkge1xuICAgICAgICAgICAgICAgIHJba10gPSBzW2tdO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGQgJiYgaXNPYmplY3QocltrXSkgJiYgaXNPYmplY3Qoc1trXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgbWl4KHJba10sIHNba10sIG8sIGQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJba10gPSBzW2tdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcjtcbn1cbi8qKlxuICogIE5vcm1hbGl6ZSBrZXlwYXRoIHdpdGggcG9zc2libGUgYnJhY2tldHMgaW50byBkb3Qgbm90YXRpb25zXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZUtleXBhdGgoa2V5KSB7XG4gICAgcmV0dXJuIGtleS5pbmRleE9mKCdbJykgPCAwID8ga2V5IDoga2V5LnJlcGxhY2UoQlJBQ0tFVF9SRV9TLCAnLiQxJykucmVwbGFjZShCUkFDS0VUX1JFX0QsICcuJDEnKVxufVxuXG5mdW5jdGlvbiBnZXRUeXBlKG9iaikge1xuICAgIGlmIChvYmogPT0gbnVsbCkge1xuICAgICAgICByZXR1cm4gU3RyaW5nKG9iaik7XG4gICAgfVxuICAgIHJldHVybiB0eXBlb2Ygb2JqID09PSBcIm9iamVjdFwiIHx8IHR5cGVvZiBvYmogPT09IFwiZnVuY3Rpb25cIiA/IGNsYXNzMnR5cGVbc2VyaWFsaXplLmNhbGwob2JqKV0gfHwgXCJvYmplY3RcIiA6IHR5cGVvZiBvYmo7XG59XG5cbmZ1bmN0aW9uIGlzVHlwZSh0eXBlKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKG9iaikge1xuICAgICAgICByZXR1cm4ge30udG9TdHJpbmcuY2FsbChvYmopID09PSAnW29iamVjdCAnICsgdHlwZSArICddJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGlzRXF1YWwodjEsIHYyKSB7XG4gICAgaWYgKHYxID09PSAwICYmIHYyID09PSAwKSB7XG4gICAgICAgIHJldHVybiAxIC8gdjEgPT09IDEgLyB2MlxuICAgIH0gZWxzZSBpZiAodjEgIT09IHYxKSB7XG4gICAgICAgIHJldHVybiB2MiAhPT0gdjJcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gdjEgPT09IHYyXG4gICAgfVxufVxuXG5mdW5jdGlvbiBndWlkKHByZWZpeCkge1xuICAgIHByZWZpeCA9IHByZWZpeCB8fCAnJztcbiAgICByZXR1cm4gTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDIsIDE1KSArIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZygyLCAxNSlcbn1cblxuZnVuY3Rpb24gbmV4dFRpY2soY2IpIHtcbiAgICBkZWZlcihjYiwgMClcbn1cblxuZnVuY3Rpb24gbWVyZ2UoYXJncykge1xuICAgIHZhciByZXQgPSB7fSxcbiAgICAgICAgaSwgbDtcbiAgICBpZiAoIWlzQXJyYXkoYXJncykpIHtcbiAgICAgICAgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICB9XG4gICAgZm9yIChpID0gMCwgbCA9IGFyZ3MubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIG1peChyZXQsIGFyZ3NbaV0sIHRydWUpO1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBlYWNoKG9iaiwgZm4pIHtcbiAgICB2YXIgaSwgbCwga3M7XG4gICAgaWYgKGlzQXJyYXkob2JqKSkge1xuICAgICAgICBmb3IgKGkgPSAwLCBsID0gb2JqLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgaWYgKGZuKG9ialtpXSwgaSwgb2JqKSA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGtzID0ga2V5cyhvYmopO1xuICAgICAgICBmb3IgKGkgPSAwLCBsID0ga3MubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBpZiAoZm4ob2JqW2tzW2ldXSwga3NbaV0sIG9iaikgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGxvZyhtc2cpIHtcbiAgICBpZiAoY29uZmlnLmRlYnVnICYmIGNvbnNvbGUpIHtcbiAgICAgICAgY29uc29sZS5sb2cobXNnKVxuICAgIH1cbn1cblxuZnVuY3Rpb24gd2Fybihtc2cpIHtcbiAgICBpZiAoIWNvbmZpZy5zaWxlbnQgJiYgY29uc29sZSkge1xuICAgICAgICBjb25zb2xlLndhcm4obXNnKTtcbiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZyAmJiBjb25zb2xlLnRyYWNlKSB7XG4gICAgICAgICAgICBjb25zb2xlLnRyYWNlKCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBvYmplY3Q6IG9iamVjdCxcbiAgICBhcnJheTogYXJyYXksXG4gICAgZG9tOiBkb20sXG4gICAgZ2V0VHlwZTogZ2V0VHlwZSxcbiAgICBpc0FycmF5OiBpc0FycmF5LFxuICAgIGlzT2JqZWN0OiBpc09iamVjdCxcbiAgICBpc1N0cmluZzogaXNTdHJpbmcsXG4gICAgaGFzaDogb2JqZWN0Lmhhc2gsXG4gICAgaXNGdW5jdGlvbjogaXNGdW5jdGlvbixcbiAgICBpc0VxdWFsOiBpc0VxdWFsLFxuICAgIG1peDogbWl4LFxuICAgIG1lcmdlOiBtZXJnZSxcbiAgICBndWlkOiBndWlkLFxuICAgIGhhc093bjogaGFzT3duLFxuICAgIHNlcmlhbGl6ZTogc2VyaWFsaXplLFxuICAgIGVhY2g6IGVhY2gsXG4gICAgbG9nOiBsb2csXG4gICAgd2Fybjogd2FybixcbiAgICBuZXh0VGljazogbmV4dFRpY2ssXG4gICAgZ3VhcmQ6IGd1YXJkXG59IiwidmFyIHV0aWxzICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuXHRCYXRjaGVyICA9IHJlcXVpcmUoJy4vYmF0Y2hlcicpLFxuXHRDb21waWxlciA9IHJlcXVpcmUoJy4vY29tcGlsZXInKSxcblx0d2F0Y2hlckJhdGNoZXIgPSBuZXcgQmF0Y2hlcigpO1xuLyoqXG4gKiBWaWV3TW9kZWxcbiAqIEBwYXJhbSB7U3RyaW5nfSBvcHRpb25zLmVsOiBpZFxuICovXG5mdW5jdGlvbiBWTShvcHRpb25zKXtcblx0aWYoIW9wdGlvbnMpe3JldHVybjt9XG5cdHRoaXMuJGluaXQob3B0aW9ucyk7XG59XG5cbnV0aWxzLm1peChWTS5wcm90b3R5cGUsIHtcblx0JyRpbml0JzogZnVuY3Rpb24gaW5pdChvcHRpb25zKXtcblx0XHRuZXcgQ29tcGlsZXIodGhpcywgb3B0aW9ucyk7XG5cdH0sXG5cdCckZGVzdHJveSc6IGZ1bmN0aW9uIGRlc3Ryb3kobm9SZW1vdmUpe1xuXHRcdHRoaXMuJGNvbXBpbGVyLmRlc3Ryb3kobm9SZW1vdmUpO1xuXHR9LFxuXHQnJGdldCc6IGZ1bmN0aW9uIGdldChrZXkpe1xuXHRcdHZhciB2YWwgPSB1dGlscy5vYmplY3QuZ2V0KHRoaXMsIGtleSk7XG5cdFx0cmV0dXJuIHZhbCA9PT0gdW5kZWZpbmVkICYmIHRoaXMuJHBhcmVudFxuXHRcdCAgICAgICAgPyB0aGlzLiRwYXJlbnQuJGdldChrZXkpXG5cdFx0ICAgICAgICA6IHZhbDtcblx0fSxcblx0JyRzZXQnOiBmdW5jdGlvbiBzZXQoa2V5LCB2YWx1ZSl7XG5cdFx0dXRpbHMub2JqZWN0LnNldCh0aGlzLCBrZXksIHZhbHVlKTtcblx0fSxcblx0JyR3YXRjaCc6IGZ1bmN0aW9uIHdhdGNoKGtleSwgY2FsbGJhY2spIHtcblx0XHR2YXIgaWQgPSB1dGlscy5ndWlkKCd3YXRjaGVyaWQtJyksIFxuXHRcdFx0c2VsZiA9IHRoaXM7XG5cdFx0ZnVuY3Rpb24gZXZlbnRSZXNvbHZlcigpe1xuXHRcdFx0dmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG5cdFx0XHR3YXRjaGVyQmF0Y2hlci5wdXNoKHtcblx0XHRcdFx0aWQ6IGlkLFxuXHRcdFx0XHRvdmVycmlkZTogdHJ1ZSxcblx0XHRcdFx0ZXhlY3V0ZTogZnVuY3Rpb24oKXtcblx0XHRcdFx0XHRjYWxsYmFjay5hcHBseShzZWxmLCBhcmdzKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdGNhbGxiYWNrLl9mbiA9IGV2ZW50UmVzb2x2ZXI7XG5cdFx0dGhpcy4kY29tcGlsZXIub2JzZXJ2ZXIub24oJ2NoYW5nZTonICsga2V5LCBldmVudFJlc29sdmVyKTtcblx0fSxcblx0JyR1bndhdGNoJzogZnVuY3Rpb24gdW53YXRjaChrZXksIGNhbGxiYWNrKSB7XG5cdFx0dmFyIGFyZ3MgPSBbJ2NoYW5nZTonICsga2V5XTtcblx0XHR0aGlzLiRjb21waWxlci5vYnNlcnZlci5kZXRhY2goa2V5LCBjYWxsYmFjay5fZm4pO1xuXHR9LFxuXHQnJGJyb2FkY2FzdCc6IGZ1bmN0aW9uIGJyb2FkY2FzdCgpe1xuXHRcdHZhciBjaGlsZHJlbiA9IHRoaXMuJGNvbXBpbGVyLmNoaWxkcmVuO1xuXHRcdGZvcih2YXIgbGVuID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTsgbGVuLS07KXtcblx0XHRcdGNoaWxkID0gY2hpbGRyZW5bbGVuXTtcblx0XHRcdGNoaWxkLmVtaXR0ZXIuZW1pdC5hcHBseShjaGlsZC5lbWl0dGVyLCBhcmd1bWVudHMpO1xuXHRcdFx0Y2hpbGQudm0uJGJyb2FkY2FzdC5hcHBseShjaGlsZC52bSwgYXJndW1lbnRzKTtcblx0XHR9XG5cdH0sXG5cdCckZGlzcGF0Y2gnOiBmdW5jdGlvbiBkaXNwYXRjaCgpe1xuXHRcdHZhciBjb21waWxlciA9IHRoaXMuJGNvbXBpbGVyLFxuXHRcdFx0ZW1pdHRlciAgPSBjb21waWxlci5lbWl0dGVyLFxuXHRcdFx0cGFyZW50ICAgPSBjb21waWxlci5wYXJlbnQ7XG5cdFx0ZW1pdHRlci5lbWl0LmFwcGx5KGVtaXR0ZXIsIGFyZ3VtZW50cyk7XG5cdFx0aWYocGFyZW50KXtcblx0XHRcdHBhcmVudC52bS4kZGlzcGF0Y2guYXBwbHkocGFyZW50LnZtLCBhcmd1bWVudHMpO1xuXHRcdH1cblx0fSxcblx0JyRhcHBlbmRUbyc6IGZ1bmN0aW9uIGFwcGVuZFRvKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWxzLmRvbS5xdWVyeSh0YXJnZXQpO1xuXHRcdHZhciBlbCA9IHRoaXMuJGVsO1xuXHRcdHRhcmdldC5hcHBlbmRDaGlsZChlbClcbiAgICAgICAgY2IgJiYgdXRpbHMubmV4dFRpY2soY2IpO1xuXHR9LFxuXHQnJHJlbW92ZSc6IGZ1bmN0aW9uIHJlbW92ZSh0YXJnZXQsIGNiKXtcblx0XHR0YXJnZXQgPSB1dGlscy5kb20ucXVlcnkodGFyZ2V0KTtcblx0XHR2YXIgZWwgPSB0aGlzLiRlbDtcblx0XHRpZihlbC5wYXJlbnROb2RlKXtcblx0XHRcdGVsLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQoZWwpO1xuXHRcdH1cblx0XHRjYiAmJiB1dGlscy5uZXh0VGljayhjYik7XG5cdH0sXG5cdCckYmVmb3JlJzogZnVuY3Rpb24gYmVmb3JlKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWxzLmRvbS5xdWVyeSh0YXJnZXQpO1xuXHRcdHZhciBlbCA9IHRoaXMuJGVsO1xuXHRcdHRhcmdldC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShlbCwgdGFyZ2V0KTtcblx0XHRjYiAmJiB1dGlscy5uZXh0VGljayhjYik7XG5cdH0sXG5cdCckYWZ0ZXInOiBmdW5jdGlvbiBhZnRlcih0YXJnZXQsIGNiKXtcblx0XHR0YXJnZXQgPSB1dGlsLmRvbS5xdWVyeSh0YXJnZXQpO1xuXHRcdHZhciBlbCA9IHRoaXMuJGVsO1xuXHRcdGlmKHRhcmdldC5uZXh0U2libGluZykge1xuXHRcdFx0dGFyZ2V0LnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKGVsLCB0YXJnZXQubmV4dFNpYmxpbmcpO1xuXHRcdH1lbHNle1xuXHRcdFx0dGFyZ2V0LnBhcmVudE5vZGUuYXBwZW5kQ2hpbGQoZWwpO1xuXHRcdH1cblx0XHRjYiAmJiB1dGlscy5uZXh0VGljayhjYik7XG5cdH1cbn0pO1xuLyoqXG4gKiAgZGVsZWdhdGUgb24vb2ZmL29uY2UgdG8gdGhlIGNvbXBpbGVyJ3MgZW1pdHRlclxuICovXG51dGlscy5lYWNoKFsnZW1pdCcsICdvbicsICdvZmYnLCAnb25jZScsICdkZXRhY2gnLCAnZmlyZSddLCBmdW5jdGlvbiAobWV0aG9kKSB7XG5cdFZNLnByb3RvdHlwZVsnJCcgKyBtZXRob2RdID0gZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZW1pdHRlciA9IHRoaXMuJGNvbXBpbGVyLmVtaXR0ZXI7XG4gICAgICAgIGVtaXR0ZXJbbWV0aG9kXS5hcHBseShlbWl0dGVyLCBhcmd1bWVudHMpO1xuICAgIH1cbn0pO1xuVk0uZXh0ZW5kID0gdXRpbHMub2JqZWN0LmV4dGVuZDtcbm1vZHVsZS5leHBvcnRzID0gVk07XG4iXX0=
