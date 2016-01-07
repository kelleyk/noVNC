#!/usr/bin/env node

var path = require('path');
var program = require('commander');
var fs = require('fs');
var fse = require('fs-extra');
var esprima = require('esprima');

program
    .option('-b, --browserify', 'create a browserify bundled app')
    .parse(process.argv);

// the various important paths
var core_path = path.resolve(__dirname, '..', 'core');
var app_path = path.resolve(__dirname, '..', 'app');
var out_dir_base = path.resolve(__dirname, '..', 'build');
var out_dir_core = path.join(out_dir_base, 'novnc');
var out_dir_app = path.join(out_dir_base, 'app');
var out_dir_full = path.resolve(out_dir_base, 'full');

var find_js_files = function (dir) {
    var filenames = fs.readdirSync(dir).filter(function (f) { return f.slice(-3) == '.js'; });
    return filenames.map(function (f) { return path.resolve(dir, f); });
};

// load the list of files to process
var target_files_core = find_js_files(core_path);
var target_files_app = find_js_files(app_path);

// make sure the output directory exists
fse.ensureDir(out_dir_base);
fse.emptyDirSync(out_dir_core);
fse.emptyDirSync(out_dir_app);

var module_names = {};
var module_info = {};

var output_files = function (cb) {
    // actually write the output files
    var cnt = 0;
    Object.keys(module_info).forEach(function (out_file, ind, keys) {
        var info = module_info[out_file];
        var contents = info.module;

        contents = contents.replace(/\/\* \[as-module\] (.+) \*\//g, '$1');
        contents = contents.replace(/\/\* \[begin skip-as-module\] \*\/(.|\n)+\/\* \[end skip-as-module\] \*\//g, '');

        if (info.requires) {
            var req_strs = info.requires.map(function (val) {
                var req_info = module_info[module_names[val]];

                if (!req_info) {
                    throw new Error("Uknown module '" + val + "' while processing module '" + info.name + "'!");
                }

                var req_base_path = '.';
                if (info.namespace !== req_info.namespace) {
                    req_base_path = path.join('..', req_info.namespace);
                }
                var req_path = path.join(req_base_path, req_info.filename);
                return "var " + val + " = require('./" + req_path + "');";
            });

            contents = req_strs.join("\n") + contents;
        }

        if (!info.commonjs) {
            contents = info.header + contents + '\nmodule.exports = ' + info.name + ';';
        }

        fs.writeFile(out_file, contents, function (err) {
            if (err) { throw err; }
            console.log("Wrote " + out_file);
            cnt++;

            if (cnt == keys.length) {
                cb();
            }
        });
    });

    // write the index.js file for core
    var rfb_file = module_info[module_names.RFB].filename;
    var index_js_core = "module.exports = require('./" + rfb_file + "');;'";
    var core_index_file = path.join(out_dir_core, 'index.js');
    fs.writeFile(core_index_file, index_js_core, function (err) {
        if (err) { throw err; }
        console.log("Wrote " + core_index_file);
    });

    // write the index.js file for app
    var index_js_app = "var UI = require('./ui');";
    var app_index_file = path.join(out_dir_app, 'index.js');
    fs.writeFile(app_index_file, index_js_app, function (err) {
        if (err) { throw err; }
        console.log("Wrote " + app_index_file);
    });
};

// populate the module info
var load_files = function (target_files, out_dir, ns, cb) {
    var cnt = 0;
    target_files.forEach(function (file_path) {
        fs.readFile(file_path, function (err, contents_raw) {
            console.log("Processing '" + file_path + "'");
            if (err) { throw err; }

            var contents = contents_raw.toString();

            var module_parts = contents.split('/* [module] ');
            var module_header = module_parts[0];
            module_parts = module_parts.slice(1);

            module_parts.forEach(function (module_part) {
                var info_end = module_part.indexOf('*/');
                var info_raw = module_part.slice(0, info_end);
                var module_rest = module_part.slice(info_end + 3);

                var info_parts = info_raw.split(';');
                var info = {};
                info_parts.forEach(function (val) {
                    var val_parts = val.split(':');
                    info[val_parts[0].trim().toLowerCase()] = val_parts[1].trim();
                });

                if (info.requires) {
                    info.requires = info.requires.split(',').map(function (v) { return v.trim(); });
                }

                if (info.commonjsrequires) {
                    info.commonjsrequires = info.commonjsrequires.split(',').map(function (v) { return v.trim(); });
                }

                //var file_name = path.basename(file_path);
                var mod_file_name = info.name.toLowerCase();
                var file_name = mod_file_name + '.js';
                var out_file = path.resolve(out_dir, file_name);

                info.filename = mod_file_name;
                info.module = module_rest;
                info.header = module_header;
                info.namespace = ns;

                // set the name in the global list
                module_names[info.name] = out_file;
                module_info[out_file] = info;
            });

            cnt++;

            if (cnt == target_files.length) {
                cb();
            }
        });
    });
};

var make_full_app = function () {
    process.chdir(out_dir_base);
    fse.emptyDirSync(out_dir_full);

    var app_file = path.join(out_dir_full, 'app.js');
    var browserify = require('browserify')();
    browserify.add(path.join(out_dir_app, 'index.js'));
    browserify.bundle().pipe(fs.createWriteStream(app_file));
    console.log("Wrote ", app_file);

    var src_dir_app = path.join(__dirname, '..', 'app');
    fs.readdir(src_dir_app, function (err, files) {
        if (err) { throw err; }

        files.forEach(function (src_file) {
            var src_file_path = path.resolve(src_dir_app, src_file);
            var out_file_path = path.resolve(out_dir_full, src_file);
            var ext = path.extname(src_file);
            if (ext === '.js' || ext === '.html') return;
            fse.copy(src_file_path, out_file_path, function (err) {
                if (err) { throw err; }
                console.log("Copied file(s) from " + src_file_path + " to " + out_file_path);
            });
        });
    });

    var src_html_path = path.resolve(__dirname, '..', 'vnc.html');
    var out_html_path = path.resolve(out_dir_full, 'vnc.html');
    fs.readFile(src_html_path, function (err, contents_raw) {
        if (err) { throw err; }

        var contents = contents_raw.toString();
        contents = contents.replace(/="app\//g, '="');

        var start_marker = '<!-- begin scripts -->\n';
        var end_marker = '<!-- end scripts -->';
        var start_ind = contents.indexOf(start_marker) + start_marker.length;
        var end_ind = contents.indexOf(end_marker, start_ind);

        contents = contents.slice(0, start_ind) + '<script src="app.js"></script>\n' + contents.slice(end_ind);

        fs.writeFile(out_html_path, contents, function (err) {
            if (err) { throw err; }
            console.log("Wrote " + out_html_path);
        });
    });
};

load_files(target_files_core, out_dir_core, 'novnc', function () {
    load_files(target_files_app, out_dir_app, 'app', output_files.bind(null, function () {
        if (program.browserify) {
            make_full_app();
        } else {
            fse.emptyDirSync(out_dir_full);
            fs.rmdir(out_dir_full);
        }
    }));
});
