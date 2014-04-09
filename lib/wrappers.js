var fs = require('fs');

var log = function(arg1, arg2, arg3, arg4, arg5, arg6) {
    if (!process.env.BROWSERIFY_DEBUG) return;
    console.log(new Date().toISOString() + " [browserify] " +
                [arg1, arg2, arg3, arg4, arg5, arg6].join(' '));
}

module.exports = fs.readdirSync(__dirname + '/../wrappers')
    .filter(function (file) { return file.match(/\.js$/) })
    .reduce(function (acc, file) {
        var name = file.replace(/\.js$/, '');
        acc[name] = fs.readFileSync(__dirname + '/../wrappers/' + file, 'utf8');
        return acc;
    }, {})
;
