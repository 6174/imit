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
		utils.log('  created binding: ' + key);
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

},{"./batcher":3,"./compiler":5,"./utils":26}]},{},[20])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9ub2RlX21vZHVsZXMvZ3VscC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL0RlcHNQYXJzZXIuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL0V4cFBhcnNlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvYmF0Y2hlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvYmluZGluZy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvY29tcGlsZXIuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2NvbmZpZy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZGVmZXJyZWQuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2RpcmVjdGl2ZS5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZGlyZWN0aXZlcy9odG1sLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL2lmLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL2luZGV4LmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL21vZGVsLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL29uLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL3BhcnRpYWwuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2RpcmVjdGl2ZXMvcmVwZWF0LmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL3N0eWxlLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9kaXJlY3RpdmVzL3ZpZXcuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2RpcmVjdGl2ZXMvd2l0aC5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZXZlbnRUYXJnZXQuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2Zha2VfNWY0MjQyY2UuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2ZpbHRlcnMuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2ZyYWdtZW50LmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9vYnNlcnZlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvcGFyc2VyLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy90ZXh0UGFyc2VyLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy91dGlscy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvdmlld21vZGVsLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzMvQkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pRQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5SEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4WEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9GQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hVQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwidmFyIEV2ZW50VGFyZ2V0ICA9IHJlcXVpcmUoJy4vZXZlbnRUYXJnZXQnKSxcbiAgICB1dGlscyAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBPYnNlcnZlciA9IHJlcXVpcmUoJy4vb2JzZXJ2ZXInKSxcbiAgICBjYXRjaGVyICA9IG5ldyBFdmVudFRhcmdldCgpO1xuXG4vKipcbiAqICBBdXRvLWV4dHJhY3QgdGhlIGRlcGVuZGVuY2llcyBvZiBhIGNvbXB1dGVkIHByb3BlcnR5XG4gKiAgYnkgcmVjb3JkaW5nIHRoZSBnZXR0ZXJzIHRyaWdnZXJlZCB3aGVuIGV2YWx1YXRpbmcgaXQuXG4gKi9cbmZ1bmN0aW9uIGNhdGNoRGVwcyAoYmluZGluZykge1xuICAgIGlmIChiaW5kaW5nLmlzRm4pIHJldHVyblxuICAgIHV0aWxzLmxvZygnXFxuLSAnICsgYmluZGluZy5rZXkpXG4gICAgdmFyIGdvdCA9IHV0aWxzLmhhc2goKVxuICAgIGJpbmRpbmcuZGVwcyA9IFtdXG4gICAgY2F0Y2hlci5vbignZ2V0JywgZnVuY3Rpb24gKGRlcCkge1xuICAgICAgICB2YXIgaGFzID0gZ290W2RlcC5rZXldXG4gICAgICAgIGlmIChcbiAgICAgICAgICAgIC8vIGF2b2lkIGR1cGxpY2F0ZSBiaW5kaW5nc1xuICAgICAgICAgICAgKGhhcyAmJiBoYXMuY29tcGlsZXIgPT09IGRlcC5jb21waWxlcikgfHxcbiAgICAgICAgICAgIC8vIGF2b2lkIHJlcGVhdGVkIGl0ZW1zIGFzIGRlcGVuZGVuY3lcbiAgICAgICAgICAgIC8vIG9ubHkgd2hlbiB0aGUgYmluZGluZyBpcyBmcm9tIHNlbGYgb3IgdGhlIHBhcmVudCBjaGFpblxuICAgICAgICAgICAgKGRlcC5jb21waWxlci5yZXBlYXQgJiYgIWlzUGFyZW50T2YoZGVwLmNvbXBpbGVyLCBiaW5kaW5nLmNvbXBpbGVyKSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuICAgICAgICBnb3RbZGVwLmtleV0gPSBkZXBcbiAgICAgICAgdXRpbHMubG9nKCcgIC0gJyArIGRlcC5rZXkpXG4gICAgICAgIGJpbmRpbmcuZGVwcy5wdXNoKGRlcClcbiAgICAgICAgZGVwLnN1YnMucHVzaChiaW5kaW5nKVxuICAgIH0pXG4gICAgYmluZGluZy52YWx1ZS4kZ2V0KClcbiAgICBjYXRjaGVyLm9mZignZ2V0Jylcbn1cblxuLyoqXG4gKiAgVGVzdCBpZiBBIGlzIGEgcGFyZW50IG9mIG9yIGVxdWFscyBCXG4gKi9cbmZ1bmN0aW9uIGlzUGFyZW50T2YgKGEsIGIpIHtcbiAgICB3aGlsZSAoYikge1xuICAgICAgICBpZiAoYSA9PT0gYikge1xuICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgfVxuICAgICAgICBiID0gYi5wYXJlbnRcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgLyoqXG4gICAgICogIHRoZSBvYnNlcnZlciB0aGF0IGNhdGNoZXMgZXZlbnRzIHRyaWdnZXJlZCBieSBnZXR0ZXJzXG4gICAgICovXG4gICAgY2F0Y2hlcjogY2F0Y2hlcixcblxuICAgIC8qKlxuICAgICAqICBwYXJzZSBhIGxpc3Qgb2YgY29tcHV0ZWQgcHJvcGVydHkgYmluZGluZ3NcbiAgICAgKi9cbiAgICBwYXJzZTogZnVuY3Rpb24gKGJpbmRpbmdzKSB7XG4gICAgICAgIHV0aWxzLmxvZygnXFxucGFyc2luZyBkZXBlbmRlbmNpZXMuLi4nKVxuICAgICAgICBPYnNlcnZlci5zaG91bGRHZXQgPSB0cnVlXG4gICAgICAgIGJpbmRpbmdzLmZvckVhY2goY2F0Y2hEZXBzKVxuICAgICAgICBPYnNlcnZlci5zaG91bGRHZXQgPSBmYWxzZVxuICAgICAgICB1dGlscy5sb2coJ1xcbmRvbmUuJylcbiAgICB9XG4gICAgXG59IiwidmFyIHV0aWxzICAgICAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBTVFJfU0FWRV9SRSAgICAgPSAvXCIoPzpbXlwiXFxcXF18XFxcXC4pKlwifCcoPzpbXidcXFxcXXxcXFxcLikqJy9nLFxuICAgIFNUUl9SRVNUT1JFX1JFICA9IC9cIihcXGQrKVwiL2csXG4gICAgTkVXTElORV9SRSAgICAgID0gL1xcbi9nLFxuICAgIENUT1JfUkUgICAgICAgICA9IG5ldyBSZWdFeHAoJ2NvbnN0cnVjdG9yJy5zcGxpdCgnJykuam9pbignW1xcJ1wiKywgXSonKSksXG4gICAgVU5JQ09ERV9SRSAgICAgID0gL1xcXFx1XFxkXFxkXFxkXFxkL1xuXG4vLyBWYXJpYWJsZSBleHRyYWN0aW9uIHNjb29wZWQgZnJvbSBodHRwczovL2dpdGh1Yi5jb20vUnVieUxvdXZyZS9hdmFsb25cblxudmFyIEtFWVdPUkRTID1cbiAgICAgICAgLy8ga2V5d29yZHNcbiAgICAgICAgJ2JyZWFrLGNhc2UsY2F0Y2gsY29udGludWUsZGVidWdnZXIsZGVmYXVsdCxkZWxldGUsZG8sZWxzZSxmYWxzZScgK1xuICAgICAgICAnLGZpbmFsbHksZm9yLGZ1bmN0aW9uLGlmLGluLGluc3RhbmNlb2YsbmV3LG51bGwscmV0dXJuLHN3aXRjaCx0aGlzJyArXG4gICAgICAgICcsdGhyb3csdHJ1ZSx0cnksdHlwZW9mLHZhcix2b2lkLHdoaWxlLHdpdGgsdW5kZWZpbmVkJyArXG4gICAgICAgIC8vIHJlc2VydmVkXG4gICAgICAgICcsYWJzdHJhY3QsYm9vbGVhbixieXRlLGNoYXIsY2xhc3MsY29uc3QsZG91YmxlLGVudW0sZXhwb3J0LGV4dGVuZHMnICtcbiAgICAgICAgJyxmaW5hbCxmbG9hdCxnb3RvLGltcGxlbWVudHMsaW1wb3J0LGludCxpbnRlcmZhY2UsbG9uZyxuYXRpdmUnICtcbiAgICAgICAgJyxwYWNrYWdlLHByaXZhdGUscHJvdGVjdGVkLHB1YmxpYyxzaG9ydCxzdGF0aWMsc3VwZXIsc3luY2hyb25pemVkJyArXG4gICAgICAgICcsdGhyb3dzLHRyYW5zaWVudCx2b2xhdGlsZScgK1xuICAgICAgICAvLyBFQ01BIDUgLSB1c2Ugc3RyaWN0XG4gICAgICAgICcsYXJndW1lbnRzLGxldCx5aWVsZCcgK1xuICAgICAgICAvLyBhbGxvdyB1c2luZyBNYXRoIGluIGV4cHJlc3Npb25zXG4gICAgICAgICcsTWF0aCcsXG4gICAgICAgIFxuICAgIEtFWVdPUkRTX1JFID0gbmV3IFJlZ0V4cChbXCJcXFxcYlwiICsgS0VZV09SRFMucmVwbGFjZSgvLC9nLCAnXFxcXGJ8XFxcXGInKSArIFwiXFxcXGJcIl0uam9pbignfCcpLCAnZycpLFxuICAgIFJFTU9WRV9SRSAgID0gL1xcL1xcKig/Oi58XFxuKSo/XFwqXFwvfFxcL1xcL1teXFxuXSpcXG58XFwvXFwvW15cXG5dKiR8J1teJ10qJ3xcIlteXCJdKlwifFtcXHNcXHRcXG5dKlxcLltcXHNcXHRcXG5dKlskXFx3XFwuXSt8W1xceyxdXFxzKltcXHdcXCRfXStcXHMqOi9nLFxuICAgIFNQTElUX1JFICAgID0gL1teXFx3JF0rL2csXG4gICAgTlVNQkVSX1JFICAgPSAvXFxiXFxkW14sXSovZyxcbiAgICBCT1VOREFSWV9SRSA9IC9eLCt8LCskL2dcblxuLyoqXG4gKiAgU3RyaXAgdG9wIGxldmVsIHZhcmlhYmxlIG5hbWVzIGZyb20gYSBzbmlwcGV0IG9mIEpTIGV4cHJlc3Npb25cbiAqL1xuZnVuY3Rpb24gZ2V0VmFyaWFibGVzIChjb2RlKSB7XG4gICAgY29kZSA9IGNvZGVcbiAgICAgICAgLnJlcGxhY2UoUkVNT1ZFX1JFLCAnJylcbiAgICAgICAgLnJlcGxhY2UoU1BMSVRfUkUsICcsJylcbiAgICAgICAgLnJlcGxhY2UoS0VZV09SRFNfUkUsICcnKVxuICAgICAgICAucmVwbGFjZShOVU1CRVJfUkUsICcnKVxuICAgICAgICAucmVwbGFjZShCT1VOREFSWV9SRSwgJycpXG4gICAgcmV0dXJuIGNvZGVcbiAgICAgICAgPyBjb2RlLnNwbGl0KC8sKy8pXG4gICAgICAgIDogW11cbn1cblxuLyoqXG4gKiAgQSBnaXZlbiBwYXRoIGNvdWxkIHBvdGVudGlhbGx5IGV4aXN0IG5vdCBvbiB0aGVcbiAqICBjdXJyZW50IGNvbXBpbGVyLCBidXQgdXAgaW4gdGhlIHBhcmVudCBjaGFpbiBzb21ld2hlcmUuXG4gKiAgVGhpcyBmdW5jdGlvbiBnZW5lcmF0ZXMgYW4gYWNjZXNzIHJlbGF0aW9uc2hpcCBzdHJpbmdcbiAqICB0aGF0IGNhbiBiZSB1c2VkIGluIHRoZSBnZXR0ZXIgZnVuY3Rpb24gYnkgd2Fsa2luZyB1cFxuICogIHRoZSBwYXJlbnQgY2hhaW4gdG8gY2hlY2sgZm9yIGtleSBleGlzdGVuY2UuXG4gKlxuICogIEl0IHN0b3BzIGF0IHRvcCBwYXJlbnQgaWYgbm8gdm0gaW4gdGhlIGNoYWluIGhhcyB0aGVcbiAqICBrZXkuIEl0IHRoZW4gY3JlYXRlcyBhbnkgbWlzc2luZyBiaW5kaW5ncyBvbiB0aGVcbiAqICBmaW5hbCByZXNvbHZlZCB2bS5cbiAqL1xuZnVuY3Rpb24gdHJhY2VTY29wZSAocGF0aCwgY29tcGlsZXIsIGRhdGEpIHtcbiAgICB2YXIgcmVsICA9ICcnLFxuICAgICAgICBkaXN0ID0gMCxcbiAgICAgICAgc2VsZiA9IGNvbXBpbGVyXG5cbiAgICBpZiAoZGF0YSAmJiB1dGlscy5vYmplY3QuZ2V0KGRhdGEsIHBhdGgpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgLy8gaGFjazogdGVtcG9yYXJpbHkgYXR0YWNoZWQgZGF0YVxuICAgICAgICByZXR1cm4gJyR0ZW1wLidcbiAgICB9XG5cbiAgICB3aGlsZSAoY29tcGlsZXIpIHtcbiAgICAgICAgaWYgKGNvbXBpbGVyLmhhc0tleShwYXRoKSkge1xuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbXBpbGVyID0gY29tcGlsZXIucGFyZW50XG4gICAgICAgICAgICBkaXN0KytcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoY29tcGlsZXIpIHtcbiAgICAgICAgd2hpbGUgKGRpc3QtLSkge1xuICAgICAgICAgICAgcmVsICs9ICckcGFyZW50LidcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWNvbXBpbGVyLmJpbmRpbmdzW3BhdGhdICYmIHBhdGguY2hhckF0KDApICE9PSAnJCcpIHtcbiAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcocGF0aClcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbGYuY3JlYXRlQmluZGluZyhwYXRoKVxuICAgIH1cbiAgICByZXR1cm4gcmVsXG59XG5cbi8qKlxuICogIENyZWF0ZSBhIGZ1bmN0aW9uIGZyb20gYSBzdHJpbmcuLi5cbiAqICB0aGlzIGxvb2tzIGxpa2UgZXZpbCBtYWdpYyBidXQgc2luY2UgYWxsIHZhcmlhYmxlcyBhcmUgbGltaXRlZFxuICogIHRvIHRoZSBWTSdzIGRhdGEgaXQncyBhY3R1YWxseSBwcm9wZXJseSBzYW5kYm94ZWRcbiAqL1xuZnVuY3Rpb24gbWFrZUdldHRlciAoZXhwLCByYXcpIHtcbiAgICB2YXIgZm5cbiAgICB0cnkge1xuICAgICAgICBmbiA9IG5ldyBGdW5jdGlvbihleHApXG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB1dGlscy53YXJuKCdFcnJvciBwYXJzaW5nIGV4cHJlc3Npb246ICcgKyByYXcpXG4gICAgfVxuICAgIHJldHVybiBmblxufVxuXG4vKipcbiAqICBFc2NhcGUgYSBsZWFkaW5nIGRvbGxhciBzaWduIGZvciByZWdleCBjb25zdHJ1Y3Rpb25cbiAqL1xuZnVuY3Rpb24gZXNjYXBlRG9sbGFyICh2KSB7XG4gICAgcmV0dXJuIHYuY2hhckF0KDApID09PSAnJCdcbiAgICAgICAgPyAnXFxcXCcgKyB2XG4gICAgICAgIDogdlxufVxuXG4vKipcbiAqICBQYXJzZSBhbmQgcmV0dXJuIGFuIGFub255bW91cyBjb21wdXRlZCBwcm9wZXJ0eSBnZXR0ZXIgZnVuY3Rpb25cbiAqICBmcm9tIGFuIGFyYml0cmFyeSBleHByZXNzaW9uLCB0b2dldGhlciB3aXRoIGEgbGlzdCBvZiBwYXRocyB0byBiZVxuICogIGNyZWF0ZWQgYXMgYmluZGluZ3MuXG4gKi9cbmV4cG9ydHMucGFyc2UgPSBmdW5jdGlvbiAoZXhwLCBjb21waWxlciwgZGF0YSkge1xuICAgIC8vIHVuaWNvZGUgYW5kICdjb25zdHJ1Y3RvcicgYXJlIG5vdCBhbGxvd2VkIGZvciBYU1Mgc2VjdXJpdHkuXG4gICAgaWYgKFVOSUNPREVfUkUudGVzdChleHApIHx8IENUT1JfUkUudGVzdChleHApKSB7XG4gICAgICAgIHV0aWxzLndhcm4oJ1Vuc2FmZSBleHByZXNzaW9uOiAnICsgZXhwKVxuICAgICAgICByZXR1cm5cbiAgICB9XG4gICAgLy8gZXh0cmFjdCB2YXJpYWJsZSBuYW1lc1xuICAgIHZhciB2YXJzID0gZ2V0VmFyaWFibGVzKGV4cClcbiAgICBpZiAoIXZhcnMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiBtYWtlR2V0dGVyKCdyZXR1cm4gJyArIGV4cCwgZXhwKVxuICAgIH1cbiAgICB2YXJzID0gdXRpbHMuYXJyYXkudW5pcXVlKHZhcnMpO1xuXG4gICAgdmFyIGFjY2Vzc29ycyA9ICcnLFxuICAgICAgICBoYXMgICAgICAgPSB1dGlscy5oYXNoKCksXG4gICAgICAgIHN0cmluZ3MgICA9IFtdLFxuICAgICAgICAvLyBjb25zdHJ1Y3QgYSByZWdleCB0byBleHRyYWN0IGFsbCB2YWxpZCB2YXJpYWJsZSBwYXRoc1xuICAgICAgICAvLyBvbmVzIHRoYXQgYmVnaW4gd2l0aCBcIiRcIiBhcmUgcGFydGljdWxhcmx5IHRyaWNreVxuICAgICAgICAvLyBiZWNhdXNlIHdlIGNhbid0IHVzZSBcXGIgZm9yIHRoZW1cbiAgICAgICAgcGF0aFJFID0gbmV3IFJlZ0V4cChcbiAgICAgICAgICAgIFwiW14kXFxcXHdcXFxcLl0oXCIgK1xuICAgICAgICAgICAgdmFycy5tYXAoZXNjYXBlRG9sbGFyKS5qb2luKCd8JykgK1xuICAgICAgICAgICAgXCIpWyRcXFxcd1xcXFwuXSpcXFxcYlwiLCAnZydcbiAgICAgICAgKSxcbiAgICAgICAgYm9keSA9ICgnICcgKyBleHApXG4gICAgICAgICAgICAucmVwbGFjZShTVFJfU0FWRV9SRSwgc2F2ZVN0cmluZ3MpXG4gICAgICAgICAgICAucmVwbGFjZShwYXRoUkUsIHJlcGxhY2VQYXRoKVxuICAgICAgICAgICAgLnJlcGxhY2UoU1RSX1JFU1RPUkVfUkUsIHJlc3RvcmVTdHJpbmdzKVxuXG4gICAgYm9keSA9IGFjY2Vzc29ycyArICdyZXR1cm4gJyArIGJvZHlcblxuICAgIGZ1bmN0aW9uIHNhdmVTdHJpbmdzIChzdHIpIHtcbiAgICAgICAgdmFyIGkgPSBzdHJpbmdzLmxlbmd0aFxuICAgICAgICAvLyBlc2NhcGUgbmV3bGluZXMgaW4gc3RyaW5ncyBzbyB0aGUgZXhwcmVzc2lvblxuICAgICAgICAvLyBjYW4gYmUgY29ycmVjdGx5IGV2YWx1YXRlZFxuICAgICAgICBzdHJpbmdzW2ldID0gc3RyLnJlcGxhY2UoTkVXTElORV9SRSwgJ1xcXFxuJylcbiAgICAgICAgcmV0dXJuICdcIicgKyBpICsgJ1wiJ1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlcGxhY2VQYXRoIChwYXRoKSB7XG4gICAgICAgIC8vIGtlZXAgdHJhY2sgb2YgdGhlIGZpcnN0IGNoYXJcbiAgICAgICAgdmFyIGMgPSBwYXRoLmNoYXJBdCgwKVxuICAgICAgICBwYXRoID0gcGF0aC5zbGljZSgxKVxuICAgICAgICB2YXIgdmFsID0gJ3RoaXMuJyArIHRyYWNlU2NvcGUocGF0aCwgY29tcGlsZXIsIGRhdGEpICsgcGF0aFxuICAgICAgICBpZiAoIWhhc1twYXRoXSkge1xuICAgICAgICAgICAgYWNjZXNzb3JzICs9IHZhbCArICc7J1xuICAgICAgICAgICAgaGFzW3BhdGhdID0gMVxuICAgICAgICB9XG4gICAgICAgIC8vIGRvbid0IGZvcmdldCB0byBwdXQgdGhhdCBmaXJzdCBjaGFyIGJhY2tcbiAgICAgICAgcmV0dXJuIGMgKyB2YWxcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZXN0b3JlU3RyaW5ncyAoc3RyLCBpKSB7XG4gICAgICAgIHJldHVybiBzdHJpbmdzW2ldXG4gICAgfVxuXG4gICAgcmV0dXJuIG1ha2VHZXR0ZXIoYm9keSwgZXhwKVxufVxuXG4vKipcbiAqICBFdmFsdWF0ZSBhbiBleHByZXNzaW9uIGluIHRoZSBjb250ZXh0IG9mIGEgY29tcGlsZXIuXG4gKiAgQWNjZXB0cyBhZGRpdGlvbmFsIGRhdGEuXG4gKi9cbmV4cG9ydHMuZXZhbCA9IGZ1bmN0aW9uIChleHAsIGNvbXBpbGVyLCBkYXRhKSB7XG4gICAgdmFyIGdldHRlciA9IGV4cG9ydHMucGFyc2UoZXhwLCBjb21waWxlciwgZGF0YSksIHJlc1xuICAgIGlmIChnZXR0ZXIpIHtcbiAgICAgICAgLy8gaGFjazogdGVtcG9yYXJpbHkgYXR0YWNoIHRoZSBhZGRpdGlvbmFsIGRhdGEgc29cbiAgICAgICAgLy8gaXQgY2FuIGJlIGFjY2Vzc2VkIGluIHRoZSBnZXR0ZXJcbiAgICAgICAgY29tcGlsZXIudm0uJHRlbXAgPSBkYXRhXG4gICAgICAgIHJlcyA9IGdldHRlci5jYWxsKGNvbXBpbGVyLnZtKVxuICAgICAgICBkZWxldGUgY29tcGlsZXIudm0uJHRlbXBcbiAgICB9XG4gICAgcmV0dXJuIHJlc1xufSIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKVxuXG5mdW5jdGlvbiBCYXRjaGVyICgpIHtcbiAgICB0aGlzLnJlc2V0KCk7XG59XG5cbnZhciBCYXRjaGVyUHJvdG8gPSBCYXRjaGVyLnByb3RvdHlwZVxuXG5CYXRjaGVyUHJvdG8ucHVzaCA9IGZ1bmN0aW9uIChqb2IpIHtcbiAgICBpZiAoIWpvYi5pZCB8fCAhdGhpcy5oYXNbam9iLmlkXSkge1xuICAgICAgICB0aGlzLnF1ZXVlLnB1c2goam9iKVxuICAgICAgICB0aGlzLmhhc1tqb2IuaWRdID0gam9iXG4gICAgICAgIGlmICghdGhpcy53YWl0aW5nKSB7XG4gICAgICAgICAgICB0aGlzLndhaXRpbmcgPSB0cnVlXG4gICAgICAgICAgICB1dGlscy5uZXh0VGljayh1dGlscy5vYmplY3QuYmluZCh0aGlzLmZsdXNoLCB0aGlzKSlcbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAoam9iLm92ZXJyaWRlKSB7XG4gICAgICAgIHZhciBvbGRKb2IgPSB0aGlzLmhhc1tqb2IuaWRdXG4gICAgICAgIG9sZEpvYi5jYW5jZWxsZWQgPSB0cnVlXG4gICAgICAgIHRoaXMucXVldWUucHVzaChqb2IpXG4gICAgICAgIHRoaXMuaGFzW2pvYi5pZF0gPSBqb2JcbiAgICB9XG59XG5cbkJhdGNoZXJQcm90by5mbHVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICAvLyBiZWZvcmUgZmx1c2ggaG9va1xuICAgIGlmICh0aGlzLl9wcmVGbHVzaCkgdGhpcy5fcHJlRmx1c2goKVxuICAgIC8vIGRvIG5vdCBjYWNoZSBsZW5ndGggYmVjYXVzZSBtb3JlIGpvYnMgbWlnaHQgYmUgcHVzaGVkXG4gICAgLy8gYXMgd2UgZXhlY3V0ZSBleGlzdGluZyBqb2JzXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLnF1ZXVlLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhciBqb2IgPSB0aGlzLnF1ZXVlW2ldXG4gICAgICAgIGlmICgham9iLmNhbmNlbGxlZCkge1xuICAgICAgICAgICAgam9iLmV4ZWN1dGUoKVxuICAgICAgICB9XG4gICAgfVxuICAgIHRoaXMucmVzZXQoKVxufVxuXG5CYXRjaGVyUHJvdG8ucmVzZXQgPSBmdW5jdGlvbiAoKSB7XG4gICAgdGhpcy5oYXMgPSB1dGlscy5vYmplY3QuaGFzaCgpXG4gICAgdGhpcy5xdWV1ZSA9IFtdXG4gICAgdGhpcy53YWl0aW5nID0gZmFsc2Vcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBCYXRjaGVyIiwidmFyIEJhdGNoZXIgICAgICAgID0gcmVxdWlyZSgnLi9iYXRjaGVyJyksXG4gICAgYmluZGluZ0JhdGNoZXIgPSBuZXcgQmF0Y2hlcigpLFxuICAgIGJpbmRpbmdJZCAgICAgID0gMVxuXG4vKipcbiAqICBCSU5ESU5HIENMQVNTLlxuICpcbiAqICBFQUNIIFBST1BFUlRZIE9OIFRIRSBWSUVXTU9ERUwgSEFTIE9ORSBDT1JSRVNQT05ESU5HIEJJTkRJTkcgT0JKRUNUXG4gKiAgV0hJQ0ggSEFTIE1VTFRJUExFIERJUkVDVElWRSBJTlNUQU5DRVMgT04gVEhFIERPTVxuICogIEFORCBNVUxUSVBMRSBDT01QVVRFRCBQUk9QRVJUWSBERVBFTkRFTlRTXG4gKi9cbmZ1bmN0aW9uIEJpbmRpbmcgKGNvbXBpbGVyLCBrZXksIGlzRXhwLCBpc0ZuKSB7XG4gICAgdGhpcy5pZCA9IGJpbmRpbmdJZCsrXG4gICAgdGhpcy52YWx1ZSA9IHVuZGVmaW5lZFxuICAgIHRoaXMuaXNFeHAgPSAhIWlzRXhwXG4gICAgdGhpcy5pc0ZuID0gaXNGblxuICAgIHRoaXMucm9vdCA9ICF0aGlzLmlzRXhwICYmIGtleS5pbmRleE9mKCcuJykgPT09IC0xXG4gICAgdGhpcy5jb21waWxlciA9IGNvbXBpbGVyXG4gICAgdGhpcy5rZXkgPSBrZXlcbiAgICB0aGlzLmRpcnMgPSBbXVxuICAgIHRoaXMuc3VicyA9IFtdXG4gICAgdGhpcy5kZXBzID0gW11cbiAgICB0aGlzLnVuYm91bmQgPSBmYWxzZVxufVxuXG52YXIgQmluZGluZ1Byb3RvID0gQmluZGluZy5wcm90b3R5cGVcblxuLyoqXG4gKiAgVVBEQVRFIFZBTFVFIEFORCBRVUVVRSBJTlNUQU5DRSBVUERBVEVTLlxuICovXG5CaW5kaW5nUHJvdG8udXBkYXRlID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgaWYgKCF0aGlzLmlzQ29tcHV0ZWQgfHwgdGhpcy5pc0ZuKSB7XG4gICAgICAgIHRoaXMudmFsdWUgPSB2YWx1ZVxuICAgIH1cbiAgICBpZiAodGhpcy5kaXJzLmxlbmd0aCB8fCB0aGlzLnN1YnMubGVuZ3RoKSB7XG4gICAgICAgIHZhciBzZWxmID0gdGhpc1xuICAgICAgICBiaW5kaW5nQmF0Y2hlci5wdXNoKHtcbiAgICAgICAgICAgIGlkOiB0aGlzLmlkLFxuICAgICAgICAgICAgZXhlY3V0ZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHNlbGYuX3VwZGF0ZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KVxuICAgIH1cbn1cblxuLyoqXG4gKiAgQUNUVUFMTFkgVVBEQVRFIFRIRSBESVJFQ1RJVkVTLlxuICovXG5CaW5kaW5nUHJvdG8uX3VwZGF0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgaSA9IHRoaXMuZGlycy5sZW5ndGgsXG4gICAgICAgIHZhbHVlID0gdGhpcy52YWwoKVxuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgdGhpcy5kaXJzW2ldLiR1cGRhdGUodmFsdWUpXG4gICAgfVxuICAgIHRoaXMucHViKClcbn1cblxuLyoqXG4gKiAgUkVUVVJOIFRIRSBWQUxVQVRFRCBWQUxVRSBSRUdBUkRMRVNTXG4gKiAgT0YgV0hFVEhFUiBJVCBJUyBDT01QVVRFRCBPUiBOT1RcbiAqL1xuQmluZGluZ1Byb3RvLnZhbCA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5pc0NvbXB1dGVkICYmICF0aGlzLmlzRm5cbiAgICAgICAgPyB0aGlzLnZhbHVlLiRnZXQoKVxuICAgICAgICA6IHRoaXMudmFsdWU7XG59XG5cbi8qKlxuICogIE5vdGlmeSBjb21wdXRlZCBwcm9wZXJ0aWVzIHRoYXQgZGVwZW5kIG9uIHRoaXMgYmluZGluZ1xuICogIHRvIHVwZGF0ZSB0aGVtc2VsdmVzXG4gKi9cbkJpbmRpbmdQcm90by5wdWIgPSBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGkgPSB0aGlzLnN1YnMubGVuZ3RoXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICB0aGlzLnN1YnNbaV0udXBkYXRlKCk7XG4gICAgfVxufVxuXG4vKipcbiAqICBVbmJpbmQgdGhlIGJpbmRpbmcsIHJlbW92ZSBpdHNlbGYgZnJvbSBhbGwgb2YgaXRzIGRlcGVuZGVuY2llc1xuICovXG5CaW5kaW5nUHJvdG8udW5iaW5kID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIEluZGljYXRlIHRoaXMgaGFzIGJlZW4gdW5ib3VuZC5cbiAgICAvLyBJdCdzIHBvc3NpYmxlIHRoaXMgYmluZGluZyB3aWxsIGJlIGluXG4gICAgLy8gdGhlIGJhdGNoZXIncyBmbHVzaCBxdWV1ZSB3aGVuIGl0cyBvd25lclxuICAgIC8vIGNvbXBpbGVyIGhhcyBhbHJlYWR5IGJlZW4gZGVzdHJveWVkLlxuICAgIHRoaXMudW5ib3VuZCA9IHRydWVcbiAgICB2YXIgaSA9IHRoaXMuZGlycy5sZW5ndGhcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIHRoaXMuZGlyc1tpXS4kdW5iaW5kKClcbiAgICB9XG4gICAgaSA9IHRoaXMuZGVwcy5sZW5ndGhcbiAgICB2YXIgc3Vic1xuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgc3VicyA9IHRoaXMuZGVwc1tpXS5zdWJzXG4gICAgICAgIHZhciBqID0gc3Vicy5pbmRleE9mKHRoaXMpXG4gICAgICAgIGlmIChqID4gLTEpIHN1YnMuc3BsaWNlKGosIDEpXG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEJpbmRpbmciLCJcbnZhciBFdmVudFRhcmdldCA9IHJlcXVpcmUoJy4vZXZlbnRUYXJnZXQnKSxcblx0dXRpbHMgICAgICAgPSByZXF1aXJlKCcuL3V0aWxzJyksXG5cdGNvbmZpZyAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcblx0QmluZGluZyAgICAgPSByZXF1aXJlKCcuL2JpbmRpbmcnKSxcblx0UGFyc2VyICAgICAgPSByZXF1aXJlKCcuL3BhcnNlcicpLFxuXHRPYnNlcnZlciAgICA9IHJlcXVpcmUoJy4vb2JzZXJ2ZXInKSxcblx0RGlyZWN0aXZlICAgPSByZXF1aXJlKCcuL2RpcmVjdGl2ZScpLFxuXHRUZXh0UGFyc2VyICA9IFBhcnNlci5UZXh0UGFyc2VyLFxuXHRFeHBQYXJzZXIgICA9IFBhcnNlci5FeHBQYXJzZXIsXG5cdERlcHNQYXJzZXIgID0gUGFyc2VyLkRlcHNQYXJzZXIsXG5cdFZpZXdNb2RlbCxcbiAgICBcbiAgICAvLyBDQUNIRSBNRVRIT0RTXG4gICAgc2xpY2UgICAgICAgPSBbXS5zbGljZSxcbiAgICBoYXNPd24gICAgICA9ICh7fSkuaGFzT3duUHJvcGVydHksXG4gICAgZGVmICAgICAgICAgPSBPYmplY3QuZGVmaW5lUHJvcGVydHksXG5cbiAgICAvLyBIT09LUyBUTyBSRUdJU1RFUlxuICAgIGhvb2tzICAgICAgID0gWydjcmVhdGVkJywgJ3JlYWR5JywgJ2JlZm9yZURlc3Ryb3knLCAnYWZ0ZXJEZXN0cm95JywgJ2F0dGFjaGVkJywgJ2RldGFjaGVkJ10sXG5cbiAgICAvLyBMSVNUIE9GIFBSSU9SSVRZIERJUkVDVElWRVNcbiAgICAvLyBUSEFUIE5FRURTIFRPIEJFIENIRUNLRUQgSU4gU1BFQ0lGSUMgT1JERVJcbiAgICBwcmlvcml0eURpcmVjdGl2ZXMgPSBbJ2lmJywgJ3JlcGVhdCcsICd2aWV3JywgJ2NvbXBvbmVudCddO1xuXG4vKipcbiAqICBUSEUgRE9NIENPTVBJTEVSXG4gKiAgU0NBTlMgQSBET00gTk9ERSBBTkQgQ09NUElMRSBCSU5ESU5HUyBGT1IgQSBWSUVXTU9ERUxcbiAqL1xuZnVuY3Rpb24gQ29tcGlsZXIodm0sIG9wdGlvbnMpe1xuXHR0aGlzLl9pbml0ZWQgICAgPSB0cnVlO1xuXHR0aGlzLl9kZXN0cm95ZWQgPSBmYWxzZTtcblx0dXRpbHMubWl4KHRoaXMsIG9wdGlvbnMuY29tcGlsZXJPcHRpb25zKTtcblx0Ly8gUkVQRUFUIElORElDQVRFUyBUSElTIElTIEEgVi1SRVBFQVQgSU5TVEFOQ0Vcblx0dGhpcy5yZXBlYXQgPSB0aGlzLnJlcGVhdCB8fCBmYWxzZTtcbiAgICAvLyBFWFBDQUNIRSBXSUxMIEJFIFNIQVJFRCBCRVRXRUVOIFYtUkVQRUFUIElOU1RBTkNFU1xuXHR0aGlzLmV4cENhY2hlID0gdGhpcy5leHBDYWNoZSB8fCB7fTtcblxuXHQvLy0tSU5USUFMSVpBVElPTiBTVFVGRlxuXHR0aGlzLnZtID0gdm07XG5cdHRoaXMub3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG5cdHRoaXMuX2luaXRPcHRpb25zKCk7XG4gXHR0aGlzLl9pbml0RWxlbWVudCgpO1xuXHR0aGlzLl9pbml0Vk0oKTtcblx0dGhpcy5faW5pdERhdGEoKTtcblx0dGhpcy5fc3RhcnRDb21waWxlKCk7XG59XG5cbi8qKlxuICogaW5pdGlhbGl6YXRpb24gYW5kIGRlc3Ryb3lcbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHRfaW5pdE9wdGlvbnM6IGZ1bmN0aW9uKCl7XG5cdFx0dmFyIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnNcblx0XHR2YXIgY29tcG9uZW50cyA9IG9wdGlvbnMuY29tcG9uZW50cyxcbiAgICAgICAgICAgIHBhcnRpYWxzICAgPSBvcHRpb25zLnBhcnRpYWxzLFxuICAgICAgICAgICAgdGVtcGxhdGUgICA9IG9wdGlvbnMudGVtcGxhdGUsXG4gICAgICAgICAgICBmaWx0ZXJzICAgID0gb3B0aW9ucy5maWx0ZXJzLFxuICAgICAgICAgICAga2V5O1xuXG4gICAgICAgIGlmIChjb21wb25lbnRzKSB7XG4gICAgICAgICAgICBmb3IgKGtleSBpbiBjb21wb25lbnRzKSB7XG4gICAgICAgICAgICAgICAgY29tcG9uZW50c1trZXldID0gVmlld01vZGVsLmV4dGVuZChjb21wb25lbnRzW2tleV0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHBhcnRpYWxzKSB7XG4gICAgICAgICAgICBmb3IgKGtleSBpbiBwYXJ0aWFscykge1xuICAgICAgICAgICAgICAgIHBhcnRpYWxzW2tleV0gPSBQYXJzZXIucGFyc2VyVGVtcGxhdGUocGFydGlhbHNba2V5XSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBmaWx0ZXIsIFRISVNfUkUgPSAvW15cXHdddGhpc1teXFx3XS87XG4gICAgICAgIGlmIChmaWx0ZXJzKSB7XG4gICAgICAgICAgICBmb3IgKGtleSBpbiBmaWx0ZXJzKSB7XG4gICAgICAgICAgICBcdGZpbHRlciA9IGZpbHRlcnNba2V5XTtcbiAgICAgICAgICAgIFx0aWYgKFRISVNfUkUudGVzdChmaWx0ZXIudG9TdHJpbmcoKSkpIHtcblx0XHQgICAgICAgICAgICBmaWx0ZXIuY29tcHV0ZWQgPSB0cnVlO1xuXHRcdCAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRlbXBsYXRlKSB7XG4gICAgICAgICAgICBvcHRpb25zLnRlbXBsYXRlID0gUGFyc2VyLnBhcnNlclRlbXBsYXRlKHRlbXBsYXRlKVxuICAgICAgICB9XG5cdH0sXG5cdF9pbml0RWxlbWVudDogZnVuY3Rpb24oKXtcblx0XHR2YXIgb3B0aW9ucyA9IHRoaXMub3B0aW9ucyxcblx0XHRcdHZtICAgICAgPSB0aGlzLnZtLFxuXHQgICAgXHR0ZW1wbGF0ZSA9IG9wdGlvbnMudGVtcGxhdGUsIFxuXHQgICAgXHRlbDtcblxuXHRcdGluaXRFbCgpO1xuXHQgICAgcmVzb2x2ZVRlbXBsYXRlKCk7XG5cdCAgICByZXNvbHZlRWxlbWVudE9wdGlvbigpO1xuXG5cdCAgICB0aGlzLmVsID0gZWw7IFxuXHRcdHRoaXMuZWwuX3ZtID0gdm07XG5cdFx0dXRpbHMubG9nKCduZXcgVk0gaW5zdGFuY2U6ICcgKyBlbC50YWdOYW1lICsgJ1xcbicpO1xuXHRcdFxuXHRcdC8vIENSRUFURSBUSEUgTk9ERSBGSVJTVFxuXHRcdGZ1bmN0aW9uIGluaXRFbCgpe1xuXHRcdFx0ZWwgPSB0eXBlb2Ygb3B0aW9ucy5lbCA9PT0gJ3N0cmluZydcblx0ICAgICAgICA/IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Iob3B0aW9ucy5lbClcblx0ICAgICAgICA6IG9wdGlvbnMuZWwgfHwgZG9jdW1lbnQuY3JlYXRlRWxlbWVudChvcHRpb25zLnRhZ05hbWUgfHwgJ2RpdicpO1xuXHRcdH1cblxuXHQgICAgZnVuY3Rpb24gcmVzb2x2ZVRlbXBsYXRlKCl7XG5cdCAgICBcdHZhciBjaGlsZCwgcmVwbGFjZXIsIGk7XG5cdCAgICBcdC8vIFRFTVBMQVRFIElTIEEgRlJBR01FTlQgRE9DVU1FTlRcblx0XHQgICAgaWYodGVtcGxhdGUpe1xuXHRcdCAgICBcdC8vIENPTExFQ1QgQU5ZVEhJTkcgQUxSRUFEWSBJTiBUSEVSRVxuXHRcdCAgICAgICAgaWYgKGVsLmhhc0NoaWxkTm9kZXMoKSkge1xuXHRcdCAgICAgICAgICAgIHRoaXMucmF3Q29udGVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpXG5cdFx0ICAgICAgICAgICAgd2hpbGUgKGNoaWxkID0gZWwuZmlyc3RDaGlsZCkge1xuXHRcdCAgICAgICAgICAgICAgICB0aGlzLnJhd0NvbnRlbnQuYXBwZW5kQ2hpbGQoY2hpbGQpXG5cdFx0ICAgICAgICAgICAgfVxuXHRcdCAgICAgICAgfVxuXHRcdCAgICAgICAgLy8gUkVQTEFDRSBPUFRJT046IFVTRSBUSEUgRklSU1QgTk9ERSBJTlxuXHRcdCAgICAgICAgLy8gVEhFIFRFTVBMQVRFIERJUkVDVExZIFRPIFJFUExBQ0UgRUxcblx0XHQgICAgICAgIGlmIChvcHRpb25zLnJlcGxhY2UgJiYgdGVtcGxhdGUuZmlyc3RDaGlsZCA9PT0gdGVtcGxhdGUubGFzdENoaWxkKSB7XG5cdFx0ICAgICAgICAgICAgcmVwbGFjZXIgPSB0ZW1wbGF0ZS5maXJzdENoaWxkLmNsb25lTm9kZSh0cnVlKVxuXHRcdCAgICAgICAgICAgIGlmIChlbC5wYXJlbnROb2RlKSB7XG5cdFx0ICAgICAgICAgICAgICAgIGVsLnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKHJlcGxhY2VyLCBlbClcblx0XHQgICAgICAgICAgICAgICAgZWwucGFyZW50Tm9kZS5yZW1vdmVDaGlsZChlbClcblx0XHQgICAgICAgICAgICB9XG5cdFx0ICAgICAgICAgICAgLy8gQ09QWSBPVkVSIEFUVFJJQlVURVNcblx0XHQgICAgICAgICAgICBpZiAoZWwuaGFzQXR0cmlidXRlcygpKSB7XG5cdFx0ICAgICAgICAgICAgICAgIGkgPSBlbC5hdHRyaWJ1dGVzLmxlbmd0aFxuXHRcdCAgICAgICAgICAgICAgICB3aGlsZSAoaS0tKSB7XG5cdFx0ICAgICAgICAgICAgICAgICAgICBhdHRyID0gZWwuYXR0cmlidXRlc1tpXVxuXHRcdCAgICAgICAgICAgICAgICAgICAgcmVwbGFjZXIuc2V0QXR0cmlidXRlKGF0dHIubmFtZSwgYXR0ci52YWx1ZSlcblx0XHQgICAgICAgICAgICAgICAgfVxuXHRcdCAgICAgICAgICAgIH1cblx0XHQgICAgICAgICAgICAvLyBSRVBMQUNFXG5cdFx0ICAgICAgICAgICAgZWwgPSByZXBsYWNlclxuXHRcdCAgICAgICAgfSBlbHNlIHtcblx0XHQgICAgICAgICAgICBlbC5hcHBlbmRDaGlsZCh0ZW1wbGF0ZS5jbG9uZU5vZGUodHJ1ZSkpXG5cdFx0ICAgICAgICB9XG5cdFx0ICAgIH1cblx0ICAgIH1cblxuXHQgICAgZnVuY3Rpb24gcmVzb2x2ZUVsZW1lbnRPcHRpb24oKXtcblx0ICAgIFx0dmFyIGF0dHJzLCBhdHRyO1xuXHRcdFx0Ly8gQVBQTFkgRUxFTUVOVCBPUFRJT05TXG5cdFx0ICAgIGlmIChvcHRpb25zLmlkKSBlbC5pZCA9IG9wdGlvbnMuaWRcblx0XHQgICAgaWYgKG9wdGlvbnMuY2xhc3NOYW1lKSBlbC5jbGFzc05hbWUgPSBvcHRpb25zLmNsYXNzTmFtZVxuXHRcdCAgICBhdHRycyA9IG9wdGlvbnMuYXR0cmlidXRlc1xuXHRcdCAgICBpZiAoYXR0cnMpIHtcblx0XHQgICAgICAgIGZvciAoYXR0ciBpbiBhdHRycykge1xuXHRcdCAgICAgICAgICAgIGVsLnNldEF0dHJpYnV0ZShhdHRyLCBhdHRyc1thdHRyXSlcblx0XHQgICAgICAgIH1cblx0XHQgICAgfVxuXHRcdH1cblx0fSxcblx0X2luaXRWTTogZnVuY3Rpb24oKXtcblx0XHR2YXIgb3B0aW9ucyAgPSB0aGlzLm9wdGlvbnMsXG5cdFx0XHRjb21waWxlciA9IHRoaXM7XG5cdFx0XHR2bSAgICAgICA9IHRoaXMudm07XG5cblx0XHQvLyBDT01QSUxFUiBcblx0XHR1dGlscy5taXgodGhpcywge1xuXHRcdFx0Ly8gdm0gcmVmXG5cdFx0XHR2bTogdm0sXG5cdFx0XHQvLyBiaW5kaW5ncyBmb3IgYWxsXG5cdFx0XHRiaW5kaW5nczogdXRpbHMuaGFzaCgpLFxuXHRcdFx0Ly8gZGlyZWN0aXZlc1xuXHRcdFx0ZGlyczogW10sXG5cdFx0XHQvLyBwcm9wZXJ0eSBpbiB0ZW1wbGF0ZSBidXQgbm90IGRlZmluZWQgaW4gZGF0YVxuXHRcdFx0ZGVmZXJyZWQ6IFtdLFxuXHRcdFx0Ly8gcHJvcGVydHkgbmVlZCBjb21wdXRhdGlvbiBieSBzdWJzY3JpYmUgb3RoZXIgcHJvcGVydHlcblx0XHRcdGNvbXB1dGVkOiBbXSxcblx0XHRcdC8vIGNvbXBvc2l0ZSBwYXR0ZXJuXG5cdFx0XHRjaGlsZHJlbjogW10sXG5cdFx0XHQvLyBldmVudCBlbWl0dGVyXG5cdFx0XHRlbWl0dGVyOiBuZXcgRXZlbnRUYXJnZXQoKVxuXHRcdH0pO1xuXG5cdFx0Ly8gQ09NUElMRVIuVk0gXG5cdFx0dXRpbHMubWl4KHZtLCB7XG5cdFx0XHQnJCc6IHt9LFxuXHRcdFx0JyRlbCc6IHRoaXMuZWwsXG5cdFx0XHQnJG9wdGlvbnMnOiBvcHRpb25zLFxuXHRcdFx0JyRjb21waWxlcic6IGNvbXBpbGVyLFxuXHRcdFx0JyRldmVudCc6IG51bGxcblx0XHR9KTtcblxuXHRcdC8vIFBBUkVOVCBWTVxuXHRcdHZhciBwYXJlbnRWTSA9IG9wdGlvbnMucGFyZW50O1xuXHRcdGlmIChwYXJlbnRWTSkge1xuXHRcdFx0dGhpcy5wYXJlbnQgPSBwYXJlbnRWTS4kY29tcGlsZXI7XG5cdFx0XHRwYXJlbnRWTS4kY29tcGlsZXIuY2hpbGRyZW4ucHVzaCh0aGlzKTtcblx0XHRcdHZtLiRwYXJlbnQgPSBwYXJlbnRWTTtcblx0XHRcdC8vIElOSEVSSVQgTEFaWSBPUFRJT05cblx0ICAgICAgICBpZiAoISgnbGF6eScgaW4gb3B0aW9ucykpIHtcblx0ICAgICAgICAgICAgb3B0aW9ucy5sYXp5ID0gdGhpcy5wYXJlbnQub3B0aW9ucy5sYXp5O1xuXHQgICAgICAgIH1cblx0XHR9XG5cdFx0dm0uJHJvb3QgPSBnZXRSb290KHRoaXMpLnZtO1xuXHRcdGZ1bmN0aW9uIGdldFJvb3QgKGNvbXBpbGVyKSB7XG5cdFx0ICAgIHdoaWxlIChjb21waWxlci5wYXJlbnQpIHtcblx0XHQgICAgICAgIGNvbXBpbGVyID0gY29tcGlsZXIucGFyZW50O1xuXHRcdCAgICB9XG5cdFx0ICAgIHJldHVybiBjb21waWxlcjtcblx0XHR9XG5cdH0sXG5cdF9pbml0RGF0YTogZnVuY3Rpb24oKXtcblx0XHR2YXIgb3B0aW9ucyAgPSB0aGlzLm9wdGlvbnMsXG5cdFx0XHRjb21waWxlciA9IHRoaXMsXG5cdFx0XHR2bSAgICAgICA9IHRoaXMudm07XG5cdFx0Ly8gU0VUVVAgT0JTRVJWRVJcblx0ICAgIC8vIFRISVMgSVMgTkVDRVNBUlJZIEZPUiBBTEwgSE9PS1MgQU5EIERBVEEgT0JTRVJWQVRJT04gRVZFTlRTXG5cdFx0Y29tcGlsZXIuc2V0dXBPYnNlcnZlcigpO1xuXHRcdC8vIENSRUFURSBCSU5ESU5HUyBGT1IgQ09NUFVURUQgUFJPUEVSVElFU1xuXHQgICAgaWYgKG9wdGlvbnMubWV0aG9kcykge1xuXHQgICAgICAgIGZvciAoa2V5IGluIG9wdGlvbnMubWV0aG9kcykge1xuXHQgICAgICAgICAgICBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSk7XG5cdCAgICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICAvLyBDUkVBVEUgQklORElOR1MgRk9SIE1FVEhPRFNcblx0ICAgIGlmIChvcHRpb25zLmNvbXB1dGVkKSB7XG5cdCAgICAgICAgZm9yIChrZXkgaW4gb3B0aW9ucy5jb21wdXRlZCkge1xuXHQgICAgICAgICAgICBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSlcblx0ICAgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIC8vIElOSVRJQUxJWkUgREFUQVxuXHQgICAgdmFyIGRhdGEgPSBjb21waWxlci5kYXRhID0gb3B0aW9ucy5kYXRhIHx8IHt9LFxuXHQgICAgICAgIGRlZmF1bHREYXRhID0gb3B0aW9ucy5kZWZhdWx0RGF0YVxuXHQgICAgaWYgKGRlZmF1bHREYXRhKSB7XG5cdCAgICAgICAgZm9yIChrZXkgaW4gZGVmYXVsdERhdGEpIHtcblx0ICAgICAgICAgICAgaWYgKCFoYXNPd24uY2FsbChkYXRhLCBrZXkpKSB7XG5cdCAgICAgICAgICAgICAgICBkYXRhW2tleV0gPSBkZWZhdWx0RGF0YVtrZXldXG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIC8vIENPUFkgUEFSQU1BVFRSSUJVVEVTXG5cdCAgICAvLyB2YXIgcGFyYW1zID0gb3B0aW9ucy5wYXJhbUF0dHJpYnV0ZXNcblx0ICAgIC8vIGlmIChwYXJhbXMpIHtcblx0ICAgIC8vICAgICBpID0gcGFyYW1zLmxlbmd0aFxuXHQgICAgLy8gICAgIHdoaWxlIChpLS0pIHtcblx0ICAgIC8vICAgICAgICAgZGF0YVtwYXJhbXNbaV1dID0gdXRpbHMuY2hlY2tOdW1iZXIoXG5cdCAgICAvLyAgICAgICAgICAgICBjb21waWxlci5ldmFsKFxuXHQgICAgLy8gICAgICAgICAgICAgICAgIGVsLmdldEF0dHJpYnV0ZShwYXJhbXNbaV0pXG5cdCAgICAvLyAgICAgICAgICAgICApXG5cdCAgICAvLyAgICAgICAgIClcblx0ICAgIC8vICAgICB9XG5cdCAgICAvLyB9XG5cblx0ICAgIHV0aWxzLm1peCh2bSwgZGF0YSk7XG5cdCAgICB2bS4kZGF0YSA9IGRhdGE7XG5cblx0ICAgIC8vIGJlZm9yZUNvbXBpbGUgaG9va1xuXHQgICAgY29tcGlsZXIuZXhlY0hvb2soJ2NyZWF0ZWQnKTtcblxuXHQgICAgLy8gVEhFIFVTRVIgTUlHSFQgSEFWRSBTV0FQUEVEIFRIRSBEQVRBIC4uLlxuXHQgICAgZGF0YSA9IGNvbXBpbGVyLmRhdGEgPSB2bS4kZGF0YTtcblx0ICAgIC8vIFVTRVIgTUlHSFQgQUxTTyBTRVQgU09NRSBQUk9QRVJUSUVTIE9OIFRIRSBWTVxuXHQgICAgLy8gSU4gV0hJQ0ggQ0FTRSBXRSBTSE9VTEQgQ09QWSBCQUNLIFRPICREQVRBXG5cdCAgICB2YXIgdm1Qcm9wXG5cdCAgICBmb3IgKGtleSBpbiB2bSkge1xuXHQgICAgICAgIHZtUHJvcCA9IHZtW2tleV1cblx0ICAgICAgICBpZiAoXG5cdCAgICAgICAgICAgIGtleS5jaGFyQXQoMCkgIT09ICckJyAmJlxuXHQgICAgICAgICAgICBkYXRhW2tleV0gIT09IHZtUHJvcCAmJlxuXHQgICAgICAgICAgICB0eXBlb2Ygdm1Qcm9wICE9PSAnZnVuY3Rpb24nXG5cdCAgICAgICAgKSB7XG5cdCAgICAgICAgICAgIGRhdGFba2V5XSA9IHZtUHJvcDtcblx0ICAgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIC8vIE5PVyBXRSBDQU4gT0JTRVJWRSBUSEUgREFUQS5cblx0ICAgIC8vIFRISVMgV0lMTCBDT05WRVJUIERBVEEgUFJPUEVSVElFUyBUTyBHRVRURVIvU0VUVEVSU1xuXHQgICAgLy8gQU5EIEVNSVQgVEhFIEZJUlNUIEJBVENIIE9GIFNFVCBFVkVOVFMsIFdISUNIIFdJTExcblx0ICAgIC8vIElOIFRVUk4gQ1JFQVRFIFRIRSBDT1JSRVNQT05ESU5HIEJJTkRJTkdTLlxuXHQgICAgY29tcGlsZXIub2JzZXJ2ZURhdGEoZGF0YSlcblx0fSxcblx0X3N0YXJ0Q29tcGlsZTogZnVuY3Rpb24oKXtcblx0XHR2YXIgb3B0aW9ucyA9IHRoaXMub3B0aW9ucyxcblx0XHRcdGNvbXBpbGVyID0gdGhpcyxcblx0XHRcdGVsID0gdGhpcy5lbDtcblx0ICAgIC8vIGJlZm9yZSBjb21waWxpbmcsIHJlc29sdmUgY29udGVudCBpbnNlcnRpb24gcG9pbnRzXG5cdCAgICBpZiAob3B0aW9ucy50ZW1wbGF0ZSkge1xuXHQgICAgICAgIHRoaXMucmVzb2x2ZUNvbnRlbnQoKTtcblx0ICAgIH1cblxuXHQgICAgLy8gbm93IHBhcnNlIHRoZSBET00gYW5kIGJpbmQgZGlyZWN0aXZlcy5cblx0ICAgIC8vIER1cmluZyB0aGlzIHN0YWdlLCB3ZSB3aWxsIGFsc28gY3JlYXRlIGJpbmRpbmdzIGZvclxuXHQgICAgLy8gZW5jb3VudGVyZWQga2V5cGF0aHMgdGhhdCBkb24ndCBoYXZlIGEgYmluZGluZyB5ZXQuXG5cdCAgICBjb21waWxlci5jb21waWxlKGVsLCB0cnVlKVxuXG5cdCAgICAvLyBBbnkgZGlyZWN0aXZlIHRoYXQgY3JlYXRlcyBjaGlsZCBWTXMgYXJlIGRlZmVycmVkXG5cdCAgICAvLyBzbyB0aGF0IHdoZW4gdGhleSBhcmUgY29tcGlsZWQsIGFsbCBiaW5kaW5ncyBvbiB0aGVcblx0ICAgIC8vIHBhcmVudCBWTSBoYXZlIGJlZW4gY3JlYXRlZC5cblxuXHQgICAgdmFyIGkgPSBjb21waWxlci5kZWZlcnJlZC5sZW5ndGg7XG5cdCAgICB3aGlsZSAoaS0tKSB7XG5cdCAgICAgICAgY29tcGlsZXIuYmluZERpcmVjdGl2ZShjb21waWxlci5kZWZlcnJlZFtpXSlcblx0ICAgIH1cblx0ICAgIGNvbXBpbGVyLmRlZmVycmVkID0gbnVsbFxuXG5cdCAgICAvLyBleHRyYWN0IGRlcGVuZGVuY2llcyBmb3IgY29tcHV0ZWQgcHJvcGVydGllcy5cblx0ICAgIC8vIHRoaXMgd2lsbCBldmFsdWF0ZWQgYWxsIGNvbGxlY3RlZCBjb21wdXRlZCBiaW5kaW5nc1xuXHQgICAgLy8gYW5kIGNvbGxlY3QgZ2V0IGV2ZW50cyB0aGF0IGFyZSBlbWl0dGVkLlxuXHQgICAgaWYgKHRoaXMuY29tcHV0ZWQubGVuZ3RoKSB7XG5cdCAgICAgICAgRGVwc1BhcnNlci5wYXJzZSh0aGlzLmNvbXB1dGVkKVxuXHQgICAgfVxuXG5cdCAgICAvLyBkb25lIVxuXHQgICAgY29tcGlsZXIuaW5pdCA9IGZhbHNlXG5cblx0ICAgIC8vIHBvc3QgY29tcGlsZSAvIHJlYWR5IGhvb2tcblx0ICAgIGNvbXBpbGVyLmV4ZWNIb29rKCdyZWFkeScpO1xuXHR9LFxuXHRkZXN0cm95OiBmdW5jdGlvbiAobm9SZW1vdmUpIHtcblxuXHQgICAgLy8gYXZvaWQgYmVpbmcgY2FsbGVkIG1vcmUgdGhhbiBvbmNlXG5cdCAgICAvLyB0aGlzIGlzIGlycmV2ZXJzaWJsZSFcblx0ICAgIGlmICh0aGlzLmRlc3Ryb3llZCkgcmV0dXJuXG5cblx0ICAgIHZhciBjb21waWxlciA9IHRoaXMsXG5cdCAgICAgICAgaSwgaiwga2V5LCBkaXIsIGRpcnMsIGJpbmRpbmcsXG5cdCAgICAgICAgdm0gICAgICAgICAgPSBjb21waWxlci52bSxcblx0ICAgICAgICBlbCAgICAgICAgICA9IGNvbXBpbGVyLmVsLFxuXHQgICAgICAgIGRpcmVjdGl2ZXMgID0gY29tcGlsZXIuZGlycyxcblx0ICAgICAgICBjb21wdXRlZCAgICA9IGNvbXBpbGVyLmNvbXB1dGVkLFxuXHQgICAgICAgIGJpbmRpbmdzICAgID0gY29tcGlsZXIuYmluZGluZ3MsXG5cdCAgICAgICAgY2hpbGRyZW4gICAgPSBjb21waWxlci5jaGlsZHJlbixcblx0ICAgICAgICBwYXJlbnQgICAgICA9IGNvbXBpbGVyLnBhcmVudFxuXG5cdCAgICBjb21waWxlci5leGVjSG9vaygnYmVmb3JlRGVzdHJveScpXG5cblx0ICAgIC8vIHVub2JzZXJ2ZSBkYXRhXG5cdCAgICBPYnNlcnZlci51bm9ic2VydmUoY29tcGlsZXIuZGF0YSwgJycsIGNvbXBpbGVyLm9ic2VydmVyKVxuXG5cdCAgICAvLyBkZXN0cm95IGFsbCBjaGlsZHJlblxuXHQgICAgLy8gZG8gbm90IHJlbW92ZSB0aGVpciBlbGVtZW50cyBzaW5jZSB0aGUgcGFyZW50XG5cdCAgICAvLyBtYXkgaGF2ZSB0cmFuc2l0aW9ucyBhbmQgdGhlIGNoaWxkcmVuIG1heSBub3Rcblx0ICAgIGkgPSBjaGlsZHJlbi5sZW5ndGhcblx0ICAgIHdoaWxlIChpLS0pIHtcblx0ICAgICAgICBjaGlsZHJlbltpXS5kZXN0cm95KHRydWUpXG5cdCAgICB9XG5cblx0ICAgIC8vIHVuYmluZCBhbGwgZGlyZWNpdHZlc1xuXHQgICAgaSA9IGRpcmVjdGl2ZXMubGVuZ3RoXG5cdCAgICB3aGlsZSAoaS0tKSB7XG5cdCAgICAgICAgZGlyID0gZGlyZWN0aXZlc1tpXVxuXHQgICAgICAgIC8vIGlmIHRoaXMgZGlyZWN0aXZlIGlzIGFuIGluc3RhbmNlIG9mIGFuIGV4dGVybmFsIGJpbmRpbmdcblx0ICAgICAgICAvLyBlLmcuIGEgZGlyZWN0aXZlIHRoYXQgcmVmZXJzIHRvIGEgdmFyaWFibGUgb24gdGhlIHBhcmVudCBWTVxuXHQgICAgICAgIC8vIHdlIG5lZWQgdG8gcmVtb3ZlIGl0IGZyb20gdGhhdCBiaW5kaW5nJ3MgZGlyZWN0aXZlc1xuXHQgICAgICAgIC8vICogZW1wdHkgYW5kIGxpdGVyYWwgYmluZGluZ3MgZG8gbm90IGhhdmUgYmluZGluZy5cblx0ICAgICAgICBpZiAoZGlyLmJpbmRpbmcgJiYgZGlyLmJpbmRpbmcuY29tcGlsZXIgIT09IGNvbXBpbGVyKSB7XG5cdCAgICAgICAgICAgIGRpcnMgPSBkaXIuYmluZGluZy5kaXJzXG5cdCAgICAgICAgICAgIGlmIChkaXJzKSB7XG5cdCAgICAgICAgICAgICAgICBqID0gZGlycy5pbmRleE9mKGRpcilcblx0ICAgICAgICAgICAgICAgIGlmIChqID4gLTEpIGRpcnMuc3BsaWNlKGosIDEpXG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9XG5cdCAgICAgICAgZGlyLiR1bmJpbmQoKVxuXHQgICAgfVxuXG5cdCAgICAvLyB1bmJpbmQgYWxsIGNvbXB1dGVkLCBhbm9ueW1vdXMgYmluZGluZ3Ncblx0ICAgIGkgPSBjb21wdXRlZC5sZW5ndGhcblx0ICAgIHdoaWxlIChpLS0pIHtcblx0ICAgICAgICBjb21wdXRlZFtpXS51bmJpbmQoKVxuXHQgICAgfVxuXG5cdCAgICAvLyB1bmJpbmQgYWxsIGtleXBhdGggYmluZGluZ3Ncblx0ICAgIGZvciAoa2V5IGluIGJpbmRpbmdzKSB7XG5cdCAgICAgICAgYmluZGluZyA9IGJpbmRpbmdzW2tleV1cblx0ICAgICAgICBpZiAoYmluZGluZykge1xuXHQgICAgICAgICAgICBiaW5kaW5nLnVuYmluZCgpXG5cdCAgICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICAvLyByZW1vdmUgc2VsZiBmcm9tIHBhcmVudFxuXHQgICAgaWYgKHBhcmVudCkge1xuXHQgICAgICAgIGogPSBwYXJlbnQuY2hpbGRyZW4uaW5kZXhPZihjb21waWxlcilcblx0ICAgICAgICBpZiAoaiA+IC0xKSBwYXJlbnQuY2hpbGRyZW4uc3BsaWNlKGosIDEpXG5cdCAgICB9XG5cblx0ICAgIC8vIGZpbmFsbHkgcmVtb3ZlIGRvbSBlbGVtZW50XG5cdCAgICBpZiAoIW5vUmVtb3ZlKSB7XG5cdCAgICAgICAgaWYgKGVsID09PSBkb2N1bWVudC5ib2R5KSB7XG5cdCAgICAgICAgICAgIGVsLmlubmVySFRNTCA9ICcnXG5cdCAgICAgICAgfSBlbHNlIHtcblx0ICAgICAgICAgICAgdm0uJHJlbW92ZSgpXG5cdCAgICAgICAgfVxuXHQgICAgfVxuXHQgICAgZWwudnVlX3ZtID0gbnVsbFxuXG5cdCAgICBjb21waWxlci5kZXN0cm95ZWQgPSB0cnVlXG5cdCAgICAvLyBlbWl0IGRlc3Ryb3kgaG9va1xuXHQgICAgY29tcGlsZXIuZXhlY0hvb2soJ2FmdGVyRGVzdHJveScpXG5cblx0ICAgIC8vIGZpbmFsbHksIHVucmVnaXN0ZXIgYWxsIGxpc3RlbmVyc1xuXHQgICAgY29tcGlsZXIub2JzZXJ2ZXIub2ZmKCk7XG5cdCAgICBjb21waWxlci5lbWl0dGVyLm9mZigpO1xuXHR9XG59KTtcbi8qKlxuICogb2JzZXJ2YXRpb25cbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHRzZXR1cE9ic2VydmVyOiBmdW5jdGlvbigpe1xuXHRcdHZhciBjb21waWxlciA9IHRoaXMsXG5cdCAgICAgICAgYmluZGluZ3MgPSBjb21waWxlci5iaW5kaW5ncyxcblx0ICAgICAgICBvcHRpb25zICA9IGNvbXBpbGVyLm9wdGlvbnMsXG5cdCAgICAgICAgb2JzZXJ2ZXIgPSBjb21waWxlci5vYnNlcnZlciA9IG5ldyBFdmVudFRhcmdldChjb21waWxlci52bSk7XG5cblx0ICAgIC8vIEEgSEFTSCBUTyBIT0xEIEVWRU5UIFBST1hJRVMgRk9SIEVBQ0ggUk9PVCBMRVZFTCBLRVlcblx0ICAgIC8vIFNPIFRIRVkgQ0FOIEJFIFJFRkVSRU5DRUQgQU5EIFJFTU9WRUQgTEFURVJcblx0ICAgIG9ic2VydmVyLnByb3hpZXMgPSB7fTtcblxuXHQgICAgLy8gQUREIE9XTiBMSVNURU5FUlMgV0hJQ0ggVFJJR0dFUiBCSU5ESU5HIFVQREFURVNcblx0ICAgIG9ic2VydmVyXG5cdCAgICAgICAgLm9uKCdnZXQnLCBvbkdldClcblx0ICAgICAgICAub24oJ3NldCcsIG9uU2V0KVxuXHQgICAgICAgIC5vbignbXV0YXRlJywgb25TZXQpO1xuXG5cdCAgICAvLyByZWdpc3RlciBob29rcyBzZXR1cCBpbiBvcHRpb25zXG5cdCAgICB1dGlscy5lYWNoKGhvb2tzLCBmdW5jdGlvbihob29rKXtcblx0ICAgIFx0dmFyIGksIGZucztcblx0ICAgICAgICBmbnMgPSBvcHRpb25zW2hvb2tdO1xuXHQgICAgICAgIGlmICh1dGlscy5pc0FycmF5KGZucykpIHtcblx0ICAgICAgICAgICAgaSA9IGZucy5sZW5ndGhcblx0ICAgICAgICAgICAgLy8gc2luY2UgaG9va3Mgd2VyZSBtZXJnZWQgd2l0aCBjaGlsZCBhdCBoZWFkLFxuXHQgICAgICAgICAgICAvLyB3ZSBsb29wIHJldmVyc2VseS5cblx0ICAgICAgICAgICAgd2hpbGUgKGktLSkge1xuXHQgICAgICAgICAgICAgICAgcmVnaXN0ZXJIb29rKGhvb2ssIGZuc1tqXSlcblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH0gZWxzZSBpZiAoZm5zKSB7XG5cdCAgICAgICAgICAgIHJlZ2lzdGVySG9vayhob29rLCBmbnMpXG5cdCAgICAgICAgfVxuXHQgICAgfSk7XG5cblx0ICAgIC8vIGJyb2FkY2FzdCBhdHRhY2hlZC9kZXRhY2hlZCBob29rc1xuXHQgICAgb2JzZXJ2ZXJcblx0ICAgICAgICAub24oJ2hvb2s6YXR0YWNoZWQnLCBmdW5jdGlvbiAoKSB7XG5cdCAgICAgICAgICAgIGJyb2FkY2FzdCgxKVxuXHQgICAgICAgIH0pXG5cdCAgICAgICAgLm9uKCdob29rOmRldGFjaGVkJywgZnVuY3Rpb24gKCkge1xuXHQgICAgICAgICAgICBicm9hZGNhc3QoMClcblx0ICAgICAgICB9KVxuXG5cdCAgICBmdW5jdGlvbiBvbkdldCAoa2V5KSB7XG5cdCAgICAgICAgY2hlY2soa2V5KVxuXHQgICAgICAgIERlcHNQYXJzZXIuY2F0Y2hlci5lbWl0KCdnZXQnLCBiaW5kaW5nc1trZXldKVxuXHQgICAgfVxuXG5cdCAgICBmdW5jdGlvbiBvblNldCAoa2V5LCB2YWwsIG11dGF0aW9uKSB7XG5cdCAgICAgICAgb2JzZXJ2ZXIuZW1pdCgnY2hhbmdlOicgKyBrZXksIHZhbCwgbXV0YXRpb24pXG5cdCAgICAgICAgY2hlY2soa2V5KVxuXHQgICAgICAgIGJpbmRpbmdzW2tleV0udXBkYXRlKHZhbClcblx0ICAgIH1cblxuXHQgICAgZnVuY3Rpb24gcmVnaXN0ZXJIb29rIChob29rLCBmbikge1xuXHQgICAgICAgIG9ic2VydmVyLm9uKCdob29rOicgKyBob29rLCBmdW5jdGlvbiAoKSB7XG5cdCAgICAgICAgICAgIGZuLmNhbGwoY29tcGlsZXIudm0pXG5cdCAgICAgICAgfSk7XG5cdCAgICB9XG5cblx0ICAgIGZ1bmN0aW9uIGJyb2FkY2FzdCAoZXZlbnQpIHtcblx0ICAgICAgICB2YXIgY2hpbGRyZW4gPSBjb21waWxlci5jaGlsZHJlblxuXHQgICAgICAgIGlmIChjaGlsZHJlbikge1xuXHQgICAgICAgICAgICB2YXIgY2hpbGQsIGkgPSBjaGlsZHJlbi5sZW5ndGhcblx0ICAgICAgICAgICAgd2hpbGUgKGktLSkge1xuXHQgICAgICAgICAgICAgICAgY2hpbGQgPSBjaGlsZHJlbltpXVxuXHQgICAgICAgICAgICAgICAgaWYgKGNoaWxkLmVsLnBhcmVudE5vZGUpIHtcblx0ICAgICAgICAgICAgICAgICAgICBldmVudCA9ICdob29rOicgKyAoZXZlbnQgPyAnYXR0YWNoZWQnIDogJ2RldGFjaGVkJylcblx0ICAgICAgICAgICAgICAgICAgICBjaGlsZC5vYnNlcnZlci5lbWl0KGV2ZW50KVxuXHQgICAgICAgICAgICAgICAgICAgIGNoaWxkLmVtaXR0ZXIuZW1pdChldmVudClcblx0ICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgZnVuY3Rpb24gY2hlY2sgKGtleSkge1xuXHQgICAgICAgIGlmICghYmluZGluZ3Nba2V5XSkge1xuXHQgICAgICAgICAgICBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSlcblx0ICAgICAgICB9XG5cdCAgICB9XG5cdH0sXG5cdG9ic2VydmVEYXRhOiBmdW5jdGlvbihkYXRhKXtcblx0XHR2YXIgY29tcGlsZXIgPSB0aGlzLFxuXHRcdFx0b2JzZXJ2ZXIgPSBjb21waWxlci5vYnNlcnZlcjtcblxuXHRcdE9ic2VydmVyLm9ic2VydmUoZGF0YSwgJycsIG9ic2VydmVyKTtcblx0XHQvLyBhbHNvIGNyZWF0ZSBiaW5kaW5nIGZvciB0b3AgbGV2ZWwgJGRhdGFcblx0ICAgIC8vIHNvIGl0IGNhbiBiZSB1c2VkIGluIHRlbXBsYXRlcyB0b29cblx0ICAgIHZhciAkZGF0YUJpbmRpbmcgPSBjb21waWxlci5iaW5kaW5nc1snJGRhdGEnXSA9IG5ldyBCaW5kaW5nKGNvbXBpbGVyLCAnJGRhdGEnKTtcblx0ICAgICRkYXRhQmluZGluZy51cGRhdGUoZGF0YSk7XG5cblx0ICAgIGRlZihjb21waWxlci52bSwgJyRkYXRhJywge1xuXHQgICAgXHRnZXQ6IGZ1bmN0aW9uKCl7XG5cdCAgICBcdFx0Y29tcGlsZXIub2JzZXJ2ZXIuZW1pdCgnZ2V0JywgJyRkYXRhJyk7XG5cdCAgICBcdFx0cmV0dXJuIGNvbXBpbGVyLmRhdGE7XG5cdCAgICBcdH0sXG5cdCAgICBcdHNldDogZnVuY3Rpb24obmV3RGF0YSl7XG5cdCAgICBcdFx0dmFyIG9sZERhdGEgPSBjb21waWxlci5kYXRhO1xuXHQgICAgXHRcdE9ic2VydmVyLnVub2JzZXJ2ZShvbGREYXRhLCAnJywgb2JzZXJ2ZXIpO1xuXHQgICAgXHRcdGNvbXBpbGVyLmRhdGEgPSBuZXdEYXRhO1xuXHQgICAgXHRcdE9ic2VydmVyLmNvcHlQYXRocyhuZXdEYXRhLCBvbGREYXRhKTtcblx0ICAgIFx0XHRPYnNlcnZlci5vYnNlcnZlKG5ld0RhdGEsICcnLCBvYnNlcnZlcik7XG5cdCAgICBcdFx0dXBkYXRlKCk7XG5cdCAgICBcdH1cblx0ICAgIH0pO1xuXG5cdCAgICBvYnNlcnZlclxuXHQgICAgXHQub24oJ3NldCcsIG9uU2V0KVxuXHQgICAgXHQub24oJ211dGF0ZScsIG9uU2V0KTtcblx0ICAgIGZ1bmN0aW9uIG9uU2V0IChrZXkpIHtcblx0ICAgIFx0aWYgKGtleSAhPT0nJGRhdGEnKSB1cGRhdGUoKTtcblx0ICAgIH1cblxuXHQgICAgZnVuY3Rpb24gdXBkYXRlKCl7XG5cdCAgICBcdCRkYXRhQmluZGluZy51cGRhdGUoY29tcGlsZXIuZGF0YSk7XG5cdCAgICBcdG9ic2VydmVyLmVtaXQoJ2NoYW5nZTokZGF0YScsIGNvbXBpbGVyLmRhdGEpO1xuXHQgICAgfVxuXHR9LFxuXG5cdC8qKlxuXHQgKiAgQ1JFQVRFIEJJTkRJTkcgQU5EIEFUVEFDSCBHRVRURVIvU0VUVEVSIEZPUiBBIEtFWSBUTyBUSEUgVklFV01PREVMIE9CSkVDVFxuXHQgKi9cblx0Y3JlYXRlQmluZGluZzogZnVuY3Rpb24oa2V5LCBkaXJlY3RpdmUpe1xuXHRcdHV0aWxzLmxvZygnICBjcmVhdGVkIGJpbmRpbmc6ICcgKyBrZXkpO1xuXHRcdHZhciBjb21waWxlciA9IHRoaXMsXG5cdCAgICAgICAgbWV0aG9kcyAgPSBjb21waWxlci5vcHRpb25zLm1ldGhvZHMsXG5cdCAgICAgICAgaXNFeHAgICAgPSBkaXJlY3RpdmUgJiYgZGlyZWN0aXZlLmlzRXhwLFxuXHQgICAgICAgIGlzRm4gICAgID0gKGRpcmVjdGl2ZSAmJiBkaXJlY3RpdmUuaXNGbikgfHwgKG1ldGhvZHMgJiYgbWV0aG9kc1trZXldKSxcblx0ICAgICAgICBiaW5kaW5ncyA9IGNvbXBpbGVyLmJpbmRpbmdzLFxuXHQgICAgICAgIGNvbXB1dGVkID0gY29tcGlsZXIub3B0aW9ucy5jb21wdXRlZCxcblx0ICAgICAgICBiaW5kaW5nICA9IG5ldyBCaW5kaW5nKGNvbXBpbGVyLCBrZXksIGlzRXhwLCBpc0ZuKTtcblxuXG5cdCAgICBpZiAoaXNFeHApIHtcblx0ICAgICAgICAvLyBFWFBSRVNTSU9OIEJJTkRJTkdTIEFSRSBBTk9OWU1PVVNcblx0ICAgICAgICBjb21waWxlci5kZWZpbmVFeHAoa2V5LCBiaW5kaW5nLCBkaXJlY3RpdmUpO1xuXHQgICAgfSBlbHNlIGlmIChpc0ZuKSB7XG5cdCAgICAgICAgYmluZGluZ3Nba2V5XSA9IGJpbmRpbmc7XG5cdCAgICAgICAgY29tcGlsZXIuZGVmaW5lVm1Qcm9wKGtleSwgYmluZGluZywgbWV0aG9kc1trZXldKTtcblx0ICAgIH0gZWxzZSB7XG5cdCAgICBcdGJpbmRpbmdzW2tleV0gPSBiaW5kaW5nO1xuXHQgICAgICAgIGlmIChiaW5kaW5nLnJvb3QpIHtcblx0ICAgICAgICAgICAgLy8gVEhJUyBJUyBBIFJPT1QgTEVWRUwgQklORElORy4gV0UgTkVFRCBUTyBERUZJTkUgR0VUVEVSL1NFVFRFUlMgRk9SIElULlxuXHQgICAgICAgICAgICBpZiAoY29tcHV0ZWQgJiYgY29tcHV0ZWRba2V5XSkge1xuXHQgICAgICAgICAgICAgICAgLy8gQ09NUFVURUQgUFJPUEVSVFlcblx0ICAgICAgICAgICAgICAgIGNvbXBpbGVyLmRlZmluZUNvbXB1dGVkKGtleSwgYmluZGluZywgY29tcHV0ZWRba2V5XSlcblx0ICAgICAgICAgICAgfSBlbHNlIGlmIChrZXkuY2hhckF0KDApICE9PSAnJCcpIHtcblx0ICAgICAgICAgICAgICAgIC8vIE5PUk1BTCBQUk9QRVJUWVxuXHQgICAgICAgICAgICAgICAgY29tcGlsZXIuZGVmaW5lRGF0YVByb3Aoa2V5LCBiaW5kaW5nKVxuXHQgICAgICAgICAgICB9IGVsc2Uge1xuXHQgICAgICAgICAgICAgICAgLy8gUFJPUEVSVElFUyBUSEFUIFNUQVJUIFdJVEggJCBBUkUgTUVUQSBQUk9QRVJUSUVTXG5cdCAgICAgICAgICAgICAgICAvLyBUSEVZIFNIT1VMRCBCRSBLRVBUIE9OIFRIRSBWTSBCVVQgTk9UIElOIFRIRSBEQVRBIE9CSkVDVC5cblx0ICAgICAgICAgICAgICAgIGNvbXBpbGVyLmRlZmluZVZtUHJvcChrZXksIGJpbmRpbmcsIGNvbXBpbGVyLmRhdGFba2V5XSlcblx0ICAgICAgICAgICAgICAgIGRlbGV0ZSBjb21waWxlci5kYXRhW2tleV1cblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH0gZWxzZSBpZiAoY29tcHV0ZWQgJiYgY29tcHV0ZWRbdXRpbHMuYmFzZUtleShrZXkpXSkge1xuXHQgICAgICAgICAgICAvLyBORVNURUQgUEFUSCBPTiBDT01QVVRFRCBQUk9QRVJUWVxuXHQgICAgICAgICAgICBjb21waWxlci5kZWZpbmVFeHAoa2V5LCBiaW5kaW5nKVxuXHQgICAgICAgIH0gZWxzZSB7XG5cdCAgICAgICAgICAgIC8vIEVOU1VSRSBQQVRIIElOIERBVEEgU08gVEhBVCBDT01QVVRFRCBQUk9QRVJUSUVTIFRIQVRcblx0ICAgICAgICAgICAgLy8gQUNDRVNTIFRIRSBQQVRIIERPTidUIFRIUk9XIEFOIEVSUk9SIEFORCBDQU4gQ09MTEVDVFxuXHQgICAgICAgICAgICAvLyBERVBFTkRFTkNJRVNcblx0ICAgICAgICAgICAgT2JzZXJ2ZXIuZW5zdXJlUGF0aChjb21waWxlci5kYXRhLCBrZXkpXG5cdCAgICAgICAgICAgIHZhciBwYXJlbnRLZXkgPSBrZXkuc2xpY2UoMCwga2V5Lmxhc3RJbmRleE9mKCcuJykpXG5cdCAgICAgICAgICAgIGlmICghYmluZGluZ3NbcGFyZW50S2V5XSkge1xuXHQgICAgICAgICAgICAgICAgLy8gdGhpcyBpcyBhIG5lc3RlZCB2YWx1ZSBiaW5kaW5nLCBidXQgdGhlIGJpbmRpbmcgZm9yIGl0cyBwYXJlbnRcblx0ICAgICAgICAgICAgICAgIC8vIGhhcyBub3QgYmVlbiBjcmVhdGVkIHlldC4gV2UgYmV0dGVyIGNyZWF0ZSB0aGF0IG9uZSB0b28uXG5cdCAgICAgICAgICAgICAgICBjb21waWxlci5jcmVhdGVCaW5kaW5nKHBhcmVudEtleSlcblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblx0ICAgIH1cblx0ICAgIHJldHVybiBiaW5kaW5nO1xuXHR9XG59KTtcblxuLyoqXG4gKiBjb250ZW50IHJlc29sdmUgYW5kIGNvbXBpbGVcbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHQvKipcblx0ICogIERFQUwgV0lUSCA8Q09OVEVOVD4gSU5TRVJUSU9OIFBPSU5UU1xuXHQgKiAgUEVSIFRIRSBXRUIgQ09NUE9ORU5UUyBTUEVDXG5cdCAqL1xuXHRyZXNvbHZlQ29udGVudDogZnVuY3Rpb24oKSB7XG5cdFx0dmFyIG91dGxldHMgPSBzbGljZS5jYWxsKHRoaXMuZWwuZ2V0RWxlbWVudHNCeVRhZ05hbWUoJ2NvbnRlbnQnKSksXG5cdFx0XHRyYXcgPSB0aGlzLnJhd0NvbnRlbnQ7XG5cblx0XHQvLyBmaXJzdCBwYXNzLCBjb2xsZWN0IGNvcnJlc3BvbmRpbmcgY29udGVudFxuICAgICAgICAvLyBmb3IgZWFjaCBvdXRsZXQuXG5cdFx0dXRpbHMuZWFjaChvdXRsZXRzLCBmdW5jdGlvbihvdXRsZXQpe1xuXHRcdFx0aWYgKHJhdykge1xuXHRcdFx0XHRzZWxlY3QgPSBvdXRsZXQuZ2V0QXR0cmlidXRlKCdzZWxlY3QnKTtcblx0XHRcdFx0aWYgKHNlbGVjdCkge1xuXHRcdFx0XHRcdG91dGxldC5jb250ZW50ID0gc2xpY2UuY2FsbChyYXcucXVlcnlTZWxlY3RvckFsbChzZWxlY3QpKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRtYWluID0gb3V0bGV0O1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRvdXRsZXQuY29udGVudCA9IHNsaWNlLmNhbGwob3V0bGV0LmNoaWxkTm9kZXMpO1xuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0Ly8gc2Vjb25kIHBhc3MsIGFjdHVhbGx5IGluc2VydCB0aGUgY29udGVudHNcblx0XHR2YXIgaSwgaiwgY291dGxldDtcbiAgICAgICAgZm9yIChpID0gMCwgaiA9IG91dGxldHMubGVuZ3RoOyBpIDwgajsgaSsrKSB7XG4gICAgICAgICAgICBvdXRsZXQgPSBvdXRsZXRzW2ldXG4gICAgICAgICAgICBpZiAob3V0bGV0ID09PSBtYWluKSBjb250aW51ZVxuICAgICAgICAgICAgaW5zZXJ0KG91dGxldCwgb3V0bGV0LmNvbnRlbnQpXG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBpbnNlcnQgKG91dGxldCwgY29udGVudHMpIHtcblx0ICAgICAgICB2YXIgcGFyZW50ID0gb3V0bGV0LnBhcmVudE5vZGUsXG5cdCAgICAgICAgICAgIGkgPSAwLCBqID0gY29udGVudHMubGVuZ3RoXG5cdCAgICAgICAgZm9yICg7IGkgPCBqOyBpKyspIHtcblx0ICAgICAgICAgICAgcGFyZW50Lmluc2VydEJlZm9yZShjb250ZW50c1tpXSwgb3V0bGV0KVxuXHQgICAgICAgIH1cblx0ICAgICAgICBwYXJlbnQucmVtb3ZlQ2hpbGQob3V0bGV0KTtcblx0ICAgIH1cblxuXHQgICAgdGhpcy5yYXdDb250ZW50ID0gbnVsbFxuXHR9LFxuXHRjb21waWxlOiBmdW5jdGlvbihub2RlLCByb290KXtcblx0XHR2YXIgbm9kZVR5cGUgPSBub2RlLm5vZGVUeXBlXG5cdCAgICAvLyBhIG5vcm1hbCBub2RlXG5cdCAgICBpZiAobm9kZVR5cGUgPT09IDEgJiYgbm9kZS50YWdOYW1lICE9PSAnU0NSSVBUJykgeyBcblx0ICAgICAgICB0aGlzLmNvbXBpbGVFbGVtZW50KG5vZGUsIHJvb3QpO1xuXHQgICAgfSBlbHNlIGlmIChub2RlVHlwZSA9PT0gMykge1xuXHQgICAgICAgIHRoaXMuY29tcGlsZVRleHROb2RlKG5vZGUpO1xuXHQgICAgfVxuXHR9LFxuXHRjb21waWxlRWxlbWVudDogZnVuY3Rpb24obm9kZSwgcm9vdCl7XG5cdFx0Ly8gdGV4dGFyZWEgaXMgcHJldHR5IGFubm95aW5nXG5cdCAgICAvLyBiZWNhdXNlIGl0cyB2YWx1ZSBjcmVhdGVzIGNoaWxkTm9kZXMgd2hpY2hcblx0ICAgIC8vIHdlIGRvbid0IHdhbnQgdG8gY29tcGlsZS5cblx0ICAgIGlmIChub2RlLnRhZ05hbWUgPT09ICdURVhUQVJFQScgJiYgbm9kZS52YWx1ZSkge1xuXHQgICAgICAgIG5vZGUudmFsdWUgPSB0aGlzLmV2YWwobm9kZS52YWx1ZSk7XG5cdCAgICB9XG5cblxuXHQgICAgLy8gb25seSBjb21waWxlIGlmIHRoaXMgZWxlbWVudCBoYXMgYXR0cmlidXRlc1xuXHQgICAgLy8gb3IgaXRzIHRhZ05hbWUgY29udGFpbnMgYSBoeXBoZW4gKHdoaWNoIG1lYW5zIGl0IGNvdWxkXG5cdCAgICAvLyBwb3RlbnRpYWxseSBiZSBhIGN1c3RvbSBlbGVtZW50KVxuXHQgICAgaWYgKG5vZGUuaGFzQXR0cmlidXRlcygpIHx8IG5vZGUudGFnTmFtZS5pbmRleE9mKCctJykgPiAtMSkge1xuXHRcdCAgICBjb25zb2xlLmxvZygnXFxuXFxuLS0tLS0tLS0tLS0tLWNvbXBpbGU6ICcsIG5vZGUpO1xuXG5cdCAgICBcdC8vIHNraXAgYW55dGhpbmcgd2l0aCB2LXByZVxuXHQgICAgICAgIGlmICh1dGlscy5kb20uYXR0cihub2RlLCAncHJlJykgIT09IG51bGwpIHtcblx0ICAgICAgICAgICAgcmV0dXJuO1xuXHQgICAgICAgIH1cblxuXHQgICAgICAgIHZhciBpLCBsLCBqLCBrO1xuXG5cdCAgICAgICAgLy8gY2hlY2sgcHJpb3JpdHkgZGlyZWN0aXZlcy5cblx0ICAgICAgICAvLyBpZiBhbnkgb2YgdGhlbSBhcmUgcHJlc2VudCwgaXQgd2lsbCB0YWtlIG92ZXIgdGhlIG5vZGUgd2l0aCBhIGNoaWxkVk1cblx0ICAgICAgICAvLyBzbyB3ZSBjYW4gc2tpcCB0aGUgcmVzdFxuXHQgICAgICAgIGZvciAoaSA9IDAsIGwgPSBwcmlvcml0eURpcmVjdGl2ZXMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG5cdCAgICAgICAgICAgIGlmICh0aGlzLmNoZWNrUHJpb3JpdHlEaXIocHJpb3JpdHlEaXJlY3RpdmVzW2ldLCBub2RlLCByb290KSkge1xuXHQgICAgICAgICAgICBcdGNvbnNvbGUubG9nKCdwcmVzZW50IGFuZCB0YWtlIG92ZXIgd2l0aCBhIGNoaWxkIHZtJyk7XG5cdCAgICAgICAgICAgICAgICByZXR1cm47XG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9XG5cblx0XHQgICAgdmFyIHByZWZpeCA9IGNvbmZpZy5wcmVmaXggKyAnLScsXG5cdCAgICAgICAgICAgIHBhcmFtcyA9IHRoaXMub3B0aW9ucy5wYXJhbUF0dHJpYnV0ZXMsXG5cdCAgICAgICAgICAgIGF0dHIsIGF0dHJuYW1lLCBpc0RpcmVjdGl2ZSwgZXhwLCBkaXJlY3RpdmVzLCBkaXJlY3RpdmUsIGRpcm5hbWU7XG5cblx0ICAgICAgICAvLyB2LXdpdGggaGFzIHNwZWNpYWwgcHJpb3JpdHkgYW1vbmcgdGhlIHJlc3Rcblx0ICAgICAgICAvLyBpdCBuZWVkcyB0byBwdWxsIGluIHRoZSB2YWx1ZSBmcm9tIHRoZSBwYXJlbnQgYmVmb3JlXG5cdCAgICAgICAgLy8gY29tcHV0ZWQgcHJvcGVydGllcyBhcmUgZXZhbHVhdGVkLCBiZWNhdXNlIGF0IHRoaXMgc3RhZ2Vcblx0ICAgICAgICAvLyB0aGUgY29tcHV0ZWQgcHJvcGVydGllcyBoYXZlIG5vdCBzZXQgdXAgdGhlaXIgZGVwZW5kZW5jaWVzIHlldC5cblx0ICAgICAgICBpZiAocm9vdCkge1xuXHQgICAgICAgICAgICB2YXIgd2l0aEV4cCA9IHV0aWxzLmRvbS5hdHRyKG5vZGUsICd3aXRoJyk7XG5cdCAgICAgICAgICAgIGlmICh3aXRoRXhwKSB7XG5cdCAgICAgICAgICAgICAgICBkaXJlY3RpdmVzID0gdGhpcy5wYXJzZURpcmVjdGl2ZSgnd2l0aCcsIHdpdGhFeHAsIG5vZGUsIHRydWUpXG5cdCAgICAgICAgICAgICAgICBmb3IgKGogPSAwLCBrID0gZGlyZWN0aXZlcy5sZW5ndGg7IGogPCBrOyBqKyspIHtcblx0ICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlc1tqXSwgdGhpcy5wYXJlbnQpXG5cdCAgICAgICAgICAgICAgICB9XG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9XG5cblx0ICAgICAgICB2YXIgYXR0cnMgPSBzbGljZS5jYWxsKG5vZGUuYXR0cmlidXRlcyk7XG5cdCAgICAgICAgZm9yIChpID0gMCwgbCA9IGF0dHJzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuXG5cdCAgICAgICAgICAgIGF0dHIgPSBhdHRyc1tpXVxuXHQgICAgICAgICAgICBhdHRybmFtZSA9IGF0dHIubmFtZVxuXHQgICAgICAgICAgICBpc0RpcmVjdGl2ZSA9IGZhbHNlXG5cblx0ICAgICAgICAgICAgaWYgKGF0dHJuYW1lLmluZGV4T2YocHJlZml4KSA9PT0gMCkge1xuXG5cdCAgICAgICAgICAgICAgICAvLyBhIGRpcmVjdGl2ZSAtIHNwbGl0LCBwYXJzZSBhbmQgYmluZCBpdC5cblx0ICAgICAgICAgICAgICAgIGlzRGlyZWN0aXZlID0gdHJ1ZVxuXHQgICAgICAgICAgICAgICAgZGlybmFtZSA9IGF0dHJuYW1lLnNsaWNlKHByZWZpeC5sZW5ndGgpXG5cdCAgICAgICAgICAgICAgICAvLyBidWlsZCB3aXRoIG11bHRpcGxlOiB0cnVlXG5cdCAgICAgICAgICAgICAgICBkaXJlY3RpdmVzID0gdGhpcy5wYXJzZURpcmVjdGl2ZShkaXJuYW1lLCBhdHRyLnZhbHVlLCBub2RlLCB0cnVlKVxuXHQgICAgICAgICAgICAgICAgLy8gbG9vcCB0aHJvdWdoIGNsYXVzZXMgKHNlcGFyYXRlZCBieSBcIixcIilcblx0ICAgICAgICAgICAgICAgIC8vIGluc2lkZSBlYWNoIGF0dHJpYnV0ZVxuXHQgICAgICAgICAgICAgICAgZm9yIChqID0gMCwgayA9IGRpcmVjdGl2ZXMubGVuZ3RoOyBqIDwgazsgaisrKSB7XG5cdCAgICAgICAgICAgICAgICAgICAgdGhpcy5iaW5kRGlyZWN0aXZlKGRpcmVjdGl2ZXNbal0pXG5cdCAgICAgICAgICAgICAgICB9XG5cdCAgICAgICAgICAgIH0gZWxzZSB7XG5cdCAgICAgICAgICAgICAgICAvLyBub24gZGlyZWN0aXZlIGF0dHJpYnV0ZSwgY2hlY2sgaW50ZXJwb2xhdGlvbiB0YWdzXG5cdCAgICAgICAgICAgICAgICBleHAgPSBUZXh0UGFyc2VyLnBhcnNlQXR0cihhdHRyLnZhbHVlKVxuXHQgICAgICAgICAgICAgICAgaWYgKGV4cCkge1xuXHRcdCAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnaW50ZXJwb2xhdGlvbjogJywgYXR0ci52YWx1ZSwgZXhwKVxuXHQgICAgICAgICAgICAgICAgICAgIGRpcmVjdGl2ZSA9IHRoaXMucGFyc2VEaXJlY3RpdmUoJ2F0dHInLCBleHAsIG5vZGUpXG5cdCAgICAgICAgICAgICAgICAgICAgZGlyZWN0aXZlLmFyZyA9IGF0dHJuYW1lXG5cdCAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBwYXJhbXMuaW5kZXhPZihhdHRybmFtZSkgPiAtMSkge1xuXHQgICAgICAgICAgICAgICAgICAgICAgICAvLyBhIHBhcmFtIGF0dHJpYnV0ZS4uLiB3ZSBzaG91bGQgdXNlIHRoZSBwYXJlbnQgYmluZGluZ1xuXHQgICAgICAgICAgICAgICAgICAgICAgICAvLyB0byBhdm9pZCBjaXJjdWxhciB1cGRhdGVzIGxpa2Ugc2l6ZT17e3NpemV9fVxuXHQgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlLCB0aGlzLnBhcmVudClcblx0ICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuXHQgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlKVxuXHQgICAgICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgfVxuXG5cdCAgICAgICAgICAgIGlmIChpc0RpcmVjdGl2ZSAmJiBkaXJuYW1lICE9PSAnY2xvYWsnKSB7XG5cdCAgICAgICAgICAgICAgICBub2RlLnJlbW92ZUF0dHJpYnV0ZShhdHRybmFtZSlcblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblxuXHQgICAgfVxuICAgICAgICAvLyByZWN1cnNpdmVseSBjb21waWxlIGNoaWxkTm9kZXNcblx0ICAgIGlmIChub2RlLmhhc0NoaWxkTm9kZXMoKSkge1xuXHQgICAgICAgIHNsaWNlLmNhbGwobm9kZS5jaGlsZE5vZGVzKS5mb3JFYWNoKHRoaXMuY29tcGlsZSwgdGhpcyk7XG5cdCAgICB9XG5cdH0sXG5cdGNvbXBpbGVUZXh0Tm9kZTogZnVuY3Rpb24gKG5vZGUpIHtcblx0ICAgIHZhciB0b2tlbnMgPSBUZXh0UGFyc2VyLnBhcnNlKG5vZGUubm9kZVZhbHVlKVxuXHQgICAgaWYgKCF0b2tlbnMpIHJldHVybjtcblx0ICAgIGNvbnNvbGUubG9nKCdcXG5cXG4tLS0tLS0tLS0tLS1jb21waWxlIHRleHROb2RlOicsIG5vZGUsIHRva2Vucyk7XG5cdCAgICB2YXIgZWwsIHRva2VuLCBkaXJlY3RpdmU7XG5cblx0ICAgIGZvciAodmFyIGkgPSAwLCBsID0gdG9rZW5zLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuXG5cdCAgICAgICAgdG9rZW4gPSB0b2tlbnNbaV07XG5cdCAgICAgICAgZGlyZWN0aXZlID0gbnVsbDtcblxuXHQgICAgICAgIGlmICh0b2tlbi5rZXkpIHsgLy8gYSBiaW5kaW5nXG5cdCAgICAgICAgICAgIGlmICh0b2tlbi5rZXkuY2hhckF0KDApID09PSAnPicpIHsgLy8gYSBwYXJ0aWFsXG5cdCAgICAgICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZUNvbW1lbnQoJ3JlZicpO1xuXHQgICAgICAgICAgICAgICAgZGlyZWN0aXZlID0gdGhpcy5wYXJzZURpcmVjdGl2ZSgncGFydGlhbCcsIHRva2VuLmtleS5zbGljZSgxKSwgZWwpO1xuXHQgICAgICAgICAgICB9IGVsc2Uge1xuXHQgICAgICAgICAgICAgICAgaWYgKCF0b2tlbi5odG1sKSB7IFxuXHQgICAgICAgICAgICAgICAgXHQvLyB0ZXh0IGJpbmRpbmdcblx0ICAgICAgICAgICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKCcnKTtcblx0ICAgICAgICAgICAgICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCd0ZXh0JywgdG9rZW4ua2V5LCBlbCk7XG5cdCAgICAgICAgICAgICAgICB9IGVsc2UgeyAvLyBodG1sIGJpbmRpbmdcblx0ICAgICAgICAgICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZUNvbW1lbnQoY29uZmlnLnByZWZpeCArICctaHRtbCcpXG5cdCAgICAgICAgICAgICAgICAgICAgZGlyZWN0aXZlID0gdGhpcy5wYXJzZURpcmVjdGl2ZSgnaHRtbCcsIHRva2VuLmtleSwgZWwpO1xuXHQgICAgICAgICAgICAgICAgfVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfSBlbHNlIHsgXG5cdCAgICAgICAgXHQvLyBhIHBsYWluIHN0cmluZ1xuXHQgICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHRva2VuKVxuXHQgICAgICAgIH1cblxuXHQgICAgICAgIC8vIGluc2VydCBub2RlXG5cdCAgICAgICAgbm9kZS5wYXJlbnROb2RlLmluc2VydEJlZm9yZShlbCwgbm9kZSk7XG5cblx0ICAgICAgICAvLyBiaW5kIGRpcmVjdGl2ZVxuXHQgICAgICAgIHRoaXMuYmluZERpcmVjdGl2ZShkaXJlY3RpdmUpO1xuXG5cdCAgICB9XG5cblx0ICAgIG5vZGUucGFyZW50Tm9kZS5yZW1vdmVDaGlsZChub2RlKVxuXHR9XG59KTtcblxuLyoqXG4gKiBkaXJlY3RpdmUgc3R1ZmZcbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHQvKipcblx0ICogIENoZWNrIGZvciBhIHByaW9yaXR5IGRpcmVjdGl2ZVxuXHQgKiAgSWYgaXQgaXMgcHJlc2VudCBhbmQgdmFsaWQsIHJldHVybiB0cnVlIHRvIHNraXAgdGhlIHJlc3Rcblx0ICovXG5cdGNoZWNrUHJpb3JpdHlEaXI6IGZ1bmN0aW9uKGRpcm5hbWUsIG5vZGUsIHJvb3Qpe1xuXHRcdHZhciBleHByZXNzaW9uLCBkaXJlY3RpdmUsIEN0b3Jcblx0ICAgIGlmIChcblx0ICAgICAgICBkaXJuYW1lID09PSAnY29tcG9uZW50JyAmJlxuXHQgICAgICAgIHJvb3QgIT09IHRydWUgJiZcblx0ICAgICAgICAoQ3RvciA9IHRoaXMucmVzb2x2ZUNvbXBvbmVudChub2RlLCB1bmRlZmluZWQsIHRydWUpKVxuXHQgICAgKSB7XG5cdCAgICAgICAgZGlyZWN0aXZlID0gdGhpcy5wYXJzZURpcmVjdGl2ZShkaXJuYW1lLCAnJywgbm9kZSlcblx0ICAgICAgICBkaXJlY3RpdmUuQ3RvciA9IEN0b3Jcblx0ICAgIH0gZWxzZSB7XG5cdCAgICAgICAgZXhwcmVzc2lvbiA9IHV0aWxzLmRvbS5hdHRyKG5vZGUsIGRpcm5hbWUpXG5cdCAgICAgICAgZGlyZWN0aXZlID0gZXhwcmVzc2lvbiAmJiB0aGlzLnBhcnNlRGlyZWN0aXZlKGRpcm5hbWUsIGV4cHJlc3Npb24sIG5vZGUpO1xuXHQgICAgfVxuXHQgICAgaWYgKGRpcmVjdGl2ZSkge1xuXHQgICAgICAgIGlmIChyb290ID09PSB0cnVlKSB7XG5cdCAgICAgICAgICAgIHV0aWxzLndhcm4oXG5cdCAgICAgICAgICAgICAgICAnRGlyZWN0aXZlIHYtJyArIGRpcm5hbWUgKyAnIGNhbm5vdCBiZSB1c2VkIG9uIGFuIGFscmVhZHkgaW5zdGFudGlhdGVkICcgK1xuXHQgICAgICAgICAgICAgICAgJ1ZNXFwncyByb290IG5vZGUuIFVzZSBpdCBmcm9tIHRoZSBwYXJlbnRcXCdzIHRlbXBsYXRlIGluc3RlYWQuJ1xuXHQgICAgICAgICAgICApXG5cdCAgICAgICAgICAgIHJldHVyblxuXHQgICAgICAgIH1cblx0ICAgICAgICB0aGlzLmRlZmVycmVkLnB1c2goZGlyZWN0aXZlKTtcblx0ICAgICAgICByZXR1cm4gdHJ1ZVxuXHQgICAgfVxuXHR9LFxuXHRwYXJzZURpcmVjdGl2ZTogZnVuY3Rpb24gKG5hbWUsIHZhbHVlLCBlbCwgbXVsdGlwbGUpIHtcblx0ICAgIHZhciBjb21waWxlciA9IHRoaXMsXG5cdCAgICAgICAgZGVmaW5pdGlvbiA9IGNvbXBpbGVyLmdldE9wdGlvbignZGlyZWN0aXZlcycsIG5hbWUpO1xuXHQgICAgaWYgKGRlZmluaXRpb24pIHtcblx0ICAgICAgICAvLyBwYXJzZSBpbnRvIEFTVC1saWtlIG9iamVjdHNcblx0ICAgICAgICB2YXIgYXN0cyA9IERpcmVjdGl2ZS5wYXJzZSh2YWx1ZSlcblx0ICAgICAgICByZXR1cm4gbXVsdGlwbGVcblx0ICAgICAgICAgICAgPyBhc3RzLm1hcChidWlsZClcblx0ICAgICAgICAgICAgOiBidWlsZChhc3RzWzBdKVxuXHQgICAgfVxuXHQgICAgZnVuY3Rpb24gYnVpbGQgKGFzdCkge1xuXHQgICAgICAgIHJldHVybiBuZXcgRGlyZWN0aXZlKG5hbWUsIGFzdCwgZGVmaW5pdGlvbiwgY29tcGlsZXIsIGVsKVxuXHQgICAgfVxuXHR9LFxuXHRiaW5kRGlyZWN0aXZlOiBmdW5jdGlvbiAoZGlyZWN0aXZlLCBiaW5kaW5nT3duZXIpIHtcblxuXHQgICAgaWYgKCFkaXJlY3RpdmUpIHJldHVybjtcblxuXHQgICAgLy8ga2VlcCB0cmFjayBvZiBpdCBzbyB3ZSBjYW4gdW5iaW5kKCkgbGF0ZXJcblx0ICAgIHRoaXMuZGlycy5wdXNoKGRpcmVjdGl2ZSk7XG5cblx0ICAgIC8vIGZvciBlbXB0eSBvciBsaXRlcmFsIGRpcmVjdGl2ZXMsIHNpbXBseSBjYWxsIGl0cyBiaW5kKClcblx0ICAgIC8vIGFuZCB3ZSdyZSBkb25lLlxuXHQgICAgaWYgKGRpcmVjdGl2ZS5pc0VtcHR5IHx8IGRpcmVjdGl2ZS5pc0xpdGVyYWwpIHtcblx0ICAgICAgICBpZiAoZGlyZWN0aXZlLmJpbmQpIGRpcmVjdGl2ZS5iaW5kKClcblx0ICAgICAgICByZXR1cm5cblx0ICAgIH1cblx0ICAgIC8vIG90aGVyd2lzZSwgd2UgZ290IG1vcmUgd29yayB0byBkby4uLlxuXHQgICAgdmFyIGJpbmRpbmcsXG5cdCAgICAgICAgY29tcGlsZXIgPSBiaW5kaW5nT3duZXIgfHwgdGhpcyxcblx0ICAgICAgICBrZXkgICAgICA9IGRpcmVjdGl2ZS5rZXlcblxuXHQgICAgaWYgKGRpcmVjdGl2ZS5pc0V4cCkge1xuXHQgICAgICAgIC8vIGV4cHJlc3Npb24gYmluZGluZ3MgYXJlIGFsd2F5cyBjcmVhdGVkIG9uIGN1cnJlbnQgY29tcGlsZXJcblx0ICAgICAgICBiaW5kaW5nID0gY29tcGlsZXIuY3JlYXRlQmluZGluZyhrZXksIGRpcmVjdGl2ZSk7XG5cdCAgICB9IGVsc2Uge1xuXHQgICAgICAgIC8vIHJlY3Vyc2l2ZWx5IGxvY2F0ZSB3aGljaCBjb21waWxlciBvd25zIHRoZSBiaW5kaW5nXG5cdCAgICAgICAgd2hpbGUgKGNvbXBpbGVyKSB7XG5cdCAgICAgICAgICAgIGlmIChjb21waWxlci5oYXNLZXkoa2V5KSkge1xuXHQgICAgICAgICAgICAgICAgYnJlYWtcblx0ICAgICAgICAgICAgfSBlbHNlIHtcblx0ICAgICAgICAgICAgICAgIGNvbXBpbGVyID0gY29tcGlsZXIucGFyZW50XG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9XG5cdCAgICAgICAgY29tcGlsZXIgPSBjb21waWxlciB8fCB0aGlzXG5cdCAgICAgICAgYmluZGluZyA9IGNvbXBpbGVyLmJpbmRpbmdzW2tleV0gfHwgY29tcGlsZXIuY3JlYXRlQmluZGluZyhrZXkpXG5cdCAgICB9XG5cdCAgICBiaW5kaW5nLmRpcnMucHVzaChkaXJlY3RpdmUpXG5cdCAgICBkaXJlY3RpdmUuYmluZGluZyA9IGJpbmRpbmdcblxuXHQgICAgdmFyIHZhbHVlID0gYmluZGluZy52YWwoKVxuXHQgICAgLy8gaW52b2tlIGJpbmQgaG9vayBpZiBleGlzdHNcblx0ICAgIGlmIChkaXJlY3RpdmUuYmluZCkge1xuXHQgICAgICAgIGRpcmVjdGl2ZS5iaW5kKHZhbHVlKVxuXHQgICAgfVxuXHQgICAgLy8gc2V0IGluaXRpYWwgdmFsdWVcblx0ICAgIGRpcmVjdGl2ZS4kdXBkYXRlKHZhbHVlLCB0cnVlKVxuXHR9XG59KTtcblxuLyoqKlxuICogZGVmaW5lIHByb3BlcnRpZXNcbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHQvKipcblx0ICogIERlZmluZSB0aGUgZ2V0dGVyL3NldHRlciB0byBwcm94eSBhIHJvb3QtbGV2ZWxcblx0ICogIGRhdGEgcHJvcGVydHkgb24gdGhlIFZNXG5cdCAqL1xuXHRkZWZpbmVEYXRhUHJvcDogZnVuY3Rpb24gKGtleSwgYmluZGluZykge1xuXHQgICAgdmFyIGNvbXBpbGVyID0gdGhpcyxcblx0ICAgICAgICBkYXRhICAgICA9IGNvbXBpbGVyLmRhdGEsXG5cdCAgICAgICAgb2IgICAgICAgPSBkYXRhLl9fZW1pdHRlcl9fO1xuXG5cdCAgICAvLyBtYWtlIHN1cmUgdGhlIGtleSBpcyBwcmVzZW50IGluIGRhdGFcblx0ICAgIC8vIHNvIGl0IGNhbiBiZSBvYnNlcnZlZFxuXHQgICAgaWYgKCEoaGFzT3duLmNhbGwoZGF0YSwga2V5KSkpIHtcblx0ICAgICAgICBkYXRhW2tleV0gPSB1bmRlZmluZWRcblx0ICAgIH1cblxuXHQgICAgLy8gaWYgdGhlIGRhdGEgb2JqZWN0IGlzIGFscmVhZHkgb2JzZXJ2ZWQsIGJ1dCB0aGUga2V5XG5cdCAgICAvLyBpcyBub3Qgb2JzZXJ2ZWQsIHdlIG5lZWQgdG8gYWRkIGl0IHRvIHRoZSBvYnNlcnZlZCBrZXlzLlxuXHQgICAgaWYgKG9iICYmICEoaGFzT3duLmNhbGwob2IudmFsdWVzLCBrZXkpKSkge1xuXHQgICAgICAgIE9ic2VydmVyLmNvbnZlcnRLZXkoZGF0YSwga2V5KVxuXHQgICAgfVxuXG5cdCAgICBiaW5kaW5nLnZhbHVlID0gZGF0YVtrZXldXG5cblx0ICAgIGRlZihjb21waWxlci52bSwga2V5LCB7XG5cdCAgICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG5cdCAgICAgICAgICAgIHJldHVybiBjb21waWxlci5kYXRhW2tleV1cblx0ICAgICAgICB9LFxuXHQgICAgICAgIHNldDogZnVuY3Rpb24gKHZhbCkge1xuXHQgICAgICAgICAgICBjb21waWxlci5kYXRhW2tleV0gPSB2YWxcblx0ICAgICAgICB9XG5cdCAgICB9KTtcblx0fSxcblx0ZGVmaW5lVm1Qcm9wOiBmdW5jdGlvbiAoa2V5LCBiaW5kaW5nLCB2YWx1ZSkge1xuXHQgICAgdmFyIG9iID0gdGhpcy5vYnNlcnZlclxuXHQgICAgYmluZGluZy52YWx1ZSA9IHZhbHVlXG5cdCAgICBkZWYodGhpcy52bSwga2V5LCB7XG5cdCAgICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG5cdCAgICAgICAgICAgIGlmIChPYnNlcnZlci5zaG91bGRHZXQpIG9iLmVtaXQoJ2dldCcsIGtleSlcblx0ICAgICAgICAgICAgcmV0dXJuIGJpbmRpbmcudmFsdWVcblx0ICAgICAgICB9LFxuXHQgICAgICAgIHNldDogZnVuY3Rpb24gKHZhbCkge1xuXHQgICAgICAgICAgICBvYi5lbWl0KCdzZXQnLCBrZXksIHZhbClcblx0ICAgICAgICB9XG5cdCAgICB9KVxuXHR9LFxuXHRkZWZpbmVFeHA6IGZ1bmN0aW9uIChrZXksIGJpbmRpbmcsIGRpcmVjdGl2ZSkge1xuXHQgICAgdmFyIGNvbXB1dGVkS2V5ID0gZGlyZWN0aXZlICYmIGRpcmVjdGl2ZS5jb21wdXRlZEtleSxcblx0ICAgICAgICBleHAgICAgICAgICA9IGNvbXB1dGVkS2V5ID8gZGlyZWN0aXZlLmV4cHJlc3Npb24gOiBrZXksXG5cdCAgICAgICAgZ2V0dGVyICAgICAgPSB0aGlzLmV4cENhY2hlW2V4cF1cblx0ICAgIGlmICghZ2V0dGVyKSB7XG5cdCAgICAgICAgZ2V0dGVyID0gdGhpcy5leHBDYWNoZVtleHBdID0gRXhwUGFyc2VyLnBhcnNlKGNvbXB1dGVkS2V5IHx8IGtleSwgdGhpcyk7XG5cdCAgICB9XG5cdCAgICBpZiAoZ2V0dGVyKSB7XG5cdCAgICAgICAgdGhpcy5tYXJrQ29tcHV0ZWQoYmluZGluZywgZ2V0dGVyKVxuXHQgICAgfVxuXHR9LFxuXHRkZWZpbmVDb21wdXRlZDogZnVuY3Rpb24gKGtleSwgYmluZGluZywgdmFsdWUpIHtcblx0ICAgIHRoaXMubWFya0NvbXB1dGVkKGJpbmRpbmcsIHZhbHVlKVxuXHQgICAgZGVmKHRoaXMudm0sIGtleSwge1xuXHQgICAgICAgIGdldDogYmluZGluZy52YWx1ZS4kZ2V0LFxuXHQgICAgICAgIHNldDogYmluZGluZy52YWx1ZS4kc2V0XG5cdCAgICB9KVxuXHR9LFxuXHRtYXJrQ29tcHV0ZWQ6IGZ1bmN0aW9uIChiaW5kaW5nLCB2YWx1ZSkge1xuXHQgICAgYmluZGluZy5pc0NvbXB1dGVkID0gdHJ1ZVxuXHQgICAgLy8gYmluZCB0aGUgYWNjZXNzb3JzIHRvIHRoZSB2bVxuXHQgICAgaWYgKGJpbmRpbmcuaXNGbikge1xuXHQgICAgICAgIGJpbmRpbmcudmFsdWUgPSB2YWx1ZVxuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7XG5cdCAgICAgICAgICAgIHZhbHVlID0geyAkZ2V0OiB2YWx1ZSB9XG5cdCAgICAgICAgfVxuXHQgICAgICAgIGJpbmRpbmcudmFsdWUgPSB7XG5cdCAgICAgICAgICAgICRnZXQ6IHV0aWxzLm9iamVjdC5iaW5kKHZhbHVlLiRnZXQsIHRoaXMudm0pLFxuXHQgICAgICAgICAgICAkc2V0OiB2YWx1ZS4kc2V0XG5cdCAgICAgICAgICAgICAgICA/IHV0aWxzLm9iamVjdC5iaW5kKHZhbHVlLiRzZXQsIHRoaXMudm0pXG5cdCAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZFxuXHQgICAgICAgIH1cblx0ICAgIH1cblx0ICAgIC8vIGtlZXAgdHJhY2sgZm9yIGRlcCBwYXJzaW5nIGxhdGVyXG5cdCAgICB0aGlzLmNvbXB1dGVkLnB1c2goYmluZGluZylcblx0fVxufSk7XG5cbi8qKlxuICogdXRpbGl0eSBmb3IgY29taXBsZXJcbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHRleGVjSG9vazogZnVuY3Rpb24gKGV2ZW50KSB7XG5cdCAgICBldmVudCA9ICdob29rOicgKyBldmVudDtcblx0ICAgIHRoaXMub2JzZXJ2ZXIuZW1pdChldmVudCk7XG5cdCAgICB0aGlzLmVtaXR0ZXIuZW1pdChldmVudCk7XG5cdH0sXG5cdGhhc0tleTogZnVuY3Rpb24gKGtleSkge1xuXHQgICAgdmFyIGJhc2VLZXkgPSB1dGlscy5vYmplY3QuYmFzZUtleShrZXkpXG5cdCAgICByZXR1cm4gaGFzT3duLmNhbGwodGhpcy5kYXRhLCBiYXNlS2V5KSB8fFxuXHQgICAgICAgIGhhc093bi5jYWxsKHRoaXMudm0sIGJhc2VLZXkpXG5cdH0sXG5cdC8qKlxuXHQgKiAgRG8gYSBvbmUtdGltZSBldmFsIG9mIGEgc3RyaW5nIHRoYXQgcG90ZW50aWFsbHlcblx0ICogIGluY2x1ZGVzIGJpbmRpbmdzLiBJdCBhY2NlcHRzIGFkZGl0aW9uYWwgcmF3IGRhdGFcblx0ICogIGJlY2F1c2Ugd2UgbmVlZCB0byBkeW5hbWljYWxseSByZXNvbHZlIHYtY29tcG9uZW50XG5cdCAqICBiZWZvcmUgYSBjaGlsZFZNIGlzIGV2ZW4gY29tcGlsZWQuLi5cblx0ICovXG5cdGV2YWw6IGZ1bmN0aW9uIChleHAsIGRhdGEpIHtcblx0ICAgIHZhciBwYXJzZWQgPSBUZXh0UGFyc2VyLnBhcnNlQXR0cihleHApO1xuXHQgICAgcmV0dXJuIHBhcnNlZFxuXHQgICAgICAgID8gRXhwUGFyc2VyLmV2YWwocGFyc2VkLCB0aGlzLCBkYXRhKVxuXHQgICAgICAgIDogZXhwO1xuXHR9LFxuXHRyZXNvbHZlQ29tcG9uZW50OiBmdW5jdGlvbihub2RlLCBkYXRhLCB0ZXN0KXtcblx0XHQvLyBsYXRlIHJlcXVpcmUgdG8gYXZvaWQgY2lyY3VsYXIgZGVwc1xuXHQgICAgVmlld01vZGVsID0gVmlld01vZGVsIHx8IHJlcXVpcmUoJy4vdmlld21vZGVsJylcblxuXHQgICAgdmFyIGV4cCAgICAgPSB1dGlscy5kb20uYXR0cihub2RlLCAnY29tcG9uZW50JyksXG5cdCAgICAgICAgdGFnTmFtZSA9IG5vZGUudGFnTmFtZSxcblx0ICAgICAgICBpZCAgICAgID0gdGhpcy5ldmFsKGV4cCwgZGF0YSksXG5cdCAgICAgICAgdGFnSWQgICA9ICh0YWdOYW1lLmluZGV4T2YoJy0nKSA+IDAgJiYgdGFnTmFtZS50b0xvd2VyQ2FzZSgpKSxcblx0ICAgICAgICBDdG9yICAgID0gdGhpcy5nZXRPcHRpb24oJ2NvbXBvbmVudHMnLCBpZCB8fCB0YWdJZCwgdHJ1ZSlcblxuXHQgICAgaWYgKGlkICYmICFDdG9yKSB7XG5cdCAgICAgICAgdXRpbHMud2FybignVW5rbm93biBjb21wb25lbnQ6ICcgKyBpZClcblx0ICAgIH1cblxuXHQgICAgcmV0dXJuIHRlc3Rcblx0ICAgICAgICA/IGV4cCA9PT0gJydcblx0ICAgICAgICAgICAgPyBWaWV3TW9kZWxcblx0ICAgICAgICAgICAgOiBDdG9yXG5cdCAgICAgICAgOiBDdG9yIHx8IFZpZXdNb2RlbDtcblx0fSxcblx0LyoqXG5cdCAqICBSZXRyaXZlIGFuIG9wdGlvbiBmcm9tIHRoZSBjb21waWxlclxuXHQgKi9cblx0Z2V0T3B0aW9uOiBmdW5jdGlvbih0eXBlLCBpZCwgc2lsZW50KXtcblx0XHR2YXIgb3B0aW9ucyA9IHRoaXMub3B0aW9ucyxcblx0ICAgICAgICBwYXJlbnQgPSB0aGlzLnBhcmVudCxcblx0ICAgICAgICBnbG9iYWxBc3NldHMgPSBjb25maWcuZ2xvYmFsQXNzZXRzLFxuXHQgICAgICAgIHJlcyA9IChvcHRpb25zW3R5cGVdICYmIG9wdGlvbnNbdHlwZV1baWRdKSB8fCAoXG5cdCAgICAgICAgICAgIHBhcmVudFxuXHQgICAgICAgICAgICAgICAgPyBwYXJlbnQuZ2V0T3B0aW9uKHR5cGUsIGlkLCBzaWxlbnQpXG5cdCAgICAgICAgICAgICAgICA6IGdsb2JhbEFzc2V0c1t0eXBlXSAmJiBnbG9iYWxBc3NldHNbdHlwZV1baWRdXG5cdCAgICAgICAgKTtcblx0ICAgIGlmICghcmVzICYmICFzaWxlbnQgJiYgdHlwZW9mIGlkID09PSAnc3RyaW5nJykge1xuXHQgICAgICAgIHV0aWxzLndhcm4oJ1Vua25vd24gJyArIHR5cGUuc2xpY2UoMCwgLTEpICsgJzogJyArIGlkKVxuXHQgICAgfVxuXHQgICAgcmV0dXJuIHJlcztcblx0fVxufSk7XG5cbm1vZHVsZS5leHBvcnRzID0gQ29tcGlsZXI7IiwibW9kdWxlLmV4cG9ydHMgPSB7XG5cdHByZWZpeDogJ3YnLFxuXHRkZWJ1ZzogdHJ1ZVxufSIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcbmZ1bmN0aW9uIERlZmVycmVkKCkge1xuICAgIHZhciBET05FID0gJ2RvbmUnLFxuICAgICAgICBGQUlMID0gJ2ZhaWwnLFxuICAgICAgICBQRU5ESU5HID0gJ3BlbmRpbmcnO1xuICAgIHZhciBzdGF0ZSA9IFBFTkRJTkc7XG4gICAgdmFyIGNhbGxiYWNrcyA9IHtcbiAgICAgICAgJ2RvbmUnOiBbXSxcbiAgICAgICAgJ2ZhaWwnOiBbXSxcbiAgICAgICAgJ2Fsd2F5cyc6IFtdXG4gICAgfTtcbiAgICB2YXIgYXJncyA9IFtdO1xuICAgIHZhciBjb250ZXh0O1xuXG4gICAgZnVuY3Rpb24gZGlzcGF0Y2goY2JzKSB7XG4gICAgICAgIHZhciBjYjtcbiAgICAgICAgd2hpbGUgKChjYiA9IGNicy5zaGlmdCgpKSB8fCAoY2IgPSBjYWxsYmFja3MuYWx3YXlzLnNoaWZ0KCkpKSB7XG4gICAgICAgICAgICB1dGlscy5uZXh0VGljaygoZnVuY3Rpb24oZm4pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIGZuLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9KShjYikpO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAgIGRvbmU6IGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBpZiAoc3RhdGUgPT09IERPTkUpIHtcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBjYi5hcHBseShjb250ZXh0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICB9LCAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gUEVORElORykge1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrcy5kb25lLnB1c2goY2IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIGZhaWw6IGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBpZiAoc3RhdGUgPT09IEZBSUwpIHtcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBjYi5hcHBseShjb250ZXh0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICB9LCAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gUEVORElORykge1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrcy5mYWlsLnB1c2goY2IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIGFsd2F5czogZnVuY3Rpb24oY2IpIHtcbiAgICAgICAgICAgIGlmIChzdGF0ZSAhPT0gUEVORElORykge1xuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgIGNiLmFwcGx5KGNvbnRleHQsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH0sIDApO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhbGxiYWNrcy5hbHdheXMucHVzaChjYik7XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgdGhlbjogZnVuY3Rpb24oZG9uZUZuLCBmYWlsRm4pIHtcbiAgICAgICAgICAgIGlmICh1dGlscy5pc0Z1bmN0aW9uKGRvbmVGbikpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmRvbmUoZG9uZUZuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh1dGlscy5pc0Z1bmN0aW9uKGZhaWxGbikpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmZhaWwoZmFpbEZuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICByZXNvbHZlOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHRoaXMucmVzb2x2ZVdpdGgoe30sIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgcmVzb2x2ZVdpdGg6IGZ1bmN0aW9uKGMsIGEpIHtcbiAgICAgICAgICAgIGlmIChzdGF0ZSAhPT0gUEVORElORykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3RhdGUgPSBET05FO1xuICAgICAgICAgICAgY29udGV4dCA9IGMgfHwgdGhpcztcbiAgICAgICAgICAgIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGEgfHwgW10pO1xuICAgICAgICAgICAgZGlzcGF0Y2goY2FsbGJhY2tzLmRvbmUpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIHJlamVjdDogZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB0aGlzLnJlamVjdFdpdGgoe30sIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgcmVqZWN0V2l0aDogZnVuY3Rpb24oYywgYSkge1xuICAgICAgICAgICAgaWYgKHN0YXRlICE9PSBQRU5ESU5HKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzdGF0ZSA9IEZBSUw7XG4gICAgICAgICAgICBjb250ZXh0ID0gYyB8fCB0aGlzO1xuICAgICAgICAgICAgYXJncyA9IFtdLnNsaWNlLmNhbGwoYSB8fCBbXSk7XG4gICAgICAgICAgICBkaXNwYXRjaChjYWxsYmFja3MuZmFpbCk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgc3RhdGU6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgcmV0dXJuIHN0YXRlO1xuICAgICAgICB9LFxuICAgICAgICBwcm9taXNlOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHZhciByZXQgPSB7fSxcbiAgICAgICAgICAgICAgICBzZWxmID0gdGhpcyxcbiAgICAgICAgICAgICAgICBrZXlzID0gdXRpbHMub2JqZWN0LmtleXModGhpcyk7XG4gICAgICAgICAgICB1dGlscy5lYWNoKGtleXMsIGZ1bmN0aW9uKGspIHtcbiAgICAgICAgICAgICAgICBpZiAoayA9PT0gJ3Jlc29sdmUnIHx8IGsgPT09ICdyZWplY3QnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0W2tdID0gc2VsZltrXTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuICAgIH07XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuLyoqXG4gKiDlpJrkuKpkZWZlcnJlZOeahOW8guatpVxuICogQHBhcmFtICBbXSBkZWZlcnNcbiAqIEByZXR1cm4gb2JqZWN0IHByb21pc2Xlr7nosaFcbiAqL1xuZnVuY3Rpb24gd2hlbihkZWZlcnMpIHtcbiAgICB2YXIgcmV0LCBsZW4sIGNvdW50ID0gMDtcbiAgICBpZiAoIXV0aWxzLmlzQXJyYXkoZGVmZXJzKSkge1xuICAgICAgICBkZWZlcnMgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgfVxuICAgIHJldCA9IERlZmVycmVkKCk7XG4gICAgbGVuID0gZGVmZXJzLmxlbmd0aDtcbiAgICBpZiAoIWxlbikge1xuICAgICAgICByZXR1cm4gcmV0LnJlc29sdmUoKS5wcm9taXNlKCk7XG4gICAgfVxuICAgIHV0aWxzLmVhY2goZGVmZXJzLCBmdW5jdGlvbihkZWZlcikge1xuICAgICAgICBkZWZlci5mYWlsKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgcmV0LnJlamVjdCgpO1xuICAgICAgICB9KS5kb25lKGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKCsrY291bnQgPT09IGxlbikge1xuICAgICAgICAgICAgICAgIHJldC5yZXNvbHZlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICAgIHJldHVybiByZXQucHJvbWlzZSgpO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgd2hlbjogd2hlbixcbiAgICBEZWZlcnJlZDogRGVmZXJyZWRcbn0iLCJ2YXIgZGlySWQgICAgICAgICAgID0gMSxcbiAgICBBUkdfUkUgICAgICAgICAgPSAvXltcXHdcXCQtXSskLyxcbiAgICBGSUxURVJfVE9LRU5fUkUgPSAvW15cXHMnXCJdK3wnW14nXSsnfFwiW15cIl0rXCIvZyxcbiAgICBORVNUSU5HX1JFICAgICAgPSAvXlxcJChwYXJlbnR8cm9vdClcXC4vLFxuICAgIFNJTkdMRV9WQVJfUkUgICA9IC9eW1xcd1xcLiRdKyQvLFxuICAgIFFVT1RFX1JFICAgICAgICA9IC9cIi9nLFxuICAgIFRleHRQYXJzZXIgICAgICA9IHJlcXVpcmUoJy4vdGV4dFBhcnNlcicpO1xuXG4vKipcbiAqICBEaXJlY3RpdmUgY2xhc3NcbiAqICByZXByZXNlbnRzIGEgc2luZ2xlIGRpcmVjdGl2ZSBpbnN0YW5jZSBpbiB0aGUgRE9NXG4gKi9cbmZ1bmN0aW9uIERpcmVjdGl2ZSAobmFtZSwgYXN0LCBkZWZpbml0aW9uLCBjb21waWxlciwgZWwpIHtcblxuICAgIHRoaXMuaWQgICAgICAgICAgICAgPSBkaXJJZCsrO1xuICAgIHRoaXMubmFtZSAgICAgICAgICAgPSBuYW1lO1xuICAgIHRoaXMuY29tcGlsZXIgICAgICAgPSBjb21waWxlcjtcbiAgICB0aGlzLnZtICAgICAgICAgICAgID0gY29tcGlsZXIudm07XG4gICAgdGhpcy5lbCAgICAgICAgICAgICA9IGVsO1xuICAgIHRoaXMuY29tcHV0ZUZpbHRlcnMgPSBmYWxzZTtcbiAgICB0aGlzLmtleSAgICAgICAgICAgID0gYXN0LmtleTtcbiAgICB0aGlzLmFyZyAgICAgICAgICAgID0gYXN0LmFyZztcbiAgICB0aGlzLmV4cHJlc3Npb24gICAgID0gYXN0LmV4cHJlc3Npb247XG5cbiAgICB2YXIgaXNFbXB0eSA9IHRoaXMuZXhwcmVzc2lvbiA9PT0gJyc7XG5cbiAgICAvLyBtaXggaW4gcHJvcGVydGllcyBmcm9tIHRoZSBkaXJlY3RpdmUgZGVmaW5pdGlvblxuICAgIGlmICh0eXBlb2YgZGVmaW5pdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICB0aGlzW2lzRW1wdHkgPyAnYmluZCcgOiAndXBkYXRlJ10gPSBkZWZpbml0aW9uXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZm9yICh2YXIgcHJvcCBpbiBkZWZpbml0aW9uKSB7XG4gICAgICAgICAgICB0aGlzW3Byb3BdID0gZGVmaW5pdGlvbltwcm9wXVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gZW1wdHkgZXhwcmVzc2lvbiwgd2UncmUgZG9uZS5cbiAgICBpZiAoaXNFbXB0eSB8fCB0aGlzLmlzRW1wdHkpIHtcbiAgICAgICAgdGhpcy5pc0VtcHR5ID0gdHJ1ZVxuICAgICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAoVGV4dFBhcnNlci5SZWdleC50ZXN0KHRoaXMua2V5KSkge1xuICAgICAgICB0aGlzLmtleSA9IGNvbXBpbGVyLmV2YWwodGhpcy5rZXkpO1xuICAgICAgICBpZiAodGhpcy5pc0xpdGVyYWwpIHtcbiAgICAgICAgICAgIHRoaXMuZXhwcmVzc2lvbiA9IHRoaXMua2V5O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgdmFyIGZpbHRlcnMgPSBhc3QuZmlsdGVycyxcbiAgICAgICAgZmlsdGVyLCBmbiwgaSwgbCwgY29tcHV0ZWQ7XG4gICAgaWYgKGZpbHRlcnMpIHtcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gW11cbiAgICAgICAgZm9yIChpID0gMCwgbCA9IGZpbHRlcnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBmaWx0ZXIgPSBmaWx0ZXJzW2ldXG4gICAgICAgICAgICBmbiA9IHRoaXMuY29tcGlsZXIuZ2V0T3B0aW9uKCdmaWx0ZXJzJywgZmlsdGVyLm5hbWUpXG4gICAgICAgICAgICBpZiAoZm4pIHtcbiAgICAgICAgICAgICAgICBmaWx0ZXIuYXBwbHkgPSBmblxuICAgICAgICAgICAgICAgIHRoaXMuZmlsdGVycy5wdXNoKGZpbHRlcilcbiAgICAgICAgICAgICAgICBpZiAoZm4uY29tcHV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLmZpbHRlcnMgfHwgIXRoaXMuZmlsdGVycy5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gbnVsbFxuICAgIH1cblxuICAgIGlmIChjb21wdXRlZCkge1xuICAgICAgICB0aGlzLmNvbXB1dGVkS2V5ID0gRGlyZWN0aXZlLmlubGluZUZpbHRlcnModGhpcy5rZXksIHRoaXMuZmlsdGVycylcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gbnVsbFxuICAgIH1cblxuICAgIHRoaXMuaXNFeHAgPVxuICAgICAgICBjb21wdXRlZCB8fFxuICAgICAgICAhU0lOR0xFX1ZBUl9SRS50ZXN0KHRoaXMua2V5KSB8fFxuICAgICAgICBORVNUSU5HX1JFLnRlc3QodGhpcy5rZXkpXG5cbn1cblxudmFyIERpclByb3RvID0gRGlyZWN0aXZlLnByb3RvdHlwZVxuXG4vKipcbiAqICBjYWxsZWQgd2hlbiBhIG5ldyB2YWx1ZSBpcyBzZXQgXG4gKiAgZm9yIGNvbXB1dGVkIHByb3BlcnRpZXMsIHRoaXMgd2lsbCBvbmx5IGJlIGNhbGxlZCBvbmNlXG4gKiAgZHVyaW5nIGluaXRpYWxpemF0aW9uLlxuICovXG5EaXJQcm90by4kdXBkYXRlID0gZnVuY3Rpb24gKHZhbHVlLCBpbml0KSB7XG4gICAgaWYgKHRoaXMuJGxvY2spIHJldHVyblxuICAgIGlmIChpbml0IHx8IHZhbHVlICE9PSB0aGlzLnZhbHVlIHx8ICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSkge1xuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWVcbiAgICAgICAgaWYgKHRoaXMudXBkYXRlKSB7XG4gICAgICAgICAgICB0aGlzLnVwZGF0ZShcbiAgICAgICAgICAgICAgICB0aGlzLmZpbHRlcnMgJiYgIXRoaXMuY29tcHV0ZUZpbHRlcnNcbiAgICAgICAgICAgICAgICAgICAgPyB0aGlzLiRhcHBseUZpbHRlcnModmFsdWUpXG4gICAgICAgICAgICAgICAgICAgIDogdmFsdWUsXG4gICAgICAgICAgICAgICAgaW5pdFxuICAgICAgICAgICAgKVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBwaXBlIHRoZSB2YWx1ZSB0aHJvdWdoIGZpbHRlcnNcbiAqL1xuRGlyUHJvdG8uJGFwcGx5RmlsdGVycyA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHZhciBmaWx0ZXJlZCA9IHZhbHVlLCBmaWx0ZXJcbiAgICBmb3IgKHZhciBpID0gMCwgbCA9IHRoaXMuZmlsdGVycy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgZmlsdGVyID0gdGhpcy5maWx0ZXJzW2ldXG4gICAgICAgIGZpbHRlcmVkID0gZmlsdGVyLmFwcGx5LmFwcGx5KHRoaXMudm0sIFtmaWx0ZXJlZF0uY29uY2F0KGZpbHRlci5hcmdzKSlcbiAgICB9XG4gICAgcmV0dXJuIGZpbHRlcmVkXG59XG5cbi8qKlxuICogIFVuYmluZCBkaXJldGl2ZVxuICovXG5EaXJQcm90by4kdW5iaW5kID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIHRoaXMgY2FuIGJlIGNhbGxlZCBiZWZvcmUgdGhlIGVsIGlzIGV2ZW4gYXNzaWduZWQuLi5cbiAgICBpZiAoIXRoaXMuZWwgfHwgIXRoaXMudm0pIHJldHVyblxuICAgIGlmICh0aGlzLnVuYmluZCkgdGhpcy51bmJpbmQoKVxuICAgIHRoaXMudm0gPSB0aGlzLmVsID0gdGhpcy5iaW5kaW5nID0gdGhpcy5jb21waWxlciA9IG51bGxcbn1cblxuLy8gRXhwb3NlZCBzdGF0aWMgbWV0aG9kcyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqICBQYXJzZSBhIGRpcmVjdGl2ZSBzdHJpbmcgaW50byBhbiBBcnJheSBvZlxuICogIEFTVC1saWtlIG9iamVjdHMgcmVwcmVzZW50aW5nIGRpcmVjdGl2ZXNcbiAqL1xuRGlyZWN0aXZlLnBhcnNlID0gZnVuY3Rpb24gKHN0cikge1xuXG4gICAgdmFyIGluU2luZ2xlID0gZmFsc2UsXG4gICAgICAgIGluRG91YmxlID0gZmFsc2UsXG4gICAgICAgIGN1cmx5ICAgID0gMCxcbiAgICAgICAgc3F1YXJlICAgPSAwLFxuICAgICAgICBwYXJlbiAgICA9IDAsXG4gICAgICAgIGJlZ2luICAgID0gMCxcbiAgICAgICAgYXJnSW5kZXggPSAwLFxuICAgICAgICBkaXJzICAgICA9IFtdLFxuICAgICAgICBkaXIgICAgICA9IHt9LFxuICAgICAgICBsYXN0RmlsdGVySW5kZXggPSAwLFxuICAgICAgICBhcmdcblxuICAgIGZvciAodmFyIGMsIGkgPSAwLCBsID0gc3RyLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICBjID0gc3RyLmNoYXJBdChpKVxuICAgICAgICBpZiAoaW5TaW5nbGUpIHtcbiAgICAgICAgICAgIC8vIGNoZWNrIHNpbmdsZSBxdW90ZVxuICAgICAgICAgICAgaWYgKGMgPT09IFwiJ1wiKSBpblNpbmdsZSA9ICFpblNpbmdsZVxuICAgICAgICB9IGVsc2UgaWYgKGluRG91YmxlKSB7XG4gICAgICAgICAgICAvLyBjaGVjayBkb3VibGUgcXVvdGVcbiAgICAgICAgICAgIGlmIChjID09PSAnXCInKSBpbkRvdWJsZSA9ICFpbkRvdWJsZVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICcsJyAmJiAhcGFyZW4gJiYgIWN1cmx5ICYmICFzcXVhcmUpIHtcbiAgICAgICAgICAgIC8vIHJlYWNoZWQgdGhlIGVuZCBvZiBhIGRpcmVjdGl2ZVxuICAgICAgICAgICAgcHVzaERpcigpXG4gICAgICAgICAgICAvLyByZXNldCAmIHNraXAgdGhlIGNvbW1hXG4gICAgICAgICAgICBkaXIgPSB7fVxuICAgICAgICAgICAgYmVnaW4gPSBhcmdJbmRleCA9IGxhc3RGaWx0ZXJJbmRleCA9IGkgKyAxXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJzonICYmICFkaXIua2V5ICYmICFkaXIuYXJnKSB7XG4gICAgICAgICAgICAvLyBhcmd1bWVudFxuICAgICAgICAgICAgYXJnID0gc3RyLnNsaWNlKGJlZ2luLCBpKS50cmltKClcbiAgICAgICAgICAgIGlmIChBUkdfUkUudGVzdChhcmcpKSB7XG4gICAgICAgICAgICAgICAgYXJnSW5kZXggPSBpICsgMVxuICAgICAgICAgICAgICAgIGRpci5hcmcgPSBhcmdcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnfCcgJiYgc3RyLmNoYXJBdChpICsgMSkgIT09ICd8JyAmJiBzdHIuY2hhckF0KGkgLSAxKSAhPT0gJ3wnKSB7XG4gICAgICAgICAgICBpZiAoZGlyLmtleSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgLy8gZmlyc3QgZmlsdGVyLCBlbmQgb2Yga2V5XG4gICAgICAgICAgICAgICAgbGFzdEZpbHRlckluZGV4ID0gaSArIDFcbiAgICAgICAgICAgICAgICBkaXIua2V5ID0gc3RyLnNsaWNlKGFyZ0luZGV4LCBpKS50cmltKClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gYWxyZWFkeSBoYXMgZmlsdGVyXG4gICAgICAgICAgICAgICAgcHVzaEZpbHRlcigpXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ1wiJykge1xuICAgICAgICAgICAgaW5Eb3VibGUgPSB0cnVlXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gXCInXCIpIHtcbiAgICAgICAgICAgIGluU2luZ2xlID0gdHJ1ZVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICcoJykge1xuICAgICAgICAgICAgcGFyZW4rK1xuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICcpJykge1xuICAgICAgICAgICAgcGFyZW4tLVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICdbJykge1xuICAgICAgICAgICAgc3F1YXJlKytcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnXScpIHtcbiAgICAgICAgICAgIHNxdWFyZS0tXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ3snKSB7XG4gICAgICAgICAgICBjdXJseSsrXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ30nKSB7XG4gICAgICAgICAgICBjdXJseS0tXG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKGkgPT09IDAgfHwgYmVnaW4gIT09IGkpIHtcbiAgICAgICAgcHVzaERpcigpXG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcHVzaERpciAoKSB7XG4gICAgICAgIGRpci5leHByZXNzaW9uID0gc3RyLnNsaWNlKGJlZ2luLCBpKS50cmltKClcbiAgICAgICAgaWYgKGRpci5rZXkgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgZGlyLmtleSA9IHN0ci5zbGljZShhcmdJbmRleCwgaSkudHJpbSgpXG4gICAgICAgIH0gZWxzZSBpZiAobGFzdEZpbHRlckluZGV4ICE9PSBiZWdpbikge1xuICAgICAgICAgICAgcHVzaEZpbHRlcigpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGkgPT09IDAgfHwgZGlyLmtleSkge1xuICAgICAgICAgICAgZGlycy5wdXNoKGRpcilcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHB1c2hGaWx0ZXIgKCkge1xuICAgICAgICB2YXIgZXhwID0gc3RyLnNsaWNlKGxhc3RGaWx0ZXJJbmRleCwgaSkudHJpbSgpLFxuICAgICAgICAgICAgZmlsdGVyXG4gICAgICAgIGlmIChleHApIHtcbiAgICAgICAgICAgIGZpbHRlciA9IHt9XG4gICAgICAgICAgICB2YXIgdG9rZW5zID0gZXhwLm1hdGNoKEZJTFRFUl9UT0tFTl9SRSlcbiAgICAgICAgICAgIGZpbHRlci5uYW1lID0gdG9rZW5zWzBdXG4gICAgICAgICAgICBmaWx0ZXIuYXJncyA9IHRva2Vucy5sZW5ndGggPiAxID8gdG9rZW5zLnNsaWNlKDEpIDogbnVsbFxuICAgICAgICB9XG4gICAgICAgIGlmIChmaWx0ZXIpIHtcbiAgICAgICAgICAgIChkaXIuZmlsdGVycyA9IGRpci5maWx0ZXJzIHx8IFtdKS5wdXNoKGZpbHRlcilcbiAgICAgICAgfVxuICAgICAgICBsYXN0RmlsdGVySW5kZXggPSBpICsgMVxuICAgIH1cblxuICAgIHJldHVybiBkaXJzXG59XG5cbi8qKlxuICogIElubGluZSBjb21wdXRlZCBmaWx0ZXJzIHNvIHRoZXkgYmVjb21lIHBhcnRcbiAqICBvZiB0aGUgZXhwcmVzc2lvblxuICovXG5EaXJlY3RpdmUuaW5saW5lRmlsdGVycyA9IGZ1bmN0aW9uIChrZXksIGZpbHRlcnMpIHtcbiAgICB2YXIgYXJncywgZmlsdGVyXG4gICAgZm9yICh2YXIgaSA9IDAsIGwgPSBmaWx0ZXJzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICBmaWx0ZXIgPSBmaWx0ZXJzW2ldXG4gICAgICAgIGFyZ3MgPSBmaWx0ZXIuYXJnc1xuICAgICAgICAgICAgPyAnLFwiJyArIGZpbHRlci5hcmdzLm1hcChlc2NhcGVRdW90ZSkuam9pbignXCIsXCInKSArICdcIidcbiAgICAgICAgICAgIDogJydcbiAgICAgICAga2V5ID0gJ3RoaXMuJGNvbXBpbGVyLmdldE9wdGlvbihcImZpbHRlcnNcIiwgXCInICtcbiAgICAgICAgICAgICAgICBmaWx0ZXIubmFtZSArXG4gICAgICAgICAgICAnXCIpLmNhbGwodGhpcywnICtcbiAgICAgICAgICAgICAgICBrZXkgKyBhcmdzICtcbiAgICAgICAgICAgICcpJ1xuICAgIH1cbiAgICByZXR1cm4ga2V5XG59XG5cbi8qKlxuICogIENvbnZlcnQgZG91YmxlIHF1b3RlcyB0byBzaW5nbGUgcXVvdGVzXG4gKiAgc28gdGhleSBkb24ndCBtZXNzIHVwIHRoZSBnZW5lcmF0ZWQgZnVuY3Rpb24gYm9keVxuICovXG5mdW5jdGlvbiBlc2NhcGVRdW90ZSAodikge1xuICAgIHJldHVybiB2LmluZGV4T2YoJ1wiJykgPiAtMVxuICAgICAgICA/IHYucmVwbGFjZShRVU9URV9SRSwgJ1xcJycpXG4gICAgICAgIDogdlxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IERpcmVjdGl2ZTsiLCJ2YXIgdXRpbHMgPSByZXF1aXJlKCcuLi91dGlscycpLFxuICAgIHNsaWNlID0gW10uc2xpY2VcblxuLyoqXG4gKiAgQmluZGluZyBmb3IgaW5uZXJIVE1MXG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBhIGNvbW1lbnQgbm9kZSBtZWFucyB0aGlzIGlzIGEgYmluZGluZyBmb3JcbiAgICAgICAgLy8ge3t7IGlubGluZSB1bmVzY2FwZWQgaHRtbCB9fX1cbiAgICAgICAgaWYgKHRoaXMuZWwubm9kZVR5cGUgPT09IDgpIHtcbiAgICAgICAgICAgIC8vIGhvbGQgbm9kZXNcbiAgICAgICAgICAgIHRoaXMubm9kZXMgPSBbXVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIHZhbHVlID0gdXRpbHMuZ3VhcmQodmFsdWUpXG4gICAgICAgIGlmICh0aGlzLm5vZGVzKSB7XG4gICAgICAgICAgICB0aGlzLnN3YXAodmFsdWUpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmVsLmlubmVySFRNTCA9IHZhbHVlXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgc3dhcDogZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIHZhciBwYXJlbnQgPSB0aGlzLmVsLnBhcmVudE5vZGUsXG4gICAgICAgICAgICBub2RlcyAgPSB0aGlzLm5vZGVzLFxuICAgICAgICAgICAgaSAgICAgID0gbm9kZXMubGVuZ3RoXG4gICAgICAgIC8vIHJlbW92ZSBvbGQgbm9kZXNcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgcGFyZW50LnJlbW92ZUNoaWxkKG5vZGVzW2ldKVxuICAgICAgICB9XG4gICAgICAgIC8vIGNvbnZlcnQgbmV3IHZhbHVlIHRvIGEgZnJhZ21lbnRcbiAgICAgICAgdmFyIGZyYWcgPSB1dGlscy50b0ZyYWdtZW50KHZhbHVlKVxuICAgICAgICAvLyBzYXZlIGEgcmVmZXJlbmNlIHRvIHRoZXNlIG5vZGVzIHNvIHdlIGNhbiByZW1vdmUgbGF0ZXJcbiAgICAgICAgdGhpcy5ub2RlcyA9IHNsaWNlLmNhbGwoZnJhZy5jaGlsZE5vZGVzKVxuICAgICAgICBwYXJlbnQuaW5zZXJ0QmVmb3JlKGZyYWcsIHRoaXMuZWwpXG4gICAgfVxufSIsInZhciB1dGlscyAgICA9IHJlcXVpcmUoJy4uL3V0aWxzJylcblxuLyoqXG4gKiAgTWFuYWdlcyBhIGNvbmRpdGlvbmFsIGNoaWxkIFZNXG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICBcbiAgICAgICAgdGhpcy5wYXJlbnQgPSB0aGlzLmVsLnBhcmVudE5vZGVcbiAgICAgICAgdGhpcy5yZWYgICAgPSBkb2N1bWVudC5jcmVhdGVDb21tZW50KCd2dWUtaWYnKVxuICAgICAgICB0aGlzLkN0b3IgICA9IHRoaXMuY29tcGlsZXIucmVzb2x2ZUNvbXBvbmVudCh0aGlzLmVsKVxuXG4gICAgICAgIC8vIGluc2VydCByZWZcbiAgICAgICAgdGhpcy5wYXJlbnQuaW5zZXJ0QmVmb3JlKHRoaXMucmVmLCB0aGlzLmVsKVxuICAgICAgICB0aGlzLnBhcmVudC5yZW1vdmVDaGlsZCh0aGlzLmVsKVxuXG4gICAgICAgIGlmICh1dGlscy5hdHRyKHRoaXMuZWwsICd2aWV3JykpIHtcbiAgICAgICAgICAgIHV0aWxzLndhcm4oXG4gICAgICAgICAgICAgICAgJ0NvbmZsaWN0OiB2LWlmIGNhbm5vdCBiZSB1c2VkIHRvZ2V0aGVyIHdpdGggdi12aWV3LiAnICtcbiAgICAgICAgICAgICAgICAnSnVzdCBzZXQgdi12aWV3XFwncyBiaW5kaW5nIHZhbHVlIHRvIGVtcHR5IHN0cmluZyB0byBlbXB0eSBpdC4nXG4gICAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHV0aWxzLmF0dHIodGhpcy5lbCwgJ3JlcGVhdCcpKSB7XG4gICAgICAgICAgICB1dGlscy53YXJuKFxuICAgICAgICAgICAgICAgICdDb25mbGljdDogdi1pZiBjYW5ub3QgYmUgdXNlZCB0b2dldGhlciB3aXRoIHYtcmVwZWF0LiAnICtcbiAgICAgICAgICAgICAgICAnVXNlIGB2LXNob3dgIG9yIHRoZSBgZmlsdGVyQnlgIGZpbHRlciBpbnN0ZWFkLidcbiAgICAgICAgICAgIClcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uICh2YWx1ZSkge1xuXG4gICAgICAgIGlmICghdmFsdWUpIHtcbiAgICAgICAgICAgIHRoaXMudW5iaW5kKClcbiAgICAgICAgfSBlbHNlIGlmICghdGhpcy5jaGlsZFZNKSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0gPSBuZXcgdGhpcy5DdG9yKHtcbiAgICAgICAgICAgICAgICBlbDogdGhpcy5lbC5jbG9uZU5vZGUodHJ1ZSksXG4gICAgICAgICAgICAgICAgcGFyZW50OiB0aGlzLnZtXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgaWYgKHRoaXMuY29tcGlsZXIuaW5pdCkge1xuICAgICAgICAgICAgICAgIHRoaXMucGFyZW50Lmluc2VydEJlZm9yZSh0aGlzLmNoaWxkVk0uJGVsLCB0aGlzLnJlZilcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5jaGlsZFZNLiRiZWZvcmUodGhpcy5yZWYpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgfSxcblxuICAgIHVuYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAodGhpcy5jaGlsZFZNKSB7XG4gICAgICAgICAgICB0aGlzLmNoaWxkVk0uJGRlc3Ryb3koKVxuICAgICAgICAgICAgdGhpcy5jaGlsZFZNID0gbnVsbFxuICAgICAgICB9XG4gICAgfVxufSIsInZhciB1dGlscyAgICAgID0gcmVxdWlyZSgnLi4vdXRpbHMnKSxcbiAgICBjb25maWcgICAgID0gcmVxdWlyZSgnLi4vY29uZmlnJyksXG4gICAgZGlyZWN0aXZlcyA9IG1vZHVsZS5leHBvcnRzID0gdXRpbHMuaGFzaCgpXG5cbi8qKlxuICogIE5lc3QgYW5kIG1hbmFnZSBhIENoaWxkIFZNXG4gKi9cbmRpcmVjdGl2ZXMuY29tcG9uZW50ID0ge1xuICAgIGlzTGl0ZXJhbDogdHJ1ZSxcbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmICghdGhpcy5lbC5fdm0pIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTSA9IG5ldyB0aGlzLkN0b3Ioe1xuICAgICAgICAgICAgICAgIGVsOiB0aGlzLmVsLFxuICAgICAgICAgICAgICAgIHBhcmVudDogdGhpcy52bVxuICAgICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgIH0sXG4gICAgdW5iaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmICh0aGlzLmNoaWxkVk0pIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTS4kZGVzdHJveSgpXG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKlxuICogIEJpbmRpbmcgSFRNTCBhdHRyaWJ1dGVzXG4gKi9cbmRpcmVjdGl2ZXMuYXR0ciA9IHtcbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBwYXJhbXMgPSB0aGlzLnZtLiRvcHRpb25zLnBhcmFtQXR0cmlidXRlc1xuICAgICAgICB0aGlzLmlzUGFyYW0gPSBwYXJhbXMgJiYgcGFyYW1zLmluZGV4T2YodGhpcy5hcmcpID4gLTFcbiAgICB9LFxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGlmICh2YWx1ZSB8fCB2YWx1ZSA9PT0gMCkge1xuICAgICAgICAgICAgdGhpcy5lbC5zZXRBdHRyaWJ1dGUodGhpcy5hcmcsIHZhbHVlKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5lbC5yZW1vdmVBdHRyaWJ1dGUodGhpcy5hcmcpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuaXNQYXJhbSkge1xuICAgICAgICAgICAgdGhpcy52bVt0aGlzLmFyZ10gPSB1dGlscy5jaGVja051bWJlcih2YWx1ZSlcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgQmluZGluZyB0ZXh0Q29udGVudFxuICovXG5kaXJlY3RpdmVzLnRleHQgPSB7XG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB0aGlzLmF0dHIgPSB0aGlzLmVsLm5vZGVUeXBlID09PSAzXG4gICAgICAgICAgICA/ICdub2RlVmFsdWUnXG4gICAgICAgICAgICA6ICd0ZXh0Q29udGVudCdcbiAgICB9LFxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIHRoaXMuZWxbdGhpcy5hdHRyXSA9IHV0aWxzLmd1YXJkKHZhbHVlKVxuICAgIH1cbn1cblxuLyoqXG4gKiAgQmluZGluZyBDU1MgZGlzcGxheSBwcm9wZXJ0eVxuICovXG5kaXJlY3RpdmVzLnNob3cgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICB2YXIgZWwgPSB0aGlzLmVsLFxuICAgICAgICB0YXJnZXQgPSB2YWx1ZSA/ICcnIDogJ25vbmUnLFxuICAgICAgICBjaGFuZ2UgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBlbC5zdHlsZS5kaXNwbGF5ID0gdGFyZ2V0XG4gICAgICAgIH1cbn1cblxuLyoqXG4gKiAgQmluZGluZyBDU1MgY2xhc3Nlc1xuICovXG5kaXJlY3RpdmVzWydjbGFzcyddID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgaWYgKHRoaXMuYXJnKSB7XG4gICAgICAgIHV0aWxzW3ZhbHVlID8gJ2FkZENsYXNzJyA6ICdyZW1vdmVDbGFzcyddKHRoaXMuZWwsIHRoaXMuYXJnKVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICh0aGlzLmxhc3RWYWwpIHtcbiAgICAgICAgICAgIHV0aWxzLnJlbW92ZUNsYXNzKHRoaXMuZWwsIHRoaXMubGFzdFZhbClcbiAgICAgICAgfVxuICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgIHV0aWxzLmFkZENsYXNzKHRoaXMuZWwsIHZhbHVlKVxuICAgICAgICAgICAgdGhpcy5sYXN0VmFsID0gdmFsdWVcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgT25seSByZW1vdmVkIGFmdGVyIHRoZSBvd25lciBWTSBpcyByZWFkeVxuICovXG5kaXJlY3RpdmVzLmNsb2FrID0ge1xuICAgIGlzRW1wdHk6IHRydWUsXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZWwgPSB0aGlzLmVsXG4gICAgICAgIHRoaXMuY29tcGlsZXIub2JzZXJ2ZXIub25jZSgnaG9vazpyZWFkeScsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGVsLnJlbW92ZUF0dHJpYnV0ZShjb25maWcucHJlZml4ICsgJy1jbG9haycpXG4gICAgICAgIH0pXG4gICAgfVxufVxuXG4vKipcbiAqICBTdG9yZSBhIHJlZmVyZW5jZSB0byBzZWxmIGluIHBhcmVudCBWTSdzICRcbiAqL1xuZGlyZWN0aXZlcy5yZWYgPSB7XG4gICAgaXNMaXRlcmFsOiB0cnVlLFxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGlkID0gdGhpcy5leHByZXNzaW9uXG4gICAgICAgIGlmIChpZCkge1xuICAgICAgICAgICAgdGhpcy52bS4kcGFyZW50LiRbaWRdID0gdGhpcy52bVxuICAgICAgICB9XG4gICAgfSxcbiAgICB1bmJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGlkID0gdGhpcy5leHByZXNzaW9uXG4gICAgICAgIGlmIChpZCkge1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMudm0uJHBhcmVudC4kW2lkXVxuICAgICAgICB9XG4gICAgfVxufVxuXG5kaXJlY3RpdmVzLm9uICAgICAgPSByZXF1aXJlKCcuL29uJylcbmRpcmVjdGl2ZXMucmVwZWF0ICA9IHJlcXVpcmUoJy4vcmVwZWF0JylcbmRpcmVjdGl2ZXMubW9kZWwgICA9IHJlcXVpcmUoJy4vbW9kZWwnKVxuZGlyZWN0aXZlc1snaWYnXSAgID0gcmVxdWlyZSgnLi9pZicpXG5kaXJlY3RpdmVzWyd3aXRoJ10gPSByZXF1aXJlKCcuL3dpdGgnKVxuZGlyZWN0aXZlcy5odG1sICAgID0gcmVxdWlyZSgnLi9odG1sJylcbmRpcmVjdGl2ZXMuc3R5bGUgICA9IHJlcXVpcmUoJy4vc3R5bGUnKVxuZGlyZWN0aXZlcy5wYXJ0aWFsID0gcmVxdWlyZSgnLi9wYXJ0aWFsJylcbmRpcmVjdGl2ZXMudmlldyAgICA9IHJlcXVpcmUoJy4vdmlldycpIiwidmFyIHV0aWxzID0gcmVxdWlyZSgnLi4vdXRpbHMnKSxcbiAgICBpc0lFOSA9IG5hdmlnYXRvci51c2VyQWdlbnQuaW5kZXhPZignTVNJRSA5LjAnKSA+IDAsXG4gICAgZmlsdGVyID0gW10uZmlsdGVyXG5cbi8qKlxuICogIFJldHVybnMgYW4gYXJyYXkgb2YgdmFsdWVzIGZyb20gYSBtdWx0aXBsZSBzZWxlY3RcbiAqL1xuZnVuY3Rpb24gZ2V0TXVsdGlwbGVTZWxlY3RPcHRpb25zIChzZWxlY3QpIHtcbiAgICByZXR1cm4gZmlsdGVyXG4gICAgICAgIC5jYWxsKHNlbGVjdC5vcHRpb25zLCBmdW5jdGlvbiAob3B0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gb3B0aW9uLnNlbGVjdGVkXG4gICAgICAgIH0pXG4gICAgICAgIC5tYXAoZnVuY3Rpb24gKG9wdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbi52YWx1ZSB8fCBvcHRpb24udGV4dFxuICAgICAgICB9KVxufVxuXG4vKipcbiAqICBUd28td2F5IGJpbmRpbmcgZm9yIGZvcm0gaW5wdXQgZWxlbWVudHNcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG5cbiAgICAgICAgdmFyIHNlbGYgPSB0aGlzLFxuICAgICAgICAgICAgZWwgICA9IHNlbGYuZWwsXG4gICAgICAgICAgICB0eXBlID0gZWwudHlwZSxcbiAgICAgICAgICAgIHRhZyAgPSBlbC50YWdOYW1lXG5cbiAgICAgICAgc2VsZi5sb2NrID0gZmFsc2VcbiAgICAgICAgc2VsZi5vd25lclZNID0gc2VsZi5iaW5kaW5nLmNvbXBpbGVyLnZtXG5cbiAgICAgICAgLy8gZGV0ZXJtaW5lIHdoYXQgZXZlbnQgdG8gbGlzdGVuIHRvXG4gICAgICAgIHNlbGYuZXZlbnQgPVxuICAgICAgICAgICAgKHNlbGYuY29tcGlsZXIub3B0aW9ucy5sYXp5IHx8XG4gICAgICAgICAgICB0YWcgPT09ICdTRUxFQ1QnIHx8XG4gICAgICAgICAgICB0eXBlID09PSAnY2hlY2tib3gnIHx8IHR5cGUgPT09ICdyYWRpbycpXG4gICAgICAgICAgICAgICAgPyAnY2hhbmdlJ1xuICAgICAgICAgICAgICAgIDogJ2lucHV0J1xuXG4gICAgICAgIC8vIGRldGVybWluZSB0aGUgYXR0cmlidXRlIHRvIGNoYW5nZSB3aGVuIHVwZGF0aW5nXG4gICAgICAgIHNlbGYuYXR0ciA9IHR5cGUgPT09ICdjaGVja2JveCdcbiAgICAgICAgICAgID8gJ2NoZWNrZWQnXG4gICAgICAgICAgICA6ICh0YWcgPT09ICdJTlBVVCcgfHwgdGFnID09PSAnU0VMRUNUJyB8fCB0YWcgPT09ICdURVhUQVJFQScpXG4gICAgICAgICAgICAgICAgPyAndmFsdWUnXG4gICAgICAgICAgICAgICAgOiAnaW5uZXJIVE1MJ1xuXG4gICAgICAgIC8vIHNlbGVjdFttdWx0aXBsZV0gc3VwcG9ydFxuICAgICAgICBpZih0YWcgPT09ICdTRUxFQ1QnICYmIGVsLmhhc0F0dHJpYnV0ZSgnbXVsdGlwbGUnKSkge1xuICAgICAgICAgICAgdGhpcy5tdWx0aSA9IHRydWVcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBjb21wb3NpdGlvbkxvY2sgPSBmYWxzZVxuICAgICAgICBzZWxmLmNMb2NrID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgY29tcG9zaXRpb25Mb2NrID0gdHJ1ZVxuICAgICAgICB9XG4gICAgICAgIHNlbGYuY1VubG9jayA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGNvbXBvc2l0aW9uTG9jayA9IGZhbHNlXG4gICAgICAgIH1cbiAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcignY29tcG9zaXRpb25zdGFydCcsIHRoaXMuY0xvY2spXG4gICAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NvbXBvc2l0aW9uZW5kJywgdGhpcy5jVW5sb2NrKVxuXG4gICAgICAgIC8vIGF0dGFjaCBsaXN0ZW5lclxuICAgICAgICBzZWxmLnNldCA9IHNlbGYuZmlsdGVyc1xuICAgICAgICAgICAgPyBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbXBvc2l0aW9uTG9jaykgcmV0dXJuXG4gICAgICAgICAgICAgICAgLy8gaWYgdGhpcyBkaXJlY3RpdmUgaGFzIGZpbHRlcnNcbiAgICAgICAgICAgICAgICAvLyB3ZSBuZWVkIHRvIGxldCB0aGUgdm0uJHNldCB0cmlnZ2VyXG4gICAgICAgICAgICAgICAgLy8gdXBkYXRlKCkgc28gZmlsdGVycyBhcmUgYXBwbGllZC5cbiAgICAgICAgICAgICAgICAvLyB0aGVyZWZvcmUgd2UgaGF2ZSB0byByZWNvcmQgY3Vyc29yIHBvc2l0aW9uXG4gICAgICAgICAgICAgICAgLy8gc28gdGhhdCBhZnRlciB2bS4kc2V0IGNoYW5nZXMgdGhlIGlucHV0XG4gICAgICAgICAgICAgICAgLy8gdmFsdWUgd2UgY2FuIHB1dCB0aGUgY3Vyc29yIGJhY2sgYXQgd2hlcmUgaXQgaXNcbiAgICAgICAgICAgICAgICB2YXIgY3Vyc29yUG9zXG4gICAgICAgICAgICAgICAgdHJ5IHsgY3Vyc29yUG9zID0gZWwuc2VsZWN0aW9uU3RhcnQgfSBjYXRjaCAoZSkge31cblxuICAgICAgICAgICAgICAgIHNlbGYuX3NldCgpXG5cbiAgICAgICAgICAgICAgICAvLyBzaW5jZSB1cGRhdGVzIGFyZSBhc3luY1xuICAgICAgICAgICAgICAgIC8vIHdlIG5lZWQgdG8gcmVzZXQgY3Vyc29yIHBvc2l0aW9uIGFzeW5jIHRvb1xuICAgICAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGN1cnNvclBvcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbC5zZXRTZWxlY3Rpb25SYW5nZShjdXJzb3JQb3MsIGN1cnNvclBvcylcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICA6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29tcG9zaXRpb25Mb2NrKSByZXR1cm5cbiAgICAgICAgICAgICAgICAvLyBubyBmaWx0ZXJzLCBkb24ndCBsZXQgaXQgdHJpZ2dlciB1cGRhdGUoKVxuICAgICAgICAgICAgICAgIHNlbGYubG9jayA9IHRydWVcblxuICAgICAgICAgICAgICAgIHNlbGYuX3NldCgpXG5cbiAgICAgICAgICAgICAgICB1dGlscy5uZXh0VGljayhmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYubG9jayA9IGZhbHNlXG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcihzZWxmLmV2ZW50LCBzZWxmLnNldClcblxuICAgICAgICAvLyBmaXggc2hpdCBmb3IgSUU5XG4gICAgICAgIC8vIHNpbmNlIGl0IGRvZXNuJ3QgZmlyZSBpbnB1dCBvbiBiYWNrc3BhY2UgLyBkZWwgLyBjdXRcbiAgICAgICAgaWYgKGlzSUU5KSB7XG4gICAgICAgICAgICBzZWxmLm9uQ3V0ID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIC8vIGN1dCBldmVudCBmaXJlcyBiZWZvcmUgdGhlIHZhbHVlIGFjdHVhbGx5IGNoYW5nZXNcbiAgICAgICAgICAgICAgICB1dGlscy5uZXh0VGljayhmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYuc2V0KClcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2VsZi5vbkRlbCA9IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGUua2V5Q29kZSA9PT0gNDYgfHwgZS5rZXlDb2RlID09PSA4KSB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGYuc2V0KClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdjdXQnLCBzZWxmLm9uQ3V0KVxuICAgICAgICAgICAgZWwuYWRkRXZlbnRMaXN0ZW5lcigna2V5dXAnLCBzZWxmLm9uRGVsKVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIF9zZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdGhpcy5vd25lclZNLiRzZXQoXG4gICAgICAgICAgICB0aGlzLmtleSwgdGhpcy5tdWx0aVxuICAgICAgICAgICAgICAgID8gZ2V0TXVsdGlwbGVTZWxlY3RPcHRpb25zKHRoaXMuZWwpXG4gICAgICAgICAgICAgICAgOiB0aGlzLmVsW3RoaXMuYXR0cl1cbiAgICAgICAgKVxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uICh2YWx1ZSwgaW5pdCkge1xuICAgICAgICAvKiBqc2hpbnQgZXFlcWVxOiBmYWxzZSAqL1xuICAgICAgICAvLyBzeW5jIGJhY2sgaW5saW5lIHZhbHVlIGlmIGluaXRpYWwgZGF0YSBpcyB1bmRlZmluZWRcbiAgICAgICAgaWYgKGluaXQgJiYgdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NldCgpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMubG9jaykgcmV0dXJuXG4gICAgICAgIHZhciBlbCA9IHRoaXMuZWxcbiAgICAgICAgaWYgKGVsLnRhZ05hbWUgPT09ICdTRUxFQ1QnKSB7IC8vIHNlbGVjdCBkcm9wZG93blxuICAgICAgICAgICAgZWwuc2VsZWN0ZWRJbmRleCA9IC0xXG4gICAgICAgICAgICBpZih0aGlzLm11bHRpICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgdmFsdWUuZm9yRWFjaCh0aGlzLnVwZGF0ZVNlbGVjdCwgdGhpcylcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy51cGRhdGVTZWxlY3QodmFsdWUpXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoZWwudHlwZSA9PT0gJ3JhZGlvJykgeyAvLyByYWRpbyBidXR0b25cbiAgICAgICAgICAgIGVsLmNoZWNrZWQgPSB2YWx1ZSA9PSBlbC52YWx1ZVxuICAgICAgICB9IGVsc2UgaWYgKGVsLnR5cGUgPT09ICdjaGVja2JveCcpIHsgLy8gY2hlY2tib3hcbiAgICAgICAgICAgIGVsLmNoZWNrZWQgPSAhIXZhbHVlXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBlbFt0aGlzLmF0dHJdID0gdXRpbHMuZ3VhcmQodmFsdWUpXG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdXBkYXRlU2VsZWN0OiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgLyoganNoaW50IGVxZXFlcTogZmFsc2UgKi9cbiAgICAgICAgLy8gc2V0dGluZyA8c2VsZWN0PidzIHZhbHVlIGluIElFOSBkb2Vzbid0IHdvcmtcbiAgICAgICAgLy8gd2UgaGF2ZSB0byBtYW51YWxseSBsb29wIHRocm91Z2ggdGhlIG9wdGlvbnNcbiAgICAgICAgdmFyIG9wdGlvbnMgPSB0aGlzLmVsLm9wdGlvbnMsXG4gICAgICAgICAgICBpID0gb3B0aW9ucy5sZW5ndGhcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgaWYgKG9wdGlvbnNbaV0udmFsdWUgPT0gdmFsdWUpIHtcbiAgICAgICAgICAgICAgICBvcHRpb25zW2ldLnNlbGVjdGVkID0gdHJ1ZVxuICAgICAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgdW5iaW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBlbCA9IHRoaXMuZWxcbiAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcih0aGlzLmV2ZW50LCB0aGlzLnNldClcbiAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignY29tcG9zaXRpb25zdGFydCcsIHRoaXMuY0xvY2spXG4gICAgICAgIGVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2NvbXBvc2l0aW9uZW5kJywgdGhpcy5jVW5sb2NrKVxuICAgICAgICBpZiAoaXNJRTkpIHtcbiAgICAgICAgICAgIGVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2N1dCcsIHRoaXMub25DdXQpXG4gICAgICAgICAgICBlbC5yZW1vdmVFdmVudExpc3RlbmVyKCdrZXl1cCcsIHRoaXMub25EZWwpXG4gICAgICAgIH1cbiAgICB9XG59IiwidmFyIHV0aWxzICAgID0gcmVxdWlyZSgnLi4vdXRpbHMnKVxuXG4vKipcbiAqICBCaW5kaW5nIGZvciBldmVudCBsaXN0ZW5lcnNcbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBpc0ZuOiB0cnVlLFxuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB0aGlzLmNvbnRleHQgPSB0aGlzLmJpbmRpbmcuaXNFeHBcbiAgICAgICAgICAgID8gdGhpcy52bVxuICAgICAgICAgICAgOiB0aGlzLmJpbmRpbmcuY29tcGlsZXIudm1cbiAgICAgICAgaWYgKHRoaXMuZWwudGFnTmFtZSA9PT0gJ0lGUkFNRScgJiYgdGhpcy5hcmcgIT09ICdsb2FkJykge1xuICAgICAgICAgICAgdmFyIHNlbGYgPSB0aGlzXG4gICAgICAgICAgICB0aGlzLmlmcmFtZUJpbmQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgc2VsZi5lbC5jb250ZW50V2luZG93LmFkZEV2ZW50TGlzdGVuZXIoc2VsZi5hcmcsIHNlbGYuaGFuZGxlcilcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuZWwuYWRkRXZlbnRMaXN0ZW5lcignbG9hZCcsIHRoaXMuaWZyYW1lQmluZClcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICB1cGRhdGU6IGZ1bmN0aW9uIChoYW5kbGVyKSB7XG4gICAgICAgIGlmICh0eXBlb2YgaGFuZGxlciAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgdXRpbHMud2FybignRGlyZWN0aXZlIFwidi1vbjonICsgdGhpcy5leHByZXNzaW9uICsgJ1wiIGV4cGVjdHMgYSBtZXRob2QuJylcbiAgICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG4gICAgICAgIHRoaXMucmVzZXQoKVxuICAgICAgICB2YXIgdm0gPSB0aGlzLnZtLFxuICAgICAgICAgICAgY29udGV4dCA9IHRoaXMuY29udGV4dFxuICAgICAgICB0aGlzLmhhbmRsZXIgPSBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgZS50YXJnZXRWTSA9IHZtXG4gICAgICAgICAgICBjb250ZXh0LiRldmVudCA9IGVcbiAgICAgICAgICAgIHZhciByZXMgPSBoYW5kbGVyLmNhbGwoY29udGV4dCwgZSlcbiAgICAgICAgICAgIGNvbnRleHQuJGV2ZW50ID0gbnVsbFxuICAgICAgICAgICAgcmV0dXJuIHJlc1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLmlmcmFtZUJpbmQpIHtcbiAgICAgICAgICAgIHRoaXMuaWZyYW1lQmluZCgpXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmVsLmFkZEV2ZW50TGlzdGVuZXIodGhpcy5hcmcsIHRoaXMuaGFuZGxlcilcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICByZXNldDogZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZWwgPSB0aGlzLmlmcmFtZUJpbmRcbiAgICAgICAgICAgID8gdGhpcy5lbC5jb250ZW50V2luZG93XG4gICAgICAgICAgICA6IHRoaXMuZWxcbiAgICAgICAgaWYgKHRoaXMuaGFuZGxlcikge1xuICAgICAgICAgICAgZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcih0aGlzLmFyZywgdGhpcy5oYW5kbGVyKVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHVuYmluZDogZnVuY3Rpb24gKCkge1xuICAgICAgICB0aGlzLnJlc2V0KClcbiAgICAgICAgdGhpcy5lbC5yZW1vdmVFdmVudExpc3RlbmVyKCdsb2FkJywgdGhpcy5pZnJhbWVCaW5kKVxuICAgIH1cbn0iLCJ2YXIgdXRpbHMgPSByZXF1aXJlKCcuLi91dGlscycpXG5cbi8qKlxuICogIEJpbmRpbmcgZm9yIHBhcnRpYWxzXG4gKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuXG4gICAgaXNMaXRlcmFsOiB0cnVlLFxuXG4gICAgYmluZDogZnVuY3Rpb24gKCkge1xuXG4gICAgICAgIHZhciBpZCA9IHRoaXMuZXhwcmVzc2lvblxuICAgICAgICBpZiAoIWlkKSByZXR1cm5cblxuICAgICAgICB2YXIgZWwgICAgICAgPSB0aGlzLmVsLFxuICAgICAgICAgICAgY29tcGlsZXIgPSB0aGlzLmNvbXBpbGVyLFxuICAgICAgICAgICAgcGFydGlhbCAgPSBjb21waWxlci5nZXRPcHRpb24oJ3BhcnRpYWxzJywgaWQpXG5cbiAgICAgICAgaWYgKCFwYXJ0aWFsKSB7XG4gICAgICAgICAgICBpZiAoaWQgPT09ICd5aWVsZCcpIHtcbiAgICAgICAgICAgICAgICB1dGlscy53YXJuKCd7ez55aWVsZH19IHN5bnRheCBoYXMgYmVlbiBkZXByZWNhdGVkLiBVc2UgPGNvbnRlbnQ+IHRhZyBpbnN0ZWFkLicpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuXG4gICAgICAgIHBhcnRpYWwgPSBwYXJ0aWFsLmNsb25lTm9kZSh0cnVlKVxuXG4gICAgICAgIC8vIGNvbW1lbnQgcmVmIG5vZGUgbWVhbnMgaW5saW5lIHBhcnRpYWxcbiAgICAgICAgaWYgKGVsLm5vZGVUeXBlID09PSA4KSB7XG5cbiAgICAgICAgICAgIC8vIGtlZXAgYSByZWYgZm9yIHRoZSBwYXJ0aWFsJ3MgY29udGVudCBub2Rlc1xuICAgICAgICAgICAgdmFyIG5vZGVzID0gW10uc2xpY2UuY2FsbChwYXJ0aWFsLmNoaWxkTm9kZXMpLFxuICAgICAgICAgICAgICAgIHBhcmVudCA9IGVsLnBhcmVudE5vZGVcbiAgICAgICAgICAgIHBhcmVudC5pbnNlcnRCZWZvcmUocGFydGlhbCwgZWwpXG4gICAgICAgICAgICBwYXJlbnQucmVtb3ZlQ2hpbGQoZWwpXG4gICAgICAgICAgICAvLyBjb21waWxlIHBhcnRpYWwgYWZ0ZXIgYXBwZW5kaW5nLCBiZWNhdXNlIGl0cyBjaGlsZHJlbidzIHBhcmVudE5vZGVcbiAgICAgICAgICAgIC8vIHdpbGwgY2hhbmdlIGZyb20gdGhlIGZyYWdtZW50IHRvIHRoZSBjb3JyZWN0IHBhcmVudE5vZGUuXG4gICAgICAgICAgICAvLyBUaGlzIGNvdWxkIGFmZmVjdCBkaXJlY3RpdmVzIHRoYXQgbmVlZCBhY2Nlc3MgdG8gaXRzIGVsZW1lbnQncyBwYXJlbnROb2RlLlxuICAgICAgICAgICAgbm9kZXMuZm9yRWFjaChjb21waWxlci5jb21waWxlLCBjb21waWxlcilcblxuICAgICAgICB9IGVsc2Uge1xuXG4gICAgICAgICAgICAvLyBqdXN0IHNldCBpbm5lckhUTUwuLi5cbiAgICAgICAgICAgIGVsLmlubmVySFRNTCA9ICcnXG4gICAgICAgICAgICBlbC5hcHBlbmRDaGlsZChwYXJ0aWFsKVxuXG4gICAgICAgIH1cbiAgICB9XG5cbn0iLCJ2YXIgdXRpbHMgICAgICA9IHJlcXVpcmUoJy4uL3V0aWxzJyksXG4gICAgY29uZmlnICAgICA9IHJlcXVpcmUoJy4uL2NvbmZpZycpXG5cbi8qKlxuICogIEJpbmRpbmcgdGhhdCBtYW5hZ2VzIFZNcyBiYXNlZCBvbiBhbiBBcnJheVxuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcblxuICAgICAgICB0aGlzLmlkZW50aWZpZXIgPSAnJHInICsgdGhpcy5pZFxuXG4gICAgICAgIC8vIGEgaGFzaCB0byBjYWNoZSB0aGUgc2FtZSBleHByZXNzaW9ucyBvbiByZXBlYXRlZCBpbnN0YW5jZXNcbiAgICAgICAgLy8gc28gdGhleSBkb24ndCBoYXZlIHRvIGJlIGNvbXBpbGVkIGZvciBldmVyeSBzaW5nbGUgaW5zdGFuY2VcbiAgICAgICAgdGhpcy5leHBDYWNoZSA9IHV0aWxzLmhhc2goKVxuXG4gICAgICAgIHZhciBlbCAgID0gdGhpcy5lbCxcbiAgICAgICAgICAgIGN0biAgPSB0aGlzLmNvbnRhaW5lciA9IGVsLnBhcmVudE5vZGVcblxuICAgICAgICAvLyBleHRyYWN0IGNoaWxkIElkLCBpZiBhbnlcbiAgICAgICAgdGhpcy5jaGlsZElkID0gdGhpcy5jb21waWxlci5ldmFsKHV0aWxzLmRvbS5hdHRyKGVsLCAncmVmJykpXG5cbiAgICAgICAgLy8gY3JlYXRlIGEgY29tbWVudCBub2RlIGFzIGEgcmVmZXJlbmNlIG5vZGUgZm9yIERPTSBpbnNlcnRpb25zXG4gICAgICAgIHRoaXMucmVmID0gZG9jdW1lbnQuY3JlYXRlQ29tbWVudChjb25maWcucHJlZml4ICsgJy1yZXBlYXQtJyArIHRoaXMua2V5KVxuICAgICAgICBjdG4uaW5zZXJ0QmVmb3JlKHRoaXMucmVmLCBlbClcbiAgICAgICAgY3RuLnJlbW92ZUNoaWxkKGVsKVxuXG4gICAgICAgIHRoaXMuY29sbGVjdGlvbiA9IG51bGxcbiAgICAgICAgdGhpcy52bXMgPSBudWxsXG5cbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAoY29sbGVjdGlvbikge1xuXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShjb2xsZWN0aW9uKSkge1xuICAgICAgICAgICAgaWYgKHV0aWxzLmlzT2JqZWN0KGNvbGxlY3Rpb24pKSB7XG4gICAgICAgICAgICAgICAgY29sbGVjdGlvbiA9IHV0aWxzLm9iamVjdFRvQXJyYXkoY29sbGVjdGlvbilcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdXRpbHMud2Fybigndi1yZXBlYXQgb25seSBhY2NlcHRzIEFycmF5IG9yIE9iamVjdCB2YWx1ZXMuJylcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGtlZXAgcmVmZXJlbmNlIG9mIG9sZCBkYXRhIGFuZCBWTXNcbiAgICAgICAgLy8gc28gd2UgY2FuIHJldXNlIHRoZW0gaWYgcG9zc2libGVcbiAgICAgICAgdGhpcy5vbGRWTXMgPSB0aGlzLnZtc1xuICAgICAgICB0aGlzLm9sZENvbGxlY3Rpb24gPSB0aGlzLmNvbGxlY3Rpb25cbiAgICAgICAgY29sbGVjdGlvbiA9IHRoaXMuY29sbGVjdGlvbiA9IGNvbGxlY3Rpb24gfHwgW11cblxuICAgICAgICB2YXIgaXNPYmplY3QgPSBjb2xsZWN0aW9uWzBdICYmIHV0aWxzLmlzT2JqZWN0KGNvbGxlY3Rpb25bMF0pXG4gICAgICAgIHRoaXMudm1zID0gdGhpcy5vbGRDb2xsZWN0aW9uXG4gICAgICAgICAgICA/IHRoaXMuZGlmZihjb2xsZWN0aW9uLCBpc09iamVjdClcbiAgICAgICAgICAgIDogdGhpcy5pbml0KGNvbGxlY3Rpb24sIGlzT2JqZWN0KVxuXG4gICAgICAgIGlmICh0aGlzLmNoaWxkSWQpIHtcbiAgICAgICAgICAgIHRoaXMudm0uJFt0aGlzLmNoaWxkSWRdID0gdGhpcy52bXNcbiAgICAgICAgfVxuXG4gICAgfSxcblxuICAgIGluaXQ6IGZ1bmN0aW9uIChjb2xsZWN0aW9uLCBpc09iamVjdCkge1xuICAgICAgICB2YXIgdm0sIHZtcyA9IFtdXG4gICAgICAgIGZvciAodmFyIGkgPSAwLCBsID0gY29sbGVjdGlvbi5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgICAgIHZtID0gdGhpcy5idWlsZChjb2xsZWN0aW9uW2ldLCBpLCBpc09iamVjdClcbiAgICAgICAgICAgIHZtcy5wdXNoKHZtKVxuICAgICAgICAgICAgaWYgKHRoaXMuY29tcGlsZXIuaW5pdCkge1xuICAgICAgICAgICAgICAgIHRoaXMuY29udGFpbmVyLmluc2VydEJlZm9yZSh2bS4kZWwsIHRoaXMucmVmKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB2bS4kYmVmb3JlKHRoaXMucmVmKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2bXNcbiAgICB9LFxuXG4gICAgLyoqXG4gICAgICogIERpZmYgdGhlIG5ldyBhcnJheSB3aXRoIHRoZSBvbGRcbiAgICAgKiAgYW5kIGRldGVybWluZSB0aGUgbWluaW11bSBhbW91bnQgb2YgRE9NIG1hbmlwdWxhdGlvbnMuXG4gICAgICovXG4gICAgZGlmZjogZnVuY3Rpb24gKG5ld0NvbGxlY3Rpb24sIGlzT2JqZWN0KSB7XG5cbiAgICAgICAgdmFyIGksIGwsIGl0ZW0sIHZtLFxuICAgICAgICAgICAgb2xkSW5kZXgsXG4gICAgICAgICAgICB0YXJnZXROZXh0LFxuICAgICAgICAgICAgY3VycmVudE5leHQsXG4gICAgICAgICAgICBuZXh0RWwsXG4gICAgICAgICAgICBjdG4gICAgPSB0aGlzLmNvbnRhaW5lcixcbiAgICAgICAgICAgIG9sZFZNcyA9IHRoaXMub2xkVk1zLFxuICAgICAgICAgICAgdm1zICAgID0gW11cblxuICAgICAgICB2bXMubGVuZ3RoID0gbmV3Q29sbGVjdGlvbi5sZW5ndGhcblxuICAgICAgICAvLyBmaXJzdCBwYXNzLCBjb2xsZWN0IG5ldyByZXVzZWQgYW5kIG5ldyBjcmVhdGVkXG4gICAgICAgIGZvciAoaSA9IDAsIGwgPSBuZXdDb2xsZWN0aW9uLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgaXRlbSA9IG5ld0NvbGxlY3Rpb25baV1cbiAgICAgICAgICAgIGlmIChpc09iamVjdCkge1xuICAgICAgICAgICAgICAgIGl0ZW0uJGluZGV4ID0gaVxuICAgICAgICAgICAgICAgIGlmIChpdGVtLl9fZW1pdHRlcl9fICYmIGl0ZW0uX19lbWl0dGVyX19bdGhpcy5pZGVudGlmaWVyXSkge1xuICAgICAgICAgICAgICAgICAgICAvLyB0aGlzIHBpZWNlIG9mIGRhdGEgaXMgYmVpbmcgcmV1c2VkLlxuICAgICAgICAgICAgICAgICAgICAvLyByZWNvcmQgaXRzIGZpbmFsIHBvc2l0aW9uIGluIHJldXNlZCB2bXNcbiAgICAgICAgICAgICAgICAgICAgaXRlbS4kcmV1c2VkID0gdHJ1ZVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHZtc1tpXSA9IHRoaXMuYnVpbGQoaXRlbSwgaSwgaXNPYmplY3QpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyB3ZSBjYW4ndCBhdHRhY2ggYW4gaWRlbnRpZmllciB0byBwcmltaXRpdmUgdmFsdWVzXG4gICAgICAgICAgICAgICAgLy8gc28gaGF2ZSB0byBkbyBhbiBpbmRleE9mLi4uXG4gICAgICAgICAgICAgICAgb2xkSW5kZXggPSBpbmRleE9mKG9sZFZNcywgaXRlbSlcbiAgICAgICAgICAgICAgICBpZiAob2xkSW5kZXggPiAtMSkge1xuICAgICAgICAgICAgICAgICAgICAvLyByZWNvcmQgdGhlIHBvc2l0aW9uIG9uIHRoZSBleGlzdGluZyB2bVxuICAgICAgICAgICAgICAgICAgICBvbGRWTXNbb2xkSW5kZXhdLiRyZXVzZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgICAgIG9sZFZNc1tvbGRJbmRleF0uJGRhdGEuJGluZGV4ID0gaVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHZtc1tpXSA9IHRoaXMuYnVpbGQoaXRlbSwgaSwgaXNPYmplY3QpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gc2Vjb25kIHBhc3MsIGNvbGxlY3Qgb2xkIHJldXNlZCBhbmQgZGVzdHJveSB1bnVzZWRcbiAgICAgICAgZm9yIChpID0gMCwgbCA9IG9sZFZNcy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgICAgIHZtID0gb2xkVk1zW2ldXG4gICAgICAgICAgICBpdGVtID0gdGhpcy5hcmdcbiAgICAgICAgICAgICAgICA/IHZtLiRkYXRhW3RoaXMuYXJnXVxuICAgICAgICAgICAgICAgIDogdm0uJGRhdGFcbiAgICAgICAgICAgIGlmIChpdGVtLiRyZXVzZWQpIHtcbiAgICAgICAgICAgICAgICB2bS4kcmV1c2VkID0gdHJ1ZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBpdGVtLiRyZXVzZWRcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2bS4kcmV1c2VkKSB7XG4gICAgICAgICAgICAgICAgLy8gdXBkYXRlIHRoZSBpbmRleCB0byBsYXRlc3RcbiAgICAgICAgICAgICAgICB2bS4kaW5kZXggPSBpdGVtLiRpbmRleFxuICAgICAgICAgICAgICAgIC8vIHRoZSBpdGVtIGNvdWxkIGhhdmUgaGFkIGEgbmV3IGtleVxuICAgICAgICAgICAgICAgIGlmIChpdGVtLiRrZXkgJiYgaXRlbS4ka2V5ICE9PSB2bS4ka2V5KSB7XG4gICAgICAgICAgICAgICAgICAgIHZtLiRrZXkgPSBpdGVtLiRrZXlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdm1zW3ZtLiRpbmRleF0gPSB2bVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyB0aGlzIG9uZSBjYW4gYmUgZGVzdHJveWVkLlxuICAgICAgICAgICAgICAgIGlmIChpdGVtLl9fZW1pdHRlcl9fKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlbGV0ZSBpdGVtLl9fZW1pdHRlcl9fW3RoaXMuaWRlbnRpZmllcl1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdm0uJGRlc3Ryb3koKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gZmluYWwgcGFzcywgbW92ZS9pbnNlcnQgRE9NIGVsZW1lbnRzXG4gICAgICAgIGkgPSB2bXMubGVuZ3RoXG4gICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgIHZtID0gdm1zW2ldXG4gICAgICAgICAgICBpdGVtID0gdm0uJGRhdGFcbiAgICAgICAgICAgIHRhcmdldE5leHQgPSB2bXNbaSArIDFdXG4gICAgICAgICAgICBpZiAodm0uJHJldXNlZCkge1xuICAgICAgICAgICAgICAgIG5leHRFbCA9IHZtLiRlbC5uZXh0U2libGluZ1xuICAgICAgICAgICAgICAgIC8vIGRlc3Ryb3llZCBWTXMnIGVsZW1lbnQgbWlnaHQgc3RpbGwgYmUgaW4gdGhlIERPTVxuICAgICAgICAgICAgICAgIC8vIGR1ZSB0byB0cmFuc2l0aW9uc1xuICAgICAgICAgICAgICAgIHdoaWxlICghbmV4dEVsLnZ1ZV92bSAmJiBuZXh0RWwgIT09IHRoaXMucmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIG5leHRFbCA9IG5leHRFbC5uZXh0U2libGluZ1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjdXJyZW50TmV4dCA9IG5leHRFbC52dWVfdm1cbiAgICAgICAgICAgICAgICBpZiAoY3VycmVudE5leHQgIT09IHRhcmdldE5leHQpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF0YXJnZXROZXh0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjdG4uaW5zZXJ0QmVmb3JlKHZtLiRlbCwgdGhpcy5yZWYpXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXh0RWwgPSB0YXJnZXROZXh0LiRlbFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gbmV3IFZNcycgZWxlbWVudCBtaWdodCBub3QgYmUgaW4gdGhlIERPTSB5ZXRcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGR1ZSB0byB0cmFuc2l0aW9uc1xuICAgICAgICAgICAgICAgICAgICAgICAgd2hpbGUgKCFuZXh0RWwucGFyZW50Tm9kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldE5leHQgPSB2bXNbbmV4dEVsLnZ1ZV92bS4kaW5kZXggKyAxXVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5leHRFbCA9IHRhcmdldE5leHRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB0YXJnZXROZXh0LiRlbFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IHRoaXMucmVmXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBjdG4uaW5zZXJ0QmVmb3JlKHZtLiRlbCwgbmV4dEVsKVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlbGV0ZSB2bS4kcmV1c2VkXG4gICAgICAgICAgICAgICAgZGVsZXRlIGl0ZW0uJGluZGV4XG4gICAgICAgICAgICAgICAgZGVsZXRlIGl0ZW0uJGtleVxuICAgICAgICAgICAgfSBlbHNlIHsgLy8gYSBuZXcgdm1cbiAgICAgICAgICAgICAgICB2bS4kYmVmb3JlKHRhcmdldE5leHQgPyB0YXJnZXROZXh0LiRlbCA6IHRoaXMucmVmKVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZtc1xuICAgIH0sXG5cbiAgICBidWlsZDogZnVuY3Rpb24gKGRhdGEsIGluZGV4LCBpc09iamVjdCkge1xuXG4gICAgICAgIC8vIHdyYXAgbm9uLW9iamVjdCB2YWx1ZXNcbiAgICAgICAgdmFyIHJhdywgYWxpYXMsXG4gICAgICAgICAgICB3cmFwID0gIWlzT2JqZWN0IHx8IHRoaXMuYXJnXG4gICAgICAgIGlmICh3cmFwKSB7XG4gICAgICAgICAgICByYXcgPSBkYXRhXG4gICAgICAgICAgICBhbGlhcyA9IHRoaXMuYXJnIHx8ICckdmFsdWUnXG4gICAgICAgICAgICBkYXRhID0ge31cbiAgICAgICAgICAgIGRhdGFbYWxpYXNdID0gcmF3XG4gICAgICAgIH1cbiAgICAgICAgZGF0YS4kaW5kZXggPSBpbmRleFxuXG4gICAgICAgIHZhciBlbCA9IHRoaXMuZWwuY2xvbmVOb2RlKHRydWUpLFxuICAgICAgICAgICAgQ3RvciA9IHRoaXMuY29tcGlsZXIucmVzb2x2ZUNvbXBvbmVudChlbCwgZGF0YSksXG4gICAgICAgICAgICB2bSA9IG5ldyBDdG9yKHtcbiAgICAgICAgICAgICAgICBlbDogZWwsXG4gICAgICAgICAgICAgICAgZGF0YTogZGF0YSxcbiAgICAgICAgICAgICAgICBwYXJlbnQ6IHRoaXMudm0sXG4gICAgICAgICAgICAgICAgY29tcGlsZXJPcHRpb25zOiB7XG4gICAgICAgICAgICAgICAgICAgIHJlcGVhdDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgZXhwQ2FjaGU6IHRoaXMuZXhwQ2FjaGVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KVxuXG4gICAgICAgIGlmIChpc09iamVjdCkge1xuICAgICAgICAgICAgLy8gYXR0YWNoIGFuIGllbnVtZXJhYmxlIGlkZW50aWZpZXIgdG8gdGhlIHJhdyBkYXRhXG4gICAgICAgICAgICAocmF3IHx8IGRhdGEpLl9fZW1pdHRlcl9fW3RoaXMuaWRlbnRpZmllcl0gPSB0cnVlXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdm1cblxuICAgIH0sXG5cbiAgICB1bmJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgaWYgKHRoaXMuY2hpbGRJZCkge1xuICAgICAgICAgICAgZGVsZXRlIHRoaXMudm0uJFt0aGlzLmNoaWxkSWRdXG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMudm1zKSB7XG4gICAgICAgICAgICB2YXIgaSA9IHRoaXMudm1zLmxlbmd0aFxuICAgICAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgICAgIHRoaXMudm1zW2ldLiRkZXN0cm95KClcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuLy8gSGVscGVycyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqICBGaW5kIGFuIG9iamVjdCBvciBhIHdyYXBwZWQgZGF0YSBvYmplY3RcbiAqICBmcm9tIGFuIEFycmF5XG4gKi9cbmZ1bmN0aW9uIGluZGV4T2YgKHZtcywgb2JqKSB7XG4gICAgZm9yICh2YXIgdm0sIGkgPSAwLCBsID0gdm1zLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICB2bSA9IHZtc1tpXVxuICAgICAgICBpZiAoIXZtLiRyZXVzZWQgJiYgdm0uJHZhbHVlID09PSBvYmopIHtcbiAgICAgICAgICAgIHJldHVybiBpXG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIC0xXG59IiwidmFyIHByZWZpeGVzID0gWyctd2Via2l0LScsICctbW96LScsICctbXMtJ11cblxuLyoqXG4gKiAgQmluZGluZyBmb3IgQ1NTIHN0eWxlc1xuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIHByb3AgPSB0aGlzLmFyZ1xuICAgICAgICBpZiAoIXByb3ApIHJldHVyblxuICAgICAgICBpZiAocHJvcC5jaGFyQXQoMCkgPT09ICckJykge1xuICAgICAgICAgICAgLy8gcHJvcGVydGllcyB0aGF0IHN0YXJ0IHdpdGggJCB3aWxsIGJlIGF1dG8tcHJlZml4ZWRcbiAgICAgICAgICAgIHByb3AgPSBwcm9wLnNsaWNlKDEpXG4gICAgICAgICAgICB0aGlzLnByZWZpeGVkID0gdHJ1ZVxuICAgICAgICB9XG4gICAgICAgIHRoaXMucHJvcCA9IHByb3BcbiAgICB9LFxuXG4gICAgdXBkYXRlOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgdmFyIHByb3AgPSB0aGlzLnByb3AsXG4gICAgICAgICAgICBpc0ltcG9ydGFudFxuICAgICAgICAvKiBqc2hpbnQgZXFlcWVxOiB0cnVlICovXG4gICAgICAgIC8vIGNhc3QgcG9zc2libGUgbnVtYmVycy9ib29sZWFucyBpbnRvIHN0cmluZ3NcbiAgICAgICAgaWYgKHZhbHVlICE9IG51bGwpIHZhbHVlICs9ICcnXG4gICAgICAgIGlmIChwcm9wKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpc0ltcG9ydGFudCA9IHZhbHVlLnNsaWNlKC0xMCkgPT09ICchaW1wb3J0YW50J1xuICAgICAgICAgICAgICAgICAgICA/ICdpbXBvcnRhbnQnXG4gICAgICAgICAgICAgICAgICAgIDogJydcbiAgICAgICAgICAgICAgICBpZiAoaXNJbXBvcnRhbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFsdWUgPSB2YWx1ZS5zbGljZSgwLCAtMTApLnRyaW0oKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuZWwuc3R5bGUuc2V0UHJvcGVydHkocHJvcCwgdmFsdWUsIGlzSW1wb3J0YW50KVxuICAgICAgICAgICAgaWYgKHRoaXMucHJlZml4ZWQpIHtcbiAgICAgICAgICAgICAgICB2YXIgaSA9IHByZWZpeGVzLmxlbmd0aFxuICAgICAgICAgICAgICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5lbC5zdHlsZS5zZXRQcm9wZXJ0eShwcmVmaXhlc1tpXSArIHByb3AsIHZhbHVlLCBpc0ltcG9ydGFudClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmVsLnN0eWxlLmNzc1RleHQgPSB2YWx1ZVxuICAgICAgICB9XG4gICAgfVxuXG59IiwiLyoqXG4gKiAgTWFuYWdlcyBhIGNvbmRpdGlvbmFsIGNoaWxkIFZNIHVzaW5nIHRoZVxuICogIGJpbmRpbmcncyB2YWx1ZSBhcyB0aGUgY29tcG9uZW50IElELlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IHtcblxuICAgIGJpbmQ6IGZ1bmN0aW9uICgpIHtcblxuICAgICAgICAvLyB0cmFjayBwb3NpdGlvbiBpbiBET00gd2l0aCBhIHJlZiBub2RlXG4gICAgICAgIHZhciBlbCAgICAgICA9IHRoaXMucmF3ID0gdGhpcy5lbCxcbiAgICAgICAgICAgIHBhcmVudCAgID0gZWwucGFyZW50Tm9kZSxcbiAgICAgICAgICAgIHJlZiAgICAgID0gdGhpcy5yZWYgPSBkb2N1bWVudC5jcmVhdGVDb21tZW50KCd2LXZpZXcnKVxuICAgICAgICBwYXJlbnQuaW5zZXJ0QmVmb3JlKHJlZiwgZWwpXG4gICAgICAgIHBhcmVudC5yZW1vdmVDaGlsZChlbClcblxuICAgICAgICAvLyBjYWNoZSBvcmlnaW5hbCBjb250ZW50XG4gICAgICAgIC8qIGpzaGludCBib3NzOiB0cnVlICovXG4gICAgICAgIHZhciBub2RlLFxuICAgICAgICAgICAgZnJhZyA9IHRoaXMuaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKVxuICAgICAgICB3aGlsZSAobm9kZSA9IGVsLmZpcnN0Q2hpbGQpIHtcbiAgICAgICAgICAgIGZyYWcuYXBwZW5kQ2hpbGQobm9kZSlcbiAgICAgICAgfVxuXG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24odmFsdWUpIHtcblxuICAgICAgICB0aGlzLnVuYmluZCgpXG5cbiAgICAgICAgdmFyIEN0b3IgID0gdGhpcy5jb21waWxlci5nZXRPcHRpb24oJ2NvbXBvbmVudHMnLCB2YWx1ZSlcbiAgICAgICAgaWYgKCFDdG9yKSByZXR1cm5cblxuICAgICAgICB0aGlzLmNoaWxkVk0gPSBuZXcgQ3Rvcih7XG4gICAgICAgICAgICBlbDogdGhpcy5yYXcuY2xvbmVOb2RlKHRydWUpLFxuICAgICAgICAgICAgcGFyZW50OiB0aGlzLnZtLFxuICAgICAgICAgICAgY29tcGlsZXJPcHRpb25zOiB7XG4gICAgICAgICAgICAgICAgcmF3Q29udGVudDogdGhpcy5pbm5lci5jbG9uZU5vZGUodHJ1ZSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSlcblxuICAgICAgICB0aGlzLmVsID0gdGhpcy5jaGlsZFZNLiRlbFxuICAgICAgICBpZiAodGhpcy5jb21waWxlci5pbml0KSB7XG4gICAgICAgICAgICB0aGlzLnJlZi5wYXJlbnROb2RlLmluc2VydEJlZm9yZSh0aGlzLmVsLCB0aGlzLnJlZilcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuY2hpbGRWTS4kYmVmb3JlKHRoaXMucmVmKVxuICAgICAgICB9XG5cbiAgICB9LFxuXG4gICAgdW5iaW5kOiBmdW5jdGlvbigpIHtcbiAgICAgICAgaWYgKHRoaXMuY2hpbGRWTSkge1xuICAgICAgICAgICAgdGhpcy5jaGlsZFZNLiRkZXN0cm95KClcbiAgICAgICAgfVxuICAgIH1cblxufSIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJylcblxuLyoqXG4gKiAgQmluZGluZyBmb3IgaW5oZXJpdGluZyBkYXRhIGZyb20gcGFyZW50IFZNcy5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSB7XG5cbiAgICBiaW5kOiBmdW5jdGlvbiAoKSB7XG5cbiAgICAgICAgdmFyIHNlbGYgICAgICA9IHRoaXMsXG4gICAgICAgICAgICBjaGlsZEtleSAgPSBzZWxmLmFyZyxcbiAgICAgICAgICAgIHBhcmVudEtleSA9IHNlbGYua2V5LFxuICAgICAgICAgICAgY29tcGlsZXIgID0gc2VsZi5jb21waWxlcixcbiAgICAgICAgICAgIG93bmVyICAgICA9IHNlbGYuYmluZGluZy5jb21waWxlclxuXG4gICAgICAgIGlmIChjb21waWxlciA9PT0gb3duZXIpIHtcbiAgICAgICAgICAgIHRoaXMuYWxvbmUgPSB0cnVlXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjaGlsZEtleSkge1xuICAgICAgICAgICAgaWYgKCFjb21waWxlci5iaW5kaW5nc1tjaGlsZEtleV0pIHtcbiAgICAgICAgICAgICAgICBjb21waWxlci5jcmVhdGVCaW5kaW5nKGNoaWxkS2V5KVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gc3luYyBjaGFuZ2VzIG9uIGNoaWxkIGJhY2sgdG8gcGFyZW50XG4gICAgICAgICAgICBjb21waWxlci5vYnNlcnZlci5vbignY2hhbmdlOicgKyBjaGlsZEtleSwgZnVuY3Rpb24gKHZhbCkge1xuICAgICAgICAgICAgICAgIGlmIChjb21waWxlci5pbml0KSByZXR1cm5cbiAgICAgICAgICAgICAgICBpZiAoIXNlbGYubG9jaykge1xuICAgICAgICAgICAgICAgICAgICBzZWxmLmxvY2sgPSB0cnVlXG4gICAgICAgICAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYubG9jayA9IGZhbHNlXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG93bmVyLnZtLiRzZXQocGFyZW50S2V5LCB2YWwpXG4gICAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIHVwZGF0ZTogZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIC8vIHN5bmMgZnJvbSBwYXJlbnRcbiAgICAgICAgaWYgKCF0aGlzLmFsb25lICYmICF0aGlzLmxvY2spIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmFyZykge1xuICAgICAgICAgICAgICAgIHRoaXMudm0uJHNldCh0aGlzLmFyZywgdmFsdWUpXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMudm0uJGRhdGEgIT09IHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgdGhpcy52bS4kZGF0YSA9IHZhbHVlXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbn0iLCIvKipcbiAqIEV2ZW50VGFyZ2V0IG1vZHVsZVxuICogQGF1dGhvcjogeHVlamlhLmN4ai82MTc0XG4gKi9cbnZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcbmZ1bmN0aW9uIEV2ZW50VGFyZ2V0KGN0eCl7XG4gICAgdGhpcy5fY3R4ID0gY3R4IHx8IHRoaXM7ICBcbn1cblxudXRpbHMubWl4KEV2ZW50VGFyZ2V0LnByb3RvdHlwZSwge1xuICAgIG9uOiBmdW5jdGlvbih0eXBlLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgY29udGV4dCA9IHRoaXMuX2N0eCB8fCB0aGlzO1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFjayA9IGNvbnRleHQuX2NhbGxiYWNrIHx8IHt9O1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXSA9IGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdIHx8IFtdO1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXS5wdXNoKGNhbGxiYWNrKTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSxcbiAgICBvbmNlOiBmdW5jdGlvbihldmVudCwgZm4pe1xuICAgICAgICB2YXIgY29udGV4dCA9IHRoaXMuX2N0eCB8fCB0aGlzO1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFjayA9IGNvbnRleHQuX2NhbGxiYWNrIHx8IHt9O1xuICAgICAgICBmdW5jdGlvbiBvbigpe1xuICAgICAgICAgICAgY29udGV4dC5kZXRhY2goZXZlbnQsIG9uKTtcbiAgICAgICAgICAgIGZuLmFwcGx5KGNvbnRleHQsIGFyZ3VtZW50cyk7XG4gICAgICAgIH1cbiAgICAgICAgb24uZm4gPSBmbjtcbiAgICAgICAgY29udGV4dC5vbihldmVudCwgb24pO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9LFxuICAgIGRldGFjaDogZnVuY3Rpb24odHlwZSwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIGNvbnRleHQgPSB0aGlzLl9jdHggfHwgdGhpcztcbiAgICAgICAgY29udGV4dC5fY2FsbGJhY2sgPSBjb250ZXh0Ll9jYWxsYmFjayB8fCB7fTtcbiAgICAgICAgaWYgKCF0eXBlKSB7XG4gICAgICAgICAgICBjb250ZXh0Ll9jYWxsYmFjayA9IHt9O1xuICAgICAgICB9IGVsc2UgaWYgKCFjYWxsYmFjaykge1xuICAgICAgICAgICAgY29udGV4dC5fY2FsbGJhY2tbdHlwZV0gPSBbXTtcbiAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Ll9jYWxsYmFja1t0eXBlXSAmJiBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICB2YXIgaW5kZXggPSB1dGlscy5hcnJheS5pbmRleE9mKGNhbGxiYWNrLCBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXSk7XG4gICAgICAgICAgICBpZiAoaW5kZXggIT0gLTEpIGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdLnNwbGljZShpbmRleCwgMSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSxcbiAgICBmaXJlOiBmdW5jdGlvbih0eXBlLCBkYXRhKSB7XG4gICAgICAgIHZhciBjb250ZXh0ID0gdGhpcy5fY3R4IHx8IHRoaXM7XG4gICAgICAgIGlmIChjb250ZXh0Ll9jYWxsYmFjaykge1xuICAgICAgICAgICAgdmFyIGFyciA9IGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdO1xuICAgICAgICAgICAgaWYgKGFyciAmJiBhcnIubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBkYXRhIHx8IHt9O1xuICAgICAgICAgICAgICAgIGRhdGEudHlwZSA9IHR5cGU7XG4gICAgICAgICAgICAgICAgZGF0YS50YXJnZXQgPSBjb250ZXh0O1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGkgPSBhcnIubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgICAgICAgICAgICAgICAgdXRpbHMuaXNGdW5jdGlvbihhcnJbaV0pICYmIGFycltpXS5jYWxsKGNvbnRleHQsIGRhdGEpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG59KTtcblxudXRpbHMubWl4KEV2ZW50VGFyZ2V0LnByb3RvdHlwZSwge1xuICAgIGVtaXQ6IEV2ZW50VGFyZ2V0LnByb3RvdHlwZS5maXJlLFxuICAgIG9mZjogRXZlbnRUYXJnZXQucHJvdG90eXBlLmRldGFjaFxufSk7XG5cbm1vZHVsZS5leHBvcnRzID0gRXZlbnRUYXJnZXQ7IiwidmFyIGNvbmZpZyAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICB1dGlscyAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBkZWZlciAgICAgICA9IHJlcXVpcmUoJy4vZGVmZXJyZWQnKSxcbiAgICBQYXJzZXIgICAgICA9IHJlcXVpcmUoJy4vcGFyc2VyJyksXG4gICAgbWFrZUhhc2ggICAgPSB1dGlscy5oYXNoO1xuICAgIFZpZXdNb2RlbCAgID0gcmVxdWlyZSgnLi92aWV3bW9kZWwnKTtcblxuXG5WaWV3TW9kZWwub3B0aW9ucyA9IGNvbmZpZy5nbG9iYWxBc3NldHMgPSB7XG4gICAgZGlyZWN0aXZlcyAgOiByZXF1aXJlKCcuL2RpcmVjdGl2ZXMnKSxcbiAgICBmaWx0ZXJzICAgICA6IHJlcXVpcmUoJy4vZmlsdGVycycpLFxuICAgIHBhcnRpYWxzICAgIDogbWFrZUhhc2goKSxcbiAgICBlZmZlY3RzICAgICA6IG1ha2VIYXNoKCksXG4gICAgY29tcG9uZW50cyAgOiBtYWtlSGFzaCgpXG59O1xuXG51dGlscy5lYWNoKFsnZGlyZWN0aXZlJywgJ2ZpbHRlcicsICdwYXJ0aWFsJywgJ2VmZmVjdCcsICdjb21wb25lbnQnXSwgZnVuY3Rpb24odHlwZSl7XG5cdFZpZXdNb2RlbFt0eXBlXSA9IGZ1bmN0aW9uKGlkLCB2YWx1ZSl7XG5cdFx0dmFyIGhhc2ggPSB0aGlzLm9wdGlvbnNbdHlwZSArICdzJ107XG5cdFx0aWYoIWhhc2gpe1xuXHRcdFx0aGFzaCA9IHRoaXMub3B0aW9uc1t0eXBlICsgJ3MnXSA9IHV0aWxzLmhhc2goKTtcblx0XHR9XG5cdFx0aWYoIXZhbHVlKXtcblx0XHRcdHJldHVybiBoYXNoW2lkXTtcblx0XHR9XG5cdFx0aWYgKHR5cGUgPT09ICdwYXJ0aWFsJykge1xuICAgICAgICAgICAgdmFsdWUgPSBQYXJzZXIucGFyc2VUZW1wbGF0ZSh2YWx1ZSk7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2NvbXBvbmVudCcpIHtcbiAgICAgICAgICAgIC8vIHZhbHVlID0gdXRpbHMudG9Db25zdHJ1Y3Rvcih2YWx1ZSlcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnZmlsdGVyJykge1xuICAgICAgICAgICAgLy8gdXRpbHMuY2hlY2tGaWx0ZXIodmFsdWUpXG4gICAgICAgIH1cbiAgICAgICAgaGFzaFtpZF0gPSB2YWx1ZTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG5cdH1cbn0pO1xuXG53aW5kb3cuVk0gPSBWaWV3TW9kZWw7XG5tb2R1bGUuZXhwb3J0cyA9IFZpZXdNb2RlbDtcbiIsInZhciB1dGlscyAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBnZXQgICAgICA9IHV0aWxzLm9iamVjdC5nZXQsXG4gICAgc2xpY2UgICAgPSBbXS5zbGljZSxcbiAgICBRVU9URV9SRSA9IC9eJy4qJyQvLFxuICAgIGZpbHRlcnMgID0gbW9kdWxlLmV4cG9ydHMgPSB1dGlscy5oYXNoKClcblxuLyoqXG4gKiAgJ2FiYycgPT4gJ0FiYydcbiAqL1xuZmlsdGVycy5jYXBpdGFsaXplID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgaWYgKCF2YWx1ZSAmJiB2YWx1ZSAhPT0gMCkgcmV0dXJuICcnXG4gICAgdmFsdWUgPSB2YWx1ZS50b1N0cmluZygpXG4gICAgcmV0dXJuIHZhbHVlLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgdmFsdWUuc2xpY2UoMSlcbn1cblxuLyoqXG4gKiAgJ2FiYycgPT4gJ0FCQydcbiAqL1xuZmlsdGVycy51cHBlcmNhc2UgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICByZXR1cm4gKHZhbHVlIHx8IHZhbHVlID09PSAwKVxuICAgICAgICA/IHZhbHVlLnRvU3RyaW5nKCkudG9VcHBlckNhc2UoKVxuICAgICAgICA6ICcnXG59XG5cbi8qKlxuICogICdBYkMnID0+ICdhYmMnXG4gKi9cbmZpbHRlcnMubG93ZXJjYXNlID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgcmV0dXJuICh2YWx1ZSB8fCB2YWx1ZSA9PT0gMClcbiAgICAgICAgPyB2YWx1ZS50b1N0cmluZygpLnRvTG93ZXJDYXNlKClcbiAgICAgICAgOiAnJ1xufVxuXG4vKipcbiAqICAxMjM0NSA9PiAkMTIsMzQ1LjAwXG4gKi9cbmZpbHRlcnMuY3VycmVuY3kgPSBmdW5jdGlvbiAodmFsdWUsIHNpZ24pIHtcbiAgICB2YWx1ZSA9IHBhcnNlRmxvYXQodmFsdWUpXG4gICAgaWYgKCF2YWx1ZSAmJiB2YWx1ZSAhPT0gMCkgcmV0dXJuICcnXG4gICAgc2lnbiA9IHNpZ24gfHwgJyQnXG4gICAgdmFyIHMgPSBNYXRoLmZsb29yKHZhbHVlKS50b1N0cmluZygpLFxuICAgICAgICBpID0gcy5sZW5ndGggJSAzLFxuICAgICAgICBoID0gaSA+IDAgPyAocy5zbGljZSgwLCBpKSArIChzLmxlbmd0aCA+IDMgPyAnLCcgOiAnJykpIDogJycsXG4gICAgICAgIGYgPSAnLicgKyB2YWx1ZS50b0ZpeGVkKDIpLnNsaWNlKC0yKVxuICAgIHJldHVybiBzaWduICsgaCArIHMuc2xpY2UoaSkucmVwbGFjZSgvKFxcZHszfSkoPz1cXGQpL2csICckMSwnKSArIGZcbn1cblxuLyoqXG4gKiAgYXJnczogYW4gYXJyYXkgb2Ygc3RyaW5ncyBjb3JyZXNwb25kaW5nIHRvXG4gKiAgdGhlIHNpbmdsZSwgZG91YmxlLCB0cmlwbGUgLi4uIGZvcm1zIG9mIHRoZSB3b3JkIHRvXG4gKiAgYmUgcGx1cmFsaXplZC4gV2hlbiB0aGUgbnVtYmVyIHRvIGJlIHBsdXJhbGl6ZWRcbiAqICBleGNlZWRzIHRoZSBsZW5ndGggb2YgdGhlIGFyZ3MsIGl0IHdpbGwgdXNlIHRoZSBsYXN0XG4gKiAgZW50cnkgaW4gdGhlIGFycmF5LlxuICpcbiAqICBlLmcuIFsnc2luZ2xlJywgJ2RvdWJsZScsICd0cmlwbGUnLCAnbXVsdGlwbGUnXVxuICovXG5maWx0ZXJzLnBsdXJhbGl6ZSA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHZhciBhcmdzID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpXG4gICAgcmV0dXJuIGFyZ3MubGVuZ3RoID4gMVxuICAgICAgICA/IChhcmdzW3ZhbHVlIC0gMV0gfHwgYXJnc1thcmdzLmxlbmd0aCAtIDFdKVxuICAgICAgICA6IChhcmdzW3ZhbHVlIC0gMV0gfHwgYXJnc1swXSArICdzJylcbn1cblxuLyoqXG4gKiAgQSBzcGVjaWFsIGZpbHRlciB0aGF0IHRha2VzIGEgaGFuZGxlciBmdW5jdGlvbixcbiAqICB3cmFwcyBpdCBzbyBpdCBvbmx5IGdldHMgdHJpZ2dlcmVkIG9uIHNwZWNpZmljIGtleXByZXNzZXMuXG4gKlxuICogIHYtb24gb25seVxuICovXG5cbnZhciBrZXlDb2RlcyA9IHtcbiAgICBlbnRlciAgICA6IDEzLFxuICAgIHRhYiAgICAgIDogOSxcbiAgICAnZGVsZXRlJyA6IDQ2LFxuICAgIHVwICAgICAgIDogMzgsXG4gICAgbGVmdCAgICAgOiAzNyxcbiAgICByaWdodCAgICA6IDM5LFxuICAgIGRvd24gICAgIDogNDAsXG4gICAgZXNjICAgICAgOiAyN1xufVxuXG5maWx0ZXJzLmtleSA9IGZ1bmN0aW9uIChoYW5kbGVyLCBrZXkpIHtcbiAgICBpZiAoIWhhbmRsZXIpIHJldHVyblxuICAgIHZhciBjb2RlID0ga2V5Q29kZXNba2V5XVxuICAgIGlmICghY29kZSkge1xuICAgICAgICBjb2RlID0gcGFyc2VJbnQoa2V5LCAxMClcbiAgICB9XG4gICAgcmV0dXJuIGZ1bmN0aW9uIChlKSB7XG4gICAgICAgIGlmIChlLmtleUNvZGUgPT09IGNvZGUpIHtcbiAgICAgICAgICAgIHJldHVybiBoYW5kbGVyLmNhbGwodGhpcywgZSlcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgRmlsdGVyIGZpbHRlciBmb3Igdi1yZXBlYXRcbiAqL1xuZmlsdGVycy5maWx0ZXJCeSA9IGZ1bmN0aW9uIChhcnIsIHNlYXJjaEtleSwgZGVsaW1pdGVyLCBkYXRhS2V5KSB7XG5cbiAgICAvLyBhbGxvdyBvcHRpb25hbCBgaW5gIGRlbGltaXRlclxuICAgIC8vIGJlY2F1c2Ugd2h5IG5vdFxuICAgIGlmIChkZWxpbWl0ZXIgJiYgZGVsaW1pdGVyICE9PSAnaW4nKSB7XG4gICAgICAgIGRhdGFLZXkgPSBkZWxpbWl0ZXJcbiAgICB9XG5cbiAgICAvLyBnZXQgdGhlIHNlYXJjaCBzdHJpbmdcbiAgICB2YXIgc2VhcmNoID0gc3RyaXBRdW90ZXMoc2VhcmNoS2V5KSB8fCB0aGlzLiRnZXQoc2VhcmNoS2V5KVxuICAgIGlmICghc2VhcmNoKSByZXR1cm4gYXJyXG4gICAgc2VhcmNoID0gc2VhcmNoLnRvTG93ZXJDYXNlKClcblxuICAgIC8vIGdldCB0aGUgb3B0aW9uYWwgZGF0YUtleVxuICAgIGRhdGFLZXkgPSBkYXRhS2V5ICYmIChzdHJpcFF1b3RlcyhkYXRhS2V5KSB8fCB0aGlzLiRnZXQoZGF0YUtleSkpXG5cbiAgICAvLyBjb252ZXJ0IG9iamVjdCB0byBhcnJheVxuICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSB7XG4gICAgICAgIGFyciA9IHV0aWxzLm9iamVjdFRvQXJyYXkoYXJyKVxuICAgIH1cblxuICAgIHJldHVybiBhcnIuZmlsdGVyKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICAgIHJldHVybiBkYXRhS2V5XG4gICAgICAgICAgICA/IGNvbnRhaW5zKGdldChpdGVtLCBkYXRhS2V5KSwgc2VhcmNoKVxuICAgICAgICAgICAgOiBjb250YWlucyhpdGVtLCBzZWFyY2gpXG4gICAgfSlcblxufVxuXG5maWx0ZXJzLmZpbHRlckJ5LmNvbXB1dGVkID0gdHJ1ZVxuXG4vKipcbiAqICBTb3J0IGZpdGxlciBmb3Igdi1yZXBlYXRcbiAqL1xuZmlsdGVycy5vcmRlckJ5ID0gZnVuY3Rpb24gKGFyciwgc29ydEtleSwgcmV2ZXJzZUtleSkge1xuXG4gICAgdmFyIGtleSA9IHN0cmlwUXVvdGVzKHNvcnRLZXkpIHx8IHRoaXMuJGdldChzb3J0S2V5KVxuICAgIGlmICgha2V5KSByZXR1cm4gYXJyXG5cbiAgICAvLyBjb252ZXJ0IG9iamVjdCB0byBhcnJheVxuICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSB7XG4gICAgICAgIGFyciA9IHV0aWxzLm9iamVjdFRvQXJyYXkoYXJyKVxuICAgIH1cblxuICAgIHZhciBvcmRlciA9IDFcbiAgICBpZiAocmV2ZXJzZUtleSkge1xuICAgICAgICBpZiAocmV2ZXJzZUtleSA9PT0gJy0xJykge1xuICAgICAgICAgICAgb3JkZXIgPSAtMVxuICAgICAgICB9IGVsc2UgaWYgKHJldmVyc2VLZXkuY2hhckF0KDApID09PSAnIScpIHtcbiAgICAgICAgICAgIHJldmVyc2VLZXkgPSByZXZlcnNlS2V5LnNsaWNlKDEpXG4gICAgICAgICAgICBvcmRlciA9IHRoaXMuJGdldChyZXZlcnNlS2V5KSA/IDEgOiAtMVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3JkZXIgPSB0aGlzLiRnZXQocmV2ZXJzZUtleSkgPyAtMSA6IDFcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIHNvcnQgb24gYSBjb3B5IHRvIGF2b2lkIG11dGF0aW5nIG9yaWdpbmFsIGFycmF5XG4gICAgcmV0dXJuIGFyci5zbGljZSgpLnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICAgICAgYSA9IGdldChhLCBrZXkpXG4gICAgICAgIGIgPSBnZXQoYiwga2V5KVxuICAgICAgICByZXR1cm4gYSA9PT0gYiA/IDAgOiBhID4gYiA/IG9yZGVyIDogLW9yZGVyXG4gICAgfSlcblxufVxuXG5maWx0ZXJzLm9yZGVyQnkuY29tcHV0ZWQgPSB0cnVlXG5cbi8vIEFycmF5IGZpbHRlciBoZWxwZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiAgU3RyaW5nIGNvbnRhaW4gaGVscGVyXG4gKi9cbmZ1bmN0aW9uIGNvbnRhaW5zICh2YWwsIHNlYXJjaCkge1xuICAgIC8qIGpzaGludCBlcWVxZXE6IGZhbHNlICovXG4gICAgaWYgKHV0aWxzLmlzT2JqZWN0KHZhbCkpIHtcbiAgICAgICAgZm9yICh2YXIga2V5IGluIHZhbCkge1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5zKHZhbFtrZXldLCBzZWFyY2gpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAodmFsICE9IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIHZhbC50b1N0cmluZygpLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihzZWFyY2gpID4gLTFcbiAgICB9XG59XG5cbi8qKlxuICogIFRlc3Qgd2hldGhlciBhIHN0cmluZyBpcyBpbiBxdW90ZXMsXG4gKiAgaWYgeWVzIHJldHVybiBzdHJpcHBlZCBzdHJpbmdcbiAqL1xuZnVuY3Rpb24gc3RyaXBRdW90ZXMgKHN0cikge1xuICAgIGlmIChRVU9URV9SRS50ZXN0KHN0cikpIHtcbiAgICAgICAgcmV0dXJuIHN0ci5zbGljZSgxLCAtMSlcbiAgICB9XG59IiwiLy8gc3RyaW5nIC0+IERPTSBjb252ZXJzaW9uXG4vLyB3cmFwcGVycyBvcmlnaW5hbGx5IGZyb20galF1ZXJ5LCBzY29vcGVkIGZyb20gY29tcG9uZW50L2RvbWlmeVxudmFyIG1hcCA9IHtcbiAgICBsZWdlbmQgICA6IFsxLCAnPGZpZWxkc2V0PicsICc8L2ZpZWxkc2V0PiddLFxuICAgIHRyICAgICAgIDogWzIsICc8dGFibGU+PHRib2R5PicsICc8L3Rib2R5PjwvdGFibGU+J10sXG4gICAgY29sICAgICAgOiBbMiwgJzx0YWJsZT48dGJvZHk+PC90Ym9keT48Y29sZ3JvdXA+JywgJzwvY29sZ3JvdXA+PC90YWJsZT4nXSxcbiAgICBfZGVmYXVsdCA6IFswLCAnJywgJyddXG59XG5cbm1hcC50ZCA9XG5tYXAudGggPSBbMywgJzx0YWJsZT48dGJvZHk+PHRyPicsICc8L3RyPjwvdGJvZHk+PC90YWJsZT4nXVxuXG5tYXAub3B0aW9uID1cbm1hcC5vcHRncm91cCA9IFsxLCAnPHNlbGVjdCBtdWx0aXBsZT1cIm11bHRpcGxlXCI+JywgJzwvc2VsZWN0PiddXG5cbm1hcC50aGVhZCA9XG5tYXAudGJvZHkgPVxubWFwLmNvbGdyb3VwID1cbm1hcC5jYXB0aW9uID1cbm1hcC50Zm9vdCA9IFsxLCAnPHRhYmxlPicsICc8L3RhYmxlPiddXG5cbm1hcC50ZXh0ID1cbm1hcC5jaXJjbGUgPVxubWFwLmVsbGlwc2UgPVxubWFwLmxpbmUgPVxubWFwLnBhdGggPVxubWFwLnBvbHlnb24gPVxubWFwLnBvbHlsaW5lID1cbm1hcC5yZWN0ID0gWzEsICc8c3ZnIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiB2ZXJzaW9uPVwiMS4xXCI+JywnPC9zdmc+J11cblxudmFyIFRBR19SRSA9IC88KFtcXHc6XSspL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uICh0ZW1wbGF0ZVN0cmluZykge1xuICAgIHZhciBmcmFnID0gZG9jdW1lbnQuY3JlYXRlRG9jdW1lbnRGcmFnbWVudCgpLFxuICAgICAgICBtID0gVEFHX1JFLmV4ZWModGVtcGxhdGVTdHJpbmcpXG4gICAgLy8gdGV4dCBvbmx5XG4gICAgaWYgKCFtKSB7XG4gICAgICAgIGZyYWcuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodGVtcGxhdGVTdHJpbmcpKVxuICAgICAgICByZXR1cm4gZnJhZ1xuICAgIH1cblxuICAgIHZhciB0YWcgPSBtWzFdLFxuICAgICAgICB3cmFwID0gbWFwW3RhZ10gfHwgbWFwLl9kZWZhdWx0LFxuICAgICAgICBkZXB0aCA9IHdyYXBbMF0sXG4gICAgICAgIHByZWZpeCA9IHdyYXBbMV0sXG4gICAgICAgIHN1ZmZpeCA9IHdyYXBbMl0sXG4gICAgICAgIG5vZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKVxuXG4gICAgbm9kZS5pbm5lckhUTUwgPSBwcmVmaXggKyB0ZW1wbGF0ZVN0cmluZy50cmltKCkgKyBzdWZmaXhcbiAgICB3aGlsZSAoZGVwdGgtLSkgbm9kZSA9IG5vZGUubGFzdENoaWxkXG5cbiAgICAvLyBvbmUgZWxlbWVudFxuICAgIGlmIChub2RlLmZpcnN0Q2hpbGQgPT09IG5vZGUubGFzdENoaWxkKSB7XG4gICAgICAgIGZyYWcuYXBwZW5kQ2hpbGQobm9kZS5maXJzdENoaWxkKVxuICAgICAgICByZXR1cm4gZnJhZ1xuICAgIH1cblxuICAgIC8vIG11bHRpcGxlIG5vZGVzLCByZXR1cm4gYSBmcmFnbWVudFxuICAgIHZhciBjaGlsZFxuICAgIC8qIGpzaGludCBib3NzOiB0cnVlICovXG4gICAgd2hpbGUgKGNoaWxkID0gbm9kZS5maXJzdENoaWxkKSB7XG4gICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxKSB7XG4gICAgICAgICAgICBmcmFnLmFwcGVuZENoaWxkKGNoaWxkKVxuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmcmFnXG59IiwidmFyIEV2ZW50VGFyZ2V0ID0gcmVxdWlyZSgnLi9ldmVudFRhcmdldCcpLFxuICAgIHV0aWxzICAgICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuICAgIGNvbmZpZyAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICBkZWYgICAgICAgICA9IE9iamVjdC5kZWZpbmVQcm9wZXJ0eSxcbiAgICBoYXNQcm90byAgICA9ICh7fSkuX19wcm90b19fO1xudmFyIEFycmF5UHJveHkgID0gT2JqZWN0LmNyZWF0ZShBcnJheS5wcm90b3R5cGUpO1xudmFyIE9ialByb3h5ICAgID0gT2JqZWN0LmNyZWF0ZShPYmplY3QucHJvdG90eXBlKTtcbnV0aWxzLm1peChBcnJheVByb3h5LCB7XG4gICAgJyRzZXQnOiBmdW5jdGlvbiBzZXQoaW5kZXgsIGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuc3BsaWNlKGluZGV4LCAxLCBkYXRhKVswXVxuICAgIH0sXG4gICAgJyRyZW1vdmUnOiBmdW5jdGlvbiByZW1vdmUoaW5kZXgpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBpbmRleCAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIGluZGV4ID0gdGhpcy5pbmRleE9mKGluZGV4KVxuICAgICAgICB9XG4gICAgICAgIGlmIChpbmRleCA+IC0xKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5zcGxpY2UoaW5kZXgsIDEpWzBdXG4gICAgICAgIH1cbiAgICB9XG59KTtcbnV0aWxzLm1peChPYmpQcm94eSwge1xuICAgICckYWRkJzogZnVuY3Rpb24gYWRkKGtleSwgdmFsKSB7XG4gICAgICAgIGlmICh1dGlscy5vYmplY3QuaGFzKHRoaXMsIGtleSkpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzW2tleV0gPSB2YWw7XG4gICAgICAgIGNvbnZlcnRLZXkodGhpcywga2V5LCB0cnVlKTtcbiAgICB9LFxuICAgICckZGVsZXRlJzogZnVuY3Rpb24gKGtleSkge1xuICAgIFx0aWYgKCF1dGlscy5vYmplY3QuaGFzKHRoaXMsIGtleSkpe1xuICAgIFx0XHRyZXR1cm47XG4gICAgXHR9XG4gICAgXHRkZWxldGUgdGhpc1trZXldO1xuICAgIFx0dGhpcy5fX2VtaXR0ZXJfXy5lbWl0KCdkZWxldGUnLCBrZXkpO1xuICAgIH1cbn0pO1xuLyoqXG4gKiAgSU5URVJDRVAgQSBNVVRBVElPTiBFVkVOVCBTTyBXRSBDQU4gRU1JVCBUSEUgTVVUQVRJT04gSU5GTy5cbiAqICBXRSBBTFNPIEFOQUxZWkUgV0hBVCBFTEVNRU5UUyBBUkUgQURERUQvUkVNT1ZFRCBBTkQgTElOSy9VTkxJTktcbiAqICBUSEVNIFdJVEggVEhFIFBBUkVOVCBBUlJBWS5cbiAqL1xudXRpbHMuZWFjaChbJ3B1c2gnLCAncG9wJywgJ3NoaWZ0JywgJ3Vuc2hpZnQnLCAnc3BsaWNlJywgJ3NvcnQnLCAncmV2ZXJzZSddLCBmdW5jdGlvbih0eXBlKSB7XG4gICAgQXJyYXlQcm94eVt0eXBlXSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSxcbiAgICAgICAgICAgIHJlc3VsdCA9IEFycmF5LnByb3RvdHlwZVttZXRob2RdLmFwcGx5KHRoaXMsIGFyZ3MpLFxuICAgICAgICAgICAgaW5zZXJ0ZWQsIHJlbW92ZWQ7XG4gICAgICAgIC8vIGRldGVybWluZSBuZXcgLyByZW1vdmVkIGVsZW1lbnRzXG4gICAgICAgIGlmIChtZXRob2QgPT09ICdwdXNoJyB8fCBtZXRob2QgPT09ICd1bnNoaWZ0Jykge1xuICAgICAgICAgICAgaW5zZXJ0ZWQgPSBhcmdzO1xuICAgICAgICB9IGVsc2UgaWYgKG1ldGhvZCA9PT0gJ3BvcCcgfHwgbWV0aG9kID09PSAnc2hpZnQnKSB7XG4gICAgICAgICAgICByZW1vdmVkID0gW3Jlc3VsdF07XG4gICAgICAgIH0gZWxzZSBpZiAobWV0aG9kID09PSAnc3BsaWNlJykge1xuICAgICAgICAgICAgaW5zZXJ0ZWQgPSBhcmdzLnNsaWNlKDIpXG4gICAgICAgICAgICByZW1vdmVkID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIC8vIGxpbmsgJiB1bmxpbmtcbiAgICAgICAgbGlua0FycmF5RWxlbWVudHModGhpcywgaW5zZXJ0ZWQpXG4gICAgICAgIHVubGlua0FycmF5RWxlbWVudHModGhpcywgcmVtb3ZlZClcbiAgICAgICAgLy8gZW1pdCB0aGUgbXV0YXRpb24gZXZlbnRcbiAgICAgICAgdGhpcy5fX2VtaXR0ZXJfXy5lbWl0KCdtdXRhdGUnLCAnJywgdGhpcywge1xuICAgICAgICAgICAgbWV0aG9kOiBtZXRob2QsXG4gICAgICAgICAgICBhcmdzOiBhcmdzLFxuICAgICAgICAgICAgcmVzdWx0OiByZXN1bHQsXG4gICAgICAgICAgICBpbnNlcnRlZDogaW5zZXJ0ZWQsXG4gICAgICAgICAgICByZW1vdmVkOiByZW1vdmVkXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cbn0pO1xuLyoqXG4gKiAgTGluayBuZXcgZWxlbWVudHMgdG8gYW4gQXJyYXksIHNvIHdoZW4gdGhleSBjaGFuZ2VcbiAqICBhbmQgZW1pdCBldmVudHMsIHRoZSBvd25lciBBcnJheSBjYW4gYmUgbm90aWZpZWQuXG4gKi9cbmZ1bmN0aW9uIGxpbmtBcnJheUVsZW1lbnRzKGFyciwgaXRlbXMpIHtcbiAgICBpZiAoaXRlbXMpIHtcbiAgICAgICAgdmFyIGkgPSBpdGVtcy5sZW5ndGgsXG4gICAgICAgICAgICBpdGVtLCBvd25lcnNcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgaXRlbSA9IGl0ZW1zW2ldXG4gICAgICAgICAgICBpZiAoaXNXYXRjaGFibGUoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICAvLyBpZiBvYmplY3QgaXMgbm90IGNvbnZlcnRlZCBmb3Igb2JzZXJ2aW5nXG4gICAgICAgICAgICAgICAgLy8gY29udmVydCBpdC4uLlxuICAgICAgICAgICAgICAgIGlmICghaXRlbS5fX2VtaXR0ZXJfXykge1xuICAgICAgICAgICAgICAgICAgICBjb252ZXJ0KGl0ZW0pXG4gICAgICAgICAgICAgICAgICAgIHdhdGNoKGl0ZW0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG93bmVycyA9IGl0ZW0uX19lbWl0dGVyX18ub3duZXJzXG4gICAgICAgICAgICAgICAgaWYgKG93bmVycy5pbmRleE9mKGFycikgPCAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG93bmVycy5wdXNoKGFycilcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG4vKipcbiAqICBVbmxpbmsgcmVtb3ZlZCBlbGVtZW50cyBmcm9tIHRoZSBleC1vd25lciBBcnJheS5cbiAqL1xuZnVuY3Rpb24gdW5saW5rQXJyYXlFbGVtZW50cyhhcnIsIGl0ZW1zKSB7XG4gICAgaWYgKGl0ZW1zKSB7XG4gICAgICAgIHZhciBpID0gaXRlbXMubGVuZ3RoLFxuICAgICAgICAgICAgaXRlbVxuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBpdGVtID0gaXRlbXNbaV1cbiAgICAgICAgICAgIGlmIChpdGVtICYmIGl0ZW0uX19lbWl0dGVyX18pIHtcbiAgICAgICAgICAgICAgICB2YXIgb3duZXJzID0gaXRlbS5fX2VtaXR0ZXJfXy5vd25lcnNcbiAgICAgICAgICAgICAgICBpZiAob3duZXJzKSBvd25lcnMuc3BsaWNlKG93bmVycy5pbmRleE9mKGFycikpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG4vKipcbiAqICBDSEVDSyBJRiBBIFZBTFVFIElTIFdBVENIQUJMRVxuICovXG5mdW5jdGlvbiBpc1dhdGNoYWJsZShvYmopIHtcbiAgICByZXR1cm4gdHlwZW9mIG9iaiA9PT0gJ29iamVjdCcgJiYgb2JqICYmICFvYmouJGNvbXBpbGVyXG59XG4vKipcbiAqICBDT05WRVJUIEFOIE9CSkVDVC9BUlJBWSBUTyBHSVZFIElUIEEgQ0hBTkdFIEVNSVRURVIuXG4gKi9cbmZ1bmN0aW9uIGNvbnZlcnQob2JqKSB7XG4gICAgaWYgKG9iai5fX2VtaXR0ZXJfXykgcmV0dXJuIHRydWVcbiAgICB2YXIgZW1pdHRlciA9IG5ldyBFdmVudFRhcmdldCgpO1xuICAgIG9ialsnX19lbWl0dGVyX18nXSA9IGVtaXR0ZXI7XG4gICAgZW1pdHRlci5vbignc2V0JywgZnVuY3Rpb24oa2V5LCB2YWwsIHByb3BhZ2F0ZSkge1xuICAgICAgICBpZiAocHJvcGFnYXRlKSBwcm9wYWdhdGVDaGFuZ2Uob2JqKVxuICAgIH0pO1xuICAgIGVtaXR0ZXIub24oJ211dGF0ZScsIGZ1bmN0aW9uKCkge1xuICAgICAgICBwcm9wYWdhdGVDaGFuZ2Uob2JqKVxuICAgIH0pO1xuICAgIGVtaXR0ZXIudmFsdWVzID0gdXRpbHMuaGFzaCgpO1xuICAgIGVtaXR0ZXIub3duZXJzID0gW107XG4gICAgcmV0dXJuIGZhbHNlO1xufVxuLyoqXG4gKiAgUFJPUEFHQVRFIEFOIEFSUkFZIEVMRU1FTlQnUyBDSEFOR0UgVE8gSVRTIE9XTkVSIEFSUkFZU1xuICovXG5mdW5jdGlvbiBwcm9wYWdhdGVDaGFuZ2Uob2JqKSB7XG4gICAgdmFyIG93bmVycyA9IG9iai5fX2VtaXR0ZXJfXy5vd25lcnMsXG4gICAgICAgIGkgPSBvd25lcnMubGVuZ3RoXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICBvd25lcnNbaV0uX19lbWl0dGVyX18uZW1pdCgnc2V0JywgJycsICcnLCB0cnVlKVxuICAgIH1cbn1cbi8qKlxuICogIFdBVENIIFRBUkdFVCBCQVNFRCBPTiBJVFMgVFlQRVxuICovXG5mdW5jdGlvbiB3YXRjaChvYmopIHtcbiAgICBpZiAodXRpbHMuaXNBcnJheShvYmopKSB7XG4gICAgICAgIHdhdGNoQXJyYXkob2JqKVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHdhdGNoT2JqZWN0KG9iailcbiAgICB9XG59XG4vKipcbiAqICBXYXRjaCBhbiBPYmplY3QsIHJlY3Vyc2l2ZS5cbiAqL1xuZnVuY3Rpb24gd2F0Y2hPYmplY3Qob2JqKSB7XG4gICAgYXVnbWVudChvYmosIE9ialByb3h5KVxuICAgIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICAgICAgY29udmVydEtleShvYmosIGtleSlcbiAgICB9XG59XG4vKipcbiAqICBXQVRDSCBBTiBBUlJBWSwgT1ZFUkxPQUQgTVVUQVRJT04gTUVUSE9EU1xuICogIEFORCBBREQgQVVHTUVOVEFUSU9OUyBCWSBJTlRFUkNFUFRJTkcgVEhFIFBST1RPVFlQRSBDSEFJTlxuICovXG5mdW5jdGlvbiB3YXRjaEFycmF5KGFycikge1xuICAgIGF1Z21lbnQoYXJyLCBBcnJheVByb3h5KTtcbiAgICBsaW5rQXJyYXlFbGVtZW50cyhhcnIsIGFycik7XG59XG4vKipcbiAqICBBVUdNRU5UIFRBUkdFVCBPQkpFQ1RTIFdJVEggTU9ESUZJRURcbiAqICBNRVRIT0RTXG4gKi9cbmZ1bmN0aW9uIGF1Z21lbnQodGFyZ2V0LCBzcmMpIHtcbiAgICBpZiAoaGFzUHJvdG8pIHtcbiAgICAgICAgdGFyZ2V0Ll9fcHJvdG9fXyA9IHNyY1xuICAgIH0gZWxzZSB7XG4gICAgXHR1dGlscy5taXgodGFyZ2V0LCBzcmMpO1xuICAgIH1cbn1cblxuXG4vKipcbiAqICBERUZJTkUgQUNDRVNTT1JTIEZPUiBBIFBST1BFUlRZIE9OIEFOIE9CSkVDVFxuICogIFNPIElUIEVNSVRTIEdFVC9TRVQgRVZFTlRTLlxuICogIFRIRU4gV0FUQ0ggVEhFIFZBTFVFIElUU0VMRi5cbiAqL1xuZnVuY3Rpb24gY29udmVydEtleSAob2JqLCBrZXksIHByb3BhZ2F0ZSl7XG5cdHZhciBrZXlQcmVmaXggPSBrZXkuY2hhckF0KDApO1xuXHRpZiAoa2V5UHJlZml4ID09PSAnJCcgfHwga2V5UHJlZml4ID09PSAnXycpe1xuXHRcdHJldHVybjtcblx0fVxuXHR2YXIgZW1pdHRlciA9IG9iai5fX2VtaXR0ZXJfXyxcblx0XHR2YWx1ZXMgID0gZW1pdHRlci52YWx1ZXM7XG5cblx0aW5pdChvYmpba2V5XSwgcHJvcGFnYXRlKTtcblx0T2JqZWN0LmRlZmluZVByb3BlcnR5KG9iaiwga2V5LCB7XG5cdFx0ZW51bWVyYWJsZTogdHJ1ZSxcblx0XHRjb25maWd1cmFibGU6IHRydWUsXG5cdFx0Z2V0OiBmdW5jdGlvbiAoKSB7XG5cdFx0XHR2YXIgdmFsdWUgPSB2YWx1ZXNba2V5XTtcblx0XHRcdGlmIChjb25maWcuZW1taXRHZXQpIHtcblx0XHRcdFx0ZW1pdHRlci5lbWl0KCdnZXQnLCBrZXkpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH0sXG5cdFx0c2V0OiBmdW5jdGlvbiAobmV3VmFsdWUpe1xuXHRcdFx0dmFyIG9sZFZhbHVlID0gdmFsdWVzW2tleV07XG5cdFx0XHR1bm9ic2VydmUob2xkVmFsdWUsIGtleSwgZW1pdHRlcik7XG5cdFx0XHRjb3B5UGF0aHMobmV3VmFsdWUsIG9sZFZhbHVlKTtcblx0XHRcdGluaXQobmV3VmFsdWUsIHRydWUpO1xuXHRcdH1cblx0fSk7XG5cdGZ1bmN0aW9uIGluaXQgKHZhbCwgcHJvcGFnYXRlKXtcblx0XHR2YWx1ZXNba2V5XSA9IHZhbDtcblx0XHRlbWl0dGVyLmVtaXQoJ3NldCcsIGtleSwgdmFsLCBwcm9wYWdhdGUpO1xuXHRcdGlmICh1dGlscy5pc0FycmF5KHZhbCkpIHtcblx0XHRcdGVtaXR0ZXIuZW1pdCgnc2V0Jywga2V5ICsgJy5sZW5ndGgnLCB2YWwubGVuZ3RoLCBwcm9wYWdhdGUpO1xuXHRcdH1cblx0XHRvYnNlcnZlKHZhbCwga2V5LCBlbWl0dGVyKTtcblx0fVxufVxuXG4vKipcbiAqICBXaGVuIGEgdmFsdWUgdGhhdCBpcyBhbHJlYWR5IGNvbnZlcnRlZCBpc1xuICogIG9ic2VydmVkIGFnYWluIGJ5IGFub3RoZXIgb2JzZXJ2ZXIsIHdlIGNhbiBza2lwXG4gKiAgdGhlIHdhdGNoIGNvbnZlcnNpb24gYW5kIHNpbXBseSBlbWl0IHNldCBldmVudCBmb3JcbiAqICBhbGwgb2YgaXRzIHByb3BlcnRpZXMuXG4gKi9cbmZ1bmN0aW9uIGVtaXRTZXQgKG9iaikge1xuICAgIHZhciBlbWl0dGVyID0gb2JqICYmIG9iai5fX2VtaXR0ZXJfXztcbiAgICBpZiAoIWVtaXR0ZXIpIHJldHVybjtcbiAgICBpZiAodXRpbHMuaXNBcnJheShvYmopKSB7XG4gICAgICAgIGVtaXR0ZXIuZW1pdCgnc2V0JywgJ2xlbmd0aCcsIG9iai5sZW5ndGgpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBrZXksIHZhbFxuICAgICAgICBmb3IgKGtleSBpbiBvYmopIHtcbiAgICAgICAgICAgIHZhbCA9IG9ialtrZXldXG4gICAgICAgICAgICBlbWl0dGVyLmVtaXQoJ3NldCcsIGtleSwgdmFsKTtcbiAgICAgICAgICAgIGVtaXRTZXQodmFsKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgTWFrZSBzdXJlIGFsbCB0aGUgcGF0aHMgaW4gYW4gb2xkIG9iamVjdCBleGlzdHNcbiAqICBpbiBhIG5ldyBvYmplY3QuXG4gKiAgU28gd2hlbiBhbiBvYmplY3QgY2hhbmdlcywgYWxsIG1pc3Npbmcga2V5cyB3aWxsXG4gKiAgZW1pdCBhIHNldCBldmVudCB3aXRoIHVuZGVmaW5lZCB2YWx1ZS5cbiAqL1xuZnVuY3Rpb24gY29weVBhdGhzIChuZXdPYmosIG9sZE9iaikge1xuICAgIGlmICghaXNPYmplY3QobmV3T2JqKSB8fCAhaXNPYmplY3Qob2xkT2JqKSkge1xuICAgICAgICByZXR1cm5cbiAgICB9XG4gICAgdmFyIHBhdGgsIG9sZFZhbCwgbmV3VmFsO1xuICAgIGZvciAocGF0aCBpbiBvbGRPYmopIHtcbiAgICAgICAgaWYgKCEodXRpbHMub2JqZWN0LmhhcyhuZXdPYmosIHBhdGgpKSkge1xuICAgICAgICAgICAgb2xkVmFsID0gb2xkT2JqW3BhdGhdXG4gICAgICAgICAgICBpZiAodXRpbHMuaXNBcnJheShvbGRWYWwpKSB7XG4gICAgICAgICAgICAgICAgbmV3T2JqW3BhdGhdID0gW11cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaXNPYmplY3Qob2xkVmFsKSkge1xuICAgICAgICAgICAgICAgIG5ld1ZhbCA9IG5ld09ialtwYXRoXSA9IHt9XG4gICAgICAgICAgICAgICAgY29weVBhdGhzKG5ld1ZhbCwgb2xkVmFsKVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBuZXdPYmpbcGF0aF0gPSB1bmRlZmluZWRcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgd2FsayBhbG9uZyBhIHBhdGggYW5kIG1ha2Ugc3VyZSBpdCBjYW4gYmUgYWNjZXNzZWRcbiAqICBhbmQgZW51bWVyYXRlZCBpbiB0aGF0IG9iamVjdFxuICovXG5mdW5jdGlvbiBlbnN1cmVQYXRoIChvYmosIGtleSkge1xuICAgIHZhciBwYXRoID0ga2V5LnNwbGl0KCcuJyksIHNlY1xuICAgIGZvciAodmFyIGkgPSAwLCBkID0gcGF0aC5sZW5ndGggLSAxOyBpIDwgZDsgaSsrKSB7XG4gICAgICAgIHNlYyA9IHBhdGhbaV1cbiAgICAgICAgaWYgKCFvYmpbc2VjXSkge1xuICAgICAgICAgICAgb2JqW3NlY10gPSB7fVxuICAgICAgICAgICAgaWYgKG9iai5fX2VtaXR0ZXJfXykgY29udmVydEtleShvYmosIHNlYylcbiAgICAgICAgfVxuICAgICAgICBvYmogPSBvYmpbc2VjXVxuICAgIH1cbiAgICBpZiAodXRpbHMuaXNPYmplY3Qob2JqKSkge1xuICAgICAgICBzZWMgPSBwYXRoW2ldXG4gICAgICAgIGlmICghKGhhc093bi5jYWxsKG9iaiwgc2VjKSkpIHtcbiAgICAgICAgICAgIG9ialtzZWNdID0gdW5kZWZpbmVkXG4gICAgICAgICAgICBpZiAob2JqLl9fZW1pdHRlcl9fKSBjb252ZXJ0S2V5KG9iaiwgc2VjKVxuICAgICAgICB9XG4gICAgfVxufVxuXG5mdW5jdGlvbiBvYnNlcnZlIChvYmosIHJhd1BhdGgsIG9ic2VydmVyKSB7XG5cdGlmICghaXNXYXRjaGFibGUob2JqKSkgcmV0dXJuO1xuXG5cdHZhciBwYXRoID0gcmF3UGF0aCA/IHJhd1BhdGggKyAnLicgOiAnJyxcblx0XHRhbHJlYWR5Q29udmVydGVkID0gY29udmVydChvYmopLFxuXHRcdGVtaXR0ZXIgPSBvYmouX19lbWl0dGVyX187XG5cblx0Ly8gc2V0dXAgcHJveHkgbGlzdGVuZXJzIG9uIHRoZSBwYXJlbnQgb2JzZXJ2ZXIuXG4gICAgLy8gd2UgbmVlZCB0byBrZWVwIHJlZmVyZW5jZSB0byB0aGVtIHNvIHRoYXQgdGhleVxuICAgIC8vIGNhbiBiZSByZW1vdmVkIHdoZW4gdGhlIG9iamVjdCBpcyB1bi1vYnNlcnZlZC5cblx0b2JzZXJ2ZXIucHJveGllcyA9IG9ic2VydmVyLnByb3hpZXMgfHwge307XG5cdHZhciBwcm94aWVzID0gb2JzZXJ2ZXIucHJveGllc1twYXRoXSA9IHtcblx0XHRnZXQ6IGZ1bmN0aW9uKGtleSl7XG5cdFx0XHRvYnNlcnZlci5lbWl0KCdnZXQnLCBwYXRoICsga2V5KTtcblx0XHR9LFxuXHRcdHNldDogZnVuY3Rpb24oa2V5LCB2YWwsIHByb3BhZ2F0ZSl7XG5cdFx0XHRpZiAoa2V5KSBvYnNlcnZlci5lbWl0KCdzZXQnLCBwYXRoICsga2V5LCB2YWwpO1xuXHRcdFx0Ly8gYWxzbyBub3RpZnkgb2JzZXJ2ZXIgdGhhdCB0aGUgb2JqZWN0IGl0c2VsZiBjaGFuZ2VkXG4gICAgICAgICAgICAvLyBidXQgb25seSBkbyBzbyB3aGVuIGl0J3MgYSBpbW1lZGlhdGUgcHJvcGVydHkuIHRoaXNcbiAgICAgICAgICAgIC8vIGF2b2lkcyBkdXBsaWNhdGUgZXZlbnQgZmlyaW5nLlxuXHRcdFx0aWYgKHJhd1BhdGggJiYgcHJvcGFnYXRlKSB7XG5cdFx0XHRcdG9ic2VydmVyLmVtaXQoJ3NldCcsIHJhd1BhdGgsIG9iaiwgdHJ1ZSk7XG5cdFx0XHR9XG5cdFx0fSxcblx0XHRtdXRhdGU6IGZ1bmN0aW9uIChrZXksIHZhbCwgbXV0YXRpb24pIHtcblx0XHRcdC8vIGlmIHRoZSBBcnJheSBpcyBhIHJvb3QgdmFsdWVcbiAgICAgICAgICAgIC8vIHRoZSBrZXkgd2lsbCBiZSBudWxsXG5cdFx0XHR2YXIgZml4ZWRQYXRoID0ga2V5ID8gcGF0aCArIGtleSA6IHJhd1BhdGg7XG5cdFx0XHRvYnNlcnZlci5lbWl0KCdtdXRhdGUnLCBmaXhlZFBhdGgsIHZhbCwgbXV0YXRpb24pO1xuXHRcdFx0dmFyIG0gPSBtdXRhaW9uLm1ldGhvZDtcblx0XHRcdGlmIChtICE9PSAnc29ydCcgJiYgbSAhPT0gJ3JldmVyc2UnKSB7XG5cdFx0XHRcdG9ic2VydmVyLmVtaXQoJ3NldCcsIGZpeGVkUGF0aCArICcubGVuZ3RoJywgdmFsLmxlbmd0aCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9O1xuXG5cdC8vIGF0dGFjaCB0aGUgbGlzdGVuZXJzIHRvIHRoZSBjaGlsZCBvYnNlcnZlci5cbiAgICAvLyBub3cgYWxsIHRoZSBldmVudHMgd2lsbCBwcm9wYWdhdGUgdXB3YXJkcy5cbiAgICBlbWl0dGVyXG4gICAgICAgIC5vbignZ2V0JywgcHJveGllcy5nZXQpXG4gICAgICAgIC5vbignc2V0JywgcHJveGllcy5zZXQpXG4gICAgICAgIC5vbignbXV0YXRlJywgcHJveGllcy5tdXRhdGUpO1xuXG5cbiAgICBpZiAoYWxyZWFkeUNvbnZlcnRlZCkge1xuICAgICAgICAvLyBmb3Igb2JqZWN0cyB0aGF0IGhhdmUgYWxyZWFkeSBiZWVuIGNvbnZlcnRlZCxcbiAgICAgICAgLy8gZW1pdCBzZXQgZXZlbnRzIGZvciBldmVyeXRoaW5nIGluc2lkZVxuICAgICAgICBlbWl0U2V0KG9iailcbiAgICB9IGVsc2Uge1xuICAgICAgICB3YXRjaChvYmopXG4gICAgfVxufVxuXG4vKipcbiAqICBDYW5jZWwgb2JzZXJ2YXRpb24sIHR1cm4gb2ZmIHRoZSBsaXN0ZW5lcnMuXG4gKi9cbmZ1bmN0aW9uIHVub2JzZXJ2ZSAob2JqLCBwYXRoLCBvYnNlcnZlcikge1xuXG4gICAgaWYgKCFvYmogfHwgIW9iai5fX2VtaXR0ZXJfXykgcmV0dXJuXG5cbiAgICBwYXRoID0gcGF0aCA/IHBhdGggKyAnLicgOiAnJ1xuICAgIHZhciBwcm94aWVzID0gb2JzZXJ2ZXIucHJveGllc1twYXRoXVxuICAgIGlmICghcHJveGllcykgcmV0dXJuXG5cbiAgICAvLyB0dXJuIG9mZiBsaXN0ZW5lcnNcbiAgICBvYmouX19lbWl0dGVyX19cbiAgICAgICAgLm9mZignZ2V0JywgcHJveGllcy5nZXQpXG4gICAgICAgIC5vZmYoJ3NldCcsIHByb3hpZXMuc2V0KVxuICAgICAgICAub2ZmKCdtdXRhdGUnLCBwcm94aWVzLm11dGF0ZSlcblxuICAgIC8vIHJlbW92ZSByZWZlcmVuY2VcbiAgICBvYnNlcnZlci5wcm94aWVzW3BhdGhdID0gbnVsbFxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBvYnNlcnZlICAgICA6IG9ic2VydmUsXG4gICAgdW5vYnNlcnZlICAgOiB1bm9ic2VydmUsXG4gICAgZW5zdXJlUGF0aCAgOiBlbnN1cmVQYXRoLFxuICAgIGNvcHlQYXRocyAgIDogY29weVBhdGhzLFxuICAgIHdhdGNoICAgICAgIDogd2F0Y2gsXG4gICAgY29udmVydCAgICAgOiBjb252ZXJ0LFxuICAgIGNvbnZlcnRLZXkgIDogY29udmVydEtleVxufSIsInZhciB0b0ZyYWdtZW50ID0gcmVxdWlyZSgnLi9mcmFnbWVudCcpXG4gICAgVGV4dFBhcnNlciA9IHJlcXVpcmUoJy4vdGV4dFBhcnNlcicpLFxuICAgIEV4cFBhcnNlciAgPSByZXF1aXJlKCcuL0V4cFBhcnNlcicpLFxuICAgIERlcHNQYXJzZXIgPSByZXF1aXJlKCcuL0RlcHNQYXJzZXInKTtcblxuLyoqXG4gKiBQYXJzZXMgYSB0ZW1wbGF0ZSBzdHJpbmcgb3Igbm9kZSBhbmQgbm9ybWFsaXplcyBpdCBpbnRvIGFcbiAqIGEgbm9kZSB0aGF0IGNhbiBiZSB1c2VkIGFzIGEgcGFydGlhbCBvZiBhIHRlbXBsYXRlIG9wdGlvblxuICpcbiAqIFBvc3NpYmxlIHZhbHVlcyBpbmNsdWRlXG4gKiBpZCBzZWxlY3RvcjogJyNzb21lLXRlbXBsYXRlLWlkJ1xuICogdGVtcGxhdGUgc3RyaW5nOiAnPGRpdj48c3Bhbj5teSB0ZW1wbGF0ZTwvc3Bhbj48L2Rpdj4nXG4gKiBEb2N1bWVudEZyYWdtZW50IG9iamVjdFxuICogTm9kZSBvYmplY3Qgb2YgdHlwZSBUZW1wbGF0ZVxuICovXG5mdW5jdGlvbiBwYXJzZVRlbXBsYXRlKHRlbXBsYXRlKSB7XG4gICAgdmFyIHRlbXBsYXRlTm9kZTtcblxuICAgIGlmICh0ZW1wbGF0ZSBpbnN0YW5jZW9mIHdpbmRvdy5Eb2N1bWVudEZyYWdtZW50KSB7XG4gICAgICAgIC8vIGlmIHRoZSB0ZW1wbGF0ZSBpcyBhbHJlYWR5IGEgZG9jdW1lbnQgZnJhZ21lbnQgLS0gZG8gbm90aGluZ1xuICAgICAgICByZXR1cm4gdGVtcGxhdGVcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHRlbXBsYXRlID09PSAnc3RyaW5nJykge1xuICAgICAgICAvLyB0ZW1wbGF0ZSBieSBJRFxuICAgICAgICBpZiAodGVtcGxhdGUuY2hhckF0KDApID09PSAnIycpIHtcbiAgICAgICAgICAgIHRlbXBsYXRlTm9kZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKHRlbXBsYXRlLnNsaWNlKDEpKVxuICAgICAgICAgICAgaWYgKCF0ZW1wbGF0ZU5vZGUpIHJldHVyblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIHRvRnJhZ21lbnQodGVtcGxhdGUpXG4gICAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHRlbXBsYXRlLm5vZGVUeXBlKSB7XG4gICAgICAgIHRlbXBsYXRlTm9kZSA9IHRlbXBsYXRlXG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gaWYgaXRzIGEgdGVtcGxhdGUgdGFnIGFuZCB0aGUgYnJvd3NlciBzdXBwb3J0cyBpdCxcbiAgICAvLyBpdHMgY29udGVudCBpcyBhbHJlYWR5IGEgZG9jdW1lbnQgZnJhZ21lbnQhXG4gICAgaWYgKHRlbXBsYXRlTm9kZS50YWdOYW1lID09PSAnVEVNUExBVEUnICYmIHRlbXBsYXRlTm9kZS5jb250ZW50KSB7XG4gICAgICAgIHJldHVybiB0ZW1wbGF0ZU5vZGUuY29udGVudFxuICAgIH1cblxuICAgIGlmICh0ZW1wbGF0ZU5vZGUudGFnTmFtZSA9PT0gJ1NDUklQVCcpIHtcbiAgICAgICAgcmV0dXJuIHRvRnJhZ21lbnQodGVtcGxhdGVOb2RlLmlubmVySFRNTClcbiAgICB9XG5cbiAgICByZXR1cm4gdG9GcmFnbWVudCh0ZW1wbGF0ZU5vZGUub3V0ZXJIVE1MKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgcGFyc2VUZW1wbGF0ZTogcGFyc2VUZW1wbGF0ZSxcbiAgICBUZXh0UGFyc2VyOiBUZXh0UGFyc2VyLFxuICAgIEV4cFBhcnNlcjogRXhwUGFyc2VyLFxuICAgIERlcHNQYXJzZXI6IERlcHNQYXJzZXJcbn07IiwidmFyIG9wZW5DaGFyICAgICAgICA9ICd7JyxcbiAgICBlbmRDaGFyICAgICAgICAgPSAnfScsXG4gICAgRVNDQVBFX1JFICAgICAgID0gL1stLiorP14ke30oKXxbXFxdXFwvXFxcXF0vZyxcbiAgICAvLyBsYXp5IHJlcXVpcmVcbiAgICBEaXJlY3RpdmVcblxuZXhwb3J0cy5SZWdleCA9IGJ1aWxkSW50ZXJwb2xhdGlvblJlZ2V4KClcblxuZnVuY3Rpb24gYnVpbGRJbnRlcnBvbGF0aW9uUmVnZXggKCkge1xuICAgIHZhciBvcGVuID0gZXNjYXBlUmVnZXgob3BlbkNoYXIpLFxuICAgICAgICBlbmQgID0gZXNjYXBlUmVnZXgoZW5kQ2hhcilcbiAgICByZXR1cm4gbmV3IFJlZ0V4cChvcGVuICsgb3BlbiArIG9wZW4gKyAnPyguKz8pJyArIGVuZCArICc/JyArIGVuZCArIGVuZClcbn1cblxuZnVuY3Rpb24gZXNjYXBlUmVnZXggKHN0cikge1xuICAgIHJldHVybiBzdHIucmVwbGFjZShFU0NBUEVfUkUsICdcXFxcJCYnKVxufVxuXG5mdW5jdGlvbiBzZXREZWxpbWl0ZXJzIChkZWxpbWl0ZXJzKSB7XG4gICAgb3BlbkNoYXIgPSBkZWxpbWl0ZXJzWzBdXG4gICAgZW5kQ2hhciA9IGRlbGltaXRlcnNbMV1cbiAgICBleHBvcnRzLmRlbGltaXRlcnMgPSBkZWxpbWl0ZXJzXG4gICAgZXhwb3J0cy5SZWdleCA9IGJ1aWxkSW50ZXJwb2xhdGlvblJlZ2V4KClcbn1cblxuLyoqIFxuICogIFBhcnNlIGEgcGllY2Ugb2YgdGV4dCwgcmV0dXJuIGFuIGFycmF5IG9mIHRva2Vuc1xuICogIHRva2VuIHR5cGVzOlxuICogIDEuIHBsYWluIHN0cmluZ1xuICogIDIuIG9iamVjdCB3aXRoIGtleSA9IGJpbmRpbmcga2V5XG4gKiAgMy4gb2JqZWN0IHdpdGgga2V5ICYgaHRtbCA9IHRydWVcbiAqL1xuZnVuY3Rpb24gcGFyc2UgKHRleHQpIHtcbiAgICBpZiAoIWV4cG9ydHMuUmVnZXgudGVzdCh0ZXh0KSkgcmV0dXJuIG51bGxcbiAgICB2YXIgbSwgaSwgdG9rZW4sIG1hdGNoLCB0b2tlbnMgPSBbXVxuICAgIC8qIGpzaGludCBib3NzOiB0cnVlICovXG4gICAgd2hpbGUgKG0gPSB0ZXh0Lm1hdGNoKGV4cG9ydHMuUmVnZXgpKSB7XG4gICAgICAgIGkgPSBtLmluZGV4XG4gICAgICAgIGlmIChpID4gMCkgdG9rZW5zLnB1c2godGV4dC5zbGljZSgwLCBpKSlcbiAgICAgICAgdG9rZW4gPSB7IGtleTogbVsxXS50cmltKCkgfVxuICAgICAgICBtYXRjaCA9IG1bMF1cbiAgICAgICAgdG9rZW4uaHRtbCA9XG4gICAgICAgICAgICBtYXRjaC5jaGFyQXQoMikgPT09IG9wZW5DaGFyICYmXG4gICAgICAgICAgICBtYXRjaC5jaGFyQXQobWF0Y2gubGVuZ3RoIC0gMykgPT09IGVuZENoYXJcbiAgICAgICAgdG9rZW5zLnB1c2godG9rZW4pXG4gICAgICAgIHRleHQgPSB0ZXh0LnNsaWNlKGkgKyBtWzBdLmxlbmd0aClcbiAgICB9XG4gICAgaWYgKHRleHQubGVuZ3RoKSB0b2tlbnMucHVzaCh0ZXh0KVxuICAgIHJldHVybiB0b2tlbnNcbn1cblxuLyoqXG4gKiAgUGFyc2UgYW4gYXR0cmlidXRlIHZhbHVlIHdpdGggcG9zc2libGUgaW50ZXJwb2xhdGlvbiB0YWdzXG4gKiAgcmV0dXJuIGEgRGlyZWN0aXZlLWZyaWVuZGx5IGV4cHJlc3Npb25cbiAqXG4gKiAgZS5nLiAgYSB7e2J9fSBjICA9PiAgXCJhIFwiICsgYiArIFwiIGNcIlxuICovXG5mdW5jdGlvbiBwYXJzZUF0dHIgKGF0dHIpIHtcbiAgICBEaXJlY3RpdmUgPSBEaXJlY3RpdmUgfHwgcmVxdWlyZSgnLi9kaXJlY3RpdmUnKVxuICAgIHZhciB0b2tlbnMgPSBwYXJzZShhdHRyKVxuICAgIGlmICghdG9rZW5zKSByZXR1cm4gbnVsbFxuICAgIGlmICh0b2tlbnMubGVuZ3RoID09PSAxKSByZXR1cm4gdG9rZW5zWzBdLmtleVxuICAgIHZhciByZXMgPSBbXSwgdG9rZW5cbiAgICBmb3IgKHZhciBpID0gMCwgbCA9IHRva2Vucy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgdG9rZW4gPSB0b2tlbnNbaV1cbiAgICAgICAgcmVzLnB1c2goXG4gICAgICAgICAgICB0b2tlbi5rZXlcbiAgICAgICAgICAgICAgICA/IGlubGluZUZpbHRlcnModG9rZW4ua2V5KVxuICAgICAgICAgICAgICAgIDogKCdcIicgKyB0b2tlbiArICdcIicpXG4gICAgICAgIClcbiAgICB9XG4gICAgcmV0dXJuIHJlcy5qb2luKCcrJylcbn1cblxuLyoqXG4gKiAgSW5saW5lcyBhbnkgcG9zc2libGUgZmlsdGVycyBpbiBhIGJpbmRpbmdcbiAqICBzbyB0aGF0IHdlIGNhbiBjb21iaW5lIGV2ZXJ5dGhpbmcgaW50byBhIGh1Z2UgZXhwcmVzc2lvblxuICovXG5mdW5jdGlvbiBpbmxpbmVGaWx0ZXJzIChrZXkpIHtcbiAgICBpZiAoa2V5LmluZGV4T2YoJ3wnKSA+IC0xKSB7XG4gICAgICAgIHZhciBkaXJzID0gRGlyZWN0aXZlLnBhcnNlKGtleSksXG4gICAgICAgICAgICBkaXIgPSBkaXJzICYmIGRpcnNbMF1cbiAgICAgICAgaWYgKGRpciAmJiBkaXIuZmlsdGVycykge1xuICAgICAgICAgICAga2V5ID0gRGlyZWN0aXZlLmlubGluZUZpbHRlcnMoXG4gICAgICAgICAgICAgICAgZGlyLmtleSxcbiAgICAgICAgICAgICAgICBkaXIuZmlsdGVyc1xuICAgICAgICAgICAgKVxuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiAnKCcgKyBrZXkgKyAnKSdcbn1cblxuZXhwb3J0cy5wYXJzZSAgICAgICAgID0gcGFyc2VcbmV4cG9ydHMucGFyc2VBdHRyICAgICA9IHBhcnNlQXR0clxuZXhwb3J0cy5zZXREZWxpbWl0ZXJzID0gc2V0RGVsaW1pdGVyc1xuZXhwb3J0cy5kZWxpbWl0ZXJzICAgID0gW29wZW5DaGFyLCBlbmRDaGFyXSIsIi8qKlxuICogdXRpbHNcbiAqXG4gKiBAYXV0aG9yOiB4dWVqaWEuY3hqLzYxNzRcbiAqL1xuXG52YXIgd2luID0gdHlwZW9mIHdpbmRvdyAhPT0gXCJ1bmRlZmluZWRcIiA/ICB3aW5kb3cgOiB7XG4gICAgICAgIHNldFRpbWVvdXQ6IHNldFRpbWVvdXRcbiAgICB9O1xuXG52YXIgY29uZmlnICAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICBjbGFzczJ0eXBlICAgPSB7fSxcbiAgICByd29yZCAgICAgICAgPSAvW14sIF0rL2csXG4gICAgQlJBQ0tFVF9SRV9TID0gL1xcWycoW14nXSspJ1xcXS9nLFxuICAgIEJSQUNLRVRfUkVfRCA9IC9cXFtcIihbXlwiXSspXCJcXF0vZztcbiAgICBpc1N0cmluZyAgICAgPSBpc1R5cGUoJ1N0cmluZycpLFxuICAgIGlzRnVuY3Rpb24gICA9IGlzVHlwZSgnRnVuY3Rpb24nKSxcbiAgICBpc1VuZGVmaW5lZCAgPSBpc1R5cGUoJ1VuZGVmaW5lZCcpLFxuICAgIGlzT2JqZWN0ICAgICA9IGlzVHlwZSgnT2JqZWN0JyksXG4gICAgaXNBcnJheSAgICAgID0gQXJyYXkuaXNBcnJheSB8fCBpc1R5cGUoJ0FycmF5JyksXG4gICAgaGFzT3duICAgICAgID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eSxcbiAgICBzZXJpYWxpemUgICAgPSBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLFxuICAgIGRlZiAgICAgICAgICA9IE9iamVjdC5kZWZpbmVQcm9wZXJ0eSxcbiAgICBkZWZlciAgICAgICAgPSB3aW4ucmVxdWVzdEFuaW1hdGlvbkZyYW1lIHx8IHdpbi53ZWJraXRSZXF1ZXN0QW5pbWF0aW9uRnJhbWUgfHwgd2luLnNldFRpbWVvdXQsXG5cIkJvb2xlYW4gTnVtYmVyIFN0cmluZyBGdW5jdGlvbiBBcnJheSBEYXRlIFJlZ0V4cCBPYmplY3QgRXJyb3JcIi5yZXBsYWNlKHJ3b3JkLCBmdW5jdGlvbihuYW1lKSB7XG4gICAgY2xhc3MydHlwZVtcIltvYmplY3QgXCIgKyBuYW1lICsgXCJdXCJdID0gbmFtZS50b0xvd2VyQ2FzZSgpXG59KTtcbi8qKlxuICogT2JqZWN0IHV0aWxzXG4gKi9cbnZhciBvYmplY3QgPSB7XG4gICAgYmFzZUtleTogZnVuY3Rpb24obmFtZXNwYWNlKSB7XG4gICAgICAgIHJldHVybiBrZXkuaW5kZXhPZignLicpID4gMCA/IGtleS5zcGxpdCgnLicpWzBdIDoga2V5O1xuICAgIH0sXG4gICAgaGFzaDogZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBPYmplY3QuY3JlYXRlKG51bGwpXG4gICAgfSxcbiAgICBiaW5kOiBmdW5jdGlvbihmbiwgY3R4KSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbihhcmcpIHtcbiAgICAgICAgICAgIHJldHVybiBmbi5jYWxsKGN0eCwgYXJnKVxuICAgICAgICB9XG4gICAgfSxcbiAgICBoYXM6IGZ1bmN0aW9uKG9iaiwga2V5KSB7XG4gICAgICAgIHJldHVybiBoYXNPd24uY2FsbChvYmosIGtleSk7XG4gICAgfSxcbiAgICBnZXQ6IGZ1bmN0aW9uKG9iaiwga2V5KSB7XG4gICAgICAgIGtleSA9IG5vcm1hbGl6ZUtleXBhdGgoa2V5KVxuICAgICAgICBpZiAoa2V5LmluZGV4T2YoJy4nKSA8IDApIHtcbiAgICAgICAgICAgIHJldHVybiBvYmpba2V5XVxuICAgICAgICB9XG4gICAgICAgIHZhciBwYXRoID0ga2V5LnNwbGl0KCcuJyksXG4gICAgICAgICAgICBkID0gLTEsXG4gICAgICAgICAgICBsID0gcGF0aC5sZW5ndGhcbiAgICAgICAgd2hpbGUgKCsrZCA8IGwgJiYgb2JqICE9IG51bGwpIHtcbiAgICAgICAgICAgIG9iaiA9IG9ialtwYXRoW2RdXVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvYmpcbiAgICB9LFxuICAgIHNldDogZnVuY3Rpb24ob2JqLCBrZXksIHZhbCkge1xuICAgICAgICBrZXkgPSBub3JtYWxpemVLZXlwYXRoKGtleSlcbiAgICAgICAgaWYgKGtleS5pbmRleE9mKCcuJykgPCAwKSB7XG4gICAgICAgICAgICBvYmpba2V5XSA9IHZhbFxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cbiAgICAgICAgdmFyIHBhdGggPSBrZXkuc3BsaXQoJy4nKSxcbiAgICAgICAgICAgIGQgPSAtMSxcbiAgICAgICAgICAgIGwgPSBwYXRoLmxlbmd0aCAtIDFcbiAgICAgICAgd2hpbGUgKCsrZCA8IGwpIHtcbiAgICAgICAgICAgIGlmIChvYmpbcGF0aFtkXV0gPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgIG9ialtwYXRoW2RdXSA9IHt9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvYmogPSBvYmpbcGF0aFtkXV1cbiAgICAgICAgfVxuICAgICAgICBvYmpbcGF0aFtkXV0gPSB2YWxcbiAgICB9LFxuICAgIGtleXM6IGZ1bmN0aW9uIChvYmopIHtcbiAgICAgICAgdmFyIF9rZXlzID0gT2JqZWN0LmtleXMsXG4gICAgICAgICAgICByZXQgPSBbXTtcblxuICAgICAgICBpZiAoaXNPYmplY3Qob2JqKSkge1xuICAgICAgICAgICAgaWYgKF9rZXlzKSB7XG4gICAgICAgICAgICAgICAgcmV0ID0gX2tleXMob2JqKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgayBpbiBvYmopIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGhhc093bi5jYWxsKG9iaixrKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0LnB1c2goayk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9LFxuICAgIHRvQXJyYXk6IGZ1bmN0aW9uKG9iamVjdCl7XG4gICAgICAgIHZhciByZXMgPSBbXSwgdmFsLCBkYXRhXG4gICAgICAgIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICAgICAgICAgIHZhbCA9IG9ialtrZXldXG4gICAgICAgICAgICBkYXRhID0gaXNPYmplY3QodmFsKVxuICAgICAgICAgICAgICAgID8gdmFsXG4gICAgICAgICAgICAgICAgOiB7ICR2YWx1ZTogdmFsIH1cbiAgICAgICAgICAgIGRhdGEuJGtleSA9IGtleVxuICAgICAgICAgICAgcmVzLnB1c2goZGF0YSlcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzO1xuICAgIH0sXG4gICAgLyoqXG4gICAgICogIERlZmluZSBhbiBpZW51bWVyYWJsZSBwcm9wZXJ0eVxuICAgICAqICBUaGlzIGF2b2lkcyBpdCBiZWluZyBpbmNsdWRlZCBpbiBKU09OLnN0cmluZ2lmeVxuICAgICAqICBvciBmb3IuLi5pbiBsb29wcy5cbiAgICAgKi9cbiAgICBkZWZQcm90ZWN0ZWQ6IGZ1bmN0aW9uIChvYmosIGtleSwgdmFsLCBlbnVtZXJhYmxlLCB3cml0YWJsZSkge1xuICAgICAgICBkZWYob2JqLCBrZXksIHtcbiAgICAgICAgICAgIHZhbHVlICAgICAgICA6IHZhbCxcbiAgICAgICAgICAgIGVudW1lcmFibGUgICA6IGVudW1lcmFibGUsXG4gICAgICAgICAgICB3cml0YWJsZSAgICAgOiB3cml0YWJsZSxcbiAgICAgICAgICAgIGNvbmZpZ3VyYWJsZSA6IHRydWVcbiAgICAgICAgfSlcbiAgICB9LFxuICAgIC8qKlxuICAgICAqIOe7p+aJv1xuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBwcm90b1Byb3BzIOmcgOimgee7p+aJv+eahOWOn+Wei1xuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBzdGF0aWNQcm9wcyDpnZnmgIHnmoTnsbvmlrnms5VcbiAgICAgKi9cbiAgICBleHRlbmQ6IGZ1bmN0aW9uKHByb3RvUHJvcHMsIHN0YXRpY1Byb3BzKSB7XG4gICAgICAgIHZhciBwYXJlbnQgPSB0aGlzO1xuICAgICAgICB2YXIgY2hpbGQ7XG4gICAgICAgIGlmIChwcm90b1Byb3BzICYmIGhhcyhwcm90b1Byb3BzLCAnY29uc3RydWN0b3InKSkge1xuICAgICAgICAgICAgY2hpbGQgPSBwcm90b1Byb3BzLmNvbnN0cnVjdG9yO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY2hpbGQgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGFyZW50LmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgbWl4KGNoaWxkLCBwYXJlbnQpO1xuICAgICAgICBtaXgoY2hpbGQsIHN0YXRpY1Byb3BzKTtcbiAgICAgICAgdmFyIFN1cnJvZ2F0ZSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdGhpcy5jb25zdHJ1Y3RvciA9IGNoaWxkO1xuICAgICAgICB9O1xuICAgICAgICBTdXJyb2dhdGUucHJvdG90eXBlID0gcGFyZW50LnByb3RvdHlwZTtcbiAgICAgICAgY2hpbGQucHJvdG90eXBlID0gbmV3IFN1cnJvZ2F0ZTtcbiAgICAgICAgaWYgKHByb3RvUHJvcHMpIHtcbiAgICAgICAgICAgIG1peChjaGlsZC5wcm90b3R5cGUsIHByb3RvUHJvcHMpO1xuICAgICAgICB9XG4gICAgICAgIGNoaWxkLl9fc3VwZXJfXyA9IHBhcmVudC5wcm90b3R5cGU7XG4gICAgICAgIHJldHVybiBjaGlsZDtcbiAgICB9XG59O1xuLyoqXG4gKiBhcnJheSB1dGlsc1xuICovXG52YXIgYXJyYXkgPSB7XG4gICAgaW5kZXhPZjogZnVuY3Rpb24oZWxlbWVudCwgYXJyKSB7XG4gICAgICAgIGlmICghaXNBcnJheShhcnIpKSB7XG4gICAgICAgICAgICByZXR1cm4gLTE7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGFyci5pbmRleE9mKGVsZW1lbnQpO1xuICAgIH0sXG4gICAgdW5pcXVlOiBmdW5jdGlvbiAoYXJyKSB7XG4gICAgICAgIHZhciBoYXNoID0ge30sXG4gICAgICAgICAgICBpID0gYXJyLmxlbmd0aCxcbiAgICAgICAgICAgIGtleSwgcmVzID0gW11cbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAga2V5ID0gYXJyW2ldXG4gICAgICAgICAgICBpZiAoaGFzaFtrZXldKSBjb250aW51ZTtcbiAgICAgICAgICAgIGhhc2hba2V5XSA9IDFcbiAgICAgICAgICAgIHJlcy5wdXNoKGtleSlcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzO1xuICAgIH1cbn07XG4vKiogXG4gKiBkb20gdXRpbHNcbiAqL1xudmFyIGRvbSA9IHtcbiAgICBhdHRyOiBmdW5jdGlvbihlbCwgdHlwZSkge1xuICAgICAgICB2YXIgYXR0ciA9IGNvbmZpZy5wcmVmaXggKyAnLScgKyB0eXBlLFxuICAgICAgICAgICAgdmFsID0gZWwuZ2V0QXR0cmlidXRlKGF0dHIpXG4gICAgICAgIGlmICh2YWwgIT09IG51bGwpIHtcbiAgICAgICAgICAgIGVsLnJlbW92ZUF0dHJpYnV0ZShhdHRyKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2YWxcbiAgICB9LFxuICAgIHF1ZXJ5OiBmdW5jdGlvbiAoZWwpIHtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBlbCA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgID8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihlbClcbiAgICAgICAgICAgIDogZWw7XG4gICAgfVxufTtcblxuIC8qKlxuICogIE1ha2Ugc3VyZSBudWxsIGFuZCB1bmRlZmluZWQgb3V0cHV0IGVtcHR5IHN0cmluZ1xuICovXG5mdW5jdGlvbiBndWFyZCh2YWx1ZSkge1xuICAgIC8qIGpzaGludCBlcWVxZXE6IGZhbHNlLCBlcW51bGw6IHRydWUgKi9cbiAgICByZXR1cm4gdmFsdWUgPT0gbnVsbFxuICAgICAgICA/ICcnXG4gICAgICAgIDogKHR5cGVvZiB2YWx1ZSA9PSAnb2JqZWN0JylcbiAgICAgICAgICAgID8gSlNPTi5zdHJpbmdpZnkodmFsdWUpXG4gICAgICAgICAgICA6IHZhbHVlO1xufVxuXG4vKipcbiAqIOeugOWNleWcsOWvueixoeWQiOW5tlxuICogQHBhcmFtICBvYmplY3QgciDmupDlr7nosaFcbiAqIEBwYXJhbSAgb2JqZWN0IHMg55uu5qCH5a+56LGhXG4gKiBAcGFyYW0gIGJvb2wgICBvIOaYr+WQpumHjeWGme+8iOm7mOiupOS4umZhbHNl77yJXG4gKiBAcGFyYW0gIGJvb2wgICBkIOaYr+WQpumAkuW9ku+8iOm7mOiupOS4umZhbHNl77yJXG4gKiBAcmV0dXJuIG9iamVjdFxuICovXG5mdW5jdGlvbiBtaXgociwgcywgbywgZCkge1xuICAgIGZvciAodmFyIGsgaW4gcykge1xuICAgICAgICBpZiAoaGFzT3duLmNhbGwocywgaykpIHtcbiAgICAgICAgICAgIGlmICghKGsgaW4gcikpIHtcbiAgICAgICAgICAgICAgICByW2tdID0gc1trXTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobykge1xuICAgICAgICAgICAgICAgIGlmIChkICYmIGlzT2JqZWN0KHJba10pICYmIGlzT2JqZWN0KHNba10pKSB7XG4gICAgICAgICAgICAgICAgICAgIG1peChyW2tdLCBzW2tdLCBvLCBkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByW2tdID0gc1trXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHI7XG59XG4vKipcbiAqICBOb3JtYWxpemUga2V5cGF0aCB3aXRoIHBvc3NpYmxlIGJyYWNrZXRzIGludG8gZG90IG5vdGF0aW9uc1xuICovXG5mdW5jdGlvbiBub3JtYWxpemVLZXlwYXRoKGtleSkge1xuICAgIHJldHVybiBrZXkuaW5kZXhPZignWycpIDwgMCA/IGtleSA6IGtleS5yZXBsYWNlKEJSQUNLRVRfUkVfUywgJy4kMScpLnJlcGxhY2UoQlJBQ0tFVF9SRV9ELCAnLiQxJylcbn1cblxuZnVuY3Rpb24gZ2V0VHlwZShvYmopIHtcbiAgICBpZiAob2JqID09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIFN0cmluZyhvYmopO1xuICAgIH1cbiAgICByZXR1cm4gdHlwZW9mIG9iaiA9PT0gXCJvYmplY3RcIiB8fCB0eXBlb2Ygb2JqID09PSBcImZ1bmN0aW9uXCIgPyBjbGFzczJ0eXBlW3NlcmlhbGl6ZS5jYWxsKG9iaildIHx8IFwib2JqZWN0XCIgOiB0eXBlb2Ygb2JqO1xufVxuXG5mdW5jdGlvbiBpc1R5cGUodHlwZSkge1xuICAgIHJldHVybiBmdW5jdGlvbihvYmopIHtcbiAgICAgICAgcmV0dXJuIHt9LnRvU3RyaW5nLmNhbGwob2JqKSA9PT0gJ1tvYmplY3QgJyArIHR5cGUgKyAnXSc7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBpc0VxdWFsKHYxLCB2Mikge1xuICAgIGlmICh2MSA9PT0gMCAmJiB2MiA9PT0gMCkge1xuICAgICAgICByZXR1cm4gMSAvIHYxID09PSAxIC8gdjJcbiAgICB9IGVsc2UgaWYgKHYxICE9PSB2MSkge1xuICAgICAgICByZXR1cm4gdjIgIT09IHYyXG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHYxID09PSB2MlxuICAgIH1cbn1cblxuZnVuY3Rpb24gZ3VpZChwcmVmaXgpIHtcbiAgICBwcmVmaXggPSBwcmVmaXggfHwgJyc7XG4gICAgcmV0dXJuIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZygyLCAxNSkgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoMiwgMTUpXG59XG5cbmZ1bmN0aW9uIG5leHRUaWNrKGNiKSB7XG4gICAgZGVmZXIoY2IsIDApXG59XG5cbmZ1bmN0aW9uIG1lcmdlKGFyZ3MpIHtcbiAgICB2YXIgcmV0ID0ge30sXG4gICAgICAgIGksIGw7XG4gICAgaWYgKCFpc0FycmF5KGFyZ3MpKSB7XG4gICAgICAgIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgfVxuICAgIGZvciAoaSA9IDAsIGwgPSBhcmdzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICBtaXgocmV0LCBhcmdzW2ldLCB0cnVlKTtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbn1cblxuZnVuY3Rpb24gZWFjaChvYmosIGZuKSB7XG4gICAgdmFyIGksIGwsIGtzO1xuICAgIGlmIChpc0FycmF5KG9iaikpIHtcbiAgICAgICAgZm9yIChpID0gMCwgbCA9IG9iai5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgICAgIGlmIChmbihvYmpbaV0sIGksIG9iaikgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgICBrcyA9IGtleXMob2JqKTtcbiAgICAgICAgZm9yIChpID0gMCwgbCA9IGtzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgaWYgKGZuKG9ialtrc1tpXV0sIGtzW2ldLCBvYmopID09PSBmYWxzZSkge1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG5mdW5jdGlvbiBsb2cobXNnKSB7XG4gICAgaWYgKGNvbmZpZy5kZWJ1ZyAmJiBjb25zb2xlKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKG1zZylcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHdhcm4obXNnKSB7XG4gICAgaWYgKCFjb25maWcuc2lsZW50ICYmIGNvbnNvbGUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKG1zZyk7XG4gICAgICAgIGlmIChjb25maWcuZGVidWcgJiYgY29uc29sZS50cmFjZSkge1xuICAgICAgICAgICAgY29uc29sZS50cmFjZSgpO1xuICAgICAgICB9XG4gICAgfVxufVxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgb2JqZWN0OiBvYmplY3QsXG4gICAgYXJyYXk6IGFycmF5LFxuICAgIGRvbTogZG9tLFxuICAgIGdldFR5cGU6IGdldFR5cGUsXG4gICAgaXNBcnJheTogaXNBcnJheSxcbiAgICBpc09iamVjdDogaXNPYmplY3QsXG4gICAgaXNTdHJpbmc6IGlzU3RyaW5nLFxuICAgIGhhc2g6IG9iamVjdC5oYXNoLFxuICAgIGlzRnVuY3Rpb246IGlzRnVuY3Rpb24sXG4gICAgaXNFcXVhbDogaXNFcXVhbCxcbiAgICBtaXg6IG1peCxcbiAgICBtZXJnZTogbWVyZ2UsXG4gICAgZ3VpZDogZ3VpZCxcbiAgICBoYXNPd246IGhhc093bixcbiAgICBzZXJpYWxpemU6IHNlcmlhbGl6ZSxcbiAgICBlYWNoOiBlYWNoLFxuICAgIGxvZzogbG9nLFxuICAgIHdhcm46IHdhcm4sXG4gICAgbmV4dFRpY2s6IG5leHRUaWNrLFxuICAgIGd1YXJkOiBndWFyZFxufSIsInZhciB1dGlscyAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcblx0QmF0Y2hlciAgPSByZXF1aXJlKCcuL2JhdGNoZXInKSxcblx0Q29tcGlsZXIgPSByZXF1aXJlKCcuL2NvbXBpbGVyJyksXG5cdHdhdGNoZXJCYXRjaGVyID0gbmV3IEJhdGNoZXIoKTtcbi8qKlxuICogVmlld01vZGVsXG4gKiBAcGFyYW0ge1N0cmluZ30gb3B0aW9ucy5lbDogaWRcbiAqL1xuZnVuY3Rpb24gVk0ob3B0aW9ucyl7XG5cdGlmKCFvcHRpb25zKXtyZXR1cm47fVxuXHR0aGlzLiRpbml0KG9wdGlvbnMpO1xufVxuXG51dGlscy5taXgoVk0ucHJvdG90eXBlLCB7XG5cdCckaW5pdCc6IGZ1bmN0aW9uIGluaXQob3B0aW9ucyl7XG5cdFx0bmV3IENvbXBpbGVyKHRoaXMsIG9wdGlvbnMpO1xuXHR9LFxuXHQnJGdldCc6IGZ1bmN0aW9uIGdldChrZXkpe1xuXHRcdHZhciB2YWwgPSB1dGlscy5vYmplY3QuZ2V0KHRoaXMsIGtleSk7XG5cdFx0cmV0dXJuIHZhbCA9PT0gdW5kZWZpbmVkICYmIHRoaXMuJHBhcmVudFxuXHRcdCAgICAgICAgPyB0aGlzLiRwYXJlbnQuJGdldChrZXkpXG5cdFx0ICAgICAgICA6IHZhbDtcblx0fSxcblx0JyRzZXQnOiBmdW5jdGlvbiBzZXQoa2V5LCB2YWx1ZSl7XG5cdFx0dXRpbHMub2JqZWN0LnNldCh0aGlzLCBrZXksIHZhbHVlKTtcblx0fSxcblx0JyR3YXRjaCc6IGZ1bmN0aW9uIHdhdGNoKGtleSwgY2FsbGJhY2spIHtcblx0XHR2YXIgaWQgPSB1dGlscy5ndWlkKCd3YXRjaGVyaWQtJyksIFxuXHRcdFx0c2VsZiA9IHRoaXM7XG5cdFx0ZnVuY3Rpb24gZXZlbnRSZXNvbHZlcigpe1xuXHRcdFx0dmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG5cdFx0XHR3YXRjaGVyQmF0Y2hlci5wdXNoKHtcblx0XHRcdFx0aWQ6IGlkLFxuXHRcdFx0XHRvdmVycmlkZTogdHJ1ZSxcblx0XHRcdFx0ZXhlY3V0ZTogZnVuY3Rpb24oKXtcblx0XHRcdFx0XHRjYWxsYmFjay5hcHBseShzZWxmLCBhcmdzKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdGNhbGxiYWNrLl9mbiA9IGV2ZW50UmVzb2x2ZXI7XG5cdFx0dGhpcy4kY29tcGlsZXIub2JzZXJ2ZXIub24oJ2NoYW5nZTonICsga2V5LCBldmVudFJlc29sdmVyKTtcblx0fSxcblx0JyR1bndhdGNoJzogZnVuY3Rpb24gdW53YXRjaChrZXksIGNhbGxiYWNrKSB7XG5cdFx0dmFyIGFyZ3MgPSBbJ2NoYW5nZTonICsga2V5XTtcblx0XHR0aGlzLiRjb21waWxlci5vYnNlcnZlci5kZXRhY2goa2V5LCBjYWxsYmFjay5fZm4pO1xuXHR9LFxuXHQnJGJyb2FkY2FzdCc6IGZ1bmN0aW9uIGJyb2FkY2FzdCgpe1xuXHRcdHZhciBjaGlsZHJlbiA9IHRoaXMuJGNvbXBpbGVyLmNoaWxkcmVuO1xuXHRcdGZvcih2YXIgbGVuID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTsgbGVuLS07KXtcblx0XHRcdGNoaWxkID0gY2hpbGRyZW5bbGVuXTtcblx0XHRcdGNoaWxkLmVtaXR0ZXIuZW1pdC5hcHBseShjaGlsZC5lbWl0dGVyLCBhcmd1bWVudHMpO1xuXHRcdFx0Y2hpbGQudm0uJGJyb2FkY2FzdC5hcHBseShjaGlsZC52bSwgYXJndW1lbnRzKTtcblx0XHR9XG5cdH0sXG5cdCckZGlzcGF0Y2gnOiBmdW5jdGlvbiBkaXNwYXRjaCgpe1xuXHRcdHZhciBjb21waWxlciA9IHRoaXMuJGNvbXBpbGVyLFxuXHRcdFx0ZW1pdHRlciAgPSBjb21waWxlci5lbWl0dGVyLFxuXHRcdFx0cGFyZW50ICAgPSBjb21waWxlci5wYXJlbnQ7XG5cdFx0ZW1pdHRlci5lbWl0LmFwcGx5KGVtaXR0ZXIsIGFyZ3VtZW50cyk7XG5cdFx0aWYocGFyZW50KXtcblx0XHRcdHBhcmVudC52bS4kZGlzcGF0Y2guYXBwbHkocGFyZW50LnZtLCBhcmd1bWVudHMpO1xuXHRcdH1cblx0fSxcblx0JyRhcHBlbmRUbyc6IGZ1bmN0aW9uIGFwcGVuZFRvKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWxzLmRvbS5xdWVyeSh0YXJnZXQpO1xuXHRcdHZhciBlbCA9IHRoaXMuJGVsO1xuXHRcdHRhcmdldC5hcHBlbmRDaGlsZChlbClcbiAgICAgICAgY2IgJiYgdXRpbC5uZXh0VGljayhjYik7XG5cdH0sXG5cdCckcmVtb3ZlJzogZnVuY3Rpb24gcmVtb3ZlKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWwuZG9tLnF1ZXJ5KHRhcmdldCk7XG5cdFx0dmFyIGVsID0gdGhpcy4kZWw7XG5cdFx0aWYoZWwucGFyZW50Tm9kZSl7XG5cdFx0XHRlbC5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKGVsKTtcblx0XHR9XG5cdFx0Y2IgJiYgdXRpbC5uZXh0VGljayhjYik7XG5cdH0sXG5cdCckYmVmb3JlJzogZnVuY3Rpb24gYmVmb3JlKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWwuZG9tLnF1ZXJ5KHRhcmdldCk7XG5cdFx0dGFyZ2V0LnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKGVsLCB0YXJnZXQpO1xuXHRcdGNiICYmIHV0aWwubmV4dFRpY2soY2IpO1xuXHR9LFxuXHQnJGFmdGVyJzogZnVuY3Rpb24gYWZ0ZXIodGFyZ2V0LCBjYil7XG5cdFx0dGFyZ2V0ID0gdXRpbC5kb20ucXVlcnkodGFyZ2V0KTtcblx0XHR2YXIgZWwgPSB0aGlzLiRlbDtcblx0XHRpZih0YXJnZXQubmV4dFNpYmxpbmcpIHtcblx0XHRcdHRhcmdldC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShlbCwgdGFyZ2V0Lm5leHRTaWJsaW5nKTtcblx0XHR9ZWxzZXtcblx0XHRcdHRhcmdldC5wYXJlbnROb2RlLmFwcGVuZENoaWxkKGVsKTtcblx0XHR9XG5cdFx0Y2IgJiYgdXRpbC5uZXh0VGljayhjYik7XG5cdH1cbn0pO1xuLyoqXG4gKiAgZGVsZWdhdGUgb24vb2ZmL29uY2UgdG8gdGhlIGNvbXBpbGVyJ3MgZW1pdHRlclxuICovXG51dGlscy5lYWNoKFsnZW1pdCcsICdvbicsICdvZmYnLCAnb25jZScsICdkZXRhY2gnLCAnZmlyZSddLCBmdW5jdGlvbiAobWV0aG9kKSB7XG5cdFZNLnByb3RvdHlwZVsnJCcgKyBtZXRob2RdID0gZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZW1pdHRlciA9IHRoaXMuJGNvbXBpbGVyLmVtaXR0ZXI7XG4gICAgICAgIGVtaXR0ZXJbbWV0aG9kXS5hcHBseShlbWl0dGVyLCBhcmd1bWVudHMpO1xuICAgIH1cbn0pO1xuVk0uZXh0ZW5kID0gdXRpbHMub2JqZWN0LmV4dGVuZDtcbm1vZHVsZS5leHBvcnRzID0gVk07XG4iXX0=
