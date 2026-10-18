/* TOP CLOUD — progressive enhancement (no framework) */
(function () {
  'use strict';

  /* ---------- Mobile nav ---------- */
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ---------- Form loading states (page-reload forms) ---------- */
  document.querySelectorAll('form').forEach(function (form) {
    var btn = form.querySelector('button[type="submit"]');
    form.addEventListener('submit', function () {
      form.classList.add('loading');
      if (btn) btn.disabled = true;
    });
  });

  /* ---------- Confirm dialogs for destructive/irreversible actions ---------- */
  document.querySelectorAll('[data-confirm]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (!window.confirm(el.dataset.confirm)) e.preventDefault();
    });
  });

  /* ---------- Client-side validation (server re-validates everything) ---------- */
  document.querySelectorAll('form[data-validate]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var ok = true;
      form.querySelectorAll('input[required], select[required], textarea[required]').forEach(function (field) {
        var empty = !field.value || (field.type === 'checkbox' && !field.checked);
        if (empty) {
          mark(field, true);
          ok = false;
        } else {
          mark(field, false);
        }
      });
      // Password match pairs (register + change password)
      var a = form.querySelector('[name="password"]');
      var a2 = form.querySelector('[name="password2"]');
      if (a && a2) {
        if (a.value !== a2.value) {
          mark(a2, true);
          ok = false;
        } else {
          mark(a2, false);
        }
      }
      var c = form.querySelector('[name="next"]');
      var c2 = form.querySelector('[name="next2"]');
      if (c && c2) {
        if (c.value !== c2.value) {
          mark(c2, true);
          ok = false;
        } else {
          mark(c2, false);
        }
      }
      if (!ok) {
        e.preventDefault();
        var first = form.querySelector('.invalid');
        if (first && first.focus) first.focus();
      }
    });
    form.addEventListener('input', function (e) {
      if (e.target.classList && e.target.classList.contains('invalid') && e.target.value) {
        e.target.classList.remove('invalid');
      }
    });
  });

  function mark(field, invalid) {
    if (field.type === 'checkbox') {
      field.closest('.check-row')?.classList.toggle('invalid-row', invalid);
      return;
    }
    field.classList.toggle('invalid', invalid);
  }

  /* ---------- Password strength hint ---------- */
  function hookPassword(id) {
    var input = document.getElementById(id);
    var out = document.getElementById('pwStrength');
    if (!input || !out) return;
    input.addEventListener('input', function () {
      var v = input.value;
      var score = 0;
      if (v.length >= 10) score++;
      if (v.length >= 14) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/\d/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      var words = ['too short', 'weak', 'okay', 'good', 'strong', 'very strong'];
      out.textContent = v ? 'Strength: ' + words[score] : '';
    });
  }
  hookPassword('password');
  hookPassword('next');

  /* ---------- Form editor (owner/admin form builder) ---------- */
  var seed = document.getElementById('seedFields');
  var rowsEl = document.getElementById('fieldRows');
  var jsonInput = document.getElementById('fieldsJson');
  var countEl = document.getElementById('fieldCount');
  if (seed && rowsEl && jsonInput) {
    var fields = [];
    try {
      fields = JSON.parse(seed.textContent || '[]');
    } catch (err) {
      fields = [];
    }

    function keyOf(i) {
      return 'question_' + (i + 1);
    }

    function renderRow(f, i) {
      var row = document.createElement('div');
      row.className = 'field-row';
      row.dataset.index = String(i);

      var typeSel = document.createElement('select');
      typeSel.name = 'f_type_' + i;
      ['text', 'textarea', 'select', 'checkbox'].forEach(function (t) {
        var o = document.createElement('option');
        o.value = t;
        o.textContent = { text: 'Text', textarea: 'Long answer', select: 'Dropdown', checkbox: 'Checkbox' }[t];
        if (f.type === t) o.selected = true;
        typeSel.appendChild(o);
      });
      typeSel.addEventListener('change', function () { syncOptions(typeSel, row); });

      var labelIn = document.createElement('input');
      labelIn.type = 'text';
      labelIn.name = 'f_label_' + i;
      labelIn.value = f.label || '';
      labelIn.placeholder = 'Question label';
      labelIn.maxLength = 120;

      var optsIn = document.createElement('input');
      optsIn.type = 'text';
      optsIn.name = 'f_options_' + i;
      optsIn.value = (f.options || []).join(', ');
      optsIn.placeholder = 'Option A, Option B, …';

      var reqChk = document.createElement('input');
      reqChk.type = 'checkbox';
      reqChk.name = 'f_required_' + i;
      reqChk.checked = !!f.required;
      var reqWrap = document.createElement('span');
      reqWrap.title = 'Required question';
      reqWrap.className = 'faint';
      reqWrap.textContent = 'req ';
      reqWrap.appendChild(reqChk);

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.textContent = '✕';
      rm.setAttribute('aria-label', 'Remove question');
      rm.addEventListener('click', function () {
        rowsEl.removeChild(row);
        reindex();
      });

      row.appendChild(typeSel);
      row.appendChild(labelIn);
      row.appendChild(optsIn);
      row.appendChild(reqWrap);
      row.appendChild(rm);
      rowsEl.appendChild(row);
      syncOptions(typeSel, row);
    }

    function syncOptions(typeSel, row) {
      var opts = row.querySelector('[name^="f_options_"]');
      opts.style.opacity = typeSel.value === 'select' ? '1' : '0.35';
    }

    function reindex() {
      Array.from(rowsEl.children).forEach(function (row, i) {
        row.dataset.index = String(i);
        row.querySelector('select').name = 'f_type_' + i;
        row.querySelector('[name^="f_label_"]').name = 'f_label_' + i;
        row.querySelector('[name^="f_options_"]').name = 'f_options_' + i;
        row.querySelector('[name^="f_required_"]').name = 'f_required_' + i;
      });
      updateCount();
    }

    function updateCount() {
      countEl.textContent = rowsEl.children.length + ' questions';
    }

    document.getElementById('addField').addEventListener('click', function () {
      renderRow({ type: 'text', label: '', required: false }, rowsEl.children.length);
      updateCount();
    });

    function collect() {
      var out = [];
      var err = null;
      var used = {};
      Array.from(rowsEl.children).forEach(function (row, i) {
        var type = row.querySelector('select').value;
        var label = row.querySelector('[name^="f_label_"]').value.trim();
        var optsRaw = row.querySelector('[name^="f_options_"]').value;
        var required = row.querySelector('[name^="f_required_"]').checked;
        if (!label) {
          err = err || 'Every question needs a label.';
          return;
        }
        var key = keyOf(i);
        if (used[key]) key = key + '_' + Math.floor(Math.random() * 9000 + 1000);
        used[key] = true;
        var f = { key: key, label: label, type: type, required: required, order: i };
        if (type === 'select') {
          var opts = optsRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          if (opts.length < 2) {
            err = err || 'Dropdown questions need at least 2 options (comma separated).';
          }
          f.options = opts;
        }
        out.push(f);
      });
      return { fields: out, error: err };
    }

    var form = document.getElementById('formEditor');
    form.addEventListener('submit', function (e) {
      var res = collect();
      if (res.error) {
        e.preventDefault();
        alert(res.error);
        return;
      }
      jsonInput.value = JSON.stringify(res.fields);
      // Let the standard loading-state handler do its thing.
    });
    // mark as json-capable? no — this form posts HTML normally; jsonInput carries the data.
    form.removeAttribute('data-nosubmit');
    updateCount();
    fields.forEach(function (f, i) { renderRow(f, i); });
  }

})();
