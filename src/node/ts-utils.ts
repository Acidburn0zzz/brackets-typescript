'use strict';

import * as log from './log';
import ReadConfigError from './read-config-error';
import { combinePaths, normalizePath } from './fs-utils';
import { getFileMatcherPatterns, matchFilesInProject } from './file-matching';

var _ = require('lodash');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var ts = require('typescript');
var Glob = require('glob');
var path = require('path');
var escapeStringRegexp = require('escape-string-regexp');
var resolveSync = require('tsconfig').resolveSync;
var projects = {};

function glob(pattern, options) {
  return new Promise(function (resolve, reject) {
    Glob(pattern, options, function (err, files) {
      return err ? reject(err) : resolve(files);
    });
  });
}

function readConfig(projectRoot) {
  var tsconfigPath = resolveSync(projectRoot);
  var tsconfigContents = fs.readFileSync(tsconfigPath, 'utf8');

  var rawConfig = ts.parseConfigFileTextToJson(tsconfigPath, tsconfigContents);
  if (rawConfig.error) {
    throw new ReadConfigError(rawConfig.error.code, rawConfig.error.messageText);
  }

  return rawConfig.config;
}

function readCompilerOptions(projectRoot) {
  var tsconfigPath = resolveSync(projectRoot);
  var tsconfigDir = tsconfigPath ? path.dirname(tsconfigPath) : projectRoot;
  var rawConfig = readConfig(projectRoot);

  var settings = ts.convertCompilerOptionsFromJson(rawConfig.compilerOptions, tsconfigDir);
  if (settings.errors && settings.errors.length > 0) {
    throw new ReadConfigError(settings.errors[0].code, settings.errors[0].messageText);
  }

  return _.defaults(settings.options, ts.getDefaultCompilerOptions());
}

function createHost(projectRoot) {

  const files = [];

  function addPackageJson(fileName: string, body: string): void {
    let packageJson;
    try {
      packageJson = JSON.parse(body);
    } catch (err) {
      log.error(`Error parsing ${fileName}: ${err}`);
      return;
    }
    if (typeof packageJson.typings === 'string') {
      addFileSync(path.resolve(path.dirname(fileName), packageJson.typings));
    }
  }

  function addFile(fileName, body) {
    if (body && /\/package.json$/.test(fileName)) {
      return addPackageJson(fileName, body);
    }
    if (body == null) {
      if (!files[fileName]) {
        files[fileName] = { version: 1, snap: null };
      }
      return;
    }
    var snap = ts.ScriptSnapshot.fromString(body);
    if (files[fileName]) {
      files[fileName].version += 1;
      files[fileName].snap = snap;
    } else {
      files[fileName] = { version: 1, snap: snap };
    }
  }

  function addFileSync(fileName) {
    if (files[fileName]) {
      return;
    }
    var contents = null;
    try {
      contents = fs.readFileSync(fileName, 'utf8');
    } catch (ignoreErr) {
      // log.error('Cannot open file (' + err.code + '): ' + fileName);
    }
    addFile(fileName, contents);
  }

  function addFileAsync(fileName) {
    return new Promise(function (resolve, reject) {
      if (files[fileName]) {
        return resolve();
      }
      fs.readFile(fileName, 'utf8', function (err, contents) {
        if (err) {
          log.error('Cannot open file (' + err.code + '): ' + fileName);
        }
        addFile(fileName, contents || null);
        return resolve();
      });
    });
  }

  return {
    $addFileSync: addFileSync,
    $addFileAsync: addFileAsync,
    getCurrentDirectory: function () {
      return projectRoot;
    },
    getScriptFileNames: function () {
      return Object.keys(files);
    },
    getCompilationSettings: function () {
      return readCompilerOptions(projectRoot);
    },
    getDefaultLibFileName: function (options) {
      var fileName = normalizePath(ts.getDefaultLibFilePath(options));
      addFileSync(fileName);
      return fileName;
    },
    addFile: addFile,
    getScriptIsOpen: function (fileName) {
      fileName = normalizePath(fileName);
      addFileSync(fileName);
      return files[fileName] && files[fileName].snap != null;
    },
    getScriptSnapshot: function (fileName) {
      fileName = normalizePath(fileName);
      addFileSync(fileName);
      return files[fileName] && files[fileName].snap;
    },
    getScriptVersion: function (fileName) {
      fileName = normalizePath(fileName);
      addFileSync(fileName);
      return files[fileName] && files[fileName].version.toString();
    }
  };
}

