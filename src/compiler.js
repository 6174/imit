
var EventTarget = require('./eventTarget'),
	utils       = require('./utils'),
	config      = require('./config'),
	Binding     = require('./binding'),
	Parser      = require('./parser'),
	Observer    = require('./observer'),
	Directive   = require('./directive'),
	TextParser  = Parser.TextParser,
	ExpParser   = Parser.ExpParser;

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
	    compiler.emitter.off()
	}
);
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
		var outlets = [].slice.call(this.el.getElementsByTagName('content')),
			raw = this.rawContent;

		// first pass, collect corresponding content
        // for each outlet.
		utils.each(outlets, function(outlet){
			if (raw) {
				select = outlet.getAttribute('select');
				if (select) {
					outlet.content = [].slice.call(raw.querySelectorAll(select));
				} else {
					main = outlet;
				}
			} else {
				outlet.content = [].slice.call(outlet.childNodes);
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

	        var attrs = [].slice.call(node.attributes);
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
		        [].slice.call(node.childNodes).forEach(this.compile, this);
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