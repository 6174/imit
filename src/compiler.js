
var EventTarget = require('./eventTarget'),
	utils       = require('./utils'),
	config      = require('./config'),
	Parser      = require('./parser'),
	observer    = require('./observer');

var ViewModel,
    
    // CACHE METHODS
    slice       = [].slice,
    extend      = utils.extend,
    hasOwn      = ({}).hasOwnProperty,
    def         = Object.defineProperty,

    // HOOKS TO REGISTER
    hooks = [
        'created', 'ready',
        'beforeDestroy', 'afterDestroy',
        'attached', 'detached'
    ],

    // LIST OF PRIORITY DIRECTIVES
    // THAT NEEDS TO BE CHECKED IN SPECIFIC ORDER
    priorityDirectives = [
        'if',
        'repeat',
        'view',
        'component'
    ];

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
	this._initVM(vm);
	this._initData();
	this._startCompile();
}

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
                // components[key] = new ViewModel(components[key]);
            }
        }
        if (partials) {
            for (key in partials) {
                partials[key] = Parser.parserTemplate(partials[key])
            }
        }
        if (filters) {
            for (key in filters) {
                // utils.checkFilter(filters[key])
            }
        }
        if (template) {
            options.template = Parser.parserTemplate(template)
        }
	},
	_initElement: function(){
		var options = this.options;
		// CREATE THE NODE FIRST
	    var el = typeof options.el === 'string'
	        ? document.querySelector(options.el)
	        : options.el || document.createElement(options.tagName || 'div');

	    var template = options.template, child, replacer, i, attr, attrs;

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

	    // APPLY ELEMENT OPTIONS
	    if (options.id) el.id = options.id
	    if (options.className) el.className = options.className
	    attrs = options.attributes
	    if (attrs) {
	        for (attr in attrs) {
	            el.setAttribute(attr, attrs[attr])
	        }
	    }

	    this.el = el;
		this.el._vm = vm;
		utils.log('new VM instance: ' + el.tagName + '\n');
	},
	_initVM: function(){
		var options = this.options,
			vm = this.vm;

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
			'$el': el,
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

	    // initialize data
	    var data = compiler.data = options.data || {},
	        defaultData = options.defaultData
	    if (defaultData) {
	        for (key in defaultData) {
	            if (!hasOwn.call(data, key)) {
	                data[key] = defaultData[key]
	            }
	        }
	    }

	    // copy paramAttributes
	    var params = options.paramAttributes
	    if (params) {
	        i = params.length
	        while (i--) {
	            data[params[i]] = utils.checkNumber(
	                compiler.eval(
	                    el.getAttribute(params[i])
	                )
	            )
	        }
	    }

	    utils.mix(vm, data);
	    vm.$data = data;

	    // beforeCompile hook
	    compiler.execHook('created');

	    // the user might have swapped the data ...
	    data = compiler.data = vm.$data;
	    // user might also set some properties on the vm
	    // in which case we should copy back to $data
	    var vmProp
	    for (key in vm) {
	        vmProp = vm[key]
	        if (
	            key.charAt(0) !== '$' &&
	            data[key] !== vmProp &&
	            typeof vmProp !== 'function'
	        ) {
	            data[key] = vmProp
	        }
	    }

	    // now we can observe the data.
	    // this will convert data properties to getter/setters
	    // and emit the first batch of set events, which will
	    // in turn create the corresponding bindings.
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
	    compiler.execHook('ready')
	},
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
	     
	}
});

module.exports = Compiler;