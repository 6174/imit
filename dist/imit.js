(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
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
},{"./utils":15}],2:[function(require,module,exports){
var utils = require('./utils')

function Batcher () {
    this.reset()
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
},{"./utils":15}],3:[function(require,module,exports){
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
                if (!self.unbound) {
                    self._update()
                }
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
},{"./batcher":2}],4:[function(require,module,exports){

var EventTarget = require('./eventTarget'),
	utils       = require('./utils'),
	config      = require('./config'),
	Binding     = require('./binding'),
	Parser      = require('./parser'),
	Observer    = require('./observer'),
	Directive   = require('./directives'),
	TextParser  = Parser.TextParser,
	ExpParser   = Parser.ExpParser,
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
			vm: vm,
			bindings: utils.hash(),
			dirs: [],
			deferred: [],
			computed: [],
			children: [],
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
	            compiler.createBinding(key)
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
	    utils.log(compiler);
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
	    i = compiler.deferred.length
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
	    compiler.observer.off()
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
	    observer.proxies = {}

	    // ADD OWN LISTENERS WHICH TRIGGER BINDING UPDATES
	    observer
	        .on('get', onGet)
	        .on('set', onSet)
	        .on('mutate', onSet);

	    // register hooks setup in options
	    utils.each(hooks, function(hook){
	    	var i, fns;
	        fns = options[hook]
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

	    Object.defineProperty(compiler.vm, '$data', {
	    	get: function(){
	    		compiler.observer.emit('get', '$data');
	    	},
	    	set: function(){
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
	    	if (key !=='$data') update;
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
	    } else if (nodeType === 3 && config.interpolate) {
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

	    	// skip anything with v-pre
	        if (utils.dom.attr(node, 'pre') !== null) {
	            return;
	        }

	        var i, l, j, k

	        // check priority directives.
	        // if any of them are present, it will take over the node with a childVM
	        // so we can skip the rest
	        for (i = 0, l = priorityDirectives.length; i < l; i++) {
	            if (this.checkPriorityDir(priorityDirectives[i], node, root)) {
	                return
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
	            } else if (config.interpolate) {
	                // non directive attribute, check interpolation tags
	                exp = TextParser.parseAttr(attr.value)
	                if (exp) {
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

	        // recursively compile childNodes
		    if (node.hasChildNodes()) {
		        slice.call(node.childNodes).forEach(this.compile, this);
		    }
	    }
	},
	compileTextNode: function (node) {
	    var tokens = TextParser.parse(node.nodeValue)
	    if (!tokens) return
	    var el, token, directive

	    for (var i = 0, l = tokens.length; i < l; i++) {

	        token = tokens[i]
	        directive = null

	        if (token.key) { // a binding
	            if (token.key.charAt(0) === '>') { // a partial
	                el = document.createComment('ref')
	                directive = this.parseDirective('partial', token.key.slice(1), el)
	            } else {
	                if (!token.html) { // text binding
	                    el = document.createTextNode('')
	                    directive = this.parseDirective('text', token.key, el)
	                } else { // html binding
	                    el = document.createComment(config.prefix + '-html')
	                    directive = this.parseDirective('html', token.key, el)
	                }
	            }
	        } else { // a plain string
	            el = document.createTextNode(token)
	        }

	        // insert node
	        node.parentNode.insertBefore(el, node)
	        // bind directive
	        this.bindDirective(directive)

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
	    this.dirs.push(directive)

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
	        binding = compiler.createBinding(key, directive)
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
	        ob       = data.__emitter__

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
	        getter = this.expCache[exp] = ExpParser.parse(computedKey || key, this)
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
	            $get: utils.bind(value.$get, this.vm),
	            $set: value.$set
	                ? utils.bind(value.$set, this.vm)
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
	    var baseKey = utils.baseKey(key)
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
	    var parsed = TextParser.parseAttr(exp)
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
},{"./binding":3,"./config":5,"./directives":7,"./eventTarget":8,"./observer":12,"./parser":13,"./utils":15,"./viewmodel":16}],5:[function(require,module,exports){
module.exports = {
	prefix: 'j',
	debug: true
}
},{}],6:[function(require,module,exports){
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
},{"./utils":15}],7:[function(require,module,exports){
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

    this.id             = dirId++
    this.name           = name
    this.compiler       = compiler
    this.vm             = compiler.vm
    this.el             = el
    this.computeFilters = false
    this.key            = ast.key
    this.arg            = ast.arg
    this.expression     = ast.expression

    var isEmpty = this.expression === ''

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
        this.key = compiler.eval(this.key)
        if (this.isLiteral) {
            this.expression = this.key
        }
    }

    var filters = ast.filters,
        filter, fn, i, l, computed
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
},{"./textParser":14}],8:[function(require,module,exports){
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
},{"./utils":15}],9:[function(require,module,exports){
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

},{"./config":5,"./deferred":6,"./directives":7,"./filters":10,"./parser":13,"./utils":15,"./viewmodel":16}],10:[function(require,module,exports){
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
},{"./utils":15}],11:[function(require,module,exports){
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
},{}],12:[function(require,module,exports){
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
			ubobserve(oldValue, key, emitter);
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
    var emitter = obj && obj.__emitter__
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
},{"./config":5,"./eventTarget":8,"./utils":15}],13:[function(require,module,exports){
var toFragment = require('./fragment')
    TextParser = require('./textParser'),
    ExpParser  = require('./ExpParser');

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
    ExpParser: ExpParser
};
},{"./ExpParser":1,"./fragment":11,"./textParser":14}],14:[function(require,module,exports){
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
    Directive = Directive || require('./directives')
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
},{"./directives":7}],15:[function(require,module,exports){
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
    nextTick: nextTick
}
},{"./config":5}],16:[function(require,module,exports){
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

},{"./batcher":2,"./compiler":4,"./utils":15}]},{},[9])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9ub2RlX21vZHVsZXMvZ3VscC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL0V4cFBhcnNlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvYmF0Y2hlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvYmluZGluZy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvY29tcGlsZXIuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2NvbmZpZy5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvZGVmZXJyZWQuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2RpcmVjdGl2ZXMuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL2V2ZW50VGFyZ2V0LmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9mYWtlXzEwYjhmYWVkLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9maWx0ZXJzLmpzIiwiL1VzZXJzL2FkbWluL3dvcmtzcGFjZS9pbWl0L3NyYy9mcmFnbWVudC5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvb2JzZXJ2ZXIuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL3BhcnNlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvdGV4dFBhcnNlci5qcyIsIi9Vc2Vycy9hZG1pbi93b3Jrc3BhY2UvaW1pdC9zcmMvdXRpbHMuanMiLCIvVXNlcnMvYWRtaW4vd29ya3NwYWNlL2ltaXQvc3JjL3ZpZXdtb2RlbC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3grQkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pRQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUxBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKX12YXIgZj1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwoZi5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxmLGYuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwidmFyIHV0aWxzICAgICAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBTVFJfU0FWRV9SRSAgICAgPSAvXCIoPzpbXlwiXFxcXF18XFxcXC4pKlwifCcoPzpbXidcXFxcXXxcXFxcLikqJy9nLFxuICAgIFNUUl9SRVNUT1JFX1JFICA9IC9cIihcXGQrKVwiL2csXG4gICAgTkVXTElORV9SRSAgICAgID0gL1xcbi9nLFxuICAgIENUT1JfUkUgICAgICAgICA9IG5ldyBSZWdFeHAoJ2NvbnN0cnVjdG9yJy5zcGxpdCgnJykuam9pbignW1xcJ1wiKywgXSonKSksXG4gICAgVU5JQ09ERV9SRSAgICAgID0gL1xcXFx1XFxkXFxkXFxkXFxkL1xuXG4vLyBWYXJpYWJsZSBleHRyYWN0aW9uIHNjb29wZWQgZnJvbSBodHRwczovL2dpdGh1Yi5jb20vUnVieUxvdXZyZS9hdmFsb25cblxudmFyIEtFWVdPUkRTID1cbiAgICAgICAgLy8ga2V5d29yZHNcbiAgICAgICAgJ2JyZWFrLGNhc2UsY2F0Y2gsY29udGludWUsZGVidWdnZXIsZGVmYXVsdCxkZWxldGUsZG8sZWxzZSxmYWxzZScgK1xuICAgICAgICAnLGZpbmFsbHksZm9yLGZ1bmN0aW9uLGlmLGluLGluc3RhbmNlb2YsbmV3LG51bGwscmV0dXJuLHN3aXRjaCx0aGlzJyArXG4gICAgICAgICcsdGhyb3csdHJ1ZSx0cnksdHlwZW9mLHZhcix2b2lkLHdoaWxlLHdpdGgsdW5kZWZpbmVkJyArXG4gICAgICAgIC8vIHJlc2VydmVkXG4gICAgICAgICcsYWJzdHJhY3QsYm9vbGVhbixieXRlLGNoYXIsY2xhc3MsY29uc3QsZG91YmxlLGVudW0sZXhwb3J0LGV4dGVuZHMnICtcbiAgICAgICAgJyxmaW5hbCxmbG9hdCxnb3RvLGltcGxlbWVudHMsaW1wb3J0LGludCxpbnRlcmZhY2UsbG9uZyxuYXRpdmUnICtcbiAgICAgICAgJyxwYWNrYWdlLHByaXZhdGUscHJvdGVjdGVkLHB1YmxpYyxzaG9ydCxzdGF0aWMsc3VwZXIsc3luY2hyb25pemVkJyArXG4gICAgICAgICcsdGhyb3dzLHRyYW5zaWVudCx2b2xhdGlsZScgK1xuICAgICAgICAvLyBFQ01BIDUgLSB1c2Ugc3RyaWN0XG4gICAgICAgICcsYXJndW1lbnRzLGxldCx5aWVsZCcgK1xuICAgICAgICAvLyBhbGxvdyB1c2luZyBNYXRoIGluIGV4cHJlc3Npb25zXG4gICAgICAgICcsTWF0aCcsXG4gICAgICAgIFxuICAgIEtFWVdPUkRTX1JFID0gbmV3IFJlZ0V4cChbXCJcXFxcYlwiICsgS0VZV09SRFMucmVwbGFjZSgvLC9nLCAnXFxcXGJ8XFxcXGInKSArIFwiXFxcXGJcIl0uam9pbignfCcpLCAnZycpLFxuICAgIFJFTU9WRV9SRSAgID0gL1xcL1xcKig/Oi58XFxuKSo/XFwqXFwvfFxcL1xcL1teXFxuXSpcXG58XFwvXFwvW15cXG5dKiR8J1teJ10qJ3xcIlteXCJdKlwifFtcXHNcXHRcXG5dKlxcLltcXHNcXHRcXG5dKlskXFx3XFwuXSt8W1xceyxdXFxzKltcXHdcXCRfXStcXHMqOi9nLFxuICAgIFNQTElUX1JFICAgID0gL1teXFx3JF0rL2csXG4gICAgTlVNQkVSX1JFICAgPSAvXFxiXFxkW14sXSovZyxcbiAgICBCT1VOREFSWV9SRSA9IC9eLCt8LCskL2dcblxuLyoqXG4gKiAgU3RyaXAgdG9wIGxldmVsIHZhcmlhYmxlIG5hbWVzIGZyb20gYSBzbmlwcGV0IG9mIEpTIGV4cHJlc3Npb25cbiAqL1xuZnVuY3Rpb24gZ2V0VmFyaWFibGVzIChjb2RlKSB7XG4gICAgY29kZSA9IGNvZGVcbiAgICAgICAgLnJlcGxhY2UoUkVNT1ZFX1JFLCAnJylcbiAgICAgICAgLnJlcGxhY2UoU1BMSVRfUkUsICcsJylcbiAgICAgICAgLnJlcGxhY2UoS0VZV09SRFNfUkUsICcnKVxuICAgICAgICAucmVwbGFjZShOVU1CRVJfUkUsICcnKVxuICAgICAgICAucmVwbGFjZShCT1VOREFSWV9SRSwgJycpXG4gICAgcmV0dXJuIGNvZGVcbiAgICAgICAgPyBjb2RlLnNwbGl0KC8sKy8pXG4gICAgICAgIDogW11cbn1cblxuLyoqXG4gKiAgQSBnaXZlbiBwYXRoIGNvdWxkIHBvdGVudGlhbGx5IGV4aXN0IG5vdCBvbiB0aGVcbiAqICBjdXJyZW50IGNvbXBpbGVyLCBidXQgdXAgaW4gdGhlIHBhcmVudCBjaGFpbiBzb21ld2hlcmUuXG4gKiAgVGhpcyBmdW5jdGlvbiBnZW5lcmF0ZXMgYW4gYWNjZXNzIHJlbGF0aW9uc2hpcCBzdHJpbmdcbiAqICB0aGF0IGNhbiBiZSB1c2VkIGluIHRoZSBnZXR0ZXIgZnVuY3Rpb24gYnkgd2Fsa2luZyB1cFxuICogIHRoZSBwYXJlbnQgY2hhaW4gdG8gY2hlY2sgZm9yIGtleSBleGlzdGVuY2UuXG4gKlxuICogIEl0IHN0b3BzIGF0IHRvcCBwYXJlbnQgaWYgbm8gdm0gaW4gdGhlIGNoYWluIGhhcyB0aGVcbiAqICBrZXkuIEl0IHRoZW4gY3JlYXRlcyBhbnkgbWlzc2luZyBiaW5kaW5ncyBvbiB0aGVcbiAqICBmaW5hbCByZXNvbHZlZCB2bS5cbiAqL1xuZnVuY3Rpb24gdHJhY2VTY29wZSAocGF0aCwgY29tcGlsZXIsIGRhdGEpIHtcbiAgICB2YXIgcmVsICA9ICcnLFxuICAgICAgICBkaXN0ID0gMCxcbiAgICAgICAgc2VsZiA9IGNvbXBpbGVyXG5cbiAgICBpZiAoZGF0YSAmJiB1dGlscy5vYmplY3QuZ2V0KGRhdGEsIHBhdGgpICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgLy8gaGFjazogdGVtcG9yYXJpbHkgYXR0YWNoZWQgZGF0YVxuICAgICAgICByZXR1cm4gJyR0ZW1wLidcbiAgICB9XG5cbiAgICB3aGlsZSAoY29tcGlsZXIpIHtcbiAgICAgICAgaWYgKGNvbXBpbGVyLmhhc0tleShwYXRoKSkge1xuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbXBpbGVyID0gY29tcGlsZXIucGFyZW50XG4gICAgICAgICAgICBkaXN0KytcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoY29tcGlsZXIpIHtcbiAgICAgICAgd2hpbGUgKGRpc3QtLSkge1xuICAgICAgICAgICAgcmVsICs9ICckcGFyZW50LidcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWNvbXBpbGVyLmJpbmRpbmdzW3BhdGhdICYmIHBhdGguY2hhckF0KDApICE9PSAnJCcpIHtcbiAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcocGF0aClcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbGYuY3JlYXRlQmluZGluZyhwYXRoKVxuICAgIH1cbiAgICByZXR1cm4gcmVsXG59XG5cbi8qKlxuICogIENyZWF0ZSBhIGZ1bmN0aW9uIGZyb20gYSBzdHJpbmcuLi5cbiAqICB0aGlzIGxvb2tzIGxpa2UgZXZpbCBtYWdpYyBidXQgc2luY2UgYWxsIHZhcmlhYmxlcyBhcmUgbGltaXRlZFxuICogIHRvIHRoZSBWTSdzIGRhdGEgaXQncyBhY3R1YWxseSBwcm9wZXJseSBzYW5kYm94ZWRcbiAqL1xuZnVuY3Rpb24gbWFrZUdldHRlciAoZXhwLCByYXcpIHtcbiAgICB2YXIgZm5cbiAgICB0cnkge1xuICAgICAgICBmbiA9IG5ldyBGdW5jdGlvbihleHApXG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB1dGlscy53YXJuKCdFcnJvciBwYXJzaW5nIGV4cHJlc3Npb246ICcgKyByYXcpXG4gICAgfVxuICAgIHJldHVybiBmblxufVxuXG4vKipcbiAqICBFc2NhcGUgYSBsZWFkaW5nIGRvbGxhciBzaWduIGZvciByZWdleCBjb25zdHJ1Y3Rpb25cbiAqL1xuZnVuY3Rpb24gZXNjYXBlRG9sbGFyICh2KSB7XG4gICAgcmV0dXJuIHYuY2hhckF0KDApID09PSAnJCdcbiAgICAgICAgPyAnXFxcXCcgKyB2XG4gICAgICAgIDogdlxufVxuXG4vKipcbiAqICBQYXJzZSBhbmQgcmV0dXJuIGFuIGFub255bW91cyBjb21wdXRlZCBwcm9wZXJ0eSBnZXR0ZXIgZnVuY3Rpb25cbiAqICBmcm9tIGFuIGFyYml0cmFyeSBleHByZXNzaW9uLCB0b2dldGhlciB3aXRoIGEgbGlzdCBvZiBwYXRocyB0byBiZVxuICogIGNyZWF0ZWQgYXMgYmluZGluZ3MuXG4gKi9cbmV4cG9ydHMucGFyc2UgPSBmdW5jdGlvbiAoZXhwLCBjb21waWxlciwgZGF0YSkge1xuICAgIC8vIHVuaWNvZGUgYW5kICdjb25zdHJ1Y3RvcicgYXJlIG5vdCBhbGxvd2VkIGZvciBYU1Mgc2VjdXJpdHkuXG4gICAgaWYgKFVOSUNPREVfUkUudGVzdChleHApIHx8IENUT1JfUkUudGVzdChleHApKSB7XG4gICAgICAgIHV0aWxzLndhcm4oJ1Vuc2FmZSBleHByZXNzaW9uOiAnICsgZXhwKVxuICAgICAgICByZXR1cm5cbiAgICB9XG4gICAgLy8gZXh0cmFjdCB2YXJpYWJsZSBuYW1lc1xuICAgIHZhciB2YXJzID0gZ2V0VmFyaWFibGVzKGV4cClcbiAgICBpZiAoIXZhcnMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiBtYWtlR2V0dGVyKCdyZXR1cm4gJyArIGV4cCwgZXhwKVxuICAgIH1cbiAgICB2YXJzID0gdXRpbHMuYXJyYXkudW5pcXVlKHZhcnMpO1xuXG4gICAgdmFyIGFjY2Vzc29ycyA9ICcnLFxuICAgICAgICBoYXMgICAgICAgPSB1dGlscy5oYXNoKCksXG4gICAgICAgIHN0cmluZ3MgICA9IFtdLFxuICAgICAgICAvLyBjb25zdHJ1Y3QgYSByZWdleCB0byBleHRyYWN0IGFsbCB2YWxpZCB2YXJpYWJsZSBwYXRoc1xuICAgICAgICAvLyBvbmVzIHRoYXQgYmVnaW4gd2l0aCBcIiRcIiBhcmUgcGFydGljdWxhcmx5IHRyaWNreVxuICAgICAgICAvLyBiZWNhdXNlIHdlIGNhbid0IHVzZSBcXGIgZm9yIHRoZW1cbiAgICAgICAgcGF0aFJFID0gbmV3IFJlZ0V4cChcbiAgICAgICAgICAgIFwiW14kXFxcXHdcXFxcLl0oXCIgK1xuICAgICAgICAgICAgdmFycy5tYXAoZXNjYXBlRG9sbGFyKS5qb2luKCd8JykgK1xuICAgICAgICAgICAgXCIpWyRcXFxcd1xcXFwuXSpcXFxcYlwiLCAnZydcbiAgICAgICAgKSxcbiAgICAgICAgYm9keSA9ICgnICcgKyBleHApXG4gICAgICAgICAgICAucmVwbGFjZShTVFJfU0FWRV9SRSwgc2F2ZVN0cmluZ3MpXG4gICAgICAgICAgICAucmVwbGFjZShwYXRoUkUsIHJlcGxhY2VQYXRoKVxuICAgICAgICAgICAgLnJlcGxhY2UoU1RSX1JFU1RPUkVfUkUsIHJlc3RvcmVTdHJpbmdzKVxuXG4gICAgYm9keSA9IGFjY2Vzc29ycyArICdyZXR1cm4gJyArIGJvZHlcblxuICAgIGZ1bmN0aW9uIHNhdmVTdHJpbmdzIChzdHIpIHtcbiAgICAgICAgdmFyIGkgPSBzdHJpbmdzLmxlbmd0aFxuICAgICAgICAvLyBlc2NhcGUgbmV3bGluZXMgaW4gc3RyaW5ncyBzbyB0aGUgZXhwcmVzc2lvblxuICAgICAgICAvLyBjYW4gYmUgY29ycmVjdGx5IGV2YWx1YXRlZFxuICAgICAgICBzdHJpbmdzW2ldID0gc3RyLnJlcGxhY2UoTkVXTElORV9SRSwgJ1xcXFxuJylcbiAgICAgICAgcmV0dXJuICdcIicgKyBpICsgJ1wiJ1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlcGxhY2VQYXRoIChwYXRoKSB7XG4gICAgICAgIC8vIGtlZXAgdHJhY2sgb2YgdGhlIGZpcnN0IGNoYXJcbiAgICAgICAgdmFyIGMgPSBwYXRoLmNoYXJBdCgwKVxuICAgICAgICBwYXRoID0gcGF0aC5zbGljZSgxKVxuICAgICAgICB2YXIgdmFsID0gJ3RoaXMuJyArIHRyYWNlU2NvcGUocGF0aCwgY29tcGlsZXIsIGRhdGEpICsgcGF0aFxuICAgICAgICBpZiAoIWhhc1twYXRoXSkge1xuICAgICAgICAgICAgYWNjZXNzb3JzICs9IHZhbCArICc7J1xuICAgICAgICAgICAgaGFzW3BhdGhdID0gMVxuICAgICAgICB9XG4gICAgICAgIC8vIGRvbid0IGZvcmdldCB0byBwdXQgdGhhdCBmaXJzdCBjaGFyIGJhY2tcbiAgICAgICAgcmV0dXJuIGMgKyB2YWxcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZXN0b3JlU3RyaW5ncyAoc3RyLCBpKSB7XG4gICAgICAgIHJldHVybiBzdHJpbmdzW2ldXG4gICAgfVxuXG4gICAgcmV0dXJuIG1ha2VHZXR0ZXIoYm9keSwgZXhwKVxufVxuXG4vKipcbiAqICBFdmFsdWF0ZSBhbiBleHByZXNzaW9uIGluIHRoZSBjb250ZXh0IG9mIGEgY29tcGlsZXIuXG4gKiAgQWNjZXB0cyBhZGRpdGlvbmFsIGRhdGEuXG4gKi9cbmV4cG9ydHMuZXZhbCA9IGZ1bmN0aW9uIChleHAsIGNvbXBpbGVyLCBkYXRhKSB7XG4gICAgdmFyIGdldHRlciA9IGV4cG9ydHMucGFyc2UoZXhwLCBjb21waWxlciwgZGF0YSksIHJlc1xuICAgIGlmIChnZXR0ZXIpIHtcbiAgICAgICAgLy8gaGFjazogdGVtcG9yYXJpbHkgYXR0YWNoIHRoZSBhZGRpdGlvbmFsIGRhdGEgc29cbiAgICAgICAgLy8gaXQgY2FuIGJlIGFjY2Vzc2VkIGluIHRoZSBnZXR0ZXJcbiAgICAgICAgY29tcGlsZXIudm0uJHRlbXAgPSBkYXRhXG4gICAgICAgIHJlcyA9IGdldHRlci5jYWxsKGNvbXBpbGVyLnZtKVxuICAgICAgICBkZWxldGUgY29tcGlsZXIudm0uJHRlbXBcbiAgICB9XG4gICAgcmV0dXJuIHJlc1xufSIsInZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKVxuXG5mdW5jdGlvbiBCYXRjaGVyICgpIHtcbiAgICB0aGlzLnJlc2V0KClcbn1cblxudmFyIEJhdGNoZXJQcm90byA9IEJhdGNoZXIucHJvdG90eXBlXG5cbkJhdGNoZXJQcm90by5wdXNoID0gZnVuY3Rpb24gKGpvYikge1xuICAgIGlmICgham9iLmlkIHx8ICF0aGlzLmhhc1tqb2IuaWRdKSB7XG4gICAgICAgIHRoaXMucXVldWUucHVzaChqb2IpXG4gICAgICAgIHRoaXMuaGFzW2pvYi5pZF0gPSBqb2JcbiAgICAgICAgaWYgKCF0aGlzLndhaXRpbmcpIHtcbiAgICAgICAgICAgIHRoaXMud2FpdGluZyA9IHRydWVcbiAgICAgICAgICAgIHV0aWxzLm5leHRUaWNrKHV0aWxzLm9iamVjdC5iaW5kKHRoaXMuZmx1c2gsIHRoaXMpKVxuICAgICAgICB9XG4gICAgfSBlbHNlIGlmIChqb2Iub3ZlcnJpZGUpIHtcbiAgICAgICAgdmFyIG9sZEpvYiA9IHRoaXMuaGFzW2pvYi5pZF1cbiAgICAgICAgb2xkSm9iLmNhbmNlbGxlZCA9IHRydWVcbiAgICAgICAgdGhpcy5xdWV1ZS5wdXNoKGpvYilcbiAgICAgICAgdGhpcy5oYXNbam9iLmlkXSA9IGpvYlxuICAgIH1cbn1cblxuQmF0Y2hlclByb3RvLmZsdXNoID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIGJlZm9yZSBmbHVzaCBob29rXG4gICAgaWYgKHRoaXMuX3ByZUZsdXNoKSB0aGlzLl9wcmVGbHVzaCgpXG4gICAgLy8gZG8gbm90IGNhY2hlIGxlbmd0aCBiZWNhdXNlIG1vcmUgam9icyBtaWdodCBiZSBwdXNoZWRcbiAgICAvLyBhcyB3ZSBleGVjdXRlIGV4aXN0aW5nIGpvYnNcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMucXVldWUubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIGpvYiA9IHRoaXMucXVldWVbaV1cbiAgICAgICAgaWYgKCFqb2IuY2FuY2VsbGVkKSB7XG4gICAgICAgICAgICBqb2IuZXhlY3V0ZSgpXG4gICAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5yZXNldCgpXG59XG5cbkJhdGNoZXJQcm90by5yZXNldCA9IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLmhhcyA9IHV0aWxzLm9iamVjdC5oYXNoKClcbiAgICB0aGlzLnF1ZXVlID0gW11cbiAgICB0aGlzLndhaXRpbmcgPSBmYWxzZVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEJhdGNoZXIiLCJ2YXIgQmF0Y2hlciAgICAgICAgPSByZXF1aXJlKCcuL2JhdGNoZXInKSxcbiAgICBiaW5kaW5nQmF0Y2hlciA9IG5ldyBCYXRjaGVyKCksXG4gICAgYmluZGluZ0lkICAgICAgPSAxXG5cbi8qKlxuICogIEJJTkRJTkcgQ0xBU1MuXG4gKlxuICogIEVBQ0ggUFJPUEVSVFkgT04gVEhFIFZJRVdNT0RFTCBIQVMgT05FIENPUlJFU1BPTkRJTkcgQklORElORyBPQkpFQ1RcbiAqICBXSElDSCBIQVMgTVVMVElQTEUgRElSRUNUSVZFIElOU1RBTkNFUyBPTiBUSEUgRE9NXG4gKiAgQU5EIE1VTFRJUExFIENPTVBVVEVEIFBST1BFUlRZIERFUEVOREVOVFNcbiAqL1xuZnVuY3Rpb24gQmluZGluZyAoY29tcGlsZXIsIGtleSwgaXNFeHAsIGlzRm4pIHtcbiAgICB0aGlzLmlkID0gYmluZGluZ0lkKytcbiAgICB0aGlzLnZhbHVlID0gdW5kZWZpbmVkXG4gICAgdGhpcy5pc0V4cCA9ICEhaXNFeHBcbiAgICB0aGlzLmlzRm4gPSBpc0ZuXG4gICAgdGhpcy5yb290ID0gIXRoaXMuaXNFeHAgJiYga2V5LmluZGV4T2YoJy4nKSA9PT0gLTFcbiAgICB0aGlzLmNvbXBpbGVyID0gY29tcGlsZXJcbiAgICB0aGlzLmtleSA9IGtleVxuICAgIHRoaXMuZGlycyA9IFtdXG4gICAgdGhpcy5zdWJzID0gW11cbiAgICB0aGlzLmRlcHMgPSBbXVxuICAgIHRoaXMudW5ib3VuZCA9IGZhbHNlXG59XG5cbnZhciBCaW5kaW5nUHJvdG8gPSBCaW5kaW5nLnByb3RvdHlwZVxuXG4vKipcbiAqICBVUERBVEUgVkFMVUUgQU5EIFFVRVVFIElOU1RBTkNFIFVQREFURVMuXG4gKi9cbkJpbmRpbmdQcm90by51cGRhdGUgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICBpZiAoIXRoaXMuaXNDb21wdXRlZCB8fCB0aGlzLmlzRm4pIHtcbiAgICAgICAgdGhpcy52YWx1ZSA9IHZhbHVlXG4gICAgfVxuICAgIGlmICh0aGlzLmRpcnMubGVuZ3RoIHx8IHRoaXMuc3Vicy5sZW5ndGgpIHtcbiAgICAgICAgdmFyIHNlbGYgPSB0aGlzXG4gICAgICAgIGJpbmRpbmdCYXRjaGVyLnB1c2goe1xuICAgICAgICAgICAgaWQ6IHRoaXMuaWQsXG4gICAgICAgICAgICBleGVjdXRlOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFzZWxmLnVuYm91bmQpIHtcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5fdXBkYXRlKClcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgfVxufVxuXG4vKipcbiAqICBBQ1RVQUxMWSBVUERBVEUgVEhFIERJUkVDVElWRVMuXG4gKi9cbkJpbmRpbmdQcm90by5fdXBkYXRlID0gZnVuY3Rpb24gKCkge1xuICAgIHZhciBpID0gdGhpcy5kaXJzLmxlbmd0aCxcbiAgICAgICAgdmFsdWUgPSB0aGlzLnZhbCgpXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICB0aGlzLmRpcnNbaV0uJHVwZGF0ZSh2YWx1ZSlcbiAgICB9XG4gICAgdGhpcy5wdWIoKVxufVxuXG4vKipcbiAqICBSRVRVUk4gVEhFIFZBTFVBVEVEIFZBTFVFIFJFR0FSRExFU1NcbiAqICBPRiBXSEVUSEVSIElUIElTIENPTVBVVEVEIE9SIE5PVFxuICovXG5CaW5kaW5nUHJvdG8udmFsID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmlzQ29tcHV0ZWQgJiYgIXRoaXMuaXNGblxuICAgICAgICA/IHRoaXMudmFsdWUuJGdldCgpXG4gICAgICAgIDogdGhpcy52YWx1ZTtcbn1cblxuLyoqXG4gKiAgTm90aWZ5IGNvbXB1dGVkIHByb3BlcnRpZXMgdGhhdCBkZXBlbmQgb24gdGhpcyBiaW5kaW5nXG4gKiAgdG8gdXBkYXRlIHRoZW1zZWx2ZXNcbiAqL1xuQmluZGluZ1Byb3RvLnB1YiA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgaSA9IHRoaXMuc3Vicy5sZW5ndGhcbiAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgIHRoaXMuc3Vic1tpXS51cGRhdGUoKTtcbiAgICB9XG59XG5cbi8qKlxuICogIFVuYmluZCB0aGUgYmluZGluZywgcmVtb3ZlIGl0c2VsZiBmcm9tIGFsbCBvZiBpdHMgZGVwZW5kZW5jaWVzXG4gKi9cbkJpbmRpbmdQcm90by51bmJpbmQgPSBmdW5jdGlvbiAoKSB7XG4gICAgLy8gSW5kaWNhdGUgdGhpcyBoYXMgYmVlbiB1bmJvdW5kLlxuICAgIC8vIEl0J3MgcG9zc2libGUgdGhpcyBiaW5kaW5nIHdpbGwgYmUgaW5cbiAgICAvLyB0aGUgYmF0Y2hlcidzIGZsdXNoIHF1ZXVlIHdoZW4gaXRzIG93bmVyXG4gICAgLy8gY29tcGlsZXIgaGFzIGFscmVhZHkgYmVlbiBkZXN0cm95ZWQuXG4gICAgdGhpcy51bmJvdW5kID0gdHJ1ZVxuICAgIHZhciBpID0gdGhpcy5kaXJzLmxlbmd0aFxuICAgIHdoaWxlIChpLS0pIHtcbiAgICAgICAgdGhpcy5kaXJzW2ldLiR1bmJpbmQoKVxuICAgIH1cbiAgICBpID0gdGhpcy5kZXBzLmxlbmd0aFxuICAgIHZhciBzdWJzXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICBzdWJzID0gdGhpcy5kZXBzW2ldLnN1YnNcbiAgICAgICAgdmFyIGogPSBzdWJzLmluZGV4T2YodGhpcylcbiAgICAgICAgaWYgKGogPiAtMSkgc3Vicy5zcGxpY2UoaiwgMSlcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gQmluZGluZyIsIlxudmFyIEV2ZW50VGFyZ2V0ID0gcmVxdWlyZSgnLi9ldmVudFRhcmdldCcpLFxuXHR1dGlscyAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcblx0Y29uZmlnICAgICAgPSByZXF1aXJlKCcuL2NvbmZpZycpLFxuXHRCaW5kaW5nICAgICA9IHJlcXVpcmUoJy4vYmluZGluZycpLFxuXHRQYXJzZXIgICAgICA9IHJlcXVpcmUoJy4vcGFyc2VyJyksXG5cdE9ic2VydmVyICAgID0gcmVxdWlyZSgnLi9vYnNlcnZlcicpLFxuXHREaXJlY3RpdmUgICA9IHJlcXVpcmUoJy4vZGlyZWN0aXZlcycpLFxuXHRUZXh0UGFyc2VyICA9IFBhcnNlci5UZXh0UGFyc2VyLFxuXHRFeHBQYXJzZXIgICA9IFBhcnNlci5FeHBQYXJzZXIsXG5cdFZpZXdNb2RlbCxcbiAgICBcbiAgICAvLyBDQUNIRSBNRVRIT0RTXG4gICAgc2xpY2UgICAgICAgPSBbXS5zbGljZSxcbiAgICBoYXNPd24gICAgICA9ICh7fSkuaGFzT3duUHJvcGVydHksXG4gICAgZGVmICAgICAgICAgPSBPYmplY3QuZGVmaW5lUHJvcGVydHksXG5cbiAgICAvLyBIT09LUyBUTyBSRUdJU1RFUlxuICAgIGhvb2tzICAgICAgID0gWydjcmVhdGVkJywgJ3JlYWR5JywgJ2JlZm9yZURlc3Ryb3knLCAnYWZ0ZXJEZXN0cm95JywgJ2F0dGFjaGVkJywgJ2RldGFjaGVkJ10sXG5cbiAgICAvLyBMSVNUIE9GIFBSSU9SSVRZIERJUkVDVElWRVNcbiAgICAvLyBUSEFUIE5FRURTIFRPIEJFIENIRUNLRUQgSU4gU1BFQ0lGSUMgT1JERVJcbiAgICBwcmlvcml0eURpcmVjdGl2ZXMgPSBbJ2lmJywgJ3JlcGVhdCcsICd2aWV3JywgJ2NvbXBvbmVudCddO1xuXG4vKipcbiAqICBUSEUgRE9NIENPTVBJTEVSXG4gKiAgU0NBTlMgQSBET00gTk9ERSBBTkQgQ09NUElMRSBCSU5ESU5HUyBGT1IgQSBWSUVXTU9ERUxcbiAqL1xuZnVuY3Rpb24gQ29tcGlsZXIodm0sIG9wdGlvbnMpe1xuXHR0aGlzLl9pbml0ZWQgICAgPSB0cnVlO1xuXHR0aGlzLl9kZXN0cm95ZWQgPSBmYWxzZTtcblx0dXRpbHMubWl4KHRoaXMsIG9wdGlvbnMuY29tcGlsZXJPcHRpb25zKTtcblx0Ly8gUkVQRUFUIElORElDQVRFUyBUSElTIElTIEEgVi1SRVBFQVQgSU5TVEFOQ0Vcblx0dGhpcy5yZXBlYXQgPSB0aGlzLnJlcGVhdCB8fCBmYWxzZTtcbiAgICAvLyBFWFBDQUNIRSBXSUxMIEJFIFNIQVJFRCBCRVRXRUVOIFYtUkVQRUFUIElOU1RBTkNFU1xuXHR0aGlzLmV4cENhY2hlID0gdGhpcy5leHBDYWNoZSB8fCB7fTtcblxuXHQvLy0tSU5USUFMSVpBVElPTiBTVFVGRlxuXHR0aGlzLnZtID0gdm07XG5cdHRoaXMub3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG5cdHRoaXMuX2luaXRPcHRpb25zKCk7XG4gXHR0aGlzLl9pbml0RWxlbWVudCgpO1xuXHR0aGlzLl9pbml0Vk0oKTtcblx0dGhpcy5faW5pdERhdGEoKTtcblx0dGhpcy5fc3RhcnRDb21waWxlKCk7XG59XG5cbi8qKlxuICogaW5pdGlhbGl6YXRpb24gYW5kIGRlc3Ryb3lcbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHRfaW5pdE9wdGlvbnM6IGZ1bmN0aW9uKCl7XG5cdFx0dmFyIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnNcblx0XHR2YXIgY29tcG9uZW50cyA9IG9wdGlvbnMuY29tcG9uZW50cyxcbiAgICAgICAgICAgIHBhcnRpYWxzICAgPSBvcHRpb25zLnBhcnRpYWxzLFxuICAgICAgICAgICAgdGVtcGxhdGUgICA9IG9wdGlvbnMudGVtcGxhdGUsXG4gICAgICAgICAgICBmaWx0ZXJzICAgID0gb3B0aW9ucy5maWx0ZXJzLFxuICAgICAgICAgICAga2V5O1xuXG4gICAgICAgIGlmIChjb21wb25lbnRzKSB7XG4gICAgICAgICAgICBmb3IgKGtleSBpbiBjb21wb25lbnRzKSB7XG4gICAgICAgICAgICAgICAgY29tcG9uZW50c1trZXldID0gVmlld01vZGVsLmV4dGVuZChjb21wb25lbnRzW2tleV0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChwYXJ0aWFscykge1xuICAgICAgICAgICAgZm9yIChrZXkgaW4gcGFydGlhbHMpIHtcbiAgICAgICAgICAgICAgICBwYXJ0aWFsc1trZXldID0gUGFyc2VyLnBhcnNlclRlbXBsYXRlKHBhcnRpYWxzW2tleV0pXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgZmlsdGVyLCBUSElTX1JFID0gL1teXFx3XXRoaXNbXlxcd10vO1xuICAgICAgICBpZiAoZmlsdGVycykge1xuICAgICAgICAgICAgZm9yIChrZXkgaW4gZmlsdGVycykge1xuICAgICAgICAgICAgXHRmaWx0ZXIgPSBmaWx0ZXJzW2tleV07XG4gICAgICAgICAgICBcdGlmIChUSElTX1JFLnRlc3QoZmlsdGVyLnRvU3RyaW5nKCkpKSB7XG5cdFx0ICAgICAgICAgICAgZmlsdGVyLmNvbXB1dGVkID0gdHJ1ZTtcblx0XHQgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0ZW1wbGF0ZSkge1xuICAgICAgICAgICAgb3B0aW9ucy50ZW1wbGF0ZSA9IFBhcnNlci5wYXJzZXJUZW1wbGF0ZSh0ZW1wbGF0ZSlcbiAgICAgICAgfVxuXHR9LFxuXHRfaW5pdEVsZW1lbnQ6IGZ1bmN0aW9uKCl7XG5cdFx0dmFyIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnMsXG5cdFx0XHR2bSAgICAgID0gdGhpcy52bSxcblx0ICAgIFx0dGVtcGxhdGUgPSBvcHRpb25zLnRlbXBsYXRlLCBcblx0ICAgIFx0ZWw7XG5cblx0XHRpbml0RWwoKTtcblx0ICAgIHJlc29sdmVUZW1wbGF0ZSgpO1xuXHQgICAgcmVzb2x2ZUVsZW1lbnRPcHRpb24oKTtcblxuXHQgICAgdGhpcy5lbCA9IGVsOyBcblx0XHR0aGlzLmVsLl92bSA9IHZtO1xuXHRcdHV0aWxzLmxvZygnbmV3IFZNIGluc3RhbmNlOiAnICsgZWwudGFnTmFtZSArICdcXG4nKTtcblx0XHRcblx0XHQvLyBDUkVBVEUgVEhFIE5PREUgRklSU1Rcblx0XHRmdW5jdGlvbiBpbml0RWwoKXtcblx0XHRcdGVsID0gdHlwZW9mIG9wdGlvbnMuZWwgPT09ICdzdHJpbmcnXG5cdCAgICAgICAgPyBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKG9wdGlvbnMuZWwpXG5cdCAgICAgICAgOiBvcHRpb25zLmVsIHx8IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQob3B0aW9ucy50YWdOYW1lIHx8ICdkaXYnKTtcblx0XHR9XG5cblx0ICAgIGZ1bmN0aW9uIHJlc29sdmVUZW1wbGF0ZSgpe1xuXHQgICAgXHR2YXIgY2hpbGQsIHJlcGxhY2VyLCBpO1xuXHQgICAgXHQvLyBURU1QTEFURSBJUyBBIEZSQUdNRU5UIERPQ1VNRU5UXG5cdFx0ICAgIGlmKHRlbXBsYXRlKXtcblx0XHQgICAgXHQvLyBDT0xMRUNUIEFOWVRISU5HIEFMUkVBRFkgSU4gVEhFUkVcblx0XHQgICAgICAgIGlmIChlbC5oYXNDaGlsZE5vZGVzKCkpIHtcblx0XHQgICAgICAgICAgICB0aGlzLnJhd0NvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKVxuXHRcdCAgICAgICAgICAgIHdoaWxlIChjaGlsZCA9IGVsLmZpcnN0Q2hpbGQpIHtcblx0XHQgICAgICAgICAgICAgICAgdGhpcy5yYXdDb250ZW50LmFwcGVuZENoaWxkKGNoaWxkKVxuXHRcdCAgICAgICAgICAgIH1cblx0XHQgICAgICAgIH1cblx0XHQgICAgICAgIC8vIFJFUExBQ0UgT1BUSU9OOiBVU0UgVEhFIEZJUlNUIE5PREUgSU5cblx0XHQgICAgICAgIC8vIFRIRSBURU1QTEFURSBESVJFQ1RMWSBUTyBSRVBMQUNFIEVMXG5cdFx0ICAgICAgICBpZiAob3B0aW9ucy5yZXBsYWNlICYmIHRlbXBsYXRlLmZpcnN0Q2hpbGQgPT09IHRlbXBsYXRlLmxhc3RDaGlsZCkge1xuXHRcdCAgICAgICAgICAgIHJlcGxhY2VyID0gdGVtcGxhdGUuZmlyc3RDaGlsZC5jbG9uZU5vZGUodHJ1ZSlcblx0XHQgICAgICAgICAgICBpZiAoZWwucGFyZW50Tm9kZSkge1xuXHRcdCAgICAgICAgICAgICAgICBlbC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShyZXBsYWNlciwgZWwpXG5cdFx0ICAgICAgICAgICAgICAgIGVsLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQoZWwpXG5cdFx0ICAgICAgICAgICAgfVxuXHRcdCAgICAgICAgICAgIC8vIENPUFkgT1ZFUiBBVFRSSUJVVEVTXG5cdFx0ICAgICAgICAgICAgaWYgKGVsLmhhc0F0dHJpYnV0ZXMoKSkge1xuXHRcdCAgICAgICAgICAgICAgICBpID0gZWwuYXR0cmlidXRlcy5sZW5ndGhcblx0XHQgICAgICAgICAgICAgICAgd2hpbGUgKGktLSkge1xuXHRcdCAgICAgICAgICAgICAgICAgICAgYXR0ciA9IGVsLmF0dHJpYnV0ZXNbaV1cblx0XHQgICAgICAgICAgICAgICAgICAgIHJlcGxhY2VyLnNldEF0dHJpYnV0ZShhdHRyLm5hbWUsIGF0dHIudmFsdWUpXG5cdFx0ICAgICAgICAgICAgICAgIH1cblx0XHQgICAgICAgICAgICB9XG5cdFx0ICAgICAgICAgICAgLy8gUkVQTEFDRVxuXHRcdCAgICAgICAgICAgIGVsID0gcmVwbGFjZXJcblx0XHQgICAgICAgIH0gZWxzZSB7XG5cdFx0ICAgICAgICAgICAgZWwuYXBwZW5kQ2hpbGQodGVtcGxhdGUuY2xvbmVOb2RlKHRydWUpKVxuXHRcdCAgICAgICAgfVxuXHRcdCAgICB9XG5cdCAgICB9XG5cblx0ICAgIGZ1bmN0aW9uIHJlc29sdmVFbGVtZW50T3B0aW9uKCl7XG5cdCAgICBcdHZhciBhdHRycywgYXR0cjtcblx0XHRcdC8vIEFQUExZIEVMRU1FTlQgT1BUSU9OU1xuXHRcdCAgICBpZiAob3B0aW9ucy5pZCkgZWwuaWQgPSBvcHRpb25zLmlkXG5cdFx0ICAgIGlmIChvcHRpb25zLmNsYXNzTmFtZSkgZWwuY2xhc3NOYW1lID0gb3B0aW9ucy5jbGFzc05hbWVcblx0XHQgICAgYXR0cnMgPSBvcHRpb25zLmF0dHJpYnV0ZXNcblx0XHQgICAgaWYgKGF0dHJzKSB7XG5cdFx0ICAgICAgICBmb3IgKGF0dHIgaW4gYXR0cnMpIHtcblx0XHQgICAgICAgICAgICBlbC5zZXRBdHRyaWJ1dGUoYXR0ciwgYXR0cnNbYXR0cl0pXG5cdFx0ICAgICAgICB9XG5cdFx0ICAgIH1cblx0XHR9XG5cdH0sXG5cdF9pbml0Vk06IGZ1bmN0aW9uKCl7XG5cdFx0dmFyIG9wdGlvbnMgID0gdGhpcy5vcHRpb25zLFxuXHRcdFx0Y29tcGlsZXIgPSB0aGlzO1xuXHRcdFx0dm0gICAgICAgPSB0aGlzLnZtO1xuXG5cdFx0Ly8gQ09NUElMRVIgXG5cdFx0dXRpbHMubWl4KHRoaXMsIHtcblx0XHRcdHZtOiB2bSxcblx0XHRcdGJpbmRpbmdzOiB1dGlscy5oYXNoKCksXG5cdFx0XHRkaXJzOiBbXSxcblx0XHRcdGRlZmVycmVkOiBbXSxcblx0XHRcdGNvbXB1dGVkOiBbXSxcblx0XHRcdGNoaWxkcmVuOiBbXSxcblx0XHRcdGVtaXR0ZXI6IG5ldyBFdmVudFRhcmdldCgpXG5cdFx0fSk7XG5cblx0XHQvLyBDT01QSUxFUi5WTSBcblx0XHR1dGlscy5taXgodm0sIHtcblx0XHRcdCckJzoge30sXG5cdFx0XHQnJGVsJzogdGhpcy5lbCxcblx0XHRcdCckb3B0aW9ucyc6IG9wdGlvbnMsXG5cdFx0XHQnJGNvbXBpbGVyJzogY29tcGlsZXIsXG5cdFx0XHQnJGV2ZW50JzogbnVsbFxuXHRcdH0pO1xuXG5cdFx0Ly8gUEFSRU5UIFZNXG5cdFx0dmFyIHBhcmVudFZNID0gb3B0aW9ucy5wYXJlbnQ7XG5cdFx0aWYgKHBhcmVudFZNKSB7XG5cdFx0XHR0aGlzLnBhcmVudCA9IHBhcmVudFZNLiRjb21waWxlcjtcblx0XHRcdHBhcmVudFZNLiRjb21waWxlci5jaGlsZHJlbi5wdXNoKHRoaXMpO1xuXHRcdFx0dm0uJHBhcmVudCA9IHBhcmVudFZNO1xuXHRcdFx0Ly8gSU5IRVJJVCBMQVpZIE9QVElPTlxuXHQgICAgICAgIGlmICghKCdsYXp5JyBpbiBvcHRpb25zKSkge1xuXHQgICAgICAgICAgICBvcHRpb25zLmxhenkgPSB0aGlzLnBhcmVudC5vcHRpb25zLmxhenk7XG5cdCAgICAgICAgfVxuXHRcdH1cblx0XHR2bS4kcm9vdCA9IGdldFJvb3QodGhpcykudm07XG5cdFx0ZnVuY3Rpb24gZ2V0Um9vdCAoY29tcGlsZXIpIHtcblx0XHQgICAgd2hpbGUgKGNvbXBpbGVyLnBhcmVudCkge1xuXHRcdCAgICAgICAgY29tcGlsZXIgPSBjb21waWxlci5wYXJlbnQ7XG5cdFx0ICAgIH1cblx0XHQgICAgcmV0dXJuIGNvbXBpbGVyO1xuXHRcdH1cblx0fSxcblx0X2luaXREYXRhOiBmdW5jdGlvbigpe1xuXHRcdHZhciBvcHRpb25zICA9IHRoaXMub3B0aW9ucyxcblx0XHRcdGNvbXBpbGVyID0gdGhpcyxcblx0XHRcdHZtICAgICAgID0gdGhpcy52bTtcblx0XHQvLyBTRVRVUCBPQlNFUlZFUlxuXHQgICAgLy8gVEhJUyBJUyBORUNFU0FSUlkgRk9SIEFMTCBIT09LUyBBTkQgREFUQSBPQlNFUlZBVElPTiBFVkVOVFNcblx0XHRjb21waWxlci5zZXR1cE9ic2VydmVyKCk7XG5cdFx0Ly8gQ1JFQVRFIEJJTkRJTkdTIEZPUiBDT01QVVRFRCBQUk9QRVJUSUVTXG5cdCAgICBpZiAob3B0aW9ucy5tZXRob2RzKSB7XG5cdCAgICAgICAgZm9yIChrZXkgaW4gb3B0aW9ucy5tZXRob2RzKSB7XG5cdCAgICAgICAgICAgIGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcoa2V5KVxuXHQgICAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgLy8gQ1JFQVRFIEJJTkRJTkdTIEZPUiBNRVRIT0RTXG5cdCAgICBpZiAob3B0aW9ucy5jb21wdXRlZCkge1xuXHQgICAgICAgIGZvciAoa2V5IGluIG9wdGlvbnMuY29tcHV0ZWQpIHtcblx0ICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhrZXkpXG5cdCAgICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICAvLyBJTklUSUFMSVpFIERBVEFcblx0ICAgIHZhciBkYXRhID0gY29tcGlsZXIuZGF0YSA9IG9wdGlvbnMuZGF0YSB8fCB7fSxcblx0ICAgICAgICBkZWZhdWx0RGF0YSA9IG9wdGlvbnMuZGVmYXVsdERhdGFcblx0ICAgIGlmIChkZWZhdWx0RGF0YSkge1xuXHQgICAgICAgIGZvciAoa2V5IGluIGRlZmF1bHREYXRhKSB7XG5cdCAgICAgICAgICAgIGlmICghaGFzT3duLmNhbGwoZGF0YSwga2V5KSkge1xuXHQgICAgICAgICAgICAgICAgZGF0YVtrZXldID0gZGVmYXVsdERhdGFba2V5XVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICAvLyBDT1BZIFBBUkFNQVRUUklCVVRFU1xuXHQgICAgLy8gdmFyIHBhcmFtcyA9IG9wdGlvbnMucGFyYW1BdHRyaWJ1dGVzXG5cdCAgICAvLyBpZiAocGFyYW1zKSB7XG5cdCAgICAvLyAgICAgaSA9IHBhcmFtcy5sZW5ndGhcblx0ICAgIC8vICAgICB3aGlsZSAoaS0tKSB7XG5cdCAgICAvLyAgICAgICAgIGRhdGFbcGFyYW1zW2ldXSA9IHV0aWxzLmNoZWNrTnVtYmVyKFxuXHQgICAgLy8gICAgICAgICAgICAgY29tcGlsZXIuZXZhbChcblx0ICAgIC8vICAgICAgICAgICAgICAgICBlbC5nZXRBdHRyaWJ1dGUocGFyYW1zW2ldKVxuXHQgICAgLy8gICAgICAgICAgICAgKVxuXHQgICAgLy8gICAgICAgICApXG5cdCAgICAvLyAgICAgfVxuXHQgICAgLy8gfVxuXG5cdCAgICB1dGlscy5taXgodm0sIGRhdGEpO1xuXHQgICAgdm0uJGRhdGEgPSBkYXRhO1xuXG5cdCAgICAvLyBiZWZvcmVDb21waWxlIGhvb2tcblx0ICAgIGNvbXBpbGVyLmV4ZWNIb29rKCdjcmVhdGVkJyk7XG5cblx0ICAgIC8vIFRIRSBVU0VSIE1JR0hUIEhBVkUgU1dBUFBFRCBUSEUgREFUQSAuLi5cblx0ICAgIGRhdGEgPSBjb21waWxlci5kYXRhID0gdm0uJGRhdGE7XG5cdCAgICAvLyBVU0VSIE1JR0hUIEFMU08gU0VUIFNPTUUgUFJPUEVSVElFUyBPTiBUSEUgVk1cblx0ICAgIC8vIElOIFdISUNIIENBU0UgV0UgU0hPVUxEIENPUFkgQkFDSyBUTyAkREFUQVxuXHQgICAgdmFyIHZtUHJvcFxuXHQgICAgZm9yIChrZXkgaW4gdm0pIHtcblx0ICAgICAgICB2bVByb3AgPSB2bVtrZXldXG5cdCAgICAgICAgaWYgKFxuXHQgICAgICAgICAgICBrZXkuY2hhckF0KDApICE9PSAnJCcgJiZcblx0ICAgICAgICAgICAgZGF0YVtrZXldICE9PSB2bVByb3AgJiZcblx0ICAgICAgICAgICAgdHlwZW9mIHZtUHJvcCAhPT0gJ2Z1bmN0aW9uJ1xuXHQgICAgICAgICkge1xuXHQgICAgICAgICAgICBkYXRhW2tleV0gPSB2bVByb3A7XG5cdCAgICAgICAgfVxuXHQgICAgfVxuXG5cdCAgICAvLyBOT1cgV0UgQ0FOIE9CU0VSVkUgVEhFIERBVEEuXG5cdCAgICAvLyBUSElTIFdJTEwgQ09OVkVSVCBEQVRBIFBST1BFUlRJRVMgVE8gR0VUVEVSL1NFVFRFUlNcblx0ICAgIC8vIEFORCBFTUlUIFRIRSBGSVJTVCBCQVRDSCBPRiBTRVQgRVZFTlRTLCBXSElDSCBXSUxMXG5cdCAgICAvLyBJTiBUVVJOIENSRUFURSBUSEUgQ09SUkVTUE9ORElORyBCSU5ESU5HUy5cblx0ICAgIGNvbXBpbGVyLm9ic2VydmVEYXRhKGRhdGEpXG5cdCAgICB1dGlscy5sb2coY29tcGlsZXIpO1xuXHR9LFxuXHRfc3RhcnRDb21waWxlOiBmdW5jdGlvbigpe1xuXHRcdHZhciBvcHRpb25zID0gdGhpcy5vcHRpb25zLFxuXHRcdFx0Y29tcGlsZXIgPSB0aGlzLFxuXHRcdFx0ZWwgPSB0aGlzLmVsO1xuXHQgICAgLy8gYmVmb3JlIGNvbXBpbGluZywgcmVzb2x2ZSBjb250ZW50IGluc2VydGlvbiBwb2ludHNcblx0ICAgIGlmIChvcHRpb25zLnRlbXBsYXRlKSB7XG5cdCAgICAgICAgdGhpcy5yZXNvbHZlQ29udGVudCgpO1xuXHQgICAgfVxuXG5cdCAgICAvLyBub3cgcGFyc2UgdGhlIERPTSBhbmQgYmluZCBkaXJlY3RpdmVzLlxuXHQgICAgLy8gRHVyaW5nIHRoaXMgc3RhZ2UsIHdlIHdpbGwgYWxzbyBjcmVhdGUgYmluZGluZ3MgZm9yXG5cdCAgICAvLyBlbmNvdW50ZXJlZCBrZXlwYXRocyB0aGF0IGRvbid0IGhhdmUgYSBiaW5kaW5nIHlldC5cblx0ICAgIGNvbXBpbGVyLmNvbXBpbGUoZWwsIHRydWUpXG5cblx0ICAgIC8vIEFueSBkaXJlY3RpdmUgdGhhdCBjcmVhdGVzIGNoaWxkIFZNcyBhcmUgZGVmZXJyZWRcblx0ICAgIC8vIHNvIHRoYXQgd2hlbiB0aGV5IGFyZSBjb21waWxlZCwgYWxsIGJpbmRpbmdzIG9uIHRoZVxuXHQgICAgLy8gcGFyZW50IFZNIGhhdmUgYmVlbiBjcmVhdGVkLlxuXHQgICAgaSA9IGNvbXBpbGVyLmRlZmVycmVkLmxlbmd0aFxuXHQgICAgd2hpbGUgKGktLSkge1xuXHQgICAgICAgIGNvbXBpbGVyLmJpbmREaXJlY3RpdmUoY29tcGlsZXIuZGVmZXJyZWRbaV0pXG5cdCAgICB9XG5cdCAgICBjb21waWxlci5kZWZlcnJlZCA9IG51bGxcblxuXHQgICAgLy8gZXh0cmFjdCBkZXBlbmRlbmNpZXMgZm9yIGNvbXB1dGVkIHByb3BlcnRpZXMuXG5cdCAgICAvLyB0aGlzIHdpbGwgZXZhbHVhdGVkIGFsbCBjb2xsZWN0ZWQgY29tcHV0ZWQgYmluZGluZ3Ncblx0ICAgIC8vIGFuZCBjb2xsZWN0IGdldCBldmVudHMgdGhhdCBhcmUgZW1pdHRlZC5cblx0ICAgIGlmICh0aGlzLmNvbXB1dGVkLmxlbmd0aCkge1xuXHQgICAgICAgIERlcHNQYXJzZXIucGFyc2UodGhpcy5jb21wdXRlZClcblx0ICAgIH1cblxuXHQgICAgLy8gZG9uZSFcblx0ICAgIGNvbXBpbGVyLmluaXQgPSBmYWxzZVxuXG5cdCAgICAvLyBwb3N0IGNvbXBpbGUgLyByZWFkeSBob29rXG5cdCAgICBjb21waWxlci5leGVjSG9vaygncmVhZHknKTtcblx0fSxcblx0ZGVzdHJveTogZnVuY3Rpb24gKG5vUmVtb3ZlKSB7XG5cblx0ICAgIC8vIGF2b2lkIGJlaW5nIGNhbGxlZCBtb3JlIHRoYW4gb25jZVxuXHQgICAgLy8gdGhpcyBpcyBpcnJldmVyc2libGUhXG5cdCAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuXG5cdCAgICB2YXIgY29tcGlsZXIgPSB0aGlzLFxuXHQgICAgICAgIGksIGosIGtleSwgZGlyLCBkaXJzLCBiaW5kaW5nLFxuXHQgICAgICAgIHZtICAgICAgICAgID0gY29tcGlsZXIudm0sXG5cdCAgICAgICAgZWwgICAgICAgICAgPSBjb21waWxlci5lbCxcblx0ICAgICAgICBkaXJlY3RpdmVzICA9IGNvbXBpbGVyLmRpcnMsXG5cdCAgICAgICAgY29tcHV0ZWQgICAgPSBjb21waWxlci5jb21wdXRlZCxcblx0ICAgICAgICBiaW5kaW5ncyAgICA9IGNvbXBpbGVyLmJpbmRpbmdzLFxuXHQgICAgICAgIGNoaWxkcmVuICAgID0gY29tcGlsZXIuY2hpbGRyZW4sXG5cdCAgICAgICAgcGFyZW50ICAgICAgPSBjb21waWxlci5wYXJlbnRcblxuXHQgICAgY29tcGlsZXIuZXhlY0hvb2soJ2JlZm9yZURlc3Ryb3knKVxuXG5cdCAgICAvLyB1bm9ic2VydmUgZGF0YVxuXHQgICAgT2JzZXJ2ZXIudW5vYnNlcnZlKGNvbXBpbGVyLmRhdGEsICcnLCBjb21waWxlci5vYnNlcnZlcilcblxuXHQgICAgLy8gZGVzdHJveSBhbGwgY2hpbGRyZW5cblx0ICAgIC8vIGRvIG5vdCByZW1vdmUgdGhlaXIgZWxlbWVudHMgc2luY2UgdGhlIHBhcmVudFxuXHQgICAgLy8gbWF5IGhhdmUgdHJhbnNpdGlvbnMgYW5kIHRoZSBjaGlsZHJlbiBtYXkgbm90XG5cdCAgICBpID0gY2hpbGRyZW4ubGVuZ3RoXG5cdCAgICB3aGlsZSAoaS0tKSB7XG5cdCAgICAgICAgY2hpbGRyZW5baV0uZGVzdHJveSh0cnVlKVxuXHQgICAgfVxuXG5cdCAgICAvLyB1bmJpbmQgYWxsIGRpcmVjaXR2ZXNcblx0ICAgIGkgPSBkaXJlY3RpdmVzLmxlbmd0aFxuXHQgICAgd2hpbGUgKGktLSkge1xuXHQgICAgICAgIGRpciA9IGRpcmVjdGl2ZXNbaV1cblx0ICAgICAgICAvLyBpZiB0aGlzIGRpcmVjdGl2ZSBpcyBhbiBpbnN0YW5jZSBvZiBhbiBleHRlcm5hbCBiaW5kaW5nXG5cdCAgICAgICAgLy8gZS5nLiBhIGRpcmVjdGl2ZSB0aGF0IHJlZmVycyB0byBhIHZhcmlhYmxlIG9uIHRoZSBwYXJlbnQgVk1cblx0ICAgICAgICAvLyB3ZSBuZWVkIHRvIHJlbW92ZSBpdCBmcm9tIHRoYXQgYmluZGluZydzIGRpcmVjdGl2ZXNcblx0ICAgICAgICAvLyAqIGVtcHR5IGFuZCBsaXRlcmFsIGJpbmRpbmdzIGRvIG5vdCBoYXZlIGJpbmRpbmcuXG5cdCAgICAgICAgaWYgKGRpci5iaW5kaW5nICYmIGRpci5iaW5kaW5nLmNvbXBpbGVyICE9PSBjb21waWxlcikge1xuXHQgICAgICAgICAgICBkaXJzID0gZGlyLmJpbmRpbmcuZGlyc1xuXHQgICAgICAgICAgICBpZiAoZGlycykge1xuXHQgICAgICAgICAgICAgICAgaiA9IGRpcnMuaW5kZXhPZihkaXIpXG5cdCAgICAgICAgICAgICAgICBpZiAoaiA+IC0xKSBkaXJzLnNwbGljZShqLCAxKVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfVxuXHQgICAgICAgIGRpci4kdW5iaW5kKClcblx0ICAgIH1cblxuXHQgICAgLy8gdW5iaW5kIGFsbCBjb21wdXRlZCwgYW5vbnltb3VzIGJpbmRpbmdzXG5cdCAgICBpID0gY29tcHV0ZWQubGVuZ3RoXG5cdCAgICB3aGlsZSAoaS0tKSB7XG5cdCAgICAgICAgY29tcHV0ZWRbaV0udW5iaW5kKClcblx0ICAgIH1cblxuXHQgICAgLy8gdW5iaW5kIGFsbCBrZXlwYXRoIGJpbmRpbmdzXG5cdCAgICBmb3IgKGtleSBpbiBiaW5kaW5ncykge1xuXHQgICAgICAgIGJpbmRpbmcgPSBiaW5kaW5nc1trZXldXG5cdCAgICAgICAgaWYgKGJpbmRpbmcpIHtcblx0ICAgICAgICAgICAgYmluZGluZy51bmJpbmQoKVxuXHQgICAgICAgIH1cblx0ICAgIH1cblxuXHQgICAgLy8gcmVtb3ZlIHNlbGYgZnJvbSBwYXJlbnRcblx0ICAgIGlmIChwYXJlbnQpIHtcblx0ICAgICAgICBqID0gcGFyZW50LmNoaWxkcmVuLmluZGV4T2YoY29tcGlsZXIpXG5cdCAgICAgICAgaWYgKGogPiAtMSkgcGFyZW50LmNoaWxkcmVuLnNwbGljZShqLCAxKVxuXHQgICAgfVxuXG5cdCAgICAvLyBmaW5hbGx5IHJlbW92ZSBkb20gZWxlbWVudFxuXHQgICAgaWYgKCFub1JlbW92ZSkge1xuXHQgICAgICAgIGlmIChlbCA9PT0gZG9jdW1lbnQuYm9keSkge1xuXHQgICAgICAgICAgICBlbC5pbm5lckhUTUwgPSAnJ1xuXHQgICAgICAgIH0gZWxzZSB7XG5cdCAgICAgICAgICAgIHZtLiRyZW1vdmUoKVxuXHQgICAgICAgIH1cblx0ICAgIH1cblx0ICAgIGVsLnZ1ZV92bSA9IG51bGxcblxuXHQgICAgY29tcGlsZXIuZGVzdHJveWVkID0gdHJ1ZVxuXHQgICAgLy8gZW1pdCBkZXN0cm95IGhvb2tcblx0ICAgIGNvbXBpbGVyLmV4ZWNIb29rKCdhZnRlckRlc3Ryb3knKVxuXG5cdCAgICAvLyBmaW5hbGx5LCB1bnJlZ2lzdGVyIGFsbCBsaXN0ZW5lcnNcblx0ICAgIGNvbXBpbGVyLm9ic2VydmVyLm9mZigpXG5cdCAgICBjb21waWxlci5lbWl0dGVyLm9mZigpO1xuXHR9XG59KTtcbi8qKlxuICogb2JzZXJ2YXRpb25cbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHRzZXR1cE9ic2VydmVyOiBmdW5jdGlvbigpe1xuXHRcdHZhciBjb21waWxlciA9IHRoaXMsXG5cdCAgICAgICAgYmluZGluZ3MgPSBjb21waWxlci5iaW5kaW5ncyxcblx0ICAgICAgICBvcHRpb25zICA9IGNvbXBpbGVyLm9wdGlvbnMsXG5cdCAgICAgICAgb2JzZXJ2ZXIgPSBjb21waWxlci5vYnNlcnZlciA9IG5ldyBFdmVudFRhcmdldChjb21waWxlci52bSk7XG5cblx0ICAgIC8vIEEgSEFTSCBUTyBIT0xEIEVWRU5UIFBST1hJRVMgRk9SIEVBQ0ggUk9PVCBMRVZFTCBLRVlcblx0ICAgIC8vIFNPIFRIRVkgQ0FOIEJFIFJFRkVSRU5DRUQgQU5EIFJFTU9WRUQgTEFURVJcblx0ICAgIG9ic2VydmVyLnByb3hpZXMgPSB7fVxuXG5cdCAgICAvLyBBREQgT1dOIExJU1RFTkVSUyBXSElDSCBUUklHR0VSIEJJTkRJTkcgVVBEQVRFU1xuXHQgICAgb2JzZXJ2ZXJcblx0ICAgICAgICAub24oJ2dldCcsIG9uR2V0KVxuXHQgICAgICAgIC5vbignc2V0Jywgb25TZXQpXG5cdCAgICAgICAgLm9uKCdtdXRhdGUnLCBvblNldCk7XG5cblx0ICAgIC8vIHJlZ2lzdGVyIGhvb2tzIHNldHVwIGluIG9wdGlvbnNcblx0ICAgIHV0aWxzLmVhY2goaG9va3MsIGZ1bmN0aW9uKGhvb2spe1xuXHQgICAgXHR2YXIgaSwgZm5zO1xuXHQgICAgICAgIGZucyA9IG9wdGlvbnNbaG9va11cblx0ICAgICAgICBpZiAodXRpbHMuaXNBcnJheShmbnMpKSB7XG5cdCAgICAgICAgICAgIGkgPSBmbnMubGVuZ3RoXG5cdCAgICAgICAgICAgIC8vIHNpbmNlIGhvb2tzIHdlcmUgbWVyZ2VkIHdpdGggY2hpbGQgYXQgaGVhZCxcblx0ICAgICAgICAgICAgLy8gd2UgbG9vcCByZXZlcnNlbHkuXG5cdCAgICAgICAgICAgIHdoaWxlIChpLS0pIHtcblx0ICAgICAgICAgICAgICAgIHJlZ2lzdGVySG9vayhob29rLCBmbnNbal0pXG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9IGVsc2UgaWYgKGZucykge1xuXHQgICAgICAgICAgICByZWdpc3Rlckhvb2soaG9vaywgZm5zKVxuXHQgICAgICAgIH1cblx0ICAgIH0pO1xuXG5cdCAgICAvLyBicm9hZGNhc3QgYXR0YWNoZWQvZGV0YWNoZWQgaG9va3Ncblx0ICAgIG9ic2VydmVyXG5cdCAgICAgICAgLm9uKCdob29rOmF0dGFjaGVkJywgZnVuY3Rpb24gKCkge1xuXHQgICAgICAgICAgICBicm9hZGNhc3QoMSlcblx0ICAgICAgICB9KVxuXHQgICAgICAgIC5vbignaG9vazpkZXRhY2hlZCcsIGZ1bmN0aW9uICgpIHtcblx0ICAgICAgICAgICAgYnJvYWRjYXN0KDApXG5cdCAgICAgICAgfSlcblxuXHQgICAgZnVuY3Rpb24gb25HZXQgKGtleSkge1xuXHQgICAgICAgIGNoZWNrKGtleSlcblx0ICAgICAgICBEZXBzUGFyc2VyLmNhdGNoZXIuZW1pdCgnZ2V0JywgYmluZGluZ3Nba2V5XSlcblx0ICAgIH1cblxuXHQgICAgZnVuY3Rpb24gb25TZXQgKGtleSwgdmFsLCBtdXRhdGlvbikge1xuXHQgICAgICAgIG9ic2VydmVyLmVtaXQoJ2NoYW5nZTonICsga2V5LCB2YWwsIG11dGF0aW9uKVxuXHQgICAgICAgIGNoZWNrKGtleSlcblx0ICAgICAgICBiaW5kaW5nc1trZXldLnVwZGF0ZSh2YWwpXG5cdCAgICB9XG5cblx0ICAgIGZ1bmN0aW9uIHJlZ2lzdGVySG9vayAoaG9vaywgZm4pIHtcblx0ICAgICAgICBvYnNlcnZlci5vbignaG9vazonICsgaG9vaywgZnVuY3Rpb24gKCkge1xuXHQgICAgICAgICAgICBmbi5jYWxsKGNvbXBpbGVyLnZtKVxuXHQgICAgICAgIH0pO1xuXHQgICAgfVxuXG5cdCAgICBmdW5jdGlvbiBicm9hZGNhc3QgKGV2ZW50KSB7XG5cdCAgICAgICAgdmFyIGNoaWxkcmVuID0gY29tcGlsZXIuY2hpbGRyZW5cblx0ICAgICAgICBpZiAoY2hpbGRyZW4pIHtcblx0ICAgICAgICAgICAgdmFyIGNoaWxkLCBpID0gY2hpbGRyZW4ubGVuZ3RoXG5cdCAgICAgICAgICAgIHdoaWxlIChpLS0pIHtcblx0ICAgICAgICAgICAgICAgIGNoaWxkID0gY2hpbGRyZW5baV1cblx0ICAgICAgICAgICAgICAgIGlmIChjaGlsZC5lbC5wYXJlbnROb2RlKSB7XG5cdCAgICAgICAgICAgICAgICAgICAgZXZlbnQgPSAnaG9vazonICsgKGV2ZW50ID8gJ2F0dGFjaGVkJyA6ICdkZXRhY2hlZCcpXG5cdCAgICAgICAgICAgICAgICAgICAgY2hpbGQub2JzZXJ2ZXIuZW1pdChldmVudClcblx0ICAgICAgICAgICAgICAgICAgICBjaGlsZC5lbWl0dGVyLmVtaXQoZXZlbnQpXG5cdCAgICAgICAgICAgICAgICB9XG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9XG5cdCAgICB9XG5cblx0ICAgIGZ1bmN0aW9uIGNoZWNrIChrZXkpIHtcblx0ICAgICAgICBpZiAoIWJpbmRpbmdzW2tleV0pIHtcblx0ICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhrZXkpXG5cdCAgICAgICAgfVxuXHQgICAgfVxuXHR9LFxuXHRvYnNlcnZlRGF0YTogZnVuY3Rpb24oZGF0YSl7XG5cdFx0dmFyIGNvbXBpbGVyID0gdGhpcyxcblx0XHRcdG9ic2VydmVyID0gY29tcGlsZXIub2JzZXJ2ZXI7XG5cblx0XHRPYnNlcnZlci5vYnNlcnZlKGRhdGEsICcnLCBvYnNlcnZlcik7XG5cdFx0Ly8gYWxzbyBjcmVhdGUgYmluZGluZyBmb3IgdG9wIGxldmVsICRkYXRhXG5cdCAgICAvLyBzbyBpdCBjYW4gYmUgdXNlZCBpbiB0ZW1wbGF0ZXMgdG9vXG5cdCAgICB2YXIgJGRhdGFCaW5kaW5nID0gY29tcGlsZXIuYmluZGluZ3NbJyRkYXRhJ10gPSBuZXcgQmluZGluZyhjb21waWxlciwgJyRkYXRhJyk7XG5cdCAgICAkZGF0YUJpbmRpbmcudXBkYXRlKGRhdGEpO1xuXG5cdCAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkoY29tcGlsZXIudm0sICckZGF0YScsIHtcblx0ICAgIFx0Z2V0OiBmdW5jdGlvbigpe1xuXHQgICAgXHRcdGNvbXBpbGVyLm9ic2VydmVyLmVtaXQoJ2dldCcsICckZGF0YScpO1xuXHQgICAgXHR9LFxuXHQgICAgXHRzZXQ6IGZ1bmN0aW9uKCl7XG5cdCAgICBcdFx0dmFyIG9sZERhdGEgPSBjb21waWxlci5kYXRhO1xuXHQgICAgXHRcdE9ic2VydmVyLnVub2JzZXJ2ZShvbGREYXRhLCAnJywgb2JzZXJ2ZXIpO1xuXHQgICAgXHRcdGNvbXBpbGVyLmRhdGEgPSBuZXdEYXRhO1xuXHQgICAgXHRcdE9ic2VydmVyLmNvcHlQYXRocyhuZXdEYXRhLCBvbGREYXRhKTtcblx0ICAgIFx0XHRPYnNlcnZlci5vYnNlcnZlKG5ld0RhdGEsICcnLCBvYnNlcnZlcik7XG5cdCAgICBcdFx0dXBkYXRlKCk7XG5cdCAgICBcdH1cblx0ICAgIH0pO1xuXG5cdCAgICBvYnNlcnZlclxuXHQgICAgXHQub24oJ3NldCcsIG9uU2V0KVxuXHQgICAgXHQub24oJ211dGF0ZScsIG9uU2V0KTtcblx0ICAgIGZ1bmN0aW9uIG9uU2V0IChrZXkpIHtcblx0ICAgIFx0aWYgKGtleSAhPT0nJGRhdGEnKSB1cGRhdGU7XG5cdCAgICB9XG5cblx0ICAgIGZ1bmN0aW9uIHVwZGF0ZSgpe1xuXHQgICAgXHQkZGF0YUJpbmRpbmcudXBkYXRlKGNvbXBpbGVyLmRhdGEpO1xuXHQgICAgXHRvYnNlcnZlci5lbWl0KCdjaGFuZ2U6JGRhdGEnLCBjb21waWxlci5kYXRhKTtcblx0ICAgIH1cblx0fSxcblxuXHQvKipcblx0ICogIENSRUFURSBCSU5ESU5HIEFORCBBVFRBQ0ggR0VUVEVSL1NFVFRFUiBGT1IgQSBLRVkgVE8gVEhFIFZJRVdNT0RFTCBPQkpFQ1Rcblx0ICovXG5cdGNyZWF0ZUJpbmRpbmc6IGZ1bmN0aW9uKGtleSwgZGlyZWN0aXZlKXtcblx0XHR1dGlscy5sb2coJyAgY3JlYXRlZCBiaW5kaW5nOiAnICsga2V5KTtcblx0XHR2YXIgY29tcGlsZXIgPSB0aGlzLFxuXHQgICAgICAgIG1ldGhvZHMgID0gY29tcGlsZXIub3B0aW9ucy5tZXRob2RzLFxuXHQgICAgICAgIGlzRXhwICAgID0gZGlyZWN0aXZlICYmIGRpcmVjdGl2ZS5pc0V4cCxcblx0ICAgICAgICBpc0ZuICAgICA9IChkaXJlY3RpdmUgJiYgZGlyZWN0aXZlLmlzRm4pIHx8IChtZXRob2RzICYmIG1ldGhvZHNba2V5XSksXG5cdCAgICAgICAgYmluZGluZ3MgPSBjb21waWxlci5iaW5kaW5ncyxcblx0ICAgICAgICBjb21wdXRlZCA9IGNvbXBpbGVyLm9wdGlvbnMuY29tcHV0ZWQsXG5cdCAgICAgICAgYmluZGluZyAgPSBuZXcgQmluZGluZyhjb21waWxlciwga2V5LCBpc0V4cCwgaXNGbik7XG5cblxuXHQgICAgaWYgKGlzRXhwKSB7XG5cdCAgICAgICAgLy8gRVhQUkVTU0lPTiBCSU5ESU5HUyBBUkUgQU5PTllNT1VTXG5cdCAgICAgICAgY29tcGlsZXIuZGVmaW5lRXhwKGtleSwgYmluZGluZywgZGlyZWN0aXZlKTtcblx0ICAgIH0gZWxzZSBpZiAoaXNGbikge1xuXHQgICAgICAgIGJpbmRpbmdzW2tleV0gPSBiaW5kaW5nO1xuXHQgICAgICAgIGNvbXBpbGVyLmRlZmluZVZtUHJvcChrZXksIGJpbmRpbmcsIG1ldGhvZHNba2V5XSk7XG5cdCAgICB9IGVsc2Uge1xuXHQgICAgXHRiaW5kaW5nc1trZXldID0gYmluZGluZztcblx0ICAgICAgICBpZiAoYmluZGluZy5yb290KSB7XG5cdCAgICAgICAgICAgIC8vIFRISVMgSVMgQSBST09UIExFVkVMIEJJTkRJTkcuIFdFIE5FRUQgVE8gREVGSU5FIEdFVFRFUi9TRVRURVJTIEZPUiBJVC5cblx0ICAgICAgICAgICAgaWYgKGNvbXB1dGVkICYmIGNvbXB1dGVkW2tleV0pIHtcblx0ICAgICAgICAgICAgICAgIC8vIENPTVBVVEVEIFBST1BFUlRZXG5cdCAgICAgICAgICAgICAgICBjb21waWxlci5kZWZpbmVDb21wdXRlZChrZXksIGJpbmRpbmcsIGNvbXB1dGVkW2tleV0pXG5cdCAgICAgICAgICAgIH0gZWxzZSBpZiAoa2V5LmNoYXJBdCgwKSAhPT0gJyQnKSB7XG5cdCAgICAgICAgICAgICAgICAvLyBOT1JNQUwgUFJPUEVSVFlcblx0ICAgICAgICAgICAgICAgIGNvbXBpbGVyLmRlZmluZURhdGFQcm9wKGtleSwgYmluZGluZylcblx0ICAgICAgICAgICAgfSBlbHNlIHtcblx0ICAgICAgICAgICAgICAgIC8vIFBST1BFUlRJRVMgVEhBVCBTVEFSVCBXSVRIICQgQVJFIE1FVEEgUFJPUEVSVElFU1xuXHQgICAgICAgICAgICAgICAgLy8gVEhFWSBTSE9VTEQgQkUgS0VQVCBPTiBUSEUgVk0gQlVUIE5PVCBJTiBUSEUgREFUQSBPQkpFQ1QuXG5cdCAgICAgICAgICAgICAgICBjb21waWxlci5kZWZpbmVWbVByb3Aoa2V5LCBiaW5kaW5nLCBjb21waWxlci5kYXRhW2tleV0pXG5cdCAgICAgICAgICAgICAgICBkZWxldGUgY29tcGlsZXIuZGF0YVtrZXldXG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9IGVsc2UgaWYgKGNvbXB1dGVkICYmIGNvbXB1dGVkW3V0aWxzLmJhc2VLZXkoa2V5KV0pIHtcblx0ICAgICAgICAgICAgLy8gTkVTVEVEIFBBVEggT04gQ09NUFVURUQgUFJPUEVSVFlcblx0ICAgICAgICAgICAgY29tcGlsZXIuZGVmaW5lRXhwKGtleSwgYmluZGluZylcblx0ICAgICAgICB9IGVsc2Uge1xuXHQgICAgICAgICAgICAvLyBFTlNVUkUgUEFUSCBJTiBEQVRBIFNPIFRIQVQgQ09NUFVURUQgUFJPUEVSVElFUyBUSEFUXG5cdCAgICAgICAgICAgIC8vIEFDQ0VTUyBUSEUgUEFUSCBET04nVCBUSFJPVyBBTiBFUlJPUiBBTkQgQ0FOIENPTExFQ1Rcblx0ICAgICAgICAgICAgLy8gREVQRU5ERU5DSUVTXG5cdCAgICAgICAgICAgIE9ic2VydmVyLmVuc3VyZVBhdGgoY29tcGlsZXIuZGF0YSwga2V5KVxuXHQgICAgICAgICAgICB2YXIgcGFyZW50S2V5ID0ga2V5LnNsaWNlKDAsIGtleS5sYXN0SW5kZXhPZignLicpKVxuXHQgICAgICAgICAgICBpZiAoIWJpbmRpbmdzW3BhcmVudEtleV0pIHtcblx0ICAgICAgICAgICAgICAgIC8vIHRoaXMgaXMgYSBuZXN0ZWQgdmFsdWUgYmluZGluZywgYnV0IHRoZSBiaW5kaW5nIGZvciBpdHMgcGFyZW50XG5cdCAgICAgICAgICAgICAgICAvLyBoYXMgbm90IGJlZW4gY3JlYXRlZCB5ZXQuIFdlIGJldHRlciBjcmVhdGUgdGhhdCBvbmUgdG9vLlxuXHQgICAgICAgICAgICAgICAgY29tcGlsZXIuY3JlYXRlQmluZGluZyhwYXJlbnRLZXkpXG5cdCAgICAgICAgICAgIH1cblx0ICAgICAgICB9XG5cdCAgICB9XG5cdCAgICByZXR1cm4gYmluZGluZztcblx0fVxufSk7XG5cbi8qKlxuICogY29udGVudCByZXNvbHZlIGFuZCBjb21waWxlXG4gKi9cbnV0aWxzLm1peChDb21waWxlci5wcm90b3R5cGUsIHtcblx0LyoqXG5cdCAqICBERUFMIFdJVEggPENPTlRFTlQ+IElOU0VSVElPTiBQT0lOVFNcblx0ICogIFBFUiBUSEUgV0VCIENPTVBPTkVOVFMgU1BFQ1xuXHQgKi9cblx0cmVzb2x2ZUNvbnRlbnQ6IGZ1bmN0aW9uKCkge1xuXHRcdHZhciBvdXRsZXRzID0gc2xpY2UuY2FsbCh0aGlzLmVsLmdldEVsZW1lbnRzQnlUYWdOYW1lKCdjb250ZW50JykpLFxuXHRcdFx0cmF3ID0gdGhpcy5yYXdDb250ZW50O1xuXG5cdFx0Ly8gZmlyc3QgcGFzcywgY29sbGVjdCBjb3JyZXNwb25kaW5nIGNvbnRlbnRcbiAgICAgICAgLy8gZm9yIGVhY2ggb3V0bGV0LlxuXHRcdHV0aWxzLmVhY2gob3V0bGV0cywgZnVuY3Rpb24ob3V0bGV0KXtcblx0XHRcdGlmIChyYXcpIHtcblx0XHRcdFx0c2VsZWN0ID0gb3V0bGV0LmdldEF0dHJpYnV0ZSgnc2VsZWN0Jyk7XG5cdFx0XHRcdGlmIChzZWxlY3QpIHtcblx0XHRcdFx0XHRvdXRsZXQuY29udGVudCA9IHNsaWNlLmNhbGwocmF3LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0KSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0bWFpbiA9IG91dGxldDtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0b3V0bGV0LmNvbnRlbnQgPSBzbGljZS5jYWxsKG91dGxldC5jaGlsZE5vZGVzKTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdC8vIHNlY29uZCBwYXNzLCBhY3R1YWxseSBpbnNlcnQgdGhlIGNvbnRlbnRzXG5cdFx0dmFyIGksIGosIGNvdXRsZXQ7XG4gICAgICAgIGZvciAoaSA9IDAsIGogPSBvdXRsZXRzLmxlbmd0aDsgaSA8IGo7IGkrKykge1xuICAgICAgICAgICAgb3V0bGV0ID0gb3V0bGV0c1tpXVxuICAgICAgICAgICAgaWYgKG91dGxldCA9PT0gbWFpbikgY29udGludWVcbiAgICAgICAgICAgIGluc2VydChvdXRsZXQsIG91dGxldC5jb250ZW50KVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gaW5zZXJ0IChvdXRsZXQsIGNvbnRlbnRzKSB7XG5cdCAgICAgICAgdmFyIHBhcmVudCA9IG91dGxldC5wYXJlbnROb2RlLFxuXHQgICAgICAgICAgICBpID0gMCwgaiA9IGNvbnRlbnRzLmxlbmd0aFxuXHQgICAgICAgIGZvciAoOyBpIDwgajsgaSsrKSB7XG5cdCAgICAgICAgICAgIHBhcmVudC5pbnNlcnRCZWZvcmUoY29udGVudHNbaV0sIG91dGxldClcblx0ICAgICAgICB9XG5cdCAgICAgICAgcGFyZW50LnJlbW92ZUNoaWxkKG91dGxldCk7XG5cdCAgICB9XG5cblx0ICAgIHRoaXMucmF3Q29udGVudCA9IG51bGxcblx0fSxcblx0Y29tcGlsZTogZnVuY3Rpb24obm9kZSwgcm9vdCl7XG5cdFx0dmFyIG5vZGVUeXBlID0gbm9kZS5ub2RlVHlwZVxuXHQgICAgLy8gYSBub3JtYWwgbm9kZVxuXHQgICAgaWYgKG5vZGVUeXBlID09PSAxICYmIG5vZGUudGFnTmFtZSAhPT0gJ1NDUklQVCcpIHsgXG5cdCAgICAgICAgdGhpcy5jb21waWxlRWxlbWVudChub2RlLCByb290KTtcblx0ICAgIH0gZWxzZSBpZiAobm9kZVR5cGUgPT09IDMgJiYgY29uZmlnLmludGVycG9sYXRlKSB7XG5cdCAgICAgICAgdGhpcy5jb21waWxlVGV4dE5vZGUobm9kZSk7XG5cdCAgICB9XG5cdH0sXG5cdGNvbXBpbGVFbGVtZW50OiBmdW5jdGlvbihub2RlLCByb290KXtcblx0XHQvLyB0ZXh0YXJlYSBpcyBwcmV0dHkgYW5ub3lpbmdcblx0ICAgIC8vIGJlY2F1c2UgaXRzIHZhbHVlIGNyZWF0ZXMgY2hpbGROb2RlcyB3aGljaFxuXHQgICAgLy8gd2UgZG9uJ3Qgd2FudCB0byBjb21waWxlLlxuXHQgICAgaWYgKG5vZGUudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyAmJiBub2RlLnZhbHVlKSB7XG5cdCAgICAgICAgbm9kZS52YWx1ZSA9IHRoaXMuZXZhbChub2RlLnZhbHVlKTtcblx0ICAgIH1cblxuXHQgICAgLy8gb25seSBjb21waWxlIGlmIHRoaXMgZWxlbWVudCBoYXMgYXR0cmlidXRlc1xuXHQgICAgLy8gb3IgaXRzIHRhZ05hbWUgY29udGFpbnMgYSBoeXBoZW4gKHdoaWNoIG1lYW5zIGl0IGNvdWxkXG5cdCAgICAvLyBwb3RlbnRpYWxseSBiZSBhIGN1c3RvbSBlbGVtZW50KVxuXHQgICAgaWYgKG5vZGUuaGFzQXR0cmlidXRlcygpIHx8IG5vZGUudGFnTmFtZS5pbmRleE9mKCctJykgPiAtMSkge1xuXG5cdCAgICBcdC8vIHNraXAgYW55dGhpbmcgd2l0aCB2LXByZVxuXHQgICAgICAgIGlmICh1dGlscy5kb20uYXR0cihub2RlLCAncHJlJykgIT09IG51bGwpIHtcblx0ICAgICAgICAgICAgcmV0dXJuO1xuXHQgICAgICAgIH1cblxuXHQgICAgICAgIHZhciBpLCBsLCBqLCBrXG5cblx0ICAgICAgICAvLyBjaGVjayBwcmlvcml0eSBkaXJlY3RpdmVzLlxuXHQgICAgICAgIC8vIGlmIGFueSBvZiB0aGVtIGFyZSBwcmVzZW50LCBpdCB3aWxsIHRha2Ugb3ZlciB0aGUgbm9kZSB3aXRoIGEgY2hpbGRWTVxuXHQgICAgICAgIC8vIHNvIHdlIGNhbiBza2lwIHRoZSByZXN0XG5cdCAgICAgICAgZm9yIChpID0gMCwgbCA9IHByaW9yaXR5RGlyZWN0aXZlcy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcblx0ICAgICAgICAgICAgaWYgKHRoaXMuY2hlY2tQcmlvcml0eURpcihwcmlvcml0eURpcmVjdGl2ZXNbaV0sIG5vZGUsIHJvb3QpKSB7XG5cdCAgICAgICAgICAgICAgICByZXR1cm5cblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblxuXHRcdCAgICB2YXIgcHJlZml4ID0gY29uZmlnLnByZWZpeCArICctJyxcblx0ICAgICAgICAgICAgcGFyYW1zID0gdGhpcy5vcHRpb25zLnBhcmFtQXR0cmlidXRlcyxcblx0ICAgICAgICAgICAgYXR0ciwgYXR0cm5hbWUsIGlzRGlyZWN0aXZlLCBleHAsIGRpcmVjdGl2ZXMsIGRpcmVjdGl2ZSwgZGlybmFtZTtcblxuXHQgICAgICAgIC8vIHYtd2l0aCBoYXMgc3BlY2lhbCBwcmlvcml0eSBhbW9uZyB0aGUgcmVzdFxuXHQgICAgICAgIC8vIGl0IG5lZWRzIHRvIHB1bGwgaW4gdGhlIHZhbHVlIGZyb20gdGhlIHBhcmVudCBiZWZvcmVcblx0ICAgICAgICAvLyBjb21wdXRlZCBwcm9wZXJ0aWVzIGFyZSBldmFsdWF0ZWQsIGJlY2F1c2UgYXQgdGhpcyBzdGFnZVxuXHQgICAgICAgIC8vIHRoZSBjb21wdXRlZCBwcm9wZXJ0aWVzIGhhdmUgbm90IHNldCB1cCB0aGVpciBkZXBlbmRlbmNpZXMgeWV0LlxuXHQgICAgICAgIGlmIChyb290KSB7XG5cdCAgICAgICAgICAgIHZhciB3aXRoRXhwID0gdXRpbHMuZG9tLmF0dHIobm9kZSwgJ3dpdGgnKTtcblx0ICAgICAgICAgICAgaWYgKHdpdGhFeHApIHtcblx0ICAgICAgICAgICAgICAgIGRpcmVjdGl2ZXMgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCd3aXRoJywgd2l0aEV4cCwgbm9kZSwgdHJ1ZSlcblx0ICAgICAgICAgICAgICAgIGZvciAoaiA9IDAsIGsgPSBkaXJlY3RpdmVzLmxlbmd0aDsgaiA8IGs7IGorKykge1xuXHQgICAgICAgICAgICAgICAgICAgIHRoaXMuYmluZERpcmVjdGl2ZShkaXJlY3RpdmVzW2pdLCB0aGlzLnBhcmVudClcblx0ICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblxuXHQgICAgICAgIHZhciBhdHRycyA9IHNsaWNlLmNhbGwobm9kZS5hdHRyaWJ1dGVzKTtcblx0ICAgICAgICBmb3IgKGkgPSAwLCBsID0gYXR0cnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG5cblx0ICAgICAgICAgICAgYXR0ciA9IGF0dHJzW2ldXG5cdCAgICAgICAgICAgIGF0dHJuYW1lID0gYXR0ci5uYW1lXG5cdCAgICAgICAgICAgIGlzRGlyZWN0aXZlID0gZmFsc2VcblxuXHQgICAgICAgICAgICBpZiAoYXR0cm5hbWUuaW5kZXhPZihwcmVmaXgpID09PSAwKSB7XG5cdCAgICAgICAgICAgICAgICAvLyBhIGRpcmVjdGl2ZSAtIHNwbGl0LCBwYXJzZSBhbmQgYmluZCBpdC5cblx0ICAgICAgICAgICAgICAgIGlzRGlyZWN0aXZlID0gdHJ1ZVxuXHQgICAgICAgICAgICAgICAgZGlybmFtZSA9IGF0dHJuYW1lLnNsaWNlKHByZWZpeC5sZW5ndGgpXG5cdCAgICAgICAgICAgICAgICAvLyBidWlsZCB3aXRoIG11bHRpcGxlOiB0cnVlXG5cdCAgICAgICAgICAgICAgICBkaXJlY3RpdmVzID0gdGhpcy5wYXJzZURpcmVjdGl2ZShkaXJuYW1lLCBhdHRyLnZhbHVlLCBub2RlLCB0cnVlKVxuXHQgICAgICAgICAgICAgICAgLy8gbG9vcCB0aHJvdWdoIGNsYXVzZXMgKHNlcGFyYXRlZCBieSBcIixcIilcblx0ICAgICAgICAgICAgICAgIC8vIGluc2lkZSBlYWNoIGF0dHJpYnV0ZVxuXHQgICAgICAgICAgICAgICAgZm9yIChqID0gMCwgayA9IGRpcmVjdGl2ZXMubGVuZ3RoOyBqIDwgazsgaisrKSB7XG5cdCAgICAgICAgICAgICAgICAgICAgdGhpcy5iaW5kRGlyZWN0aXZlKGRpcmVjdGl2ZXNbal0pXG5cdCAgICAgICAgICAgICAgICB9XG5cdCAgICAgICAgICAgIH0gZWxzZSBpZiAoY29uZmlnLmludGVycG9sYXRlKSB7XG5cdCAgICAgICAgICAgICAgICAvLyBub24gZGlyZWN0aXZlIGF0dHJpYnV0ZSwgY2hlY2sgaW50ZXJwb2xhdGlvbiB0YWdzXG5cdCAgICAgICAgICAgICAgICBleHAgPSBUZXh0UGFyc2VyLnBhcnNlQXR0cihhdHRyLnZhbHVlKVxuXHQgICAgICAgICAgICAgICAgaWYgKGV4cCkge1xuXHQgICAgICAgICAgICAgICAgICAgIGRpcmVjdGl2ZSA9IHRoaXMucGFyc2VEaXJlY3RpdmUoJ2F0dHInLCBleHAsIG5vZGUpXG5cdCAgICAgICAgICAgICAgICAgICAgZGlyZWN0aXZlLmFyZyA9IGF0dHJuYW1lXG5cdCAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBwYXJhbXMuaW5kZXhPZihhdHRybmFtZSkgPiAtMSkge1xuXHQgICAgICAgICAgICAgICAgICAgICAgICAvLyBhIHBhcmFtIGF0dHJpYnV0ZS4uLiB3ZSBzaG91bGQgdXNlIHRoZSBwYXJlbnQgYmluZGluZ1xuXHQgICAgICAgICAgICAgICAgICAgICAgICAvLyB0byBhdm9pZCBjaXJjdWxhciB1cGRhdGVzIGxpa2Ugc2l6ZT17e3NpemV9fVxuXHQgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlLCB0aGlzLnBhcmVudClcblx0ICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuXHQgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlKVxuXHQgICAgICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgICAgIH1cblx0ICAgICAgICAgICAgfVxuXG5cdCAgICAgICAgICAgIGlmIChpc0RpcmVjdGl2ZSAmJiBkaXJuYW1lICE9PSAnY2xvYWsnKSB7XG5cdCAgICAgICAgICAgICAgICBub2RlLnJlbW92ZUF0dHJpYnV0ZShhdHRybmFtZSlcblx0ICAgICAgICAgICAgfVxuXHQgICAgICAgIH1cblxuXHQgICAgICAgIC8vIHJlY3Vyc2l2ZWx5IGNvbXBpbGUgY2hpbGROb2Rlc1xuXHRcdCAgICBpZiAobm9kZS5oYXNDaGlsZE5vZGVzKCkpIHtcblx0XHQgICAgICAgIHNsaWNlLmNhbGwobm9kZS5jaGlsZE5vZGVzKS5mb3JFYWNoKHRoaXMuY29tcGlsZSwgdGhpcyk7XG5cdFx0ICAgIH1cblx0ICAgIH1cblx0fSxcblx0Y29tcGlsZVRleHROb2RlOiBmdW5jdGlvbiAobm9kZSkge1xuXHQgICAgdmFyIHRva2VucyA9IFRleHRQYXJzZXIucGFyc2Uobm9kZS5ub2RlVmFsdWUpXG5cdCAgICBpZiAoIXRva2VucykgcmV0dXJuXG5cdCAgICB2YXIgZWwsIHRva2VuLCBkaXJlY3RpdmVcblxuXHQgICAgZm9yICh2YXIgaSA9IDAsIGwgPSB0b2tlbnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG5cblx0ICAgICAgICB0b2tlbiA9IHRva2Vuc1tpXVxuXHQgICAgICAgIGRpcmVjdGl2ZSA9IG51bGxcblxuXHQgICAgICAgIGlmICh0b2tlbi5rZXkpIHsgLy8gYSBiaW5kaW5nXG5cdCAgICAgICAgICAgIGlmICh0b2tlbi5rZXkuY2hhckF0KDApID09PSAnPicpIHsgLy8gYSBwYXJ0aWFsXG5cdCAgICAgICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZUNvbW1lbnQoJ3JlZicpXG5cdCAgICAgICAgICAgICAgICBkaXJlY3RpdmUgPSB0aGlzLnBhcnNlRGlyZWN0aXZlKCdwYXJ0aWFsJywgdG9rZW4ua2V5LnNsaWNlKDEpLCBlbClcblx0ICAgICAgICAgICAgfSBlbHNlIHtcblx0ICAgICAgICAgICAgICAgIGlmICghdG9rZW4uaHRtbCkgeyAvLyB0ZXh0IGJpbmRpbmdcblx0ICAgICAgICAgICAgICAgICAgICBlbCA9IGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKCcnKVxuXHQgICAgICAgICAgICAgICAgICAgIGRpcmVjdGl2ZSA9IHRoaXMucGFyc2VEaXJlY3RpdmUoJ3RleHQnLCB0b2tlbi5rZXksIGVsKVxuXHQgICAgICAgICAgICAgICAgfSBlbHNlIHsgLy8gaHRtbCBiaW5kaW5nXG5cdCAgICAgICAgICAgICAgICAgICAgZWwgPSBkb2N1bWVudC5jcmVhdGVDb21tZW50KGNvbmZpZy5wcmVmaXggKyAnLWh0bWwnKVxuXHQgICAgICAgICAgICAgICAgICAgIGRpcmVjdGl2ZSA9IHRoaXMucGFyc2VEaXJlY3RpdmUoJ2h0bWwnLCB0b2tlbi5rZXksIGVsKVxuXHQgICAgICAgICAgICAgICAgfVxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfSBlbHNlIHsgLy8gYSBwbGFpbiBzdHJpbmdcblx0ICAgICAgICAgICAgZWwgPSBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0b2tlbilcblx0ICAgICAgICB9XG5cblx0ICAgICAgICAvLyBpbnNlcnQgbm9kZVxuXHQgICAgICAgIG5vZGUucGFyZW50Tm9kZS5pbnNlcnRCZWZvcmUoZWwsIG5vZGUpXG5cdCAgICAgICAgLy8gYmluZCBkaXJlY3RpdmVcblx0ICAgICAgICB0aGlzLmJpbmREaXJlY3RpdmUoZGlyZWN0aXZlKVxuXG5cdCAgICB9XG5cdCAgICBub2RlLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQobm9kZSlcblx0fVxufSk7XG5cbi8qKlxuICogZGlyZWN0aXZlIHN0dWZmXG4gKi9cbnV0aWxzLm1peChDb21waWxlci5wcm90b3R5cGUsIHtcblx0LyoqXG5cdCAqICBDaGVjayBmb3IgYSBwcmlvcml0eSBkaXJlY3RpdmVcblx0ICogIElmIGl0IGlzIHByZXNlbnQgYW5kIHZhbGlkLCByZXR1cm4gdHJ1ZSB0byBza2lwIHRoZSByZXN0XG5cdCAqL1xuXHRjaGVja1ByaW9yaXR5RGlyOiBmdW5jdGlvbihkaXJuYW1lLCBub2RlLCByb290KXtcblx0XHR2YXIgZXhwcmVzc2lvbiwgZGlyZWN0aXZlLCBDdG9yXG5cdCAgICBpZiAoXG5cdCAgICAgICAgZGlybmFtZSA9PT0gJ2NvbXBvbmVudCcgJiZcblx0ICAgICAgICByb290ICE9PSB0cnVlICYmXG5cdCAgICAgICAgKEN0b3IgPSB0aGlzLnJlc29sdmVDb21wb25lbnQobm9kZSwgdW5kZWZpbmVkLCB0cnVlKSlcblx0ICAgICkge1xuXHQgICAgICAgIGRpcmVjdGl2ZSA9IHRoaXMucGFyc2VEaXJlY3RpdmUoZGlybmFtZSwgJycsIG5vZGUpXG5cdCAgICAgICAgZGlyZWN0aXZlLkN0b3IgPSBDdG9yXG5cdCAgICB9IGVsc2Uge1xuXHQgICAgICAgIGV4cHJlc3Npb24gPSB1dGlscy5kb20uYXR0cihub2RlLCBkaXJuYW1lKVxuXHQgICAgICAgIGRpcmVjdGl2ZSA9IGV4cHJlc3Npb24gJiYgdGhpcy5wYXJzZURpcmVjdGl2ZShkaXJuYW1lLCBleHByZXNzaW9uLCBub2RlKTtcblx0ICAgIH1cblx0ICAgIGlmIChkaXJlY3RpdmUpIHtcblx0ICAgICAgICBpZiAocm9vdCA9PT0gdHJ1ZSkge1xuXHQgICAgICAgICAgICB1dGlscy53YXJuKFxuXHQgICAgICAgICAgICAgICAgJ0RpcmVjdGl2ZSB2LScgKyBkaXJuYW1lICsgJyBjYW5ub3QgYmUgdXNlZCBvbiBhbiBhbHJlYWR5IGluc3RhbnRpYXRlZCAnICtcblx0ICAgICAgICAgICAgICAgICdWTVxcJ3Mgcm9vdCBub2RlLiBVc2UgaXQgZnJvbSB0aGUgcGFyZW50XFwncyB0ZW1wbGF0ZSBpbnN0ZWFkLidcblx0ICAgICAgICAgICAgKVxuXHQgICAgICAgICAgICByZXR1cm5cblx0ICAgICAgICB9XG5cdCAgICAgICAgdGhpcy5kZWZlcnJlZC5wdXNoKGRpcmVjdGl2ZSk7XG5cdCAgICAgICAgcmV0dXJuIHRydWVcblx0ICAgIH1cblx0fSxcblx0cGFyc2VEaXJlY3RpdmU6IGZ1bmN0aW9uIChuYW1lLCB2YWx1ZSwgZWwsIG11bHRpcGxlKSB7XG5cdCAgICB2YXIgY29tcGlsZXIgPSB0aGlzLFxuXHQgICAgICAgIGRlZmluaXRpb24gPSBjb21waWxlci5nZXRPcHRpb24oJ2RpcmVjdGl2ZXMnLCBuYW1lKTtcblx0ICAgIGlmIChkZWZpbml0aW9uKSB7XG5cdCAgICAgICAgLy8gcGFyc2UgaW50byBBU1QtbGlrZSBvYmplY3RzXG5cdCAgICAgICAgdmFyIGFzdHMgPSBEaXJlY3RpdmUucGFyc2UodmFsdWUpXG5cdCAgICAgICAgcmV0dXJuIG11bHRpcGxlXG5cdCAgICAgICAgICAgID8gYXN0cy5tYXAoYnVpbGQpXG5cdCAgICAgICAgICAgIDogYnVpbGQoYXN0c1swXSlcblx0ICAgIH1cblx0ICAgIGZ1bmN0aW9uIGJ1aWxkIChhc3QpIHtcblx0ICAgICAgICByZXR1cm4gbmV3IERpcmVjdGl2ZShuYW1lLCBhc3QsIGRlZmluaXRpb24sIGNvbXBpbGVyLCBlbClcblx0ICAgIH1cblx0fSxcblx0YmluZERpcmVjdGl2ZTogZnVuY3Rpb24gKGRpcmVjdGl2ZSwgYmluZGluZ093bmVyKSB7XG5cblx0ICAgIGlmICghZGlyZWN0aXZlKSByZXR1cm47XG5cblx0ICAgIC8vIGtlZXAgdHJhY2sgb2YgaXQgc28gd2UgY2FuIHVuYmluZCgpIGxhdGVyXG5cdCAgICB0aGlzLmRpcnMucHVzaChkaXJlY3RpdmUpXG5cblx0ICAgIC8vIGZvciBlbXB0eSBvciBsaXRlcmFsIGRpcmVjdGl2ZXMsIHNpbXBseSBjYWxsIGl0cyBiaW5kKClcblx0ICAgIC8vIGFuZCB3ZSdyZSBkb25lLlxuXHQgICAgaWYgKGRpcmVjdGl2ZS5pc0VtcHR5IHx8IGRpcmVjdGl2ZS5pc0xpdGVyYWwpIHtcblx0ICAgICAgICBpZiAoZGlyZWN0aXZlLmJpbmQpIGRpcmVjdGl2ZS5iaW5kKClcblx0ICAgICAgICByZXR1cm5cblx0ICAgIH1cblxuXHQgICAgLy8gb3RoZXJ3aXNlLCB3ZSBnb3QgbW9yZSB3b3JrIHRvIGRvLi4uXG5cdCAgICB2YXIgYmluZGluZyxcblx0ICAgICAgICBjb21waWxlciA9IGJpbmRpbmdPd25lciB8fCB0aGlzLFxuXHQgICAgICAgIGtleSAgICAgID0gZGlyZWN0aXZlLmtleVxuXG5cdCAgICBpZiAoZGlyZWN0aXZlLmlzRXhwKSB7XG5cdCAgICAgICAgLy8gZXhwcmVzc2lvbiBiaW5kaW5ncyBhcmUgYWx3YXlzIGNyZWF0ZWQgb24gY3VycmVudCBjb21waWxlclxuXHQgICAgICAgIGJpbmRpbmcgPSBjb21waWxlci5jcmVhdGVCaW5kaW5nKGtleSwgZGlyZWN0aXZlKVxuXHQgICAgfSBlbHNlIHtcblx0ICAgICAgICAvLyByZWN1cnNpdmVseSBsb2NhdGUgd2hpY2ggY29tcGlsZXIgb3ducyB0aGUgYmluZGluZ1xuXHQgICAgICAgIHdoaWxlIChjb21waWxlcikge1xuXHQgICAgICAgICAgICBpZiAoY29tcGlsZXIuaGFzS2V5KGtleSkpIHtcblx0ICAgICAgICAgICAgICAgIGJyZWFrXG5cdCAgICAgICAgICAgIH0gZWxzZSB7XG5cdCAgICAgICAgICAgICAgICBjb21waWxlciA9IGNvbXBpbGVyLnBhcmVudFxuXHQgICAgICAgICAgICB9XG5cdCAgICAgICAgfVxuXHQgICAgICAgIGNvbXBpbGVyID0gY29tcGlsZXIgfHwgdGhpc1xuXHQgICAgICAgIGJpbmRpbmcgPSBjb21waWxlci5iaW5kaW5nc1trZXldIHx8IGNvbXBpbGVyLmNyZWF0ZUJpbmRpbmcoa2V5KVxuXHQgICAgfVxuXHQgICAgYmluZGluZy5kaXJzLnB1c2goZGlyZWN0aXZlKVxuXHQgICAgZGlyZWN0aXZlLmJpbmRpbmcgPSBiaW5kaW5nXG5cblx0ICAgIHZhciB2YWx1ZSA9IGJpbmRpbmcudmFsKClcblx0ICAgIC8vIGludm9rZSBiaW5kIGhvb2sgaWYgZXhpc3RzXG5cdCAgICBpZiAoZGlyZWN0aXZlLmJpbmQpIHtcblx0ICAgICAgICBkaXJlY3RpdmUuYmluZCh2YWx1ZSlcblx0ICAgIH1cblx0ICAgIC8vIHNldCBpbml0aWFsIHZhbHVlXG5cdCAgICBkaXJlY3RpdmUuJHVwZGF0ZSh2YWx1ZSwgdHJ1ZSlcblx0fVxufSk7XG5cbi8qKipcbiAqIGRlZmluZSBwcm9wZXJ0aWVzXG4gKi9cbnV0aWxzLm1peChDb21waWxlci5wcm90b3R5cGUsIHtcblx0LyoqXG5cdCAqICBEZWZpbmUgdGhlIGdldHRlci9zZXR0ZXIgdG8gcHJveHkgYSByb290LWxldmVsXG5cdCAqICBkYXRhIHByb3BlcnR5IG9uIHRoZSBWTVxuXHQgKi9cblx0ZGVmaW5lRGF0YVByb3A6IGZ1bmN0aW9uIChrZXksIGJpbmRpbmcpIHtcblx0ICAgIHZhciBjb21waWxlciA9IHRoaXMsXG5cdCAgICAgICAgZGF0YSAgICAgPSBjb21waWxlci5kYXRhLFxuXHQgICAgICAgIG9iICAgICAgID0gZGF0YS5fX2VtaXR0ZXJfX1xuXG5cdCAgICAvLyBtYWtlIHN1cmUgdGhlIGtleSBpcyBwcmVzZW50IGluIGRhdGFcblx0ICAgIC8vIHNvIGl0IGNhbiBiZSBvYnNlcnZlZFxuXHQgICAgaWYgKCEoaGFzT3duLmNhbGwoZGF0YSwga2V5KSkpIHtcblx0ICAgICAgICBkYXRhW2tleV0gPSB1bmRlZmluZWRcblx0ICAgIH1cblxuXHQgICAgLy8gaWYgdGhlIGRhdGEgb2JqZWN0IGlzIGFscmVhZHkgb2JzZXJ2ZWQsIGJ1dCB0aGUga2V5XG5cdCAgICAvLyBpcyBub3Qgb2JzZXJ2ZWQsIHdlIG5lZWQgdG8gYWRkIGl0IHRvIHRoZSBvYnNlcnZlZCBrZXlzLlxuXHQgICAgaWYgKG9iICYmICEoaGFzT3duLmNhbGwob2IudmFsdWVzLCBrZXkpKSkge1xuXHQgICAgICAgIE9ic2VydmVyLmNvbnZlcnRLZXkoZGF0YSwga2V5KVxuXHQgICAgfVxuXG5cdCAgICBiaW5kaW5nLnZhbHVlID0gZGF0YVtrZXldXG5cblx0ICAgIGRlZihjb21waWxlci52bSwga2V5LCB7XG5cdCAgICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG5cdCAgICAgICAgICAgIHJldHVybiBjb21waWxlci5kYXRhW2tleV1cblx0ICAgICAgICB9LFxuXHQgICAgICAgIHNldDogZnVuY3Rpb24gKHZhbCkge1xuXHQgICAgICAgICAgICBjb21waWxlci5kYXRhW2tleV0gPSB2YWxcblx0ICAgICAgICB9XG5cdCAgICB9KTtcblx0fSxcblx0ZGVmaW5lVm1Qcm9wOiBmdW5jdGlvbiAoa2V5LCBiaW5kaW5nLCB2YWx1ZSkge1xuXHQgICAgdmFyIG9iID0gdGhpcy5vYnNlcnZlclxuXHQgICAgYmluZGluZy52YWx1ZSA9IHZhbHVlXG5cdCAgICBkZWYodGhpcy52bSwga2V5LCB7XG5cdCAgICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG5cdCAgICAgICAgICAgIGlmIChPYnNlcnZlci5zaG91bGRHZXQpIG9iLmVtaXQoJ2dldCcsIGtleSlcblx0ICAgICAgICAgICAgcmV0dXJuIGJpbmRpbmcudmFsdWVcblx0ICAgICAgICB9LFxuXHQgICAgICAgIHNldDogZnVuY3Rpb24gKHZhbCkge1xuXHQgICAgICAgICAgICBvYi5lbWl0KCdzZXQnLCBrZXksIHZhbClcblx0ICAgICAgICB9XG5cdCAgICB9KVxuXHR9LFxuXHRkZWZpbmVFeHA6IGZ1bmN0aW9uIChrZXksIGJpbmRpbmcsIGRpcmVjdGl2ZSkge1xuXHQgICAgdmFyIGNvbXB1dGVkS2V5ID0gZGlyZWN0aXZlICYmIGRpcmVjdGl2ZS5jb21wdXRlZEtleSxcblx0ICAgICAgICBleHAgICAgICAgICA9IGNvbXB1dGVkS2V5ID8gZGlyZWN0aXZlLmV4cHJlc3Npb24gOiBrZXksXG5cdCAgICAgICAgZ2V0dGVyICAgICAgPSB0aGlzLmV4cENhY2hlW2V4cF1cblx0ICAgIGlmICghZ2V0dGVyKSB7XG5cdCAgICAgICAgZ2V0dGVyID0gdGhpcy5leHBDYWNoZVtleHBdID0gRXhwUGFyc2VyLnBhcnNlKGNvbXB1dGVkS2V5IHx8IGtleSwgdGhpcylcblx0ICAgIH1cblx0ICAgIGlmIChnZXR0ZXIpIHtcblx0ICAgICAgICB0aGlzLm1hcmtDb21wdXRlZChiaW5kaW5nLCBnZXR0ZXIpXG5cdCAgICB9XG5cdH0sXG5cdGRlZmluZUNvbXB1dGVkOiBmdW5jdGlvbiAoa2V5LCBiaW5kaW5nLCB2YWx1ZSkge1xuXHQgICAgdGhpcy5tYXJrQ29tcHV0ZWQoYmluZGluZywgdmFsdWUpXG5cdCAgICBkZWYodGhpcy52bSwga2V5LCB7XG5cdCAgICAgICAgZ2V0OiBiaW5kaW5nLnZhbHVlLiRnZXQsXG5cdCAgICAgICAgc2V0OiBiaW5kaW5nLnZhbHVlLiRzZXRcblx0ICAgIH0pXG5cdH0sXG5cdG1hcmtDb21wdXRlZDogZnVuY3Rpb24gKGJpbmRpbmcsIHZhbHVlKSB7XG5cdCAgICBiaW5kaW5nLmlzQ29tcHV0ZWQgPSB0cnVlXG5cdCAgICAvLyBiaW5kIHRoZSBhY2Nlc3NvcnMgdG8gdGhlIHZtXG5cdCAgICBpZiAoYmluZGluZy5pc0ZuKSB7XG5cdCAgICAgICAgYmluZGluZy52YWx1ZSA9IHZhbHVlXG5cdCAgICB9IGVsc2Uge1xuXHQgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdmdW5jdGlvbicpIHtcblx0ICAgICAgICAgICAgdmFsdWUgPSB7ICRnZXQ6IHZhbHVlIH1cblx0ICAgICAgICB9XG5cdCAgICAgICAgYmluZGluZy52YWx1ZSA9IHtcblx0ICAgICAgICAgICAgJGdldDogdXRpbHMuYmluZCh2YWx1ZS4kZ2V0LCB0aGlzLnZtKSxcblx0ICAgICAgICAgICAgJHNldDogdmFsdWUuJHNldFxuXHQgICAgICAgICAgICAgICAgPyB1dGlscy5iaW5kKHZhbHVlLiRzZXQsIHRoaXMudm0pXG5cdCAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZFxuXHQgICAgICAgIH1cblx0ICAgIH1cblx0ICAgIC8vIGtlZXAgdHJhY2sgZm9yIGRlcCBwYXJzaW5nIGxhdGVyXG5cdCAgICB0aGlzLmNvbXB1dGVkLnB1c2goYmluZGluZylcblx0fVxufSk7XG5cbi8qKlxuICogdXRpbGl0eSBmb3IgY29taXBsZXJcbiAqL1xudXRpbHMubWl4KENvbXBpbGVyLnByb3RvdHlwZSwge1xuXHRleGVjSG9vazogZnVuY3Rpb24gKGV2ZW50KSB7XG5cdCAgICBldmVudCA9ICdob29rOicgKyBldmVudDtcblx0ICAgIHRoaXMub2JzZXJ2ZXIuZW1pdChldmVudCk7XG5cdCAgICB0aGlzLmVtaXR0ZXIuZW1pdChldmVudCk7XG5cdH0sXG5cdGhhc0tleTogZnVuY3Rpb24gKGtleSkge1xuXHQgICAgdmFyIGJhc2VLZXkgPSB1dGlscy5iYXNlS2V5KGtleSlcblx0ICAgIHJldHVybiBoYXNPd24uY2FsbCh0aGlzLmRhdGEsIGJhc2VLZXkpIHx8XG5cdCAgICAgICAgaGFzT3duLmNhbGwodGhpcy52bSwgYmFzZUtleSlcblx0fSxcblx0LyoqXG5cdCAqICBEbyBhIG9uZS10aW1lIGV2YWwgb2YgYSBzdHJpbmcgdGhhdCBwb3RlbnRpYWxseVxuXHQgKiAgaW5jbHVkZXMgYmluZGluZ3MuIEl0IGFjY2VwdHMgYWRkaXRpb25hbCByYXcgZGF0YVxuXHQgKiAgYmVjYXVzZSB3ZSBuZWVkIHRvIGR5bmFtaWNhbGx5IHJlc29sdmUgdi1jb21wb25lbnRcblx0ICogIGJlZm9yZSBhIGNoaWxkVk0gaXMgZXZlbiBjb21waWxlZC4uLlxuXHQgKi9cblx0ZXZhbDogZnVuY3Rpb24gKGV4cCwgZGF0YSkge1xuXHQgICAgdmFyIHBhcnNlZCA9IFRleHRQYXJzZXIucGFyc2VBdHRyKGV4cClcblx0ICAgIHJldHVybiBwYXJzZWRcblx0ICAgICAgICA/IEV4cFBhcnNlci5ldmFsKHBhcnNlZCwgdGhpcywgZGF0YSlcblx0ICAgICAgICA6IGV4cDtcblx0fSxcblx0cmVzb2x2ZUNvbXBvbmVudDogZnVuY3Rpb24obm9kZSwgZGF0YSwgdGVzdCl7XG5cdFx0Ly8gbGF0ZSByZXF1aXJlIHRvIGF2b2lkIGNpcmN1bGFyIGRlcHNcblx0ICAgIFZpZXdNb2RlbCA9IFZpZXdNb2RlbCB8fCByZXF1aXJlKCcuL3ZpZXdtb2RlbCcpXG5cblx0ICAgIHZhciBleHAgICAgID0gdXRpbHMuZG9tLmF0dHIobm9kZSwgJ2NvbXBvbmVudCcpLFxuXHQgICAgICAgIHRhZ05hbWUgPSBub2RlLnRhZ05hbWUsXG5cdCAgICAgICAgaWQgICAgICA9IHRoaXMuZXZhbChleHAsIGRhdGEpLFxuXHQgICAgICAgIHRhZ0lkICAgPSAodGFnTmFtZS5pbmRleE9mKCctJykgPiAwICYmIHRhZ05hbWUudG9Mb3dlckNhc2UoKSksXG5cdCAgICAgICAgQ3RvciAgICA9IHRoaXMuZ2V0T3B0aW9uKCdjb21wb25lbnRzJywgaWQgfHwgdGFnSWQsIHRydWUpXG5cblx0ICAgIGlmIChpZCAmJiAhQ3Rvcikge1xuXHQgICAgICAgIHV0aWxzLndhcm4oJ1Vua25vd24gY29tcG9uZW50OiAnICsgaWQpXG5cdCAgICB9XG5cblx0ICAgIHJldHVybiB0ZXN0XG5cdCAgICAgICAgPyBleHAgPT09ICcnXG5cdCAgICAgICAgICAgID8gVmlld01vZGVsXG5cdCAgICAgICAgICAgIDogQ3RvclxuXHQgICAgICAgIDogQ3RvciB8fCBWaWV3TW9kZWw7XG5cdH0sXG5cdC8qKlxuXHQgKiAgUmV0cml2ZSBhbiBvcHRpb24gZnJvbSB0aGUgY29tcGlsZXJcblx0ICovXG5cdGdldE9wdGlvbjogZnVuY3Rpb24odHlwZSwgaWQsIHNpbGVudCl7XG5cdFx0dmFyIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnMsXG5cdCAgICAgICAgcGFyZW50ID0gdGhpcy5wYXJlbnQsXG5cdCAgICAgICAgZ2xvYmFsQXNzZXRzID0gY29uZmlnLmdsb2JhbEFzc2V0cyxcblx0ICAgICAgICByZXMgPSAob3B0aW9uc1t0eXBlXSAmJiBvcHRpb25zW3R5cGVdW2lkXSkgfHwgKFxuXHQgICAgICAgICAgICBwYXJlbnRcblx0ICAgICAgICAgICAgICAgID8gcGFyZW50LmdldE9wdGlvbih0eXBlLCBpZCwgc2lsZW50KVxuXHQgICAgICAgICAgICAgICAgOiBnbG9iYWxBc3NldHNbdHlwZV0gJiYgZ2xvYmFsQXNzZXRzW3R5cGVdW2lkXVxuXHQgICAgICAgICk7XG5cdCAgICBpZiAoIXJlcyAmJiAhc2lsZW50ICYmIHR5cGVvZiBpZCA9PT0gJ3N0cmluZycpIHtcblx0ICAgICAgICB1dGlscy53YXJuKCdVbmtub3duICcgKyB0eXBlLnNsaWNlKDAsIC0xKSArICc6ICcgKyBpZClcblx0ICAgIH1cblx0ICAgIHJldHVybiByZXM7XG5cdH1cbn0pO1xuXG5tb2R1bGUuZXhwb3J0cyA9IENvbXBpbGVyOyIsIm1vZHVsZS5leHBvcnRzID0ge1xuXHRwcmVmaXg6ICdqJyxcblx0ZGVidWc6IHRydWVcbn0iLCJ2YXIgdXRpbHMgPSByZXF1aXJlKCcuL3V0aWxzJyk7XG5mdW5jdGlvbiBEZWZlcnJlZCgpIHtcbiAgICB2YXIgRE9ORSA9ICdkb25lJyxcbiAgICAgICAgRkFJTCA9ICdmYWlsJyxcbiAgICAgICAgUEVORElORyA9ICdwZW5kaW5nJztcbiAgICB2YXIgc3RhdGUgPSBQRU5ESU5HO1xuICAgIHZhciBjYWxsYmFja3MgPSB7XG4gICAgICAgICdkb25lJzogW10sXG4gICAgICAgICdmYWlsJzogW10sXG4gICAgICAgICdhbHdheXMnOiBbXVxuICAgIH07XG4gICAgdmFyIGFyZ3MgPSBbXTtcbiAgICB2YXIgY29udGV4dDtcblxuICAgIGZ1bmN0aW9uIGRpc3BhdGNoKGNicykge1xuICAgICAgICB2YXIgY2I7XG4gICAgICAgIHdoaWxlICgoY2IgPSBjYnMuc2hpZnQoKSkgfHwgKGNiID0gY2FsbGJhY2tzLmFsd2F5cy5zaGlmdCgpKSkge1xuICAgICAgICAgICAgdXRpbHMubmV4dFRpY2soKGZ1bmN0aW9uKGZuKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBmbi5hcHBseShjb250ZXh0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSkoY2IpKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgICBkb25lOiBmdW5jdGlvbihjYikge1xuICAgICAgICAgICAgaWYgKHN0YXRlID09PSBET05FKSB7XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgY2IuYXBwbHkoY29udGV4dCwgYXJncyk7XG4gICAgICAgICAgICAgICAgfSwgMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoc3RhdGUgPT09IFBFTkRJTkcpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFja3MuZG9uZS5wdXNoKGNiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICBmYWlsOiBmdW5jdGlvbihjYikge1xuICAgICAgICAgICAgaWYgKHN0YXRlID09PSBGQUlMKSB7XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgY2IuYXBwbHkoY29udGV4dCwgYXJncyk7XG4gICAgICAgICAgICAgICAgfSwgMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoc3RhdGUgPT09IFBFTkRJTkcpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFja3MuZmFpbC5wdXNoKGNiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICBhbHdheXM6IGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBpZiAoc3RhdGUgIT09IFBFTkRJTkcpIHtcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICBjYi5hcHBseShjb250ZXh0LCBhcmdzKTtcbiAgICAgICAgICAgICAgICB9LCAwKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYWxsYmFja3MuYWx3YXlzLnB1c2goY2IpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIHRoZW46IGZ1bmN0aW9uKGRvbmVGbiwgZmFpbEZuKSB7XG4gICAgICAgICAgICBpZiAodXRpbHMuaXNGdW5jdGlvbihkb25lRm4pKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5kb25lKGRvbmVGbik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodXRpbHMuaXNGdW5jdGlvbihmYWlsRm4pKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5mYWlsKGZhaWxGbik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfSxcbiAgICAgICAgcmVzb2x2ZTogZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB0aGlzLnJlc29sdmVXaXRoKHt9LCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIHJlc29sdmVXaXRoOiBmdW5jdGlvbihjLCBhKSB7XG4gICAgICAgICAgICBpZiAoc3RhdGUgIT09IFBFTkRJTkcpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN0YXRlID0gRE9ORTtcbiAgICAgICAgICAgIGNvbnRleHQgPSBjIHx8IHRoaXM7XG4gICAgICAgICAgICBhcmdzID0gW10uc2xpY2UuY2FsbChhIHx8IFtdKTtcbiAgICAgICAgICAgIGRpc3BhdGNoKGNhbGxiYWNrcy5kb25lKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9LFxuICAgICAgICByZWplY3Q6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdGhpcy5yZWplY3RXaXRoKHt9LCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIHJlamVjdFdpdGg6IGZ1bmN0aW9uKGMsIGEpIHtcbiAgICAgICAgICAgIGlmIChzdGF0ZSAhPT0gUEVORElORykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3RhdGUgPSBGQUlMO1xuICAgICAgICAgICAgY29udGV4dCA9IGMgfHwgdGhpcztcbiAgICAgICAgICAgIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGEgfHwgW10pO1xuICAgICAgICAgICAgZGlzcGF0Y2goY2FsbGJhY2tzLmZhaWwpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH0sXG4gICAgICAgIHN0YXRlOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHJldHVybiBzdGF0ZTtcbiAgICAgICAgfSxcbiAgICAgICAgcHJvbWlzZTogZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICB2YXIgcmV0ID0ge30sXG4gICAgICAgICAgICAgICAgc2VsZiA9IHRoaXMsXG4gICAgICAgICAgICAgICAga2V5cyA9IHV0aWxzLm9iamVjdC5rZXlzKHRoaXMpO1xuICAgICAgICAgICAgdXRpbHMuZWFjaChrZXlzLCBmdW5jdGlvbihrKSB7XG4gICAgICAgICAgICAgICAgaWYgKGsgPT09ICdyZXNvbHZlJyB8fCBrID09PSAncmVqZWN0Jykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldFtrXSA9IHNlbGZba107XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cbiAgICB9O1xuICAgIHJldHVybiB0aGlzO1xufTtcbi8qKlxuICog5aSa5LiqZGVmZXJyZWTnmoTlvILmraVcbiAqIEBwYXJhbSAgW10gZGVmZXJzXG4gKiBAcmV0dXJuIG9iamVjdCBwcm9taXNl5a+56LGhXG4gKi9cbmZ1bmN0aW9uIHdoZW4oZGVmZXJzKSB7XG4gICAgdmFyIHJldCwgbGVuLCBjb3VudCA9IDA7XG4gICAgaWYgKCF1dGlscy5pc0FycmF5KGRlZmVycykpIHtcbiAgICAgICAgZGVmZXJzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuICAgIH1cbiAgICByZXQgPSBEZWZlcnJlZCgpO1xuICAgIGxlbiA9IGRlZmVycy5sZW5ndGg7XG4gICAgaWYgKCFsZW4pIHtcbiAgICAgICAgcmV0dXJuIHJldC5yZXNvbHZlKCkucHJvbWlzZSgpO1xuICAgIH1cbiAgICB1dGlscy5lYWNoKGRlZmVycywgZnVuY3Rpb24oZGVmZXIpIHtcbiAgICAgICAgZGVmZXIuZmFpbChmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIHJldC5yZWplY3QoKTtcbiAgICAgICAgfSkuZG9uZShmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmICgrK2NvdW50ID09PSBsZW4pIHtcbiAgICAgICAgICAgICAgICByZXQucmVzb2x2ZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICByZXR1cm4gcmV0LnByb21pc2UoKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIHdoZW46IHdoZW4sXG4gICAgRGVmZXJyZWQ6IERlZmVycmVkXG59IiwidmFyIGRpcklkICAgICAgICAgICA9IDEsXG4gICAgQVJHX1JFICAgICAgICAgID0gL15bXFx3XFwkLV0rJC8sXG4gICAgRklMVEVSX1RPS0VOX1JFID0gL1teXFxzJ1wiXSt8J1teJ10rJ3xcIlteXCJdK1wiL2csXG4gICAgTkVTVElOR19SRSAgICAgID0gL15cXCQocGFyZW50fHJvb3QpXFwuLyxcbiAgICBTSU5HTEVfVkFSX1JFICAgPSAvXltcXHdcXC4kXSskLyxcbiAgICBRVU9URV9SRSAgICAgICAgPSAvXCIvZyxcbiAgICBUZXh0UGFyc2VyICAgICAgPSByZXF1aXJlKCcuL3RleHRQYXJzZXInKTtcblxuLyoqXG4gKiAgRGlyZWN0aXZlIGNsYXNzXG4gKiAgcmVwcmVzZW50cyBhIHNpbmdsZSBkaXJlY3RpdmUgaW5zdGFuY2UgaW4gdGhlIERPTVxuICovXG5mdW5jdGlvbiBEaXJlY3RpdmUgKG5hbWUsIGFzdCwgZGVmaW5pdGlvbiwgY29tcGlsZXIsIGVsKSB7XG5cbiAgICB0aGlzLmlkICAgICAgICAgICAgID0gZGlySWQrK1xuICAgIHRoaXMubmFtZSAgICAgICAgICAgPSBuYW1lXG4gICAgdGhpcy5jb21waWxlciAgICAgICA9IGNvbXBpbGVyXG4gICAgdGhpcy52bSAgICAgICAgICAgICA9IGNvbXBpbGVyLnZtXG4gICAgdGhpcy5lbCAgICAgICAgICAgICA9IGVsXG4gICAgdGhpcy5jb21wdXRlRmlsdGVycyA9IGZhbHNlXG4gICAgdGhpcy5rZXkgICAgICAgICAgICA9IGFzdC5rZXlcbiAgICB0aGlzLmFyZyAgICAgICAgICAgID0gYXN0LmFyZ1xuICAgIHRoaXMuZXhwcmVzc2lvbiAgICAgPSBhc3QuZXhwcmVzc2lvblxuXG4gICAgdmFyIGlzRW1wdHkgPSB0aGlzLmV4cHJlc3Npb24gPT09ICcnXG5cbiAgICAvLyBtaXggaW4gcHJvcGVydGllcyBmcm9tIHRoZSBkaXJlY3RpdmUgZGVmaW5pdGlvblxuICAgIGlmICh0eXBlb2YgZGVmaW5pdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICB0aGlzW2lzRW1wdHkgPyAnYmluZCcgOiAndXBkYXRlJ10gPSBkZWZpbml0aW9uXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZm9yICh2YXIgcHJvcCBpbiBkZWZpbml0aW9uKSB7XG4gICAgICAgICAgICB0aGlzW3Byb3BdID0gZGVmaW5pdGlvbltwcm9wXVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gZW1wdHkgZXhwcmVzc2lvbiwgd2UncmUgZG9uZS5cbiAgICBpZiAoaXNFbXB0eSB8fCB0aGlzLmlzRW1wdHkpIHtcbiAgICAgICAgdGhpcy5pc0VtcHR5ID0gdHJ1ZVxuICAgICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAoVGV4dFBhcnNlci5SZWdleC50ZXN0KHRoaXMua2V5KSkge1xuICAgICAgICB0aGlzLmtleSA9IGNvbXBpbGVyLmV2YWwodGhpcy5rZXkpXG4gICAgICAgIGlmICh0aGlzLmlzTGl0ZXJhbCkge1xuICAgICAgICAgICAgdGhpcy5leHByZXNzaW9uID0gdGhpcy5rZXlcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHZhciBmaWx0ZXJzID0gYXN0LmZpbHRlcnMsXG4gICAgICAgIGZpbHRlciwgZm4sIGksIGwsIGNvbXB1dGVkXG4gICAgaWYgKGZpbHRlcnMpIHtcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gW11cbiAgICAgICAgZm9yIChpID0gMCwgbCA9IGZpbHRlcnMubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBmaWx0ZXIgPSBmaWx0ZXJzW2ldXG4gICAgICAgICAgICBmbiA9IHRoaXMuY29tcGlsZXIuZ2V0T3B0aW9uKCdmaWx0ZXJzJywgZmlsdGVyLm5hbWUpXG4gICAgICAgICAgICBpZiAoZm4pIHtcbiAgICAgICAgICAgICAgICBmaWx0ZXIuYXBwbHkgPSBmblxuICAgICAgICAgICAgICAgIHRoaXMuZmlsdGVycy5wdXNoKGZpbHRlcilcbiAgICAgICAgICAgICAgICBpZiAoZm4uY29tcHV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29tcHV0ZWQgPSB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLmZpbHRlcnMgfHwgIXRoaXMuZmlsdGVycy5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gbnVsbFxuICAgIH1cblxuICAgIGlmIChjb21wdXRlZCkge1xuICAgICAgICB0aGlzLmNvbXB1dGVkS2V5ID0gRGlyZWN0aXZlLmlubGluZUZpbHRlcnModGhpcy5rZXksIHRoaXMuZmlsdGVycylcbiAgICAgICAgdGhpcy5maWx0ZXJzID0gbnVsbFxuICAgIH1cblxuICAgIHRoaXMuaXNFeHAgPVxuICAgICAgICBjb21wdXRlZCB8fFxuICAgICAgICAhU0lOR0xFX1ZBUl9SRS50ZXN0KHRoaXMua2V5KSB8fFxuICAgICAgICBORVNUSU5HX1JFLnRlc3QodGhpcy5rZXkpXG5cbn1cblxudmFyIERpclByb3RvID0gRGlyZWN0aXZlLnByb3RvdHlwZVxuXG4vKipcbiAqICBjYWxsZWQgd2hlbiBhIG5ldyB2YWx1ZSBpcyBzZXQgXG4gKiAgZm9yIGNvbXB1dGVkIHByb3BlcnRpZXMsIHRoaXMgd2lsbCBvbmx5IGJlIGNhbGxlZCBvbmNlXG4gKiAgZHVyaW5nIGluaXRpYWxpemF0aW9uLlxuICovXG5EaXJQcm90by4kdXBkYXRlID0gZnVuY3Rpb24gKHZhbHVlLCBpbml0KSB7XG4gICAgaWYgKHRoaXMuJGxvY2spIHJldHVyblxuICAgIGlmIChpbml0IHx8IHZhbHVlICE9PSB0aGlzLnZhbHVlIHx8ICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSkge1xuICAgICAgICB0aGlzLnZhbHVlID0gdmFsdWVcbiAgICAgICAgaWYgKHRoaXMudXBkYXRlKSB7XG4gICAgICAgICAgICB0aGlzLnVwZGF0ZShcbiAgICAgICAgICAgICAgICB0aGlzLmZpbHRlcnMgJiYgIXRoaXMuY29tcHV0ZUZpbHRlcnNcbiAgICAgICAgICAgICAgICAgICAgPyB0aGlzLiRhcHBseUZpbHRlcnModmFsdWUpXG4gICAgICAgICAgICAgICAgICAgIDogdmFsdWUsXG4gICAgICAgICAgICAgICAgaW5pdFxuICAgICAgICAgICAgKVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBwaXBlIHRoZSB2YWx1ZSB0aHJvdWdoIGZpbHRlcnNcbiAqL1xuRGlyUHJvdG8uJGFwcGx5RmlsdGVycyA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHZhciBmaWx0ZXJlZCA9IHZhbHVlLCBmaWx0ZXJcbiAgICBmb3IgKHZhciBpID0gMCwgbCA9IHRoaXMuZmlsdGVycy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgZmlsdGVyID0gdGhpcy5maWx0ZXJzW2ldXG4gICAgICAgIGZpbHRlcmVkID0gZmlsdGVyLmFwcGx5LmFwcGx5KHRoaXMudm0sIFtmaWx0ZXJlZF0uY29uY2F0KGZpbHRlci5hcmdzKSlcbiAgICB9XG4gICAgcmV0dXJuIGZpbHRlcmVkXG59XG5cbi8qKlxuICogIFVuYmluZCBkaXJldGl2ZVxuICovXG5EaXJQcm90by4kdW5iaW5kID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIHRoaXMgY2FuIGJlIGNhbGxlZCBiZWZvcmUgdGhlIGVsIGlzIGV2ZW4gYXNzaWduZWQuLi5cbiAgICBpZiAoIXRoaXMuZWwgfHwgIXRoaXMudm0pIHJldHVyblxuICAgIGlmICh0aGlzLnVuYmluZCkgdGhpcy51bmJpbmQoKVxuICAgIHRoaXMudm0gPSB0aGlzLmVsID0gdGhpcy5iaW5kaW5nID0gdGhpcy5jb21waWxlciA9IG51bGxcbn1cblxuLy8gRXhwb3NlZCBzdGF0aWMgbWV0aG9kcyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqICBQYXJzZSBhIGRpcmVjdGl2ZSBzdHJpbmcgaW50byBhbiBBcnJheSBvZlxuICogIEFTVC1saWtlIG9iamVjdHMgcmVwcmVzZW50aW5nIGRpcmVjdGl2ZXNcbiAqL1xuRGlyZWN0aXZlLnBhcnNlID0gZnVuY3Rpb24gKHN0cikge1xuXG4gICAgdmFyIGluU2luZ2xlID0gZmFsc2UsXG4gICAgICAgIGluRG91YmxlID0gZmFsc2UsXG4gICAgICAgIGN1cmx5ICAgID0gMCxcbiAgICAgICAgc3F1YXJlICAgPSAwLFxuICAgICAgICBwYXJlbiAgICA9IDAsXG4gICAgICAgIGJlZ2luICAgID0gMCxcbiAgICAgICAgYXJnSW5kZXggPSAwLFxuICAgICAgICBkaXJzICAgICA9IFtdLFxuICAgICAgICBkaXIgICAgICA9IHt9LFxuICAgICAgICBsYXN0RmlsdGVySW5kZXggPSAwLFxuICAgICAgICBhcmdcblxuICAgIGZvciAodmFyIGMsIGkgPSAwLCBsID0gc3RyLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICBjID0gc3RyLmNoYXJBdChpKVxuICAgICAgICBpZiAoaW5TaW5nbGUpIHtcbiAgICAgICAgICAgIC8vIGNoZWNrIHNpbmdsZSBxdW90ZVxuICAgICAgICAgICAgaWYgKGMgPT09IFwiJ1wiKSBpblNpbmdsZSA9ICFpblNpbmdsZVxuICAgICAgICB9IGVsc2UgaWYgKGluRG91YmxlKSB7XG4gICAgICAgICAgICAvLyBjaGVjayBkb3VibGUgcXVvdGVcbiAgICAgICAgICAgIGlmIChjID09PSAnXCInKSBpbkRvdWJsZSA9ICFpbkRvdWJsZVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICcsJyAmJiAhcGFyZW4gJiYgIWN1cmx5ICYmICFzcXVhcmUpIHtcbiAgICAgICAgICAgIC8vIHJlYWNoZWQgdGhlIGVuZCBvZiBhIGRpcmVjdGl2ZVxuICAgICAgICAgICAgcHVzaERpcigpXG4gICAgICAgICAgICAvLyByZXNldCAmIHNraXAgdGhlIGNvbW1hXG4gICAgICAgICAgICBkaXIgPSB7fVxuICAgICAgICAgICAgYmVnaW4gPSBhcmdJbmRleCA9IGxhc3RGaWx0ZXJJbmRleCA9IGkgKyAxXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJzonICYmICFkaXIua2V5ICYmICFkaXIuYXJnKSB7XG4gICAgICAgICAgICAvLyBhcmd1bWVudFxuICAgICAgICAgICAgYXJnID0gc3RyLnNsaWNlKGJlZ2luLCBpKS50cmltKClcbiAgICAgICAgICAgIGlmIChBUkdfUkUudGVzdChhcmcpKSB7XG4gICAgICAgICAgICAgICAgYXJnSW5kZXggPSBpICsgMVxuICAgICAgICAgICAgICAgIGRpci5hcmcgPSBhcmdcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnfCcgJiYgc3RyLmNoYXJBdChpICsgMSkgIT09ICd8JyAmJiBzdHIuY2hhckF0KGkgLSAxKSAhPT0gJ3wnKSB7XG4gICAgICAgICAgICBpZiAoZGlyLmtleSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgLy8gZmlyc3QgZmlsdGVyLCBlbmQgb2Yga2V5XG4gICAgICAgICAgICAgICAgbGFzdEZpbHRlckluZGV4ID0gaSArIDFcbiAgICAgICAgICAgICAgICBkaXIua2V5ID0gc3RyLnNsaWNlKGFyZ0luZGV4LCBpKS50cmltKClcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gYWxyZWFkeSBoYXMgZmlsdGVyXG4gICAgICAgICAgICAgICAgcHVzaEZpbHRlcigpXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ1wiJykge1xuICAgICAgICAgICAgaW5Eb3VibGUgPSB0cnVlXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gXCInXCIpIHtcbiAgICAgICAgICAgIGluU2luZ2xlID0gdHJ1ZVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICcoJykge1xuICAgICAgICAgICAgcGFyZW4rK1xuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICcpJykge1xuICAgICAgICAgICAgcGFyZW4tLVxuICAgICAgICB9IGVsc2UgaWYgKGMgPT09ICdbJykge1xuICAgICAgICAgICAgc3F1YXJlKytcbiAgICAgICAgfSBlbHNlIGlmIChjID09PSAnXScpIHtcbiAgICAgICAgICAgIHNxdWFyZS0tXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ3snKSB7XG4gICAgICAgICAgICBjdXJseSsrXG4gICAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ30nKSB7XG4gICAgICAgICAgICBjdXJseS0tXG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKGkgPT09IDAgfHwgYmVnaW4gIT09IGkpIHtcbiAgICAgICAgcHVzaERpcigpXG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcHVzaERpciAoKSB7XG4gICAgICAgIGRpci5leHByZXNzaW9uID0gc3RyLnNsaWNlKGJlZ2luLCBpKS50cmltKClcbiAgICAgICAgaWYgKGRpci5rZXkgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgZGlyLmtleSA9IHN0ci5zbGljZShhcmdJbmRleCwgaSkudHJpbSgpXG4gICAgICAgIH0gZWxzZSBpZiAobGFzdEZpbHRlckluZGV4ICE9PSBiZWdpbikge1xuICAgICAgICAgICAgcHVzaEZpbHRlcigpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKGkgPT09IDAgfHwgZGlyLmtleSkge1xuICAgICAgICAgICAgZGlycy5wdXNoKGRpcilcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHB1c2hGaWx0ZXIgKCkge1xuICAgICAgICB2YXIgZXhwID0gc3RyLnNsaWNlKGxhc3RGaWx0ZXJJbmRleCwgaSkudHJpbSgpLFxuICAgICAgICAgICAgZmlsdGVyXG4gICAgICAgIGlmIChleHApIHtcbiAgICAgICAgICAgIGZpbHRlciA9IHt9XG4gICAgICAgICAgICB2YXIgdG9rZW5zID0gZXhwLm1hdGNoKEZJTFRFUl9UT0tFTl9SRSlcbiAgICAgICAgICAgIGZpbHRlci5uYW1lID0gdG9rZW5zWzBdXG4gICAgICAgICAgICBmaWx0ZXIuYXJncyA9IHRva2Vucy5sZW5ndGggPiAxID8gdG9rZW5zLnNsaWNlKDEpIDogbnVsbFxuICAgICAgICB9XG4gICAgICAgIGlmIChmaWx0ZXIpIHtcbiAgICAgICAgICAgIChkaXIuZmlsdGVycyA9IGRpci5maWx0ZXJzIHx8IFtdKS5wdXNoKGZpbHRlcilcbiAgICAgICAgfVxuICAgICAgICBsYXN0RmlsdGVySW5kZXggPSBpICsgMVxuICAgIH1cblxuICAgIHJldHVybiBkaXJzXG59XG5cbi8qKlxuICogIElubGluZSBjb21wdXRlZCBmaWx0ZXJzIHNvIHRoZXkgYmVjb21lIHBhcnRcbiAqICBvZiB0aGUgZXhwcmVzc2lvblxuICovXG5EaXJlY3RpdmUuaW5saW5lRmlsdGVycyA9IGZ1bmN0aW9uIChrZXksIGZpbHRlcnMpIHtcbiAgICB2YXIgYXJncywgZmlsdGVyXG4gICAgZm9yICh2YXIgaSA9IDAsIGwgPSBmaWx0ZXJzLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICBmaWx0ZXIgPSBmaWx0ZXJzW2ldXG4gICAgICAgIGFyZ3MgPSBmaWx0ZXIuYXJnc1xuICAgICAgICAgICAgPyAnLFwiJyArIGZpbHRlci5hcmdzLm1hcChlc2NhcGVRdW90ZSkuam9pbignXCIsXCInKSArICdcIidcbiAgICAgICAgICAgIDogJydcbiAgICAgICAga2V5ID0gJ3RoaXMuJGNvbXBpbGVyLmdldE9wdGlvbihcImZpbHRlcnNcIiwgXCInICtcbiAgICAgICAgICAgICAgICBmaWx0ZXIubmFtZSArXG4gICAgICAgICAgICAnXCIpLmNhbGwodGhpcywnICtcbiAgICAgICAgICAgICAgICBrZXkgKyBhcmdzICtcbiAgICAgICAgICAgICcpJ1xuICAgIH1cbiAgICByZXR1cm4ga2V5XG59XG5cbi8qKlxuICogIENvbnZlcnQgZG91YmxlIHF1b3RlcyB0byBzaW5nbGUgcXVvdGVzXG4gKiAgc28gdGhleSBkb24ndCBtZXNzIHVwIHRoZSBnZW5lcmF0ZWQgZnVuY3Rpb24gYm9keVxuICovXG5mdW5jdGlvbiBlc2NhcGVRdW90ZSAodikge1xuICAgIHJldHVybiB2LmluZGV4T2YoJ1wiJykgPiAtMVxuICAgICAgICA/IHYucmVwbGFjZShRVU9URV9SRSwgJ1xcJycpXG4gICAgICAgIDogdlxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IERpcmVjdGl2ZTsiLCIvKipcbiAqIEV2ZW50VGFyZ2V0IG1vZHVsZVxuICogQGF1dGhvcjogeHVlamlhLmN4ai82MTc0XG4gKi9cbnZhciB1dGlscyA9IHJlcXVpcmUoJy4vdXRpbHMnKTtcbmZ1bmN0aW9uIEV2ZW50VGFyZ2V0KGN0eCl7XG4gICAgdGhpcy5fY3R4ID0gY3R4IHx8IHRoaXM7ICBcbn1cblxudXRpbHMubWl4KEV2ZW50VGFyZ2V0LnByb3RvdHlwZSwge1xuICAgIG9uOiBmdW5jdGlvbih0eXBlLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgY29udGV4dCA9IHRoaXMuX2N0eCB8fCB0aGlzO1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFjayA9IGNvbnRleHQuX2NhbGxiYWNrIHx8IHt9O1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXSA9IGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdIHx8IFtdO1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXS5wdXNoKGNhbGxiYWNrKTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSxcbiAgICBvbmNlOiBmdW5jdGlvbihldmVudCwgZm4pe1xuICAgICAgICB2YXIgY29udGV4dCA9IHRoaXMuX2N0eCB8fCB0aGlzO1xuICAgICAgICBjb250ZXh0Ll9jYWxsYmFjayA9IGNvbnRleHQuX2NhbGxiYWNrIHx8IHt9O1xuICAgICAgICBmdW5jdGlvbiBvbigpe1xuICAgICAgICAgICAgY29udGV4dC5kZXRhY2goZXZlbnQsIG9uKTtcbiAgICAgICAgICAgIGZuLmFwcGx5KGNvbnRleHQsIGFyZ3VtZW50cyk7XG4gICAgICAgIH1cbiAgICAgICAgb24uZm4gPSBmbjtcbiAgICAgICAgY29udGV4dC5vbihldmVudCwgb24pO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9LFxuICAgIGRldGFjaDogZnVuY3Rpb24odHlwZSwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIGNvbnRleHQgPSB0aGlzLl9jdHggfHwgdGhpcztcbiAgICAgICAgY29udGV4dC5fY2FsbGJhY2sgPSBjb250ZXh0Ll9jYWxsYmFjayB8fCB7fTtcbiAgICAgICAgaWYgKCF0eXBlKSB7XG4gICAgICAgICAgICBjb250ZXh0Ll9jYWxsYmFjayA9IHt9O1xuICAgICAgICB9IGVsc2UgaWYgKCFjYWxsYmFjaykge1xuICAgICAgICAgICAgY29udGV4dC5fY2FsbGJhY2tbdHlwZV0gPSBbXTtcbiAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Ll9jYWxsYmFja1t0eXBlXSAmJiBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICB2YXIgaW5kZXggPSB1dGlscy5pbmRleE9mKGNhbGxiYWNrLCBjb250ZXh0Ll9jYWxsYmFja1t0eXBlXSk7XG4gICAgICAgICAgICBpZiAoaW5kZXggIT0gLTEpIGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdLnNwbGljZShpbmRleCwgMSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSxcbiAgICBmaXJlOiBmdW5jdGlvbih0eXBlLCBkYXRhKSB7XG4gICAgICAgIHZhciBjb250ZXh0ID0gdGhpcy5fY3R4IHx8IHRoaXM7XG4gICAgICAgIGlmIChjb250ZXh0Ll9jYWxsYmFjaykge1xuICAgICAgICAgICAgdmFyIGFyciA9IGNvbnRleHQuX2NhbGxiYWNrW3R5cGVdO1xuICAgICAgICAgICAgaWYgKGFyciAmJiBhcnIubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBkYXRhIHx8IHt9O1xuICAgICAgICAgICAgICAgIGRhdGEudHlwZSA9IHR5cGU7XG4gICAgICAgICAgICAgICAgZGF0YS50YXJnZXQgPSBjb250ZXh0O1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGkgPSBhcnIubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgICAgICAgICAgICAgICAgdXRpbHMuaXNGdW5jdGlvbihhcnJbaV0pICYmIGFycltpXS5jYWxsKGNvbnRleHQsIGRhdGEpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG59KTtcblxudXRpbHMubWl4KEV2ZW50VGFyZ2V0LnByb3RvdHlwZSwge1xuICAgIGVtaXQ6IEV2ZW50VGFyZ2V0LnByb3RvdHlwZS5maXJlLFxuICAgIG9mZjogRXZlbnRUYXJnZXQucHJvdG90eXBlLmRldGFjaFxufSk7XG5cbm1vZHVsZS5leHBvcnRzID0gRXZlbnRUYXJnZXQ7IiwidmFyIGNvbmZpZyAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICB1dGlscyAgICAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBkZWZlciAgICAgICA9IHJlcXVpcmUoJy4vZGVmZXJyZWQnKSxcbiAgICBQYXJzZXIgICAgICA9IHJlcXVpcmUoJy4vcGFyc2VyJyksXG4gICAgbWFrZUhhc2ggICAgPSB1dGlscy5oYXNoO1xuICAgIFZpZXdNb2RlbCAgID0gcmVxdWlyZSgnLi92aWV3bW9kZWwnKTtcblxuXG5WaWV3TW9kZWwub3B0aW9ucyA9IGNvbmZpZy5nbG9iYWxBc3NldHMgPSB7XG4gICAgZGlyZWN0aXZlcyAgOiByZXF1aXJlKCcuL2RpcmVjdGl2ZXMnKSxcbiAgICBmaWx0ZXJzICAgICA6IHJlcXVpcmUoJy4vZmlsdGVycycpLFxuICAgIHBhcnRpYWxzICAgIDogbWFrZUhhc2goKSxcbiAgICBlZmZlY3RzICAgICA6IG1ha2VIYXNoKCksXG4gICAgY29tcG9uZW50cyAgOiBtYWtlSGFzaCgpXG59O1xuXG51dGlscy5lYWNoKFsnZGlyZWN0aXZlJywgJ2ZpbHRlcicsICdwYXJ0aWFsJywgJ2VmZmVjdCcsICdjb21wb25lbnQnXSwgZnVuY3Rpb24odHlwZSl7XG5cdFZpZXdNb2RlbFt0eXBlXSA9IGZ1bmN0aW9uKGlkLCB2YWx1ZSl7XG5cdFx0dmFyIGhhc2ggPSB0aGlzLm9wdGlvbnNbdHlwZSArICdzJ107XG5cdFx0aWYoIWhhc2gpe1xuXHRcdFx0aGFzaCA9IHRoaXMub3B0aW9uc1t0eXBlICsgJ3MnXSA9IHV0aWxzLmhhc2goKTtcblx0XHR9XG5cdFx0aWYoIXZhbHVlKXtcblx0XHRcdHJldHVybiBoYXNoW2lkXTtcblx0XHR9XG5cdFx0aWYgKHR5cGUgPT09ICdwYXJ0aWFsJykge1xuICAgICAgICAgICAgdmFsdWUgPSBQYXJzZXIucGFyc2VUZW1wbGF0ZSh2YWx1ZSk7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2NvbXBvbmVudCcpIHtcbiAgICAgICAgICAgIC8vIHZhbHVlID0gdXRpbHMudG9Db25zdHJ1Y3Rvcih2YWx1ZSlcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnZmlsdGVyJykge1xuICAgICAgICAgICAgLy8gdXRpbHMuY2hlY2tGaWx0ZXIodmFsdWUpXG4gICAgICAgIH1cbiAgICAgICAgaGFzaFtpZF0gPSB2YWx1ZTtcbiAgICAgICAgcmV0dXJuIHRoaXM7XG5cdH1cbn0pO1xuXG53aW5kb3cuVk0gPSBWaWV3TW9kZWw7XG5tb2R1bGUuZXhwb3J0cyA9IFZpZXdNb2RlbDtcbiIsInZhciB1dGlscyAgICA9IHJlcXVpcmUoJy4vdXRpbHMnKSxcbiAgICBnZXQgICAgICA9IHV0aWxzLm9iamVjdC5nZXQsXG4gICAgc2xpY2UgICAgPSBbXS5zbGljZSxcbiAgICBRVU9URV9SRSA9IC9eJy4qJyQvLFxuICAgIGZpbHRlcnMgID0gbW9kdWxlLmV4cG9ydHMgPSB1dGlscy5oYXNoKClcblxuLyoqXG4gKiAgJ2FiYycgPT4gJ0FiYydcbiAqL1xuZmlsdGVycy5jYXBpdGFsaXplID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgaWYgKCF2YWx1ZSAmJiB2YWx1ZSAhPT0gMCkgcmV0dXJuICcnXG4gICAgdmFsdWUgPSB2YWx1ZS50b1N0cmluZygpXG4gICAgcmV0dXJuIHZhbHVlLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgdmFsdWUuc2xpY2UoMSlcbn1cblxuLyoqXG4gKiAgJ2FiYycgPT4gJ0FCQydcbiAqL1xuZmlsdGVycy51cHBlcmNhc2UgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICByZXR1cm4gKHZhbHVlIHx8IHZhbHVlID09PSAwKVxuICAgICAgICA/IHZhbHVlLnRvU3RyaW5nKCkudG9VcHBlckNhc2UoKVxuICAgICAgICA6ICcnXG59XG5cbi8qKlxuICogICdBYkMnID0+ICdhYmMnXG4gKi9cbmZpbHRlcnMubG93ZXJjYXNlID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgcmV0dXJuICh2YWx1ZSB8fCB2YWx1ZSA9PT0gMClcbiAgICAgICAgPyB2YWx1ZS50b1N0cmluZygpLnRvTG93ZXJDYXNlKClcbiAgICAgICAgOiAnJ1xufVxuXG4vKipcbiAqICAxMjM0NSA9PiAkMTIsMzQ1LjAwXG4gKi9cbmZpbHRlcnMuY3VycmVuY3kgPSBmdW5jdGlvbiAodmFsdWUsIHNpZ24pIHtcbiAgICB2YWx1ZSA9IHBhcnNlRmxvYXQodmFsdWUpXG4gICAgaWYgKCF2YWx1ZSAmJiB2YWx1ZSAhPT0gMCkgcmV0dXJuICcnXG4gICAgc2lnbiA9IHNpZ24gfHwgJyQnXG4gICAgdmFyIHMgPSBNYXRoLmZsb29yKHZhbHVlKS50b1N0cmluZygpLFxuICAgICAgICBpID0gcy5sZW5ndGggJSAzLFxuICAgICAgICBoID0gaSA+IDAgPyAocy5zbGljZSgwLCBpKSArIChzLmxlbmd0aCA+IDMgPyAnLCcgOiAnJykpIDogJycsXG4gICAgICAgIGYgPSAnLicgKyB2YWx1ZS50b0ZpeGVkKDIpLnNsaWNlKC0yKVxuICAgIHJldHVybiBzaWduICsgaCArIHMuc2xpY2UoaSkucmVwbGFjZSgvKFxcZHszfSkoPz1cXGQpL2csICckMSwnKSArIGZcbn1cblxuLyoqXG4gKiAgYXJnczogYW4gYXJyYXkgb2Ygc3RyaW5ncyBjb3JyZXNwb25kaW5nIHRvXG4gKiAgdGhlIHNpbmdsZSwgZG91YmxlLCB0cmlwbGUgLi4uIGZvcm1zIG9mIHRoZSB3b3JkIHRvXG4gKiAgYmUgcGx1cmFsaXplZC4gV2hlbiB0aGUgbnVtYmVyIHRvIGJlIHBsdXJhbGl6ZWRcbiAqICBleGNlZWRzIHRoZSBsZW5ndGggb2YgdGhlIGFyZ3MsIGl0IHdpbGwgdXNlIHRoZSBsYXN0XG4gKiAgZW50cnkgaW4gdGhlIGFycmF5LlxuICpcbiAqICBlLmcuIFsnc2luZ2xlJywgJ2RvdWJsZScsICd0cmlwbGUnLCAnbXVsdGlwbGUnXVxuICovXG5maWx0ZXJzLnBsdXJhbGl6ZSA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHZhciBhcmdzID0gc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpXG4gICAgcmV0dXJuIGFyZ3MubGVuZ3RoID4gMVxuICAgICAgICA/IChhcmdzW3ZhbHVlIC0gMV0gfHwgYXJnc1thcmdzLmxlbmd0aCAtIDFdKVxuICAgICAgICA6IChhcmdzW3ZhbHVlIC0gMV0gfHwgYXJnc1swXSArICdzJylcbn1cblxuLyoqXG4gKiAgQSBzcGVjaWFsIGZpbHRlciB0aGF0IHRha2VzIGEgaGFuZGxlciBmdW5jdGlvbixcbiAqICB3cmFwcyBpdCBzbyBpdCBvbmx5IGdldHMgdHJpZ2dlcmVkIG9uIHNwZWNpZmljIGtleXByZXNzZXMuXG4gKlxuICogIHYtb24gb25seVxuICovXG5cbnZhciBrZXlDb2RlcyA9IHtcbiAgICBlbnRlciAgICA6IDEzLFxuICAgIHRhYiAgICAgIDogOSxcbiAgICAnZGVsZXRlJyA6IDQ2LFxuICAgIHVwICAgICAgIDogMzgsXG4gICAgbGVmdCAgICAgOiAzNyxcbiAgICByaWdodCAgICA6IDM5LFxuICAgIGRvd24gICAgIDogNDAsXG4gICAgZXNjICAgICAgOiAyN1xufVxuXG5maWx0ZXJzLmtleSA9IGZ1bmN0aW9uIChoYW5kbGVyLCBrZXkpIHtcbiAgICBpZiAoIWhhbmRsZXIpIHJldHVyblxuICAgIHZhciBjb2RlID0ga2V5Q29kZXNba2V5XVxuICAgIGlmICghY29kZSkge1xuICAgICAgICBjb2RlID0gcGFyc2VJbnQoa2V5LCAxMClcbiAgICB9XG4gICAgcmV0dXJuIGZ1bmN0aW9uIChlKSB7XG4gICAgICAgIGlmIChlLmtleUNvZGUgPT09IGNvZGUpIHtcbiAgICAgICAgICAgIHJldHVybiBoYW5kbGVyLmNhbGwodGhpcywgZSlcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqXG4gKiAgRmlsdGVyIGZpbHRlciBmb3Igdi1yZXBlYXRcbiAqL1xuZmlsdGVycy5maWx0ZXJCeSA9IGZ1bmN0aW9uIChhcnIsIHNlYXJjaEtleSwgZGVsaW1pdGVyLCBkYXRhS2V5KSB7XG5cbiAgICAvLyBhbGxvdyBvcHRpb25hbCBgaW5gIGRlbGltaXRlclxuICAgIC8vIGJlY2F1c2Ugd2h5IG5vdFxuICAgIGlmIChkZWxpbWl0ZXIgJiYgZGVsaW1pdGVyICE9PSAnaW4nKSB7XG4gICAgICAgIGRhdGFLZXkgPSBkZWxpbWl0ZXJcbiAgICB9XG5cbiAgICAvLyBnZXQgdGhlIHNlYXJjaCBzdHJpbmdcbiAgICB2YXIgc2VhcmNoID0gc3RyaXBRdW90ZXMoc2VhcmNoS2V5KSB8fCB0aGlzLiRnZXQoc2VhcmNoS2V5KVxuICAgIGlmICghc2VhcmNoKSByZXR1cm4gYXJyXG4gICAgc2VhcmNoID0gc2VhcmNoLnRvTG93ZXJDYXNlKClcblxuICAgIC8vIGdldCB0aGUgb3B0aW9uYWwgZGF0YUtleVxuICAgIGRhdGFLZXkgPSBkYXRhS2V5ICYmIChzdHJpcFF1b3RlcyhkYXRhS2V5KSB8fCB0aGlzLiRnZXQoZGF0YUtleSkpXG5cbiAgICAvLyBjb252ZXJ0IG9iamVjdCB0byBhcnJheVxuICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSB7XG4gICAgICAgIGFyciA9IHV0aWxzLm9iamVjdFRvQXJyYXkoYXJyKVxuICAgIH1cblxuICAgIHJldHVybiBhcnIuZmlsdGVyKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICAgIHJldHVybiBkYXRhS2V5XG4gICAgICAgICAgICA/IGNvbnRhaW5zKGdldChpdGVtLCBkYXRhS2V5KSwgc2VhcmNoKVxuICAgICAgICAgICAgOiBjb250YWlucyhpdGVtLCBzZWFyY2gpXG4gICAgfSlcblxufVxuXG5maWx0ZXJzLmZpbHRlckJ5LmNvbXB1dGVkID0gdHJ1ZVxuXG4vKipcbiAqICBTb3J0IGZpdGxlciBmb3Igdi1yZXBlYXRcbiAqL1xuZmlsdGVycy5vcmRlckJ5ID0gZnVuY3Rpb24gKGFyciwgc29ydEtleSwgcmV2ZXJzZUtleSkge1xuXG4gICAgdmFyIGtleSA9IHN0cmlwUXVvdGVzKHNvcnRLZXkpIHx8IHRoaXMuJGdldChzb3J0S2V5KVxuICAgIGlmICgha2V5KSByZXR1cm4gYXJyXG5cbiAgICAvLyBjb252ZXJ0IG9iamVjdCB0byBhcnJheVxuICAgIGlmICghQXJyYXkuaXNBcnJheShhcnIpKSB7XG4gICAgICAgIGFyciA9IHV0aWxzLm9iamVjdFRvQXJyYXkoYXJyKVxuICAgIH1cblxuICAgIHZhciBvcmRlciA9IDFcbiAgICBpZiAocmV2ZXJzZUtleSkge1xuICAgICAgICBpZiAocmV2ZXJzZUtleSA9PT0gJy0xJykge1xuICAgICAgICAgICAgb3JkZXIgPSAtMVxuICAgICAgICB9IGVsc2UgaWYgKHJldmVyc2VLZXkuY2hhckF0KDApID09PSAnIScpIHtcbiAgICAgICAgICAgIHJldmVyc2VLZXkgPSByZXZlcnNlS2V5LnNsaWNlKDEpXG4gICAgICAgICAgICBvcmRlciA9IHRoaXMuJGdldChyZXZlcnNlS2V5KSA/IDEgOiAtMVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3JkZXIgPSB0aGlzLiRnZXQocmV2ZXJzZUtleSkgPyAtMSA6IDFcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIHNvcnQgb24gYSBjb3B5IHRvIGF2b2lkIG11dGF0aW5nIG9yaWdpbmFsIGFycmF5XG4gICAgcmV0dXJuIGFyci5zbGljZSgpLnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICAgICAgYSA9IGdldChhLCBrZXkpXG4gICAgICAgIGIgPSBnZXQoYiwga2V5KVxuICAgICAgICByZXR1cm4gYSA9PT0gYiA/IDAgOiBhID4gYiA/IG9yZGVyIDogLW9yZGVyXG4gICAgfSlcblxufVxuXG5maWx0ZXJzLm9yZGVyQnkuY29tcHV0ZWQgPSB0cnVlXG5cbi8vIEFycmF5IGZpbHRlciBoZWxwZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiAgU3RyaW5nIGNvbnRhaW4gaGVscGVyXG4gKi9cbmZ1bmN0aW9uIGNvbnRhaW5zICh2YWwsIHNlYXJjaCkge1xuICAgIC8qIGpzaGludCBlcWVxZXE6IGZhbHNlICovXG4gICAgaWYgKHV0aWxzLmlzT2JqZWN0KHZhbCkpIHtcbiAgICAgICAgZm9yICh2YXIga2V5IGluIHZhbCkge1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5zKHZhbFtrZXldLCBzZWFyY2gpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAodmFsICE9IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIHZhbC50b1N0cmluZygpLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihzZWFyY2gpID4gLTFcbiAgICB9XG59XG5cbi8qKlxuICogIFRlc3Qgd2hldGhlciBhIHN0cmluZyBpcyBpbiBxdW90ZXMsXG4gKiAgaWYgeWVzIHJldHVybiBzdHJpcHBlZCBzdHJpbmdcbiAqL1xuZnVuY3Rpb24gc3RyaXBRdW90ZXMgKHN0cikge1xuICAgIGlmIChRVU9URV9SRS50ZXN0KHN0cikpIHtcbiAgICAgICAgcmV0dXJuIHN0ci5zbGljZSgxLCAtMSlcbiAgICB9XG59IiwiLy8gc3RyaW5nIC0+IERPTSBjb252ZXJzaW9uXG4vLyB3cmFwcGVycyBvcmlnaW5hbGx5IGZyb20galF1ZXJ5LCBzY29vcGVkIGZyb20gY29tcG9uZW50L2RvbWlmeVxudmFyIG1hcCA9IHtcbiAgICBsZWdlbmQgICA6IFsxLCAnPGZpZWxkc2V0PicsICc8L2ZpZWxkc2V0PiddLFxuICAgIHRyICAgICAgIDogWzIsICc8dGFibGU+PHRib2R5PicsICc8L3Rib2R5PjwvdGFibGU+J10sXG4gICAgY29sICAgICAgOiBbMiwgJzx0YWJsZT48dGJvZHk+PC90Ym9keT48Y29sZ3JvdXA+JywgJzwvY29sZ3JvdXA+PC90YWJsZT4nXSxcbiAgICBfZGVmYXVsdCA6IFswLCAnJywgJyddXG59XG5cbm1hcC50ZCA9XG5tYXAudGggPSBbMywgJzx0YWJsZT48dGJvZHk+PHRyPicsICc8L3RyPjwvdGJvZHk+PC90YWJsZT4nXVxuXG5tYXAub3B0aW9uID1cbm1hcC5vcHRncm91cCA9IFsxLCAnPHNlbGVjdCBtdWx0aXBsZT1cIm11bHRpcGxlXCI+JywgJzwvc2VsZWN0PiddXG5cbm1hcC50aGVhZCA9XG5tYXAudGJvZHkgPVxubWFwLmNvbGdyb3VwID1cbm1hcC5jYXB0aW9uID1cbm1hcC50Zm9vdCA9IFsxLCAnPHRhYmxlPicsICc8L3RhYmxlPiddXG5cbm1hcC50ZXh0ID1cbm1hcC5jaXJjbGUgPVxubWFwLmVsbGlwc2UgPVxubWFwLmxpbmUgPVxubWFwLnBhdGggPVxubWFwLnBvbHlnb24gPVxubWFwLnBvbHlsaW5lID1cbm1hcC5yZWN0ID0gWzEsICc8c3ZnIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiB2ZXJzaW9uPVwiMS4xXCI+JywnPC9zdmc+J11cblxudmFyIFRBR19SRSA9IC88KFtcXHc6XSspL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uICh0ZW1wbGF0ZVN0cmluZykge1xuICAgIHZhciBmcmFnID0gZG9jdW1lbnQuY3JlYXRlRG9jdW1lbnRGcmFnbWVudCgpLFxuICAgICAgICBtID0gVEFHX1JFLmV4ZWModGVtcGxhdGVTdHJpbmcpXG4gICAgLy8gdGV4dCBvbmx5XG4gICAgaWYgKCFtKSB7XG4gICAgICAgIGZyYWcuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodGVtcGxhdGVTdHJpbmcpKVxuICAgICAgICByZXR1cm4gZnJhZ1xuICAgIH1cblxuICAgIHZhciB0YWcgPSBtWzFdLFxuICAgICAgICB3cmFwID0gbWFwW3RhZ10gfHwgbWFwLl9kZWZhdWx0LFxuICAgICAgICBkZXB0aCA9IHdyYXBbMF0sXG4gICAgICAgIHByZWZpeCA9IHdyYXBbMV0sXG4gICAgICAgIHN1ZmZpeCA9IHdyYXBbMl0sXG4gICAgICAgIG5vZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKVxuXG4gICAgbm9kZS5pbm5lckhUTUwgPSBwcmVmaXggKyB0ZW1wbGF0ZVN0cmluZy50cmltKCkgKyBzdWZmaXhcbiAgICB3aGlsZSAoZGVwdGgtLSkgbm9kZSA9IG5vZGUubGFzdENoaWxkXG5cbiAgICAvLyBvbmUgZWxlbWVudFxuICAgIGlmIChub2RlLmZpcnN0Q2hpbGQgPT09IG5vZGUubGFzdENoaWxkKSB7XG4gICAgICAgIGZyYWcuYXBwZW5kQ2hpbGQobm9kZS5maXJzdENoaWxkKVxuICAgICAgICByZXR1cm4gZnJhZ1xuICAgIH1cblxuICAgIC8vIG11bHRpcGxlIG5vZGVzLCByZXR1cm4gYSBmcmFnbWVudFxuICAgIHZhciBjaGlsZFxuICAgIC8qIGpzaGludCBib3NzOiB0cnVlICovXG4gICAgd2hpbGUgKGNoaWxkID0gbm9kZS5maXJzdENoaWxkKSB7XG4gICAgICAgIGlmIChub2RlLm5vZGVUeXBlID09PSAxKSB7XG4gICAgICAgICAgICBmcmFnLmFwcGVuZENoaWxkKGNoaWxkKVxuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmcmFnXG59IiwidmFyIEV2ZW50VGFyZ2V0ID0gcmVxdWlyZSgnLi9ldmVudFRhcmdldCcpLFxuICAgIHV0aWxzICAgICAgID0gcmVxdWlyZSgnLi91dGlscycpLFxuICAgIGNvbmZpZyAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICBkZWYgICAgICAgICA9IE9iamVjdC5kZWZpbmVQcm9wZXJ0eSxcbiAgICBoYXNQcm90byAgICA9ICh7fSkuX19wcm90b19fO1xudmFyIEFycmF5UHJveHkgID0gT2JqZWN0LmNyZWF0ZShBcnJheS5wcm90b3R5cGUpO1xudmFyIE9ialByb3h5ICAgID0gT2JqZWN0LmNyZWF0ZShPYmplY3QucHJvdG90eXBlKTtcbnV0aWxzLm1peChBcnJheVByb3h5LCB7XG4gICAgJyRzZXQnOiBmdW5jdGlvbiBzZXQoaW5kZXgsIGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuc3BsaWNlKGluZGV4LCAxLCBkYXRhKVswXVxuICAgIH0sXG4gICAgJyRyZW1vdmUnOiBmdW5jdGlvbiByZW1vdmUoaW5kZXgpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBpbmRleCAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIGluZGV4ID0gdGhpcy5pbmRleE9mKGluZGV4KVxuICAgICAgICB9XG4gICAgICAgIGlmIChpbmRleCA+IC0xKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5zcGxpY2UoaW5kZXgsIDEpWzBdXG4gICAgICAgIH1cbiAgICB9XG59KTtcbnV0aWxzLm1peChPYmpQcm94eSwge1xuICAgICckYWRkJzogZnVuY3Rpb24gYWRkKGtleSwgdmFsKSB7XG4gICAgICAgIGlmICh1dGlscy5vYmplY3QuaGFzKHRoaXMsIGtleSkpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aGlzW2tleV0gPSB2YWw7XG4gICAgICAgIGNvbnZlcnRLZXkodGhpcywga2V5LCB0cnVlKTtcbiAgICB9LFxuICAgICckZGVsZXRlJzogZnVuY3Rpb24gKGtleSkge1xuICAgIFx0aWYgKCF1dGlscy5vYmplY3QuaGFzKHRoaXMsIGtleSkpe1xuICAgIFx0XHRyZXR1cm47XG4gICAgXHR9XG4gICAgXHRkZWxldGUgdGhpc1trZXldO1xuICAgIFx0dGhpcy5fX2VtaXR0ZXJfXy5lbWl0KCdkZWxldGUnLCBrZXkpO1xuICAgIH1cbn0pO1xuLyoqXG4gKiAgSU5URVJDRVAgQSBNVVRBVElPTiBFVkVOVCBTTyBXRSBDQU4gRU1JVCBUSEUgTVVUQVRJT04gSU5GTy5cbiAqICBXRSBBTFNPIEFOQUxZWkUgV0hBVCBFTEVNRU5UUyBBUkUgQURERUQvUkVNT1ZFRCBBTkQgTElOSy9VTkxJTktcbiAqICBUSEVNIFdJVEggVEhFIFBBUkVOVCBBUlJBWS5cbiAqL1xudXRpbHMuZWFjaChbJ3B1c2gnLCAncG9wJywgJ3NoaWZ0JywgJ3Vuc2hpZnQnLCAnc3BsaWNlJywgJ3NvcnQnLCAncmV2ZXJzZSddLCBmdW5jdGlvbih0eXBlKSB7XG4gICAgQXJyYXlQcm94eVt0eXBlXSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSxcbiAgICAgICAgICAgIHJlc3VsdCA9IEFycmF5LnByb3RvdHlwZVttZXRob2RdLmFwcGx5KHRoaXMsIGFyZ3MpLFxuICAgICAgICAgICAgaW5zZXJ0ZWQsIHJlbW92ZWQ7XG4gICAgICAgIC8vIGRldGVybWluZSBuZXcgLyByZW1vdmVkIGVsZW1lbnRzXG4gICAgICAgIGlmIChtZXRob2QgPT09ICdwdXNoJyB8fCBtZXRob2QgPT09ICd1bnNoaWZ0Jykge1xuICAgICAgICAgICAgaW5zZXJ0ZWQgPSBhcmdzO1xuICAgICAgICB9IGVsc2UgaWYgKG1ldGhvZCA9PT0gJ3BvcCcgfHwgbWV0aG9kID09PSAnc2hpZnQnKSB7XG4gICAgICAgICAgICByZW1vdmVkID0gW3Jlc3VsdF07XG4gICAgICAgIH0gZWxzZSBpZiAobWV0aG9kID09PSAnc3BsaWNlJykge1xuICAgICAgICAgICAgaW5zZXJ0ZWQgPSBhcmdzLnNsaWNlKDIpXG4gICAgICAgICAgICByZW1vdmVkID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIC8vIGxpbmsgJiB1bmxpbmtcbiAgICAgICAgbGlua0FycmF5RWxlbWVudHModGhpcywgaW5zZXJ0ZWQpXG4gICAgICAgIHVubGlua0FycmF5RWxlbWVudHModGhpcywgcmVtb3ZlZClcbiAgICAgICAgLy8gZW1pdCB0aGUgbXV0YXRpb24gZXZlbnRcbiAgICAgICAgdGhpcy5fX2VtaXR0ZXJfXy5lbWl0KCdtdXRhdGUnLCAnJywgdGhpcywge1xuICAgICAgICAgICAgbWV0aG9kOiBtZXRob2QsXG4gICAgICAgICAgICBhcmdzOiBhcmdzLFxuICAgICAgICAgICAgcmVzdWx0OiByZXN1bHQsXG4gICAgICAgICAgICBpbnNlcnRlZDogaW5zZXJ0ZWQsXG4gICAgICAgICAgICByZW1vdmVkOiByZW1vdmVkXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cbn0pO1xuLyoqXG4gKiAgTGluayBuZXcgZWxlbWVudHMgdG8gYW4gQXJyYXksIHNvIHdoZW4gdGhleSBjaGFuZ2VcbiAqICBhbmQgZW1pdCBldmVudHMsIHRoZSBvd25lciBBcnJheSBjYW4gYmUgbm90aWZpZWQuXG4gKi9cbmZ1bmN0aW9uIGxpbmtBcnJheUVsZW1lbnRzKGFyciwgaXRlbXMpIHtcbiAgICBpZiAoaXRlbXMpIHtcbiAgICAgICAgdmFyIGkgPSBpdGVtcy5sZW5ndGgsXG4gICAgICAgICAgICBpdGVtLCBvd25lcnNcbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAgaXRlbSA9IGl0ZW1zW2ldXG4gICAgICAgICAgICBpZiAoaXNXYXRjaGFibGUoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICAvLyBpZiBvYmplY3QgaXMgbm90IGNvbnZlcnRlZCBmb3Igb2JzZXJ2aW5nXG4gICAgICAgICAgICAgICAgLy8gY29udmVydCBpdC4uLlxuICAgICAgICAgICAgICAgIGlmICghaXRlbS5fX2VtaXR0ZXJfXykge1xuICAgICAgICAgICAgICAgICAgICBjb252ZXJ0KGl0ZW0pXG4gICAgICAgICAgICAgICAgICAgIHdhdGNoKGl0ZW0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG93bmVycyA9IGl0ZW0uX19lbWl0dGVyX18ub3duZXJzXG4gICAgICAgICAgICAgICAgaWYgKG93bmVycy5pbmRleE9mKGFycikgPCAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG93bmVycy5wdXNoKGFycilcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG4vKipcbiAqICBVbmxpbmsgcmVtb3ZlZCBlbGVtZW50cyBmcm9tIHRoZSBleC1vd25lciBBcnJheS5cbiAqL1xuZnVuY3Rpb24gdW5saW5rQXJyYXlFbGVtZW50cyhhcnIsIGl0ZW1zKSB7XG4gICAgaWYgKGl0ZW1zKSB7XG4gICAgICAgIHZhciBpID0gaXRlbXMubGVuZ3RoLFxuICAgICAgICAgICAgaXRlbVxuICAgICAgICB3aGlsZSAoaS0tKSB7XG4gICAgICAgICAgICBpdGVtID0gaXRlbXNbaV1cbiAgICAgICAgICAgIGlmIChpdGVtICYmIGl0ZW0uX19lbWl0dGVyX18pIHtcbiAgICAgICAgICAgICAgICB2YXIgb3duZXJzID0gaXRlbS5fX2VtaXR0ZXJfXy5vd25lcnNcbiAgICAgICAgICAgICAgICBpZiAob3duZXJzKSBvd25lcnMuc3BsaWNlKG93bmVycy5pbmRleE9mKGFycikpXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG4vKipcbiAqICBDSEVDSyBJRiBBIFZBTFVFIElTIFdBVENIQUJMRVxuICovXG5mdW5jdGlvbiBpc1dhdGNoYWJsZShvYmopIHtcbiAgICByZXR1cm4gdHlwZW9mIG9iaiA9PT0gJ29iamVjdCcgJiYgb2JqICYmICFvYmouJGNvbXBpbGVyXG59XG4vKipcbiAqICBDT05WRVJUIEFOIE9CSkVDVC9BUlJBWSBUTyBHSVZFIElUIEEgQ0hBTkdFIEVNSVRURVIuXG4gKi9cbmZ1bmN0aW9uIGNvbnZlcnQob2JqKSB7XG4gICAgaWYgKG9iai5fX2VtaXR0ZXJfXykgcmV0dXJuIHRydWVcbiAgICB2YXIgZW1pdHRlciA9IG5ldyBFdmVudFRhcmdldCgpO1xuICAgIG9ialsnX19lbWl0dGVyX18nXSA9IGVtaXR0ZXI7XG4gICAgZW1pdHRlci5vbignc2V0JywgZnVuY3Rpb24oa2V5LCB2YWwsIHByb3BhZ2F0ZSkge1xuICAgICAgICBpZiAocHJvcGFnYXRlKSBwcm9wYWdhdGVDaGFuZ2Uob2JqKVxuICAgIH0pO1xuICAgIGVtaXR0ZXIub24oJ211dGF0ZScsIGZ1bmN0aW9uKCkge1xuICAgICAgICBwcm9wYWdhdGVDaGFuZ2Uob2JqKVxuICAgIH0pO1xuICAgIGVtaXR0ZXIudmFsdWVzID0gdXRpbHMuaGFzaCgpO1xuICAgIGVtaXR0ZXIub3duZXJzID0gW107XG4gICAgcmV0dXJuIGZhbHNlO1xufVxuLyoqXG4gKiAgUFJPUEFHQVRFIEFOIEFSUkFZIEVMRU1FTlQnUyBDSEFOR0UgVE8gSVRTIE9XTkVSIEFSUkFZU1xuICovXG5mdW5jdGlvbiBwcm9wYWdhdGVDaGFuZ2Uob2JqKSB7XG4gICAgdmFyIG93bmVycyA9IG9iai5fX2VtaXR0ZXJfXy5vd25lcnMsXG4gICAgICAgIGkgPSBvd25lcnMubGVuZ3RoXG4gICAgd2hpbGUgKGktLSkge1xuICAgICAgICBvd25lcnNbaV0uX19lbWl0dGVyX18uZW1pdCgnc2V0JywgJycsICcnLCB0cnVlKVxuICAgIH1cbn1cbi8qKlxuICogIFdBVENIIFRBUkdFVCBCQVNFRCBPTiBJVFMgVFlQRVxuICovXG5mdW5jdGlvbiB3YXRjaChvYmopIHtcbiAgICBpZiAodXRpbHMuaXNBcnJheShvYmopKSB7XG4gICAgICAgIHdhdGNoQXJyYXkob2JqKVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHdhdGNoT2JqZWN0KG9iailcbiAgICB9XG59XG4vKipcbiAqICBXYXRjaCBhbiBPYmplY3QsIHJlY3Vyc2l2ZS5cbiAqL1xuZnVuY3Rpb24gd2F0Y2hPYmplY3Qob2JqKSB7XG4gICAgYXVnbWVudChvYmosIE9ialByb3h5KVxuICAgIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICAgICAgY29udmVydEtleShvYmosIGtleSlcbiAgICB9XG59XG4vKipcbiAqICBXQVRDSCBBTiBBUlJBWSwgT1ZFUkxPQUQgTVVUQVRJT04gTUVUSE9EU1xuICogIEFORCBBREQgQVVHTUVOVEFUSU9OUyBCWSBJTlRFUkNFUFRJTkcgVEhFIFBST1RPVFlQRSBDSEFJTlxuICovXG5mdW5jdGlvbiB3YXRjaEFycmF5KGFycikge1xuICAgIGF1Z21lbnQoYXJyLCBBcnJheVByb3h5KTtcbiAgICBsaW5rQXJyYXlFbGVtZW50cyhhcnIsIGFycik7XG59XG4vKipcbiAqICBBVUdNRU5UIFRBUkdFVCBPQkpFQ1RTIFdJVEggTU9ESUZJRURcbiAqICBNRVRIT0RTXG4gKi9cbmZ1bmN0aW9uIGF1Z21lbnQodGFyZ2V0LCBzcmMpIHtcbiAgICBpZiAoaGFzUHJvdG8pIHtcbiAgICAgICAgdGFyZ2V0Ll9fcHJvdG9fXyA9IHNyY1xuICAgIH0gZWxzZSB7XG4gICAgXHR1dGlscy5taXgodGFyZ2V0LCBzcmMpO1xuICAgIH1cbn1cblxuXG4vKipcbiAqICBERUZJTkUgQUNDRVNTT1JTIEZPUiBBIFBST1BFUlRZIE9OIEFOIE9CSkVDVFxuICogIFNPIElUIEVNSVRTIEdFVC9TRVQgRVZFTlRTLlxuICogIFRIRU4gV0FUQ0ggVEhFIFZBTFVFIElUU0VMRi5cbiAqL1xuZnVuY3Rpb24gY29udmVydEtleSAob2JqLCBrZXksIHByb3BhZ2F0ZSl7XG5cdHZhciBrZXlQcmVmaXggPSBrZXkuY2hhckF0KDApO1xuXHRpZiAoa2V5UHJlZml4ID09PSAnJCcgfHwga2V5UHJlZml4ID09PSAnXycpe1xuXHRcdHJldHVybjtcblx0fVxuXHR2YXIgZW1pdHRlciA9IG9iai5fX2VtaXR0ZXJfXyxcblx0XHR2YWx1ZXMgID0gZW1pdHRlci52YWx1ZXM7XG5cblx0aW5pdChvYmpba2V5XSwgcHJvcGFnYXRlKTtcblx0T2JqZWN0LmRlZmluZVByb3BlcnR5KG9iaiwga2V5LCB7XG5cdFx0ZW51bWVyYWJsZTogdHJ1ZSxcblx0XHRjb25maWd1cmFibGU6IHRydWUsXG5cdFx0Z2V0OiBmdW5jdGlvbiAoKSB7XG5cdFx0XHR2YXIgdmFsdWUgPSB2YWx1ZXNba2V5XTtcblx0XHRcdGlmIChjb25maWcuZW1taXRHZXQpIHtcblx0XHRcdFx0ZW1pdHRlci5lbWl0KCdnZXQnLCBrZXkpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH0sXG5cdFx0c2V0OiBmdW5jdGlvbiAobmV3VmFsdWUpe1xuXHRcdFx0dmFyIG9sZFZhbHVlID0gdmFsdWVzW2tleV07XG5cdFx0XHR1Ym9ic2VydmUob2xkVmFsdWUsIGtleSwgZW1pdHRlcik7XG5cdFx0XHRjb3B5UGF0aHMobmV3VmFsdWUsIG9sZFZhbHVlKTtcblx0XHRcdGluaXQobmV3VmFsdWUsIHRydWUpO1xuXHRcdH1cblx0fSk7XG5cdGZ1bmN0aW9uIGluaXQgKHZhbCwgcHJvcGFnYXRlKXtcblx0XHR2YWx1ZXNba2V5XSA9IHZhbDtcblx0XHRlbWl0dGVyLmVtaXQoJ3NldCcsIGtleSwgdmFsLCBwcm9wYWdhdGUpO1xuXHRcdGlmICh1dGlscy5pc0FycmF5KHZhbCkpIHtcblx0XHRcdGVtaXR0ZXIuZW1pdCgnc2V0Jywga2V5ICsgJy5sZW5ndGgnLCB2YWwubGVuZ3RoLCBwcm9wYWdhdGUpO1xuXHRcdH1cblx0XHRvYnNlcnZlKHZhbCwga2V5LCBlbWl0dGVyKTtcblx0fVxufVxuXG4vKipcbiAqICBXaGVuIGEgdmFsdWUgdGhhdCBpcyBhbHJlYWR5IGNvbnZlcnRlZCBpc1xuICogIG9ic2VydmVkIGFnYWluIGJ5IGFub3RoZXIgb2JzZXJ2ZXIsIHdlIGNhbiBza2lwXG4gKiAgdGhlIHdhdGNoIGNvbnZlcnNpb24gYW5kIHNpbXBseSBlbWl0IHNldCBldmVudCBmb3JcbiAqICBhbGwgb2YgaXRzIHByb3BlcnRpZXMuXG4gKi9cbmZ1bmN0aW9uIGVtaXRTZXQgKG9iaikge1xuICAgIHZhciBlbWl0dGVyID0gb2JqICYmIG9iai5fX2VtaXR0ZXJfX1xuICAgIGlmICghZW1pdHRlcikgcmV0dXJuO1xuICAgIGlmICh1dGlscy5pc0FycmF5KG9iaikpIHtcbiAgICAgICAgZW1pdHRlci5lbWl0KCdzZXQnLCAnbGVuZ3RoJywgb2JqLmxlbmd0aCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGtleSwgdmFsXG4gICAgICAgIGZvciAoa2V5IGluIG9iaikge1xuICAgICAgICAgICAgdmFsID0gb2JqW2tleV1cbiAgICAgICAgICAgIGVtaXR0ZXIuZW1pdCgnc2V0Jywga2V5LCB2YWwpO1xuICAgICAgICAgICAgZW1pdFNldCh2YWwpO1xuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICBNYWtlIHN1cmUgYWxsIHRoZSBwYXRocyBpbiBhbiBvbGQgb2JqZWN0IGV4aXN0c1xuICogIGluIGEgbmV3IG9iamVjdC5cbiAqICBTbyB3aGVuIGFuIG9iamVjdCBjaGFuZ2VzLCBhbGwgbWlzc2luZyBrZXlzIHdpbGxcbiAqICBlbWl0IGEgc2V0IGV2ZW50IHdpdGggdW5kZWZpbmVkIHZhbHVlLlxuICovXG5mdW5jdGlvbiBjb3B5UGF0aHMgKG5ld09iaiwgb2xkT2JqKSB7XG4gICAgaWYgKCFpc09iamVjdChuZXdPYmopIHx8ICFpc09iamVjdChvbGRPYmopKSB7XG4gICAgICAgIHJldHVyblxuICAgIH1cbiAgICB2YXIgcGF0aCwgb2xkVmFsLCBuZXdWYWw7XG4gICAgZm9yIChwYXRoIGluIG9sZE9iaikge1xuICAgICAgICBpZiAoISh1dGlscy5vYmplY3QuaGFzKG5ld09iaiwgcGF0aCkpKSB7XG4gICAgICAgICAgICBvbGRWYWwgPSBvbGRPYmpbcGF0aF1cbiAgICAgICAgICAgIGlmICh1dGlscy5pc0FycmF5KG9sZFZhbCkpIHtcbiAgICAgICAgICAgICAgICBuZXdPYmpbcGF0aF0gPSBbXVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpc09iamVjdChvbGRWYWwpKSB7XG4gICAgICAgICAgICAgICAgbmV3VmFsID0gbmV3T2JqW3BhdGhdID0ge31cbiAgICAgICAgICAgICAgICBjb3B5UGF0aHMobmV3VmFsLCBvbGRWYWwpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG5ld09ialtwYXRoXSA9IHVuZGVmaW5lZFxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuXG4vKipcbiAqICB3YWxrIGFsb25nIGEgcGF0aCBhbmQgbWFrZSBzdXJlIGl0IGNhbiBiZSBhY2Nlc3NlZFxuICogIGFuZCBlbnVtZXJhdGVkIGluIHRoYXQgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIGVuc3VyZVBhdGggKG9iaiwga2V5KSB7XG4gICAgdmFyIHBhdGggPSBrZXkuc3BsaXQoJy4nKSwgc2VjXG4gICAgZm9yICh2YXIgaSA9IDAsIGQgPSBwYXRoLmxlbmd0aCAtIDE7IGkgPCBkOyBpKyspIHtcbiAgICAgICAgc2VjID0gcGF0aFtpXVxuICAgICAgICBpZiAoIW9ialtzZWNdKSB7XG4gICAgICAgICAgICBvYmpbc2VjXSA9IHt9XG4gICAgICAgICAgICBpZiAob2JqLl9fZW1pdHRlcl9fKSBjb252ZXJ0S2V5KG9iaiwgc2VjKVxuICAgICAgICB9XG4gICAgICAgIG9iaiA9IG9ialtzZWNdXG4gICAgfVxuICAgIGlmICh1dGlscy5pc09iamVjdChvYmopKSB7XG4gICAgICAgIHNlYyA9IHBhdGhbaV1cbiAgICAgICAgaWYgKCEoaGFzT3duLmNhbGwob2JqLCBzZWMpKSkge1xuICAgICAgICAgICAgb2JqW3NlY10gPSB1bmRlZmluZWRcbiAgICAgICAgICAgIGlmIChvYmouX19lbWl0dGVyX18pIGNvbnZlcnRLZXkob2JqLCBzZWMpXG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIG9ic2VydmUgKG9iaiwgcmF3UGF0aCwgb2JzZXJ2ZXIpIHtcblx0aWYgKCFpc1dhdGNoYWJsZShvYmopKSByZXR1cm47XG5cblx0dmFyIHBhdGggPSByYXdQYXRoID8gcmF3UGF0aCArICcuJyA6ICcnLFxuXHRcdGFscmVhZHlDb252ZXJ0ZWQgPSBjb252ZXJ0KG9iaiksXG5cdFx0ZW1pdHRlciA9IG9iai5fX2VtaXR0ZXJfXztcblxuXHQvLyBzZXR1cCBwcm94eSBsaXN0ZW5lcnMgb24gdGhlIHBhcmVudCBvYnNlcnZlci5cbiAgICAvLyB3ZSBuZWVkIHRvIGtlZXAgcmVmZXJlbmNlIHRvIHRoZW0gc28gdGhhdCB0aGV5XG4gICAgLy8gY2FuIGJlIHJlbW92ZWQgd2hlbiB0aGUgb2JqZWN0IGlzIHVuLW9ic2VydmVkLlxuXHRvYnNlcnZlci5wcm94aWVzID0gb2JzZXJ2ZXIucHJveGllcyB8fCB7fTtcblx0dmFyIHByb3hpZXMgPSBvYnNlcnZlci5wcm94aWVzW3BhdGhdID0ge1xuXHRcdGdldDogZnVuY3Rpb24oa2V5KXtcblx0XHRcdG9ic2VydmVyLmVtaXQoJ2dldCcsIHBhdGggKyBrZXkpO1xuXHRcdH0sXG5cdFx0c2V0OiBmdW5jdGlvbihrZXksIHZhbCwgcHJvcGFnYXRlKXtcblx0XHRcdGlmIChrZXkpIG9ic2VydmVyLmVtaXQoJ3NldCcsIHBhdGggKyBrZXksIHZhbCk7XG5cdFx0XHQvLyBhbHNvIG5vdGlmeSBvYnNlcnZlciB0aGF0IHRoZSBvYmplY3QgaXRzZWxmIGNoYW5nZWRcbiAgICAgICAgICAgIC8vIGJ1dCBvbmx5IGRvIHNvIHdoZW4gaXQncyBhIGltbWVkaWF0ZSBwcm9wZXJ0eS4gdGhpc1xuICAgICAgICAgICAgLy8gYXZvaWRzIGR1cGxpY2F0ZSBldmVudCBmaXJpbmcuXG5cdFx0XHRpZiAocmF3UGF0aCAmJiBwcm9wYWdhdGUpIHtcblx0XHRcdFx0b2JzZXJ2ZXIuZW1pdCgnc2V0JywgcmF3UGF0aCwgb2JqLCB0cnVlKTtcblx0XHRcdH1cblx0XHR9LFxuXHRcdG11dGF0ZTogZnVuY3Rpb24gKGtleSwgdmFsLCBtdXRhdGlvbikge1xuXHRcdFx0Ly8gaWYgdGhlIEFycmF5IGlzIGEgcm9vdCB2YWx1ZVxuICAgICAgICAgICAgLy8gdGhlIGtleSB3aWxsIGJlIG51bGxcblx0XHRcdHZhciBmaXhlZFBhdGggPSBrZXkgPyBwYXRoICsga2V5IDogcmF3UGF0aDtcblx0XHRcdG9ic2VydmVyLmVtaXQoJ211dGF0ZScsIGZpeGVkUGF0aCwgdmFsLCBtdXRhdGlvbik7XG5cdFx0XHR2YXIgbSA9IG11dGFpb24ubWV0aG9kO1xuXHRcdFx0aWYgKG0gIT09ICdzb3J0JyAmJiBtICE9PSAncmV2ZXJzZScpIHtcblx0XHRcdFx0b2JzZXJ2ZXIuZW1pdCgnc2V0JywgZml4ZWRQYXRoICsgJy5sZW5ndGgnLCB2YWwubGVuZ3RoKTtcblx0XHRcdH1cblx0XHR9XG5cdH07XG5cblx0Ly8gYXR0YWNoIHRoZSBsaXN0ZW5lcnMgdG8gdGhlIGNoaWxkIG9ic2VydmVyLlxuICAgIC8vIG5vdyBhbGwgdGhlIGV2ZW50cyB3aWxsIHByb3BhZ2F0ZSB1cHdhcmRzLlxuICAgIGVtaXR0ZXJcbiAgICAgICAgLm9uKCdnZXQnLCBwcm94aWVzLmdldClcbiAgICAgICAgLm9uKCdzZXQnLCBwcm94aWVzLnNldClcbiAgICAgICAgLm9uKCdtdXRhdGUnLCBwcm94aWVzLm11dGF0ZSk7XG5cblxuICAgIGlmIChhbHJlYWR5Q29udmVydGVkKSB7XG4gICAgICAgIC8vIGZvciBvYmplY3RzIHRoYXQgaGF2ZSBhbHJlYWR5IGJlZW4gY29udmVydGVkLFxuICAgICAgICAvLyBlbWl0IHNldCBldmVudHMgZm9yIGV2ZXJ5dGhpbmcgaW5zaWRlXG4gICAgICAgIGVtaXRTZXQob2JqKVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHdhdGNoKG9iailcbiAgICB9XG59XG5cbi8qKlxuICogIENhbmNlbCBvYnNlcnZhdGlvbiwgdHVybiBvZmYgdGhlIGxpc3RlbmVycy5cbiAqL1xuZnVuY3Rpb24gdW5vYnNlcnZlIChvYmosIHBhdGgsIG9ic2VydmVyKSB7XG5cbiAgICBpZiAoIW9iaiB8fCAhb2JqLl9fZW1pdHRlcl9fKSByZXR1cm5cblxuICAgIHBhdGggPSBwYXRoID8gcGF0aCArICcuJyA6ICcnXG4gICAgdmFyIHByb3hpZXMgPSBvYnNlcnZlci5wcm94aWVzW3BhdGhdXG4gICAgaWYgKCFwcm94aWVzKSByZXR1cm5cblxuICAgIC8vIHR1cm4gb2ZmIGxpc3RlbmVyc1xuICAgIG9iai5fX2VtaXR0ZXJfX1xuICAgICAgICAub2ZmKCdnZXQnLCBwcm94aWVzLmdldClcbiAgICAgICAgLm9mZignc2V0JywgcHJveGllcy5zZXQpXG4gICAgICAgIC5vZmYoJ211dGF0ZScsIHByb3hpZXMubXV0YXRlKVxuXG4gICAgLy8gcmVtb3ZlIHJlZmVyZW5jZVxuICAgIG9ic2VydmVyLnByb3hpZXNbcGF0aF0gPSBudWxsXG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIG9ic2VydmUgICAgIDogb2JzZXJ2ZSxcbiAgICB1bm9ic2VydmUgICA6IHVub2JzZXJ2ZSxcbiAgICBlbnN1cmVQYXRoICA6IGVuc3VyZVBhdGgsXG4gICAgY29weVBhdGhzICAgOiBjb3B5UGF0aHMsXG4gICAgd2F0Y2ggICAgICAgOiB3YXRjaCxcbiAgICBjb252ZXJ0ICAgICA6IGNvbnZlcnQsXG4gICAgY29udmVydEtleSAgOiBjb252ZXJ0S2V5XG59IiwidmFyIHRvRnJhZ21lbnQgPSByZXF1aXJlKCcuL2ZyYWdtZW50JylcbiAgICBUZXh0UGFyc2VyID0gcmVxdWlyZSgnLi90ZXh0UGFyc2VyJyksXG4gICAgRXhwUGFyc2VyICA9IHJlcXVpcmUoJy4vRXhwUGFyc2VyJyk7XG5cbi8qKlxuICogUGFyc2VzIGEgdGVtcGxhdGUgc3RyaW5nIG9yIG5vZGUgYW5kIG5vcm1hbGl6ZXMgaXQgaW50byBhXG4gKiBhIG5vZGUgdGhhdCBjYW4gYmUgdXNlZCBhcyBhIHBhcnRpYWwgb2YgYSB0ZW1wbGF0ZSBvcHRpb25cbiAqXG4gKiBQb3NzaWJsZSB2YWx1ZXMgaW5jbHVkZVxuICogaWQgc2VsZWN0b3I6ICcjc29tZS10ZW1wbGF0ZS1pZCdcbiAqIHRlbXBsYXRlIHN0cmluZzogJzxkaXY+PHNwYW4+bXkgdGVtcGxhdGU8L3NwYW4+PC9kaXY+J1xuICogRG9jdW1lbnRGcmFnbWVudCBvYmplY3RcbiAqIE5vZGUgb2JqZWN0IG9mIHR5cGUgVGVtcGxhdGVcbiAqL1xuZnVuY3Rpb24gcGFyc2VUZW1wbGF0ZSh0ZW1wbGF0ZSkge1xuICAgIHZhciB0ZW1wbGF0ZU5vZGU7XG5cbiAgICBpZiAodGVtcGxhdGUgaW5zdGFuY2VvZiB3aW5kb3cuRG9jdW1lbnRGcmFnbWVudCkge1xuICAgICAgICAvLyBpZiB0aGUgdGVtcGxhdGUgaXMgYWxyZWFkeSBhIGRvY3VtZW50IGZyYWdtZW50IC0tIGRvIG5vdGhpbmdcbiAgICAgICAgcmV0dXJuIHRlbXBsYXRlXG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiB0ZW1wbGF0ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgLy8gdGVtcGxhdGUgYnkgSURcbiAgICAgICAgaWYgKHRlbXBsYXRlLmNoYXJBdCgwKSA9PT0gJyMnKSB7XG4gICAgICAgICAgICB0ZW1wbGF0ZU5vZGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCh0ZW1wbGF0ZS5zbGljZSgxKSlcbiAgICAgICAgICAgIGlmICghdGVtcGxhdGVOb2RlKSByZXR1cm5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiB0b0ZyYWdtZW50KHRlbXBsYXRlKVxuICAgICAgICB9XG4gICAgfSBlbHNlIGlmICh0ZW1wbGF0ZS5ub2RlVHlwZSkge1xuICAgICAgICB0ZW1wbGF0ZU5vZGUgPSB0ZW1wbGF0ZVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIGlmIGl0cyBhIHRlbXBsYXRlIHRhZyBhbmQgdGhlIGJyb3dzZXIgc3VwcG9ydHMgaXQsXG4gICAgLy8gaXRzIGNvbnRlbnQgaXMgYWxyZWFkeSBhIGRvY3VtZW50IGZyYWdtZW50IVxuICAgIGlmICh0ZW1wbGF0ZU5vZGUudGFnTmFtZSA9PT0gJ1RFTVBMQVRFJyAmJiB0ZW1wbGF0ZU5vZGUuY29udGVudCkge1xuICAgICAgICByZXR1cm4gdGVtcGxhdGVOb2RlLmNvbnRlbnRcbiAgICB9XG5cbiAgICBpZiAodGVtcGxhdGVOb2RlLnRhZ05hbWUgPT09ICdTQ1JJUFQnKSB7XG4gICAgICAgIHJldHVybiB0b0ZyYWdtZW50KHRlbXBsYXRlTm9kZS5pbm5lckhUTUwpXG4gICAgfVxuXG4gICAgcmV0dXJuIHRvRnJhZ21lbnQodGVtcGxhdGVOb2RlLm91dGVySFRNTCk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIHBhcnNlVGVtcGxhdGU6IHBhcnNlVGVtcGxhdGUsXG4gICAgVGV4dFBhcnNlcjogVGV4dFBhcnNlcixcbiAgICBFeHBQYXJzZXI6IEV4cFBhcnNlclxufTsiLCJ2YXIgb3BlbkNoYXIgICAgICAgID0gJ3snLFxuICAgIGVuZENoYXIgICAgICAgICA9ICd9JyxcbiAgICBFU0NBUEVfUkUgICAgICAgPSAvWy0uKis/XiR7fSgpfFtcXF1cXC9cXFxcXS9nLFxuICAgIC8vIGxhenkgcmVxdWlyZVxuICAgIERpcmVjdGl2ZVxuXG5leHBvcnRzLlJlZ2V4ID0gYnVpbGRJbnRlcnBvbGF0aW9uUmVnZXgoKVxuXG5mdW5jdGlvbiBidWlsZEludGVycG9sYXRpb25SZWdleCAoKSB7XG4gICAgdmFyIG9wZW4gPSBlc2NhcGVSZWdleChvcGVuQ2hhciksXG4gICAgICAgIGVuZCAgPSBlc2NhcGVSZWdleChlbmRDaGFyKVxuICAgIHJldHVybiBuZXcgUmVnRXhwKG9wZW4gKyBvcGVuICsgb3BlbiArICc/KC4rPyknICsgZW5kICsgJz8nICsgZW5kICsgZW5kKVxufVxuXG5mdW5jdGlvbiBlc2NhcGVSZWdleCAoc3RyKSB7XG4gICAgcmV0dXJuIHN0ci5yZXBsYWNlKEVTQ0FQRV9SRSwgJ1xcXFwkJicpXG59XG5cbmZ1bmN0aW9uIHNldERlbGltaXRlcnMgKGRlbGltaXRlcnMpIHtcbiAgICBvcGVuQ2hhciA9IGRlbGltaXRlcnNbMF1cbiAgICBlbmRDaGFyID0gZGVsaW1pdGVyc1sxXVxuICAgIGV4cG9ydHMuZGVsaW1pdGVycyA9IGRlbGltaXRlcnNcbiAgICBleHBvcnRzLlJlZ2V4ID0gYnVpbGRJbnRlcnBvbGF0aW9uUmVnZXgoKVxufVxuXG4vKiogXG4gKiAgUGFyc2UgYSBwaWVjZSBvZiB0ZXh0LCByZXR1cm4gYW4gYXJyYXkgb2YgdG9rZW5zXG4gKiAgdG9rZW4gdHlwZXM6XG4gKiAgMS4gcGxhaW4gc3RyaW5nXG4gKiAgMi4gb2JqZWN0IHdpdGgga2V5ID0gYmluZGluZyBrZXlcbiAqICAzLiBvYmplY3Qgd2l0aCBrZXkgJiBodG1sID0gdHJ1ZVxuICovXG5mdW5jdGlvbiBwYXJzZSAodGV4dCkge1xuICAgIGlmICghZXhwb3J0cy5SZWdleC50ZXN0KHRleHQpKSByZXR1cm4gbnVsbFxuICAgIHZhciBtLCBpLCB0b2tlbiwgbWF0Y2gsIHRva2VucyA9IFtdXG4gICAgLyoganNoaW50IGJvc3M6IHRydWUgKi9cbiAgICB3aGlsZSAobSA9IHRleHQubWF0Y2goZXhwb3J0cy5SZWdleCkpIHtcbiAgICAgICAgaSA9IG0uaW5kZXhcbiAgICAgICAgaWYgKGkgPiAwKSB0b2tlbnMucHVzaCh0ZXh0LnNsaWNlKDAsIGkpKVxuICAgICAgICB0b2tlbiA9IHsga2V5OiBtWzFdLnRyaW0oKSB9XG4gICAgICAgIG1hdGNoID0gbVswXVxuICAgICAgICB0b2tlbi5odG1sID1cbiAgICAgICAgICAgIG1hdGNoLmNoYXJBdCgyKSA9PT0gb3BlbkNoYXIgJiZcbiAgICAgICAgICAgIG1hdGNoLmNoYXJBdChtYXRjaC5sZW5ndGggLSAzKSA9PT0gZW5kQ2hhclxuICAgICAgICB0b2tlbnMucHVzaCh0b2tlbilcbiAgICAgICAgdGV4dCA9IHRleHQuc2xpY2UoaSArIG1bMF0ubGVuZ3RoKVxuICAgIH1cbiAgICBpZiAodGV4dC5sZW5ndGgpIHRva2Vucy5wdXNoKHRleHQpXG4gICAgcmV0dXJuIHRva2Vuc1xufVxuXG4vKipcbiAqICBQYXJzZSBhbiBhdHRyaWJ1dGUgdmFsdWUgd2l0aCBwb3NzaWJsZSBpbnRlcnBvbGF0aW9uIHRhZ3NcbiAqICByZXR1cm4gYSBEaXJlY3RpdmUtZnJpZW5kbHkgZXhwcmVzc2lvblxuICpcbiAqICBlLmcuICBhIHt7Yn19IGMgID0+ICBcImEgXCIgKyBiICsgXCIgY1wiXG4gKi9cbmZ1bmN0aW9uIHBhcnNlQXR0ciAoYXR0cikge1xuICAgIERpcmVjdGl2ZSA9IERpcmVjdGl2ZSB8fCByZXF1aXJlKCcuL2RpcmVjdGl2ZXMnKVxuICAgIHZhciB0b2tlbnMgPSBwYXJzZShhdHRyKVxuICAgIGlmICghdG9rZW5zKSByZXR1cm4gbnVsbFxuICAgIGlmICh0b2tlbnMubGVuZ3RoID09PSAxKSByZXR1cm4gdG9rZW5zWzBdLmtleVxuICAgIHZhciByZXMgPSBbXSwgdG9rZW5cbiAgICBmb3IgKHZhciBpID0gMCwgbCA9IHRva2Vucy5sZW5ndGg7IGkgPCBsOyBpKyspIHtcbiAgICAgICAgdG9rZW4gPSB0b2tlbnNbaV1cbiAgICAgICAgcmVzLnB1c2goXG4gICAgICAgICAgICB0b2tlbi5rZXlcbiAgICAgICAgICAgICAgICA/IGlubGluZUZpbHRlcnModG9rZW4ua2V5KVxuICAgICAgICAgICAgICAgIDogKCdcIicgKyB0b2tlbiArICdcIicpXG4gICAgICAgIClcbiAgICB9XG4gICAgcmV0dXJuIHJlcy5qb2luKCcrJylcbn1cblxuLyoqXG4gKiAgSW5saW5lcyBhbnkgcG9zc2libGUgZmlsdGVycyBpbiBhIGJpbmRpbmdcbiAqICBzbyB0aGF0IHdlIGNhbiBjb21iaW5lIGV2ZXJ5dGhpbmcgaW50byBhIGh1Z2UgZXhwcmVzc2lvblxuICovXG5mdW5jdGlvbiBpbmxpbmVGaWx0ZXJzIChrZXkpIHtcbiAgICBpZiAoa2V5LmluZGV4T2YoJ3wnKSA+IC0xKSB7XG4gICAgICAgIHZhciBkaXJzID0gRGlyZWN0aXZlLnBhcnNlKGtleSksXG4gICAgICAgICAgICBkaXIgPSBkaXJzICYmIGRpcnNbMF1cbiAgICAgICAgaWYgKGRpciAmJiBkaXIuZmlsdGVycykge1xuICAgICAgICAgICAga2V5ID0gRGlyZWN0aXZlLmlubGluZUZpbHRlcnMoXG4gICAgICAgICAgICAgICAgZGlyLmtleSxcbiAgICAgICAgICAgICAgICBkaXIuZmlsdGVyc1xuICAgICAgICAgICAgKVxuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiAnKCcgKyBrZXkgKyAnKSdcbn1cblxuZXhwb3J0cy5wYXJzZSAgICAgICAgID0gcGFyc2VcbmV4cG9ydHMucGFyc2VBdHRyICAgICA9IHBhcnNlQXR0clxuZXhwb3J0cy5zZXREZWxpbWl0ZXJzID0gc2V0RGVsaW1pdGVyc1xuZXhwb3J0cy5kZWxpbWl0ZXJzICAgID0gW29wZW5DaGFyLCBlbmRDaGFyXSIsIi8qKlxuICogdXRpbHNcbiAqXG4gKiBAYXV0aG9yOiB4dWVqaWEuY3hqLzYxNzRcbiAqL1xuXG52YXIgd2luID0gdHlwZW9mIHdpbmRvdyAhPT0gXCJ1bmRlZmluZWRcIiA/ICB3aW5kb3cgOiB7XG4gICAgICAgIHNldFRpbWVvdXQ6IHNldFRpbWVvdXRcbiAgICB9O1xuXG52YXIgY29uZmlnICAgICAgID0gcmVxdWlyZSgnLi9jb25maWcnKSxcbiAgICBjbGFzczJ0eXBlICAgPSB7fSxcbiAgICByd29yZCAgICAgICAgPSAvW14sIF0rL2csXG4gICAgQlJBQ0tFVF9SRV9TID0gL1xcWycoW14nXSspJ1xcXS9nLFxuICAgIEJSQUNLRVRfUkVfRCA9IC9cXFtcIihbXlwiXSspXCJcXF0vZztcbiAgICBpc1N0cmluZyAgICAgPSBpc1R5cGUoJ1N0cmluZycpLFxuICAgIGlzRnVuY3Rpb24gICA9IGlzVHlwZSgnRnVuY3Rpb24nKSxcbiAgICBpc1VuZGVmaW5lZCAgPSBpc1R5cGUoJ1VuZGVmaW5lZCcpLFxuICAgIGlzT2JqZWN0ICAgICA9IGlzVHlwZSgnT2JqZWN0JyksXG4gICAgaXNBcnJheSAgICAgID0gQXJyYXkuaXNBcnJheSB8fCBpc1R5cGUoJ0FycmF5JyksXG4gICAgaGFzT3duICAgICAgID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eSxcbiAgICBzZXJpYWxpemUgICAgPSBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLFxuICAgIGRlZiAgICAgICAgICA9IE9iamVjdC5kZWZpbmVQcm9wZXJ0eSxcbiAgICBkZWZlciAgICAgICAgPSB3aW4ucmVxdWVzdEFuaW1hdGlvbkZyYW1lIHx8IHdpbi53ZWJraXRSZXF1ZXN0QW5pbWF0aW9uRnJhbWUgfHwgd2luLnNldFRpbWVvdXQsXG5cIkJvb2xlYW4gTnVtYmVyIFN0cmluZyBGdW5jdGlvbiBBcnJheSBEYXRlIFJlZ0V4cCBPYmplY3QgRXJyb3JcIi5yZXBsYWNlKHJ3b3JkLCBmdW5jdGlvbihuYW1lKSB7XG4gICAgY2xhc3MydHlwZVtcIltvYmplY3QgXCIgKyBuYW1lICsgXCJdXCJdID0gbmFtZS50b0xvd2VyQ2FzZSgpXG59KTtcbi8qKlxuICogT2JqZWN0IHV0aWxzXG4gKi9cbnZhciBvYmplY3QgPSB7XG4gICAgYmFzZUtleTogZnVuY3Rpb24obmFtZXNwYWNlKSB7XG4gICAgICAgIHJldHVybiBrZXkuaW5kZXhPZignLicpID4gMCA/IGtleS5zcGxpdCgnLicpWzBdIDoga2V5O1xuICAgIH0sXG4gICAgaGFzaDogZnVuY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBPYmplY3QuY3JlYXRlKG51bGwpXG4gICAgfSxcbiAgICBiaW5kOiBmdW5jdGlvbihmbiwgY3R4KSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbihhcmcpIHtcbiAgICAgICAgICAgIHJldHVybiBmbi5jYWxsKGN0eCwgYXJnKVxuICAgICAgICB9XG4gICAgfSxcbiAgICBoYXM6IGZ1bmN0aW9uKG9iaiwga2V5KSB7XG4gICAgICAgIHJldHVybiBoYXNPd24uY2FsbChvYmosIGtleSk7XG4gICAgfSxcbiAgICBnZXQ6IGZ1bmN0aW9uKG9iaiwga2V5KSB7XG4gICAgICAgIGtleSA9IG5vcm1hbGl6ZUtleXBhdGgoa2V5KVxuICAgICAgICBpZiAoa2V5LmluZGV4T2YoJy4nKSA8IDApIHtcbiAgICAgICAgICAgIHJldHVybiBvYmpba2V5XVxuICAgICAgICB9XG4gICAgICAgIHZhciBwYXRoID0ga2V5LnNwbGl0KCcuJyksXG4gICAgICAgICAgICBkID0gLTEsXG4gICAgICAgICAgICBsID0gcGF0aC5sZW5ndGhcbiAgICAgICAgd2hpbGUgKCsrZCA8IGwgJiYgb2JqICE9IG51bGwpIHtcbiAgICAgICAgICAgIG9iaiA9IG9ialtwYXRoW2RdXVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvYmpcbiAgICB9LFxuICAgIHNldDogZnVuY3Rpb24ob2JqLCBrZXksIHZhbCkge1xuICAgICAgICBrZXkgPSBub3JtYWxpemVLZXlwYXRoKGtleSlcbiAgICAgICAgaWYgKGtleS5pbmRleE9mKCcuJykgPCAwKSB7XG4gICAgICAgICAgICBvYmpba2V5XSA9IHZhbFxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cbiAgICAgICAgdmFyIHBhdGggPSBrZXkuc3BsaXQoJy4nKSxcbiAgICAgICAgICAgIGQgPSAtMSxcbiAgICAgICAgICAgIGwgPSBwYXRoLmxlbmd0aCAtIDFcbiAgICAgICAgd2hpbGUgKCsrZCA8IGwpIHtcbiAgICAgICAgICAgIGlmIChvYmpbcGF0aFtkXV0gPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgIG9ialtwYXRoW2RdXSA9IHt9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvYmogPSBvYmpbcGF0aFtkXV1cbiAgICAgICAgfVxuICAgICAgICBvYmpbcGF0aFtkXV0gPSB2YWxcbiAgICB9LFxuICAgIGtleXM6IGZ1bmN0aW9uIChvYmopIHtcbiAgICAgICAgdmFyIF9rZXlzID0gT2JqZWN0LmtleXMsXG4gICAgICAgICAgICByZXQgPSBbXTtcblxuICAgICAgICBpZiAoaXNPYmplY3Qob2JqKSkge1xuICAgICAgICAgICAgaWYgKF9rZXlzKSB7XG4gICAgICAgICAgICAgICAgcmV0ID0gX2tleXMob2JqKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgayBpbiBvYmopIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGhhc093bi5jYWxsKG9iaixrKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0LnB1c2goayk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJldDtcbiAgICB9LFxuICAgIHRvQXJyYXk6IGZ1bmN0aW9uKG9iamVjdCl7XG4gICAgICAgIHZhciByZXMgPSBbXSwgdmFsLCBkYXRhXG4gICAgICAgIGZvciAodmFyIGtleSBpbiBvYmopIHtcbiAgICAgICAgICAgIHZhbCA9IG9ialtrZXldXG4gICAgICAgICAgICBkYXRhID0gaXNPYmplY3QodmFsKVxuICAgICAgICAgICAgICAgID8gdmFsXG4gICAgICAgICAgICAgICAgOiB7ICR2YWx1ZTogdmFsIH1cbiAgICAgICAgICAgIGRhdGEuJGtleSA9IGtleVxuICAgICAgICAgICAgcmVzLnB1c2goZGF0YSlcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzO1xuICAgIH0sXG4gICAgLyoqXG4gICAgICogIERlZmluZSBhbiBpZW51bWVyYWJsZSBwcm9wZXJ0eVxuICAgICAqICBUaGlzIGF2b2lkcyBpdCBiZWluZyBpbmNsdWRlZCBpbiBKU09OLnN0cmluZ2lmeVxuICAgICAqICBvciBmb3IuLi5pbiBsb29wcy5cbiAgICAgKi9cbiAgICBkZWZQcm90ZWN0ZWQ6IGZ1bmN0aW9uIChvYmosIGtleSwgdmFsLCBlbnVtZXJhYmxlLCB3cml0YWJsZSkge1xuICAgICAgICBkZWYob2JqLCBrZXksIHtcbiAgICAgICAgICAgIHZhbHVlICAgICAgICA6IHZhbCxcbiAgICAgICAgICAgIGVudW1lcmFibGUgICA6IGVudW1lcmFibGUsXG4gICAgICAgICAgICB3cml0YWJsZSAgICAgOiB3cml0YWJsZSxcbiAgICAgICAgICAgIGNvbmZpZ3VyYWJsZSA6IHRydWVcbiAgICAgICAgfSlcbiAgICB9LFxuICAgIC8qKlxuICAgICAqIOe7p+aJv1xuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBwcm90b1Byb3BzIOmcgOimgee7p+aJv+eahOWOn+Wei1xuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBzdGF0aWNQcm9wcyDpnZnmgIHnmoTnsbvmlrnms5VcbiAgICAgKi9cbiAgICBleHRlbmQ6IGZ1bmN0aW9uKHByb3RvUHJvcHMsIHN0YXRpY1Byb3BzKSB7XG4gICAgICAgIHZhciBwYXJlbnQgPSB0aGlzO1xuICAgICAgICB2YXIgY2hpbGQ7XG4gICAgICAgIGlmIChwcm90b1Byb3BzICYmIGhhcyhwcm90b1Byb3BzLCAnY29uc3RydWN0b3InKSkge1xuICAgICAgICAgICAgY2hpbGQgPSBwcm90b1Byb3BzLmNvbnN0cnVjdG9yO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY2hpbGQgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGFyZW50LmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgbWl4KGNoaWxkLCBwYXJlbnQpO1xuICAgICAgICBtaXgoY2hpbGQsIHN0YXRpY1Byb3BzKTtcbiAgICAgICAgdmFyIFN1cnJvZ2F0ZSA9IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgdGhpcy5jb25zdHJ1Y3RvciA9IGNoaWxkO1xuICAgICAgICB9O1xuICAgICAgICBTdXJyb2dhdGUucHJvdG90eXBlID0gcGFyZW50LnByb3RvdHlwZTtcbiAgICAgICAgY2hpbGQucHJvdG90eXBlID0gbmV3IFN1cnJvZ2F0ZTtcbiAgICAgICAgaWYgKHByb3RvUHJvcHMpIHtcbiAgICAgICAgICAgIG1peChjaGlsZC5wcm90b3R5cGUsIHByb3RvUHJvcHMpO1xuICAgICAgICB9XG4gICAgICAgIGNoaWxkLl9fc3VwZXJfXyA9IHBhcmVudC5wcm90b3R5cGU7XG4gICAgICAgIHJldHVybiBjaGlsZDtcbiAgICB9XG59O1xuLyoqXG4gKiBhcnJheSB1dGlsc1xuICovXG52YXIgYXJyYXkgPSB7XG4gICAgaW5kZXhPZjogZnVuY3Rpb24oZWxlbWVudCwgYXJyKSB7XG4gICAgICAgIGlmICghaXNBcnJheShhcnIpKSB7XG4gICAgICAgICAgICByZXR1cm4gLTE7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGFyci5pbmRleE9mKGVsZW1lbnQpO1xuICAgIH0sXG4gICAgdW5pcXVlOiBmdW5jdGlvbiAoYXJyKSB7XG4gICAgICAgIHZhciBoYXNoID0ge30sXG4gICAgICAgICAgICBpID0gYXJyLmxlbmd0aCxcbiAgICAgICAgICAgIGtleSwgcmVzID0gW11cbiAgICAgICAgd2hpbGUgKGktLSkge1xuICAgICAgICAgICAga2V5ID0gYXJyW2ldXG4gICAgICAgICAgICBpZiAoaGFzaFtrZXldKSBjb250aW51ZTtcbiAgICAgICAgICAgIGhhc2hba2V5XSA9IDFcbiAgICAgICAgICAgIHJlcy5wdXNoKGtleSlcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzO1xuICAgIH1cbn07XG4vKiogXG4gKiBkb20gdXRpbHNcbiAqL1xudmFyIGRvbSA9IHtcbiAgICBhdHRyOiBmdW5jdGlvbihlbCwgdHlwZSkge1xuICAgICAgICB2YXIgYXR0ciA9IGNvbmZpZy5wcmVmaXggKyAnLScgKyB0eXBlLFxuICAgICAgICAgICAgdmFsID0gZWwuZ2V0QXR0cmlidXRlKGF0dHIpXG4gICAgICAgIGlmICh2YWwgIT09IG51bGwpIHtcbiAgICAgICAgICAgIGVsLnJlbW92ZUF0dHJpYnV0ZShhdHRyKVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2YWxcbiAgICB9LFxuICAgIHF1ZXJ5OiBmdW5jdGlvbiAoZWwpIHtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiBlbCA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgID8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihlbClcbiAgICAgICAgICAgIDogZWw7XG4gICAgfVxufTtcbi8qKlxuICog566A5Y2V5Zyw5a+56LGh5ZCI5bm2XG4gKiBAcGFyYW0gIG9iamVjdCByIOa6kOWvueixoVxuICogQHBhcmFtICBvYmplY3QgcyDnm67moIflr7nosaFcbiAqIEBwYXJhbSAgYm9vbCAgIG8g5piv5ZCm6YeN5YaZ77yI6buY6K6k5Li6ZmFsc2XvvIlcbiAqIEBwYXJhbSAgYm9vbCAgIGQg5piv5ZCm6YCS5b2S77yI6buY6K6k5Li6ZmFsc2XvvIlcbiAqIEByZXR1cm4gb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIG1peChyLCBzLCBvLCBkKSB7XG4gICAgZm9yICh2YXIgayBpbiBzKSB7XG4gICAgICAgIGlmIChoYXNPd24uY2FsbChzLCBrKSkge1xuICAgICAgICAgICAgaWYgKCEoayBpbiByKSkge1xuICAgICAgICAgICAgICAgIHJba10gPSBzW2tdO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGQgJiYgaXNPYmplY3QocltrXSkgJiYgaXNPYmplY3Qoc1trXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgbWl4KHJba10sIHNba10sIG8sIGQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJba10gPSBzW2tdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcjtcbn1cbi8qKlxuICogIE5vcm1hbGl6ZSBrZXlwYXRoIHdpdGggcG9zc2libGUgYnJhY2tldHMgaW50byBkb3Qgbm90YXRpb25zXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZUtleXBhdGgoa2V5KSB7XG4gICAgcmV0dXJuIGtleS5pbmRleE9mKCdbJykgPCAwID8ga2V5IDoga2V5LnJlcGxhY2UoQlJBQ0tFVF9SRV9TLCAnLiQxJykucmVwbGFjZShCUkFDS0VUX1JFX0QsICcuJDEnKVxufVxuXG5mdW5jdGlvbiBnZXRUeXBlKG9iaikge1xuICAgIGlmIChvYmogPT0gbnVsbCkge1xuICAgICAgICByZXR1cm4gU3RyaW5nKG9iaik7XG4gICAgfVxuICAgIHJldHVybiB0eXBlb2Ygb2JqID09PSBcIm9iamVjdFwiIHx8IHR5cGVvZiBvYmogPT09IFwiZnVuY3Rpb25cIiA/IGNsYXNzMnR5cGVbc2VyaWFsaXplLmNhbGwob2JqKV0gfHwgXCJvYmplY3RcIiA6IHR5cGVvZiBvYmo7XG59XG5cbmZ1bmN0aW9uIGlzVHlwZSh0eXBlKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKG9iaikge1xuICAgICAgICByZXR1cm4ge30udG9TdHJpbmcuY2FsbChvYmopID09PSAnW29iamVjdCAnICsgdHlwZSArICddJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGlzRXF1YWwodjEsIHYyKSB7XG4gICAgaWYgKHYxID09PSAwICYmIHYyID09PSAwKSB7XG4gICAgICAgIHJldHVybiAxIC8gdjEgPT09IDEgLyB2MlxuICAgIH0gZWxzZSBpZiAodjEgIT09IHYxKSB7XG4gICAgICAgIHJldHVybiB2MiAhPT0gdjJcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gdjEgPT09IHYyXG4gICAgfVxufVxuXG5mdW5jdGlvbiBndWlkKHByZWZpeCkge1xuICAgIHByZWZpeCA9IHByZWZpeCB8fCAnJztcbiAgICByZXR1cm4gTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDIsIDE1KSArIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZygyLCAxNSlcbn1cblxuZnVuY3Rpb24gbmV4dFRpY2soY2IpIHtcbiAgICBkZWZlcihjYiwgMClcbn1cblxuZnVuY3Rpb24gbWVyZ2UoYXJncykge1xuICAgIHZhciByZXQgPSB7fSxcbiAgICAgICAgaSwgbDtcbiAgICBpZiAoIWlzQXJyYXkoYXJncykpIHtcbiAgICAgICAgYXJncyA9IFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKTtcbiAgICB9XG4gICAgZm9yIChpID0gMCwgbCA9IGFyZ3MubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIG1peChyZXQsIGFyZ3NbaV0sIHRydWUpO1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xufVxuXG5mdW5jdGlvbiBlYWNoKG9iaiwgZm4pIHtcbiAgICB2YXIgaSwgbCwga3M7XG4gICAgaWYgKGlzQXJyYXkob2JqKSkge1xuICAgICAgICBmb3IgKGkgPSAwLCBsID0gb2JqLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICAgICAgaWYgKGZuKG9ialtpXSwgaSwgb2JqKSA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGtzID0ga2V5cyhvYmopO1xuICAgICAgICBmb3IgKGkgPSAwLCBsID0ga3MubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgICAgICBpZiAoZm4ob2JqW2tzW2ldXSwga3NbaV0sIG9iaikgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGxvZyhtc2cpIHtcbiAgICBpZiAoY29uZmlnLmRlYnVnICYmIGNvbnNvbGUpIHtcbiAgICAgICAgY29uc29sZS5sb2cobXNnKVxuICAgIH1cbn1cblxuZnVuY3Rpb24gd2Fybihtc2cpIHtcbiAgICBpZiAoIWNvbmZpZy5zaWxlbnQgJiYgY29uc29sZSkge1xuICAgICAgICBjb25zb2xlLndhcm4obXNnKTtcbiAgICAgICAgaWYgKGNvbmZpZy5kZWJ1ZyAmJiBjb25zb2xlLnRyYWNlKSB7XG4gICAgICAgICAgICBjb25zb2xlLnRyYWNlKCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBvYmplY3Q6IG9iamVjdCxcbiAgICBhcnJheTogYXJyYXksXG4gICAgZG9tOiBkb20sXG4gICAgZ2V0VHlwZTogZ2V0VHlwZSxcbiAgICBpc0FycmF5OiBpc0FycmF5LFxuICAgIGlzT2JqZWN0OiBpc09iamVjdCxcbiAgICBpc1N0cmluZzogaXNTdHJpbmcsXG4gICAgaGFzaDogb2JqZWN0Lmhhc2gsXG4gICAgaXNGdW5jdGlvbjogaXNGdW5jdGlvbixcbiAgICBpc0VxdWFsOiBpc0VxdWFsLFxuICAgIG1peDogbWl4LFxuICAgIG1lcmdlOiBtZXJnZSxcbiAgICBndWlkOiBndWlkLFxuICAgIGhhc093bjogaGFzT3duLFxuICAgIHNlcmlhbGl6ZTogc2VyaWFsaXplLFxuICAgIGVhY2g6IGVhY2gsXG4gICAgbG9nOiBsb2csXG4gICAgd2Fybjogd2FybixcbiAgICBuZXh0VGljazogbmV4dFRpY2tcbn0iLCJ2YXIgdXRpbHMgICAgPSByZXF1aXJlKCcuL3V0aWxzJyksXG5cdEJhdGNoZXIgID0gcmVxdWlyZSgnLi9iYXRjaGVyJyksXG5cdENvbXBpbGVyID0gcmVxdWlyZSgnLi9jb21waWxlcicpLFxuXHR3YXRjaGVyQmF0Y2hlciA9IG5ldyBCYXRjaGVyKCk7XG4vKipcbiAqIFZpZXdNb2RlbFxuICogQHBhcmFtIHtTdHJpbmd9IG9wdGlvbnMuZWw6IGlkXG4gKi9cbmZ1bmN0aW9uIFZNKG9wdGlvbnMpe1xuXHRpZighb3B0aW9ucyl7cmV0dXJuO31cblx0dGhpcy4kaW5pdChvcHRpb25zKTtcbn1cblxudXRpbHMubWl4KFZNLnByb3RvdHlwZSwge1xuXHQnJGluaXQnOiBmdW5jdGlvbiBpbml0KG9wdGlvbnMpe1xuXHRcdG5ldyBDb21waWxlcih0aGlzLCBvcHRpb25zKTtcblx0fSxcblx0JyRnZXQnOiBmdW5jdGlvbiBnZXQoa2V5KXtcblx0XHR2YXIgdmFsID0gdXRpbHMub2JqZWN0LmdldCh0aGlzLCBrZXkpO1xuXHRcdHJldHVybiB2YWwgPT09IHVuZGVmaW5lZCAmJiB0aGlzLiRwYXJlbnRcblx0XHQgICAgICAgID8gdGhpcy4kcGFyZW50LiRnZXQoa2V5KVxuXHRcdCAgICAgICAgOiB2YWw7XG5cdH0sXG5cdCckc2V0JzogZnVuY3Rpb24gc2V0KGtleSwgdmFsdWUpe1xuXHRcdHV0aWxzLnNldCh0aGlzLCBrZXksIHZhbHVlKTtcblx0fSxcblx0JyR3YXRjaCc6IGZ1bmN0aW9uIHdhdGNoKGtleSwgY2FsbGJhY2spIHtcblx0XHR2YXIgaWQgPSB1dGlscy5ndWlkKCd3YXRjaGVyaWQtJyksIFxuXHRcdFx0c2VsZiA9IHRoaXM7XG5cdFx0ZnVuY3Rpb24gZXZlbnRSZXNvbHZlcigpe1xuXHRcdFx0dmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG5cdFx0XHR3YXRjaGVyQmF0Y2hlci5wdXNoKHtcblx0XHRcdFx0aWQ6IGlkLFxuXHRcdFx0XHRvdmVycmlkZTogdHJ1ZSxcblx0XHRcdFx0ZXhlY3V0ZTogZnVuY3Rpb24oKXtcblx0XHRcdFx0XHRjYWxsYmFjay5hcHBseShzZWxmLCBhcmdzKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdGNhbGxiYWNrLl9mbiA9IGV2ZW50UmVzb2x2ZXI7XG5cdFx0dGhpcy4kY29tcGlsZXIub2JzZXJ2ZXIub24oJ2NoYW5nZTonICsga2V5LCBldmVudFJlc29sdmVyKTtcblx0fSxcblx0JyR1bndhdGNoJzogZnVuY3Rpb24gdW53YXRjaChrZXksIGNhbGxiYWNrKSB7XG5cdFx0dmFyIGFyZ3MgPSBbJ2NoYW5nZTonICsga2V5XTtcblx0XHR0aGlzLiRjb21waWxlci5vYnNlcnZlci5kZXRhY2goa2V5LCBjYWxsYmFjay5fZm4pO1xuXHR9LFxuXHQnJGJyb2FkY2FzdCc6IGZ1bmN0aW9uIGJyb2FkY2FzdCgpe1xuXHRcdHZhciBjaGlsZHJlbiA9IHRoaXMuJGNvbXBpbGVyLmNoaWxkcmVuO1xuXHRcdGZvcih2YXIgbGVuID0gY2hpbGRyZW4ubGVuZ3RoIC0gMTsgbGVuLS07KXtcblx0XHRcdGNoaWxkID0gY2hpbGRyZW5bbGVuXTtcblx0XHRcdGNoaWxkLmVtaXR0ZXIuZW1pdC5hcHBseShjaGlsZC5lbWl0dGVyLCBhcmd1bWVudHMpO1xuXHRcdFx0Y2hpbGQudm0uJGJyb2FkY2FzdC5hcHBseShjaGlsZC52bSwgYXJndW1lbnRzKTtcblx0XHR9XG5cdH0sXG5cdCckZGlzcGF0Y2gnOiBmdW5jdGlvbiBkaXNwYXRjaCgpe1xuXHRcdHZhciBjb21waWxlciA9IHRoaXMuJGNvbXBpbGVyLFxuXHRcdFx0ZW1pdHRlciAgPSBjb21waWxlci5lbWl0dGVyLFxuXHRcdFx0cGFyZW50ICAgPSBjb21waWxlci5wYXJlbnQ7XG5cdFx0ZW1pdHRlci5lbWl0LmFwcGx5KGVtaXR0ZXIsIGFyZ3VtZW50cyk7XG5cdFx0aWYocGFyZW50KXtcblx0XHRcdHBhcmVudC52bS4kZGlzcGF0Y2guYXBwbHkocGFyZW50LnZtLCBhcmd1bWVudHMpO1xuXHRcdH1cblx0fSxcblx0JyRhcHBlbmRUbyc6IGZ1bmN0aW9uIGFwcGVuZFRvKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWxzLmRvbS5xdWVyeSh0YXJnZXQpO1xuXHRcdHZhciBlbCA9IHRoaXMuJGVsO1xuXHRcdHRhcmdldC5hcHBlbmRDaGlsZChlbClcbiAgICAgICAgY2IgJiYgdXRpbC5uZXh0VGljayhjYik7XG5cdH0sXG5cdCckcmVtb3ZlJzogZnVuY3Rpb24gcmVtb3ZlKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWwuZG9tLnF1ZXJ5KHRhcmdldCk7XG5cdFx0dmFyIGVsID0gdGhpcy4kZWw7XG5cdFx0aWYoZWwucGFyZW50Tm9kZSl7XG5cdFx0XHRlbC5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKGVsKTtcblx0XHR9XG5cdFx0Y2IgJiYgdXRpbC5uZXh0VGljayhjYik7XG5cdH0sXG5cdCckYmVmb3JlJzogZnVuY3Rpb24gYmVmb3JlKHRhcmdldCwgY2Ipe1xuXHRcdHRhcmdldCA9IHV0aWwuZG9tLnF1ZXJ5KHRhcmdldCk7XG5cdFx0dGFyZ2V0LnBhcmVudE5vZGUuaW5zZXJ0QmVmb3JlKGVsLCB0YXJnZXQpO1xuXHRcdGNiICYmIHV0aWwubmV4dFRpY2soY2IpO1xuXHR9LFxuXHQnJGFmdGVyJzogZnVuY3Rpb24gYWZ0ZXIodGFyZ2V0LCBjYil7XG5cdFx0dGFyZ2V0ID0gdXRpbC5kb20ucXVlcnkodGFyZ2V0KTtcblx0XHR2YXIgZWwgPSB0aGlzLiRlbDtcblx0XHRpZih0YXJnZXQubmV4dFNpYmxpbmcpIHtcblx0XHRcdHRhcmdldC5wYXJlbnROb2RlLmluc2VydEJlZm9yZShlbCwgdGFyZ2V0Lm5leHRTaWJsaW5nKTtcblx0XHR9ZWxzZXtcblx0XHRcdHRhcmdldC5wYXJlbnROb2RlLmFwcGVuZENoaWxkKGVsKTtcblx0XHR9XG5cdFx0Y2IgJiYgdXRpbC5uZXh0VGljayhjYik7XG5cdH1cbn0pO1xuLyoqXG4gKiAgZGVsZWdhdGUgb24vb2ZmL29uY2UgdG8gdGhlIGNvbXBpbGVyJ3MgZW1pdHRlclxuICovXG51dGlscy5lYWNoKFsnZW1pdCcsICdvbicsICdvZmYnLCAnb25jZScsICdkZXRhY2gnLCAnZmlyZSddLCBmdW5jdGlvbiAobWV0aG9kKSB7XG5cdFZNLnByb3RvdHlwZVsnJCcgKyBtZXRob2RdID0gZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZW1pdHRlciA9IHRoaXMuJGNvbXBpbGVyLmVtaXR0ZXI7XG4gICAgICAgIGVtaXR0ZXJbbWV0aG9kXS5hcHBseShlbWl0dGVyLCBhcmd1bWVudHMpO1xuICAgIH1cbn0pO1xuVk0uZXh0ZW5kID0gdXRpbHMub2JqZWN0LmV4dGVuZDtcbm1vZHVsZS5leHBvcnRzID0gVk07XG4iXX0=
