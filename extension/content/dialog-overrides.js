(function() {
  function _renderAgenticDialog(type, msg) {
    const div = document.createElement('div');
    div.id = 'agentic-native-dialog-' + Date.now();
    div.style.cssText = 'position:fixed; top:10px; right:10px; background:yellow; color:black; padding:10px; z-index:2147483647; border:2px solid red; font-weight:bold;';
    div.innerText = 'System ' + type + ': ' + msg;
    const target = document.body || document.documentElement;
    if (target) {
      target.appendChild(div);
      setTimeout(() => div.remove(), 10000);
    }
  }
  window.alert = function(msg) { _renderAgenticDialog('alert', msg); return true; };
  window.confirm = function(msg) { _renderAgenticDialog('confirm', msg); return true; };
  window.prompt = function(msg, def) { _renderAgenticDialog('prompt', msg); return def; };
})();
