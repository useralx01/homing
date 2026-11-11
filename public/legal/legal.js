// Picks English or German: ?lang=de / ?lang=en first, else the browser language.
// Stores nothing on the device (no cookie, no localStorage). Without JS both languages show.
(function () {
  var q = new URLSearchParams(location.search).get('lang');
  var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
  var lang = q === 'de' || q === 'en' ? q : /^de\b/i.test(nav) ? 'de' : 'en';
  var root = document.documentElement;
  root.setAttribute('data-lang', lang);
  root.setAttribute('lang', lang);
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.lg-lang a').forEach(function (a) {
      a.setAttribute('aria-current', a.getAttribute('data-l') === lang ? 'true' : 'false');
    });
    // keep the chosen language when moving between the legal pages
    document.querySelectorAll('a[href]').forEach(function (a) {
      var h = a.getAttribute('href');
      if (/^[a-z-]+\.html(#.*)?$/.test(h)) {
        var parts = h.split('#');
        a.setAttribute('href', parts[0] + '?lang=' + lang + (parts[1] ? '#' + parts[1] : ''));
      }
    });
    var t = document.querySelector('[data-title-' + lang + ']');
    if (t) document.title = t.getAttribute('data-title-' + lang);
  });
})();
