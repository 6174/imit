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
