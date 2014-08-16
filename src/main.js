var config      = require('./config'),
    utils       = require('./utils'),
    defer       = require('./deferred'),
    ViewModel   = require('./viewmodel');


testDefered();
function testDefered(){
	console.log('start');
	defer.when((function(){
		var deferrd = new defer.Deferred();
		setTimeout(function(){
			deferrd.resolve('resolve haha ')
		}, 2000);
		return deferrd.promise();
	})()).then(function(attr){
		console.log('so haha')
	});
}
module.exports = ViewModel;


