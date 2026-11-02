/* GoatMessenger site helpers: cookie-choice banner + tiny nav niceties. */
(function () {
  'use strict';

  var KEY = 'gm:cookieChoice';

  function read(name) {
    try { return window.localStorage.getItem(name); } catch { return null; }
  }
  function write(name, value) {
    try { window.localStorage.setItem(name, value); } catch { /* private mode */ }
  }

  function banner() {
    if (read(KEY)) return;
    var bar = document.createElement('aside');
    bar.className = 'cookie-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Cookie and storage choice');
    var text = document.createElement('p');
    text.innerHTML = 'No cookies here, honestly — no analytics, no ads, nothing third-party. ' +
      'We only keep your message history in <em>your</em> browser when you use the web app. ' +
      '<a href="cookies.html">What we store</a>';
    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'cookie-btn';
    accept.textContent = 'That works for me';
    var reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'cookie-btn';
    reject.textContent = 'Keep me cookie-free';
    accept.addEventListener('click', function () { choice('accepted'); });
    reject.addEventListener('click', function () { choice('rejected'); });
    function choice(v) {
      write(KEY, v);
      write(KEY + ':at', new Date().toISOString());
      bar.remove();
    }
    bar.append(text, accept, reject);
    document.body.append(bar);
    accept.focus({ preventScroll: true });
  }

  function onReady() {
    banner();
    // Keyboard user? Skip straight past the nav.
    var main = document.querySelector('main');
    if (main) main.setAttribute('tabindex', '-1');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  // Exported for the settings page? Nothing else yet — keep it out of globals.
})();
