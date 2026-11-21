// Language switch (EN default, BM) and the census filter. Pages work without this script: English shows.
(function () {
  var KEY = 'bumpproof-lang';
  var buttons = document.querySelectorAll('[data-set]');
  function show(lang) {
    var found = false;
    document.querySelectorAll('[data-lang]').forEach(function (el) {
      var on = el.getAttribute('data-lang') === lang;
      el.hidden = !on;
      if (on) found = true;
    });
    if (!found) return;
    document.documentElement.lang = lang;
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-set') === lang)); });
    try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
    // Anchors carry a language suffix (#runs, #runs-ms); follow the open one into the shown copy.
    var id = location.hash.slice(1).replace(/-[a-z]{2}$/, '');
    if (id) {
      var target = document.getElementById(lang === 'en' ? id : id + '-' + lang);
      if (target) target.scrollIntoView();
    }
  }
  buttons.forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-set')); }); });
  var wanted = new URLSearchParams(location.search).get('lang');
  try { wanted = wanted || localStorage.getItem(KEY); } catch (e) { /* private mode */ }
  if (wanted && wanted !== 'en') show(wanted);

  document.querySelectorAll('.filters').forEach(function (group) {
    var table = group.parentElement.querySelector('[data-census]');
    if (!table) return;
    group.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-filter');
        group.querySelectorAll('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        table.querySelectorAll('tbody tr').forEach(function (tr) { tr.hidden = v !== '' && tr.getAttribute('data-verdict') !== v; });
      });
    });
  });
})();