function getStuffForProject(projectRoot) {
  projectRoot = normalizePath(projectRoot);
  if (projects[projectRoot]) {
    return Promise.resolve(projects[projectRoot]);
  }
  var host = createHost(projectRoot);
  var languageService = ts.createLanguageService(host, ts.createDocumentRegistry());

  const config = readConfig(projectRoot);
  const extensions: string[] = ['.ts', '.tsx'];
  const includes: string[] = config.files;
  const excludes: string[] = config.exclude;

  excludes.push('.git');
  if (config.compilerOptions.outDir) {
    excludes.push(config.compilerOptions.outDir);
  }

  const fileMatcherPatterns = getFileMatcherPatterns(projectRoot, extensions, excludes, includes);
  return matchFilesInProject(projectRoot, fileMatcherPatterns, extensions).then(files => {
    return Promise.all(files.map(function (relativePath) {
      return host.$addFileAsync(normalizePath(combinePaths(projectRoot, relativePath)));
    }));
  }).then(function () {
    projects[projectRoot] = {
      host: host,
      languageService: languageService,
      fileMatcherPatterns: fileMatcherPatterns
    };
    return projects[projectRoot];
  });
}

function mapDiagnostics(diagnostics) {
  return {
    errors: diagnostics.map(function (diagnostic) {
      // sample: {"start":255,"length":1,"messageText":"Cannot find name 's'.","category":1,"code":2304}
      // sample2: { file: undefined, start: undefined, length: undefined,
      // messageText: 'Cannot find global type \'String\'.', category: 1, code: 2318 }
      var type = 'TypeScriptDiagnostic';
      var messageText = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      var message = 'TS' + diagnostic.code + ': ' + messageText;

      var line = 0;
      var ch = 0;
      if (diagnostic.file) {
        var lineChar = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        line = lineChar.line;
        ch = lineChar.character;
      }

      return {
        type: type,
        message: message,
        pos: {
          line: line,
          ch: ch
        }
      };
    })
  };
}

exports.getDiagnostics = function getDiagnostics(projectRoot, fullPath, code, callback) {
  return getStuffForProject(projectRoot).then(function (obj) {
    var host = obj.host;
    var languageService = obj.languageService;
    var relativePath = normalizePath(path.relative(projectRoot, fullPath));
    host.addFile(relativePath, code);

    var compilerDiagnostics = languageService.getCompilerOptionsDiagnostics(relativePath);
    if (compilerDiagnostics.length > 0) {
      return callback(null, mapDiagnostics(compilerDiagnostics));
    }

    var semanticDiagnostics = languageService.getSemanticDiagnostics(relativePath);
    var syntaxDiagnostics = languageService.getSyntacticDiagnostics(relativePath);
    var diagnostics = [].concat(semanticDiagnostics, syntaxDiagnostics);
    return callback(null, mapDiagnostics(diagnostics));
  }).catch(function (err) {
    if (err.name === 'ReadConfigError') {
      return callback(null, mapDiagnostics([ err ]));
    }
    log.error(err);
    return callback(err);
  });
};

function mapCompletions(completions, currentWord) {
  var entries = completions.entries || [];
  var hints = _.sortBy(entries, function (entry) {
    var sort = entry.sortText;
    if (currentWord) {
      sort += entry.name.indexOf(currentWord) === 0 ? '0' : '1';
    }
    return sort + entry.name.toLowerCase();
  }).map(function (entry) { return entry.name; });

  if (currentWord) {
    var re = new RegExp('^' + escapeStringRegexp(currentWord), 'i');
    hints = hints.filter(function (h) { return re.test(h); });
  }

  return {
    hints: hints,
    match: currentWord,
    selectInitial: true,
    handleWideResults: false
  };
}

exports.getCompletions = function getCompletions(projectRoot, fullPath, code, position, callback) {
  return getStuffForProject(projectRoot).then(function (obj) {
    var host = obj.host;
    var languageService = obj.languageService;
    var relativePath = normalizePath(path.relative(projectRoot, fullPath));
    host.addFile(relativePath, code);

    var isMemberCompletion = false;
    var currentWord = null;
    var codeBeforeCursor = code.slice(0, position);
    var match = codeBeforeCursor.match(/\.([\$_a-zA-Z0-9]*$)/);
    if (match && match.length > 0) {
      isMemberCompletion = true;
      currentWord = match[1];
    } else {
      match = codeBeforeCursor.match(/[\$_a-zA-Z0-9]+$/);
      currentWord = match ? match[0] : null;
    }

    var completions = languageService.getCompletionsAtPosition(relativePath, position, isMemberCompletion);
    return callback(null, mapCompletions(completions, currentWord));
  }).catch(function (err) {
    if (err.name === 'ReadConfigError') {
      return callback(null, mapDiagnostics([ err ]));
    }
    log.error(err);
    return callback(err);
  });
};