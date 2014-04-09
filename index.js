var fs = require('fs');
var path = require('path');
var coffee = require('coffee-script');
var mkpath = require('mkpath');
var EventEmitter = require('events').EventEmitter;

var wrap = require('./lib/wrap');
var watch = require('./lib/watch');

var log = function(arg1, arg2, arg3, arg4, arg5, arg6) {
    if (!process.env.BROWSERIFY_DEBUG) return;
    console.log(new Date().toISOString() + " [browserify] " +
                [arg1, arg2, arg3, arg4, arg5, arg6].join(' '));
}

function idFromPath (path) {
    return path.replace(/\\/g, '/');
}

function isAbsolute (pathOrId) {
    return path.normalize(pathOrId) === path.normalize(path.resolve(pathOrId));
}

function needsNodeModulesPrepended (id) {
    return !/^[.\/]/.test(id) && !isAbsolute(id);
}

var exports = module.exports = function (entryFile, opts) {
    if (!opts) opts = {};

    if (Array.isArray(entryFile)) {
        if (Array.isArray(opts.entry)) {
            opts.entry.unshift.apply(opts.entry, entryFile);
        }
        else if (opts.entry) {
            opts.entry = entryFile.concat(opts.entry);
        }
        else {
            opts.entry = entryFile;
        }
    }
    else if (typeof entryFile === 'object') {
        opts = entryFile;
    }
    else if (typeof entryFile === 'string') {
        if (Array.isArray(opts.entry)) {
            opts.entry.unshift(entryFile);
        }
        else if (opts.entry) {
            opts.entry = [ opts.entry, entryFile ];
        }
        else {
            opts.entry = entryFile;
        }
    }

    var opts_ = {
        cache : opts.cache,
        debug : opts.debug,
        exports : opts.exports,
    };

    log("Wrapping entry point: " + opts.entry);
    var w = wrap(opts_);
    w.register('.coffee', function (body, file) {
        try {
            // Check coffee-cache for the file first.
            // See https://github.com/FogCreek/node-coffee-cache
            var cacheDir = process.env['COFFEE_CACHE_DIR'] || '.coffee';
            var cachePath = path.join(cacheDir, path.relative('.', file)).replace(/\.coffee$/, '.js');
            var mapPath = path.resolve(cachePath.replace(/\.js$/, '.map'));
            var res;

            try {
                var sourceTime = fs.statSync(file).mtime;
                var cacheTime = fs.statSync(cachePath).mtime;
                if (cacheTime > sourceTime) {
                    log("Using cache for " + file);
                    res = fs.readFileSync(cachePath, 'utf8');
                }
            } catch (e) {}

            if (!res) {
                // Added instrumentation for Artillery.
                t = process.hrtime();
                var compiled = coffee.compile(body, { filename : file, sourceMap: true });
                t = process.hrtime(t);
                delta = Math.round(t[0] * 1000 + t[1] / 1e6);
                log("Compiled " + file + " in " + delta + " ms");

                res = compiled.js;

                // Handle older version of CoffeeScript.
                if (res == null) res = compiled;

                mkpath.sync(path.dirname(cachePath));
                fs.writeFileSync(cachePath, res, 'utf8');
                if (mapPath) fs.writeFileSync(mapPath, compiled.v3SourceMap, 'utf8');
            }

        }
        catch (err) {
            w.emit('syntaxError', err);
        }
        return res;
    });
    w.register('.json', function (body, file) {
        return 'module.exports = ' + body + ';\n';
    });

    var listening = false;
    w._cache = null;

    var self = function (req, res, next) {
        if (!listening && req.connection && req.connection.server) {
            req.connection.server.on('close', function () {
                self.end();
            });
        }
        listening = true;

        if (req.url.split('?')[0] === (opts.mount || '/browserify.js')) {
            if (!w._cache) self.bundle();
            res.statusCode = 200;
            res.setHeader('last-modified', self.modified.toString());
            res.setHeader('content-type', 'text/javascript');
            res.end(w._cache);
        }
        else next()
    };

    if (opts.watch) watch(w, opts.watch);

    if (opts.filter) {
        w.register('post', function (body) {
            return opts.filter(body);
        });
    }

    if (opts.contentfilter) {
        w.register('content', function (target, body) {
            return opts.contentfilter(target, body);
        });
    }

    w.ignore(opts.ignore || []);

    if (opts.require) {
        if (Array.isArray(opts.require)) {
            opts.require.forEach(function (r) {
                r = idFromPath(r);

                var params = {};
                if (needsNodeModulesPrepended(r)) {
                    params.target = '/node_modules/' + r + '/index.js';
                }
                w.require(r, params);
            });
        }
        else if (typeof opts.require === 'object') {
            Object.keys(opts.require).forEach(function (key) {
                opts.require[key] = idFromPath(opts.require[key]);

                var params = {};
                if (needsNodeModulesPrepended(opts.require[key])) {
                    params.target = '/node_modules/'
                        + opts.require[key] + '/index.js'
                    ;
                }
                w.require(opts.require[key], params);
                w.alias(key, opts.require[key]);
            });
        }
        else {
            opts.require = idFromPath(opts.require);

            var params = {};
            if (needsNodeModulesPrepended(opts.require)) {
                params.target = '/node_modules/'
                    + opts.require + '/index.js'
                ;
            }
            w.require(opts.require, params);
        }
    }

    if (opts.entry) {
        if (Array.isArray(opts.entry)) {
            opts.entry.forEach(function (e) {
                w.addEntry(e);
            });
        }
        else {
            w.addEntry(opts.entry);
        }
    }

    Object.keys(w).forEach(function (key) {
        Object.defineProperty(self, key, {
            set : function (value) { w[key] = value },
            get : function () { return w[key] }
        });
    });

    Object.keys(Object.getPrototypeOf(w)).forEach(function (key) {
        self[key] = function () {
            var s = w[key].apply(self, arguments)
            if (s === self) { w._cache = null }
            return s;
        };
    });

    Object.keys(EventEmitter.prototype).forEach(function (key) {
        if (typeof w[key] === 'function' && w[key].bind) {
            self[key] = w[key].bind(w);
        }
        else {
            self[key] = w[key];
        }
    });

    var firstBundle = true;
    self.modified = new Date;

    self.bundle = function () {
        if (w._cache) {
            return w._cache;
        }

        var src = w.bundle.apply(w, arguments);
        self.ok = Object.keys(w.errors).length === 0;

        if (!firstBundle) {
            self.modified = new Date;
        }
        firstBundle = false;

        w._cache = src;
        return src;
    };

    self.end = function () {
        Object.keys(w.watches || {}).forEach(function (file) {
            w.watches[file].close();
        });
    };

    return self;
};

exports.bundle = function (opts) {
    return exports(opts).bundle();
};
