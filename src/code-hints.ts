define(function (require, exports, module) {
  'use strict';

  var CodeHintManager = brackets.getModule('editor/CodeHintManager');
  var LanguageManager = brackets.getModule('language/LanguageManager');
  var ProjectManager = brackets.getModule('project/ProjectManager');
  var nodeDomain = require('./node-domain');

  function TypeScriptHintProvider() {
    this.editor = null;
  }

  TypeScriptHintProvider.prototype.hasHints = function hasHints(editor, implicitChar) {
    this.editor = editor;
    return true;
  };

  TypeScriptHintProvider.prototype.getHints = function getHints(implicitChar) {
    if (implicitChar == null || !/^[\.\$_a-zA-Z0-9]$/.test(implicitChar)) {
      return null;
    }
    var deferred = $.Deferred();
    var projectRoot = ProjectManager.getProjectRoot().fullPath;
    var fullPath = this.editor.document.file.fullPath;
    var code = this.editor.document.getText();
    var position = this.editor.indexFromPos(this.editor.getCursorPos());
    nodeDomain.exec('getCompletions', projectRoot, fullPath, code, position)
    .then(function (results) {
      deferred.resolve(results);
    }, function (err) {
      deferred.reject(err);
    });
    return deferred;
  };

  TypeScriptHintProvider.prototype.insertHint = function insertHint(hint) {
    var cursorPos = this.editor.getCursorPos();
    var line = this.editor.document.getLine(cursorPos.line);

    var lineBeforeCursor = line.slice(0, cursorPos.ch);
    var wordBeforeCursor = lineBeforeCursor.match(/[\$_a-zA-Z0-9]+$/);
    wordBeforeCursor = wordBeforeCursor ? wordBeforeCursor[0] : '';

    var lineAfterCursor = line.slice(cursorPos.ch);
    var wordAfterCursor = lineAfterCursor.match(/^[\$_a-zA-Z0-9]+/);
    wordAfterCursor = wordAfterCursor ? wordAfterCursor[0] : '';

    var start = { line: cursorPos.line, ch: cursorPos.ch - wordBeforeCursor.length };
    var end = { line: cursorPos.line, ch: cursorPos.ch + wordAfterCursor.length };
    this.editor.document.replaceRange(hint, start, end);
  };

  module.exports = function () {
    var langIds = ['ts', 'tsx'].map(function (extension) {
      var language = LanguageManager.getLanguageForExtension(extension);
      return language ? language.getId() : null;
    }).filter(x => x != null);
    CodeHintManager.registerHintProvider(new TypeScriptHintProvider(), langIds, 0);
  };

});
