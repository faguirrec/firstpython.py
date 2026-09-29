/* Editor de líneas de cotizaciones y arriendos.
   El servidor recalcula y valida todo al guardar: esto sólo da respuesta inmediata. */
(function () {
  var editor = document.getElementById('editor-lineas');
  if (!editor) return;
  var catalogo = JSON.parse(document.getElementById('catalogo').textContent);
  var porId = {};
  catalogo.forEach(function (e) { porId[e.id] = e; });
  var tbody = editor.querySelector('tbody');
  var plantilla = document.getElementById('plantilla-linea');
  var excluir = editor.dataset.excluir;
  var ivaPct = parseInt(editor.dataset.iva, 10) || 0;
  var form = editor.closest('form');
  var inicio = form.querySelector('[name=fecha_inicio]');
  var fin = form.querySelector('[name=fecha_fin]');
  var flete = form.querySelector('[name=flete]');
  var garantiaCampo = form.querySelector('[name=garantia_monto]');
  document.getElementById('t-iva-pct').textContent = ivaPct;

  function clp(n) {
    return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  function totales() {
    var items = 0, garantia = 0;
    tbody.querySelectorAll('tr.linea').forEach(function (tr) {
      var q = num(tr.querySelector('.l-cant').value);
      var p = num(tr.querySelector('.l-precio').value);
      var d = Math.min(100, Math.max(0, num(tr.querySelector('.l-desc').value)));
      var sub = Math.floor((q * p * (100 - d) + 50) / 100);
      tr.querySelector('.l-sub').textContent = clp(sub);
      items += sub;
      var e = porId[tr.querySelector('.l-equipo').value];
      if (e) garantia += q * e.garantia;
    });
    var f = flete ? Math.max(0, num(flete.value)) : 0;
    var neto = items + f;
    var iva = Math.floor((neto * ivaPct + 50) / 100);
    document.getElementById('t-items').textContent = clp(items);
    document.getElementById('t-flete').textContent = clp(f);
    document.getElementById('t-neto').textContent = clp(neto);
    document.getElementById('t-iva').textContent = clp(iva);
    document.getElementById('t-total').textContent = clp(neto + iva);
    document.getElementById('t-garantia').textContent = clp(garantia);
    if (garantiaCampo && !garantiaCampo.dataset.manual) garantiaCampo.value = garantia;
  }

  function refrescar(tr, repreciar) {
    var id = tr.querySelector('.l-equipo').value;
    var hint = tr.querySelector('.disp-hint');
    if (!id || !inicio.value || !fin.value) { hint.textContent = ''; totales(); return; }
    var url = editor.dataset.urlBase + id + '/cotizar?desde=' + inicio.value + '&hasta=' + fin.value +
      (excluir ? '&excluir=' + excluir : '');
    var token = (tr._token = (tr._token || 0) + 1);
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || token !== tr._token) return;
        var precio = tr.querySelector('.l-precio');
        if (repreciar && !precio.dataset.manual) { precio.value = d.precio; }
        var q = num(tr.querySelector('.l-cant').value);
        if (d.disponible !== null) {
          var falta = q > d.disponible;
          hint.className = 'disp-hint ' + (falta ? 'mal' : 'bien');
          hint.textContent = falta
            ? 'Sólo hay ' + d.disponible + ' disponible(s) en esas fechas'
            : d.disponible + ' disponible(s) en esas fechas';
        }
        totales();
      })
      .catch(function () { totales(); });
  }

  function agregar() {
    var frag = plantilla.content.cloneNode(true);
    tbody.appendChild(frag);
    return tbody.lastElementChild;
  }

  tbody.addEventListener('change', function (ev) {
    var tr = ev.target.closest('tr.linea');
    if (!tr) return;
    if (ev.target.classList.contains('l-equipo')) {
      delete tr.querySelector('.l-precio').dataset.manual;
      refrescar(tr, true);
    } else if (ev.target.classList.contains('l-cant')) {
      refrescar(tr, false);
    }
  });
  tbody.addEventListener('input', function (ev) {
    if (ev.target.classList.contains('l-precio')) ev.target.dataset.manual = '1';
    totales();
  });
  tbody.addEventListener('click', function (ev) {
    if (!ev.target.classList.contains('l-quitar')) return;
    ev.target.closest('tr.linea').remove();
    totales();
  });
  document.getElementById('agregar-linea').addEventListener('click', function () {
    agregar().querySelector('.l-equipo').focus();
  });
  [inicio, fin].forEach(function (c) {
    c.addEventListener('change', function () {
      tbody.querySelectorAll('tr.linea').forEach(function (tr) { refrescar(tr, true); });
    });
  });
  if (flete) flete.addEventListener('input', totales);
  if (garantiaCampo) garantiaCampo.addEventListener('input', function () { garantiaCampo.dataset.manual = '1'; });

  if (!tbody.querySelector('tr.linea')) agregar();
  else if (garantiaCampo && num(garantiaCampo.value) > 0) garantiaCampo.dataset.manual = '1';
  tbody.querySelectorAll('tr.linea').forEach(function (tr) { refrescar(tr, false); });
  totales();
})();
